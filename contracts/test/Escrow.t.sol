// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Escrow} from "../src/Escrow.sol";
import {MockUSD8} from "../src/mocks/MockUSD8.sol";
import {Signing} from "./Signing.sol";

contract EscrowTest is Test {
    MockUSD8 token;
    Escrow escrow;
    address buyer;
    uint256 buyerKey;
    address seller = makeAddr("seller");
    address arbiter = makeAddr("arbiter");
    address stranger = makeAddr("stranger");

    bytes32 constant ID = keccak256("deal-1");
    uint96 constant M1 = 600e6;
    uint96 constant M2 = 800e6;
    uint96 constant M3 = 600e6;
    uint96 constant TOTAL = 2000e6;
    uint64 constant WINDOW = 1 days;

    function setUp() public {
        (buyer, buyerKey) = makeAddrAndKey("buyer");
        token = new MockUSD8();
        escrow = new Escrow(IERC20(address(token)), WINDOW);
        token.mint(buyer, 10_000e6);
        vm.prank(buyer);
        token.approve(address(escrow), type(uint256).max);
    }

    function _milestones() internal view returns (Escrow.MilestoneInput[] memory arr) {
        arr = new Escrow.MilestoneInput[](3);
        arr[0] = Escrow.MilestoneInput(M1, uint64(block.timestamp + 1 days));
        arr[1] = Escrow.MilestoneInput(M2, uint64(block.timestamp + 2 days));
        arr[2] = Escrow.MilestoneInput(M3, uint64(block.timestamp + 3 days));
    }

    function _create() internal {
        vm.prank(buyer);
        escrow.create(ID, seller, arbiter, _milestones());
    }

    function _createAndFund() internal {
        _create();
        vm.prank(buyer);
        escrow.fund(ID);
    }

    function _latestDeadline() internal view returns (uint64) {
        return uint64(block.timestamp + 3 days);
    }

    // ---------------- create ----------------

    function test_create_storesDealAndMilestones() public {
        vm.expectEmit(true, true, true, true, address(escrow));
        emit Escrow.Created(ID, buyer, seller, arbiter, TOTAL, _latestDeadline());
        vm.prank(buyer);
        escrow.create(ID, seller, arbiter, _milestones());

        Escrow.Deal memory d = escrow.dealOf(ID);
        assertEq(d.buyer, buyer);
        assertEq(d.seller, seller);
        assertEq(d.arbiter, arbiter);
        assertEq(uint8(d.state), uint8(Escrow.State.Created));
        assertEq(d.total, TOTAL);
        assertEq(d.totalReleased, 0);
        assertEq(d.milestones.length, 3);

        Escrow.Milestone memory m0 = escrow.milestoneOf(ID, 0);
        assertEq(m0.amount, M1);
        assertEq(m0.deadline, block.timestamp + 1 days);
        assertEq(m0.evidence, bytes32(0));
        assertFalse(m0.approved);
        assertFalse(m0.released);
    }

    function test_create_revertsOnBadInputs() public {
        _create();
        // duplicate id
        vm.expectRevert(Escrow.IdAlreadyUsed.selector);
        escrow.create(ID, seller, arbiter, _milestones());

        bytes32 id2 = keccak256("deal-2");
        // seller is the buyer
        vm.prank(buyer);
        vm.expectRevert(Escrow.SameAddress.selector);
        escrow.create(id2, buyer, arbiter, _milestones());

        // arbiter is the seller
        vm.expectRevert(Escrow.SameAddress.selector);
        escrow.create(id2, seller, seller, _milestones());

        // zero address
        vm.expectRevert(Escrow.ZeroAddress.selector);
        escrow.create(id2, address(0), arbiter, _milestones());

        // empty milestones
        vm.expectRevert(Escrow.EmptyMilestones.selector);
        escrow.create(id2, seller, arbiter, new Escrow.MilestoneInput[](0));

        // zero amount
        Escrow.MilestoneInput[] memory bad = new Escrow.MilestoneInput[](1);
        bad[0] = Escrow.MilestoneInput(0, uint64(block.timestamp + 1 days));
        vm.expectRevert(Escrow.ZeroAmount.selector);
        escrow.create(id2, seller, arbiter, bad);

        // deadline in the past
        bad[0] = Escrow.MilestoneInput(M1, uint64(block.timestamp - 1));
        vm.expectRevert(Escrow.DeadlineInPast.selector);
        escrow.create(id2, seller, arbiter, bad);
    }

    function test_create_unknownEscrowReverts() public {
        vm.expectRevert(Escrow.UnknownEscrow.selector);
        escrow.fund(keccak256("nope"));
    }

    // ---------------- funding ----------------

    function test_fund_locksTotal() public {
        _create();
        vm.prank(buyer);
        escrow.fund(ID);

        assertEq(token.balanceOf(address(escrow)), TOTAL);
        assertEq(token.balanceOf(buyer), 10_000e6 - TOTAL);
        assertEq(uint8(escrow.dealOf(ID).state), uint8(Escrow.State.Funded));
    }

    function test_fund_onlyBuyerAndOnlyOnce() public {
        _create();
        vm.prank(stranger);
        vm.expectRevert(Escrow.NotBuyer.selector);
        escrow.fund(ID);

        vm.prank(buyer);
        escrow.fund(ID);

        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Escrow.WrongState.selector, uint8(Escrow.State.Created), uint8(Escrow.State.Funded)));
        escrow.fund(ID);
    }

    function test_fundWithAuthorization_relayerPaysGasNotBuyer() public {
        _create();
        uint256 validAfter = 0;
        uint256 validBefore = block.timestamp + 1 hours;
        Signing.Auth memory a = Signing.Auth({
            from: buyer,
            to: address(escrow),
            value: TOTAL,
            validAfter: validAfter,
            validBefore: validBefore,
            nonce: escrow.authorizationNonce(ID)
        });
        (uint8 v, bytes32 r, bytes32 s) = Signing.signReceive(vm, buyerKey, token.DOMAIN_SEPARATOR(), a);

        // anyone (the relayer) submits; the buyer spends no tokens and signs nothing on-chain
        vm.prank(stranger);
        escrow.fundWithAuthorization(ID, validAfter, validBefore, v, r, s);

        assertEq(token.balanceOf(address(escrow)), TOTAL);
        assertEq(token.balanceOf(buyer), 10_000e6 - TOTAL);
        assertEq(uint8(escrow.dealOf(ID).state), uint8(Escrow.State.Funded));
        assertTrue(token.authorizationState(buyer, escrow.authorizationNonce(ID)));
    }

    function test_fundWithAuthorization_signatureBoundToEscrow() public {
        _create();
        bytes32 id2 = keccak256("deal-2");
        escrow.create(id2, seller, arbiter, _milestones());

        uint256 validBefore = block.timestamp + 1 hours;
        // signed for ID…
        Signing.Auth memory a = Signing.Auth({
            from: buyer,
            to: address(escrow),
            value: TOTAL,
            validAfter: 0,
            validBefore: validBefore,
            nonce: escrow.authorizationNonce(ID)
        });
        (uint8 v, bytes32 r, bytes32 s) = Signing.signReceive(vm, buyerKey, token.DOMAIN_SEPARATOR(), a);

        // …but relayed against id2: the nonce differs, so the token recovers a different signer
        vm.expectRevert(MockUSD8.InvalidSignature.selector);
        escrow.fundWithAuthorization(id2, 0, validBefore, v, r, s);
    }

    // ---------------- milestones ----------------

    function test_approveMilestone_releasesToSellerAndCompletes() public {
        _createAndFund();

        vm.prank(buyer);
        escrow.approveMilestone(ID, 0);
        assertEq(token.balanceOf(seller), M1);
        assertEq(token.balanceOf(address(escrow)), TOTAL - M1);
        assertEq(uint8(escrow.dealOf(ID).state), uint8(Escrow.State.Funded));
        assertTrue(escrow.milestoneOf(ID, 0).released);

        vm.startPrank(buyer);
        escrow.approveMilestone(ID, 1);
        escrow.approveMilestone(ID, 2);
        vm.stopPrank();

        assertEq(token.balanceOf(seller), TOTAL);
        assertEq(token.balanceOf(address(escrow)), 0);
        assertEq(uint8(escrow.dealOf(ID).state), uint8(Escrow.State.Completed));
    }

    function test_approveMilestone_onlyBuyerAndNotTwice() public {
        _createAndFund();

        vm.prank(seller);
        vm.expectRevert(Escrow.NotBuyer.selector);
        escrow.approveMilestone(ID, 0);

        vm.prank(buyer);
        escrow.approveMilestone(ID, 0);

        vm.prank(buyer);
        vm.expectRevert(Escrow.AlreadyReleased.selector);
        escrow.approveMilestone(ID, 0);

        vm.prank(buyer);
        vm.expectRevert(Escrow.IndexOutOfBounds.selector);
        escrow.approveMilestone(ID, 3);
    }

    function test_submitEvidence_onlySellerAndOnlyOnce() public {
        _createAndFund();
        bytes32 proof = keccak256("bill-of-lading-001");

        vm.prank(buyer);
        vm.expectRevert(Escrow.NotSeller.selector);
        escrow.submitEvidence(ID, 0, proof);

        vm.prank(seller);
        vm.expectRevert(Escrow.ZeroEvidence.selector);
        escrow.submitEvidence(ID, 0, bytes32(0));

        vm.prank(seller);
        escrow.submitEvidence(ID, 0, proof);
        assertEq(escrow.milestoneOf(ID, 0).evidence, proof);
        assertEq(escrow.milestoneOf(ID, 0).evidenceAt, block.timestamp);

        vm.prank(seller);
        vm.expectRevert(Escrow.EvidenceAlreadyFiled.selector);
        escrow.submitEvidence(ID, 0, keccak256("other"));
    }

    function test_claimAfterDeadline_needsEvidenceAndWindow() public {
        _createAndFund();
        bytes32 proof = keccak256("proof-of-shipment");

        // no evidence yet
        vm.prank(seller);
        vm.expectRevert(Escrow.EvidenceRequired.selector);
        escrow.claimAfterDeadline(ID, 0);

        vm.prank(seller);
        escrow.submitEvidence(ID, 0, proof);

        // window still open
        vm.prank(seller);
        vm.expectRevert(Escrow.ResponseWindowOpen.selector);
        escrow.claimAfterDeadline(ID, 0);

        // window closed: the seller can claim without the buyer
        vm.warp(block.timestamp + WINDOW);
        vm.prank(seller);
        escrow.claimAfterDeadline(ID, 0);
        assertEq(token.balanceOf(seller), M1);

        // only the seller may claim
        vm.prank(stranger);
        vm.expectRevert(Escrow.NotSeller.selector);
        escrow.claimAfterDeadline(ID, 1);
    }

    // ---------------- refund ----------------

    function test_refund_afterDeadlineAnyoneReturnsFundsToBuyer() public {
        _createAndFund();
        vm.warp(_latestDeadline() + 1);

        vm.prank(stranger); // permissionless: the escrow cannot stay locked forever
        escrow.refund(ID);

        assertEq(token.balanceOf(buyer), 10_000e6);
        assertEq(token.balanceOf(address(escrow)), 0);
        assertEq(uint8(escrow.dealOf(ID).state), uint8(Escrow.State.Refunded));
    }

    function test_refund_blockedBeforeDeadline() public {
        _createAndFund();
        vm.prank(stranger);
        vm.expectRevert(Escrow.DeadlineNotPassed.selector);
        escrow.refund(ID);
    }

    function test_refund_blockedWhenEvidenceFiled() public {
        _createAndFund();
        vm.prank(seller);
        escrow.submitEvidence(ID, 1, keccak256("partial-proof"));
        vm.warp(_latestDeadline() + 1);

        // proof exists on milestone 1: the claim path owns it, not the refund path
        vm.expectRevert(Escrow.NotRefundable.selector);
        escrow.refund(ID);
    }

    function test_refund_blockedAfterPartialRelease() public {
        _createAndFund();
        vm.prank(buyer);
        escrow.approveMilestone(ID, 0);
        vm.warp(_latestDeadline() + 1);

        vm.expectRevert(Escrow.NotRefundable.selector);
        escrow.refund(ID);
    }

    // ---------------- dispute ----------------

    function test_dispute_freezesThenArbiterSplits() public {
        _createAndFund();

        vm.prank(stranger);
        vm.expectRevert(Escrow.NotParty.selector);
        escrow.raiseDispute(ID, "not my deal");

        vm.prank(seller);
        escrow.raiseDispute(ID, "cargo arrived damaged");

        // frozen: no more approvals while disputed
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Escrow.WrongState.selector, uint8(Escrow.State.Funded), uint8(Escrow.State.Disputed)));
        escrow.approveMilestone(ID, 0);

        // only the arbiter resolves
        vm.prank(stranger);
        vm.expectRevert(Escrow.NotArbiter.selector);
        escrow.resolveDispute(ID, 0);

        uint96 toSeller = 700e6;
        vm.prank(arbiter);
        escrow.resolveDispute(ID, toSeller);

        assertEq(token.balanceOf(seller), toSeller);
        assertEq(token.balanceOf(buyer), 10_000e6 - TOTAL + (TOTAL - toSeller));
        assertEq(token.balanceOf(address(escrow)), 0);
        assertEq(uint8(escrow.dealOf(ID).state), uint8(Escrow.State.Completed));
    }

    function test_dispute_allToBuyerMeansRefunded() public {
        _createAndFund();
        vm.prank(buyer);
        escrow.raiseDispute(ID, "seller never responded");

        vm.prank(arbiter);
        escrow.resolveDispute(ID, 0);

        assertEq(token.balanceOf(buyer), 10_000e6);
        assertEq(uint8(escrow.dealOf(ID).state), uint8(Escrow.State.Refunded));
    }

    function test_resolveDispute_rejectsMoreThanUnreleased() public {
        _createAndFund();
        vm.prank(buyer);
        escrow.raiseDispute(ID, "x");

        vm.prank(arbiter);
        vm.expectRevert(Escrow.AmountTooLarge.selector);
        escrow.resolveDispute(ID, TOTAL + 1);
    }

    // ---------------- cancel ----------------

    function test_cancel_onlyBuyerAndOnlyBeforeFunding() public {
        _create();

        vm.prank(seller);
        vm.expectRevert(Escrow.NotBuyer.selector);
        escrow.cancel(ID);

        vm.prank(buyer);
        escrow.cancel(ID);
        assertEq(uint8(escrow.dealOf(ID).state), uint8(Escrow.State.Cancelled));

        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Escrow.WrongState.selector, uint8(Escrow.State.Created), uint8(Escrow.State.Cancelled)));
        escrow.cancel(ID);
    }

    function test_cancel_thenCannotFund() public {
        _create();
        vm.prank(buyer);
        escrow.cancel(ID);

        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Escrow.WrongState.selector, uint8(Escrow.State.Created), uint8(Escrow.State.Cancelled)));
        escrow.fund(ID);
    }
}
