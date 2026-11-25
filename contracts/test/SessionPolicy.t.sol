// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SessionPolicy} from "../src/SessionPolicy.sol";
import {MockUSD8} from "../src/mocks/MockUSD8.sol";

/// @dev Stand-in for an ExportFlow target contract (the escrow in production).
contract Target {
    uint256 public value;

    function poke(uint256 v) external {
        value = v;
    }

    function boom() external pure {
        revert("boom");
    }
}

contract SessionPolicyTest is Test {
    SessionPolicy policy;
    MockUSD8 token;
    Target target;

    address owner;
    uint256 ownerKey;
    address sessionKey = makeAddr("sessionKey");
    address stranger = makeAddr("stranger");
    address payee = makeAddr("payee");

    bytes4 constant SELECTOR_POKE = Target.poke.selector;
    address[] targets;
    bytes4[] selectors;

    function setUp() public {
        (owner, ownerKey) = makeAddrAndKey("owner");
        policy = new SessionPolicy();
        token = new MockUSD8();
        target = new Target();

        targets.push(address(target));
        selectors.push(SELECTOR_POKE);

        token.mint(owner, 1_000e6);
        vm.prank(owner);
        token.approve(address(policy), type(uint256).max);
    }

    function _create(uint32 maxCalls, uint64 validAfter, uint64 validUntil, uint96 spendCap)
        internal returns (bytes32 sessionId)
    {
        vm.prank(owner);
        sessionId = policy.createSession(sessionKey, targets, selectors, maxCalls, validAfter, validUntil, IERC20(address(token)), spendCap);
    }

    function _defaultSession() internal returns (bytes32) {
        return _create(5, uint64(block.timestamp), uint64(block.timestamp + 1 days), 100e6);
    }

    function _calldata(uint256 v) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(SELECTOR_POKE, v);
    }

    // ---------------- create ----------------

    function test_createSession_storesSessionAndAllowlist() public {
        vm.expectEmit(true, true, true, true, address(policy));
        emit SessionPolicy.SessionCreated(keccak256(abi.encode(owner, uint256(0))), owner, sessionKey, 5, uint64(block.timestamp + 1 days), 100e6);
        bytes32 id = _defaultSession();

        (SessionPolicy.Session memory s, address o) = policy.sessionOf(id);
        assertEq(o, owner);
        assertEq(s.delegate, sessionKey);
        assertTrue(s.active);
        assertEq(s.maxCalls, 5);
        assertEq(s.callsUsed, 0);
        assertEq(s.spendCap, 100e6);
        assertEq(s.spent, 0);
        assertTrue(policy.isAllowed(id, address(target), SELECTOR_POKE));
        assertFalse(policy.isAllowed(id, address(target), Target.boom.selector));
        assertEq(policy.sessionCount(), 1);
    }

    function test_createSession_revertsOnBadInputs() public {
        bytes4[] memory noSelectors;
        vm.startPrank(owner);
        vm.expectRevert(SessionPolicy.ZeroAddress.selector);
        policy.createSession(address(0), targets, selectors, 5, uint64(block.timestamp), uint64(block.timestamp + 1), IERC20(address(token)), 0);

        vm.expectRevert(SessionPolicy.EmptyAllowlist.selector);
        policy.createSession(sessionKey, new address[](0), selectors, 5, uint64(block.timestamp), uint64(block.timestamp + 1), IERC20(address(token)), 0);

        vm.expectRevert(SessionPolicy.EmptyAllowlist.selector);
        policy.createSession(sessionKey, targets, noSelectors, 5, uint64(block.timestamp), uint64(block.timestamp + 1), IERC20(address(token)), 0);

        vm.expectRevert(SessionPolicy.SessionExpired.selector);
        policy.createSession(sessionKey, targets, selectors, 5, uint64(block.timestamp + 1), uint64(block.timestamp + 1), IERC20(address(token)), 0);
        vm.stopPrank();
    }

    // ---------------- execute ----------------

    function test_execute_sessionKeyRunsAllowlistedCall() public {
        bytes32 id = _defaultSession();

        vm.prank(sessionKey);
        policy.execute(id, address(target), _calldata(42));

        assertEq(target.value(), 42);
        (SessionPolicy.Session memory s,) = policy.sessionOf(id);
        assertEq(s.callsUsed, 1);
    }

    function test_execute_onlyTheDelegate() public {
        bytes32 id = _defaultSession();

        vm.prank(stranger);
        vm.expectRevert(SessionPolicy.NotDelegate.selector);
        policy.execute(id, address(target), _calldata(1));
    }

    function test_execute_rejectsUnknownTargetAndSelector() public {
        bytes32 id = _defaultSession();

        vm.prank(sessionKey);
        vm.expectRevert(SessionPolicy.TargetNotAllowed.selector);
        policy.execute(id, stranger, _calldata(1));

        vm.prank(sessionKey);
        vm.expectRevert(SessionPolicy.SelectorNotAllowed.selector);
        policy.execute(id, address(target), abi.encodeWithSelector(Target.boom.selector));
    }

    function test_execute_enforcesCallLimit() public {
        bytes32 id = _create(2, uint64(block.timestamp), uint64(block.timestamp + 1 days), 0);

        vm.startPrank(sessionKey);
        policy.execute(id, address(target), _calldata(1));
        policy.execute(id, address(target), _calldata(2));
        vm.expectRevert(SessionPolicy.CallLimitReached.selector);
        policy.execute(id, address(target), _calldata(3));
        vm.stopPrank();
    }

    function test_execute_respectsTimeWindow() public {
        bytes32 id = _create(5, uint64(block.timestamp + 1 hours), uint64(block.timestamp + 2 hours), 0);

        vm.prank(sessionKey);
        vm.expectRevert(SessionPolicy.SessionNotStarted.selector);
        policy.execute(id, address(target), _calldata(1));

        vm.warp(block.timestamp + 1 hours);
        vm.prank(sessionKey);
        policy.execute(id, address(target), _calldata(1)); // open now

        vm.warp(block.timestamp + 2 hours);
        vm.prank(sessionKey);
        vm.expectRevert(SessionPolicy.SessionExpired.selector);
        policy.execute(id, address(target), _calldata(2));
    }

    function test_execute_failedCallRevertsWholeCall() public {
        bytes4[] memory sels = new bytes4[](2);
        sels[0] = SELECTOR_POKE;
        sels[1] = Target.boom.selector;
        vm.prank(owner);
        bytes32 id = policy.createSession(sessionKey, targets, sels, 5, uint64(block.timestamp), uint64(block.timestamp + 1 days), IERC20(address(token)), 0);

        vm.prank(sessionKey);
        vm.expectRevert(SessionPolicy.CallFailed.selector);
        policy.execute(id, address(target), abi.encodeWithSelector(Target.boom.selector));

        // the call counter was NOT consumed by the failure
        (SessionPolicy.Session memory s,) = policy.sessionOf(id);
        assertEq(s.callsUsed, 0);
    }

    // ---------------- revoke ----------------

    function test_revoke_killsSessionImmediately() public {
        bytes32 id = _defaultSession();

        vm.prank(stranger);
        vm.expectRevert(SessionPolicy.NotOwner.selector);
        policy.revokeSession(id);

        vm.prank(owner);
        policy.revokeSession(id);

        vm.prank(sessionKey);
        vm.expectRevert(SessionPolicy.SessionInactive.selector);
        policy.execute(id, address(target), _calldata(1));

        vm.prank(sessionKey);
        vm.expectRevert(SessionPolicy.SessionInactive.selector);
        policy.spend(id, payee, 1e6);
    }

    function test_revoke_unknownSessionReverts() public {
        vm.expectRevert(SessionPolicy.UnknownSession.selector);
        policy.revokeSession(keccak256("nope"));
    }

    // ---------------- spend ----------------

    function test_spend_staysInsideCap() public {
        bytes32 id = _create(5, uint64(block.timestamp), uint64(block.timestamp + 1 days), 100e6);

        vm.prank(sessionKey);
        policy.spend(id, payee, 40e6);
        assertEq(token.balanceOf(payee), 40e6);

        vm.prank(sessionKey);
        policy.spend(id, payee, 60e6);
        assertEq(token.balanceOf(payee), 100e6);

        // cap reached: one unit more reverts
        vm.prank(sessionKey);
        vm.expectRevert(SessionPolicy.SpendCapExceeded.selector);
        policy.spend(id, payee, 1);
    }

    function test_spend_countsTowardCallLimit() public {
        bytes32 id = _create(1, uint64(block.timestamp), uint64(block.timestamp + 1 days), 100e6);

        vm.startPrank(sessionKey);
        policy.spend(id, payee, 1e6);
        vm.expectRevert(SessionPolicy.CallLimitReached.selector);
        policy.spend(id, payee, 1e6);
        vm.stopPrank();
    }

    function test_spend_onlyDelegateAndOnlyOneOwnerWallet() public {
        bytes32 id = _defaultSession();

        vm.prank(stranger);
        vm.expectRevert(SessionPolicy.NotDelegate.selector);
        policy.spend(id, payee, 1e6);

        // session key cannot move another wallet's funds: allowance is the owner's only
        vm.prank(sessionKey);
        policy.spend(id, payee, 1e6);
        assertEq(token.balanceOf(owner), 1_000e6 - 1e6);
    }

    function test_spend_zeroCapMeansSpendingDisabled() public {
        bytes32 id = _create(5, uint64(block.timestamp), uint64(block.timestamp + 1 days), 0);

        vm.prank(sessionKey);
        vm.expectRevert(SessionPolicy.SpendCapExceeded.selector);
        policy.spend(id, payee, 1e6);
    }

    // ---------------- unknown ----------------

    function test_unknownSessionRevertsEverywhere() public {
        bytes32 id = keccak256("nope");
        vm.expectRevert(SessionPolicy.UnknownSession.selector);
        policy.sessionOf(id);

        vm.prank(sessionKey);
        vm.expectRevert(SessionPolicy.UnknownSession.selector);
        policy.execute(id, address(target), _calldata(1));
    }
}
