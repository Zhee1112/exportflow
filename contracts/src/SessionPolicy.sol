// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title SessionPolicy
/// @notice Scoped session keys for ExportFlow: the owner grants a hot key (frontend/backend
///         agent) the right to perform a narrow, bounded set of actions without exposing the
///         main wallet. Every session carries a call limit, a target+selector allowlist, an
///         expiry, and an optional stablecoin spend cap; the owner can revoke instantly.
/// @dev Aevum testnet has no supported bundler/paymaster (challenge FAQ), so this contract IS
///      the session-key layer: it sits between the session key and the target contracts.
///      Checks-effects-interactions + `nonReentrant` on `execute`; state is bumped before the
///      external call, and failed calls revert the whole transaction (the counter is undone).
contract SessionPolicy is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Session {
        address delegate; // slot 1 (20) + start(6) + active(1) = 27 bytes
        uint64 validAfter;
        bool active; // false = revoked
        uint64 validUntil; // slot 2 (8)
        uint32 maxCalls;
        uint32 callsUsed;
        uint96 spendCap; // slot 3 (12)
        uint96 spent;
        IERC20 spendToken; // slot 4 (20)
    }

    // allowlists live outside the packed struct: keccak256(sessionId, value) keys
    mapping(bytes32 sessionId => Session) private _sessions;
    mapping(bytes32 sessionId => mapping(address value => bool)) private _targets;
    mapping(bytes32 sessionId => mapping(bytes4 value => bool)) private _selectors;
    mapping(bytes32 sessionId => address owner) public ownerOf;

    uint256 public sessionCount;
    mapping(address owner => uint256 nonce) private _nonces;

    event SessionCreated(
        bytes32 indexed sessionId,
        address indexed owner,
        address indexed delegate,
        uint32 maxCalls,
        uint64 validUntil,
        uint96 spendCap
    );
    event Executed(bytes32 indexed sessionId, address indexed target, bytes4 selector, bool success);
    event Spent(bytes32 indexed sessionId, address indexed to, uint96 amount, uint96 spentTotal);
    event SessionRevoked(bytes32 indexed sessionId, address indexed by);

    error UnknownSession();
    error NotOwner();
    error NotDelegate();
    error SessionInactive();
    error SessionNotStarted();
    error SessionExpired();
    error CallLimitReached();
    error TargetNotAllowed();
    error SelectorNotAllowed();
    error SpendCapExceeded();
    error WrongToken();
    error ZeroAddress();
    error CallFailed();
    error EmptyAllowlist();

    // ---------------------------------------------------------------- create

    /// @notice Grant a session key. The session id is derived from the owner's nonce so it
    ///         can never collide with another owner's session.
    function createSession(
        address delegate,
        address[] calldata targets,
        bytes4[] calldata selectors,
        uint32 maxCalls,
        uint64 validAfter,
        uint64 validUntil,
        IERC20 spendToken,
        uint96 spendCap
    ) external returns (bytes32 sessionId) {
        if (delegate == address(0)) revert ZeroAddress();
        if (targets.length == 0 || selectors.length == 0) revert EmptyAllowlist();
        if (validUntil <= validAfter) revert SessionExpired();

        sessionId = keccak256(abi.encode(msg.sender, _nonces[msg.sender]++));
        unchecked {
            ++sessionCount;
        }

        Session storage s = _sessions[sessionId];
        s.delegate = delegate;
        s.validAfter = validAfter;
        s.active = true;
        s.validUntil = validUntil;
        s.maxCalls = maxCalls;
        s.spendCap = spendCap;
        s.spendToken = spendToken;
        ownerOf[sessionId] = msg.sender;

        for (uint256 i; i < targets.length;) {
            _targets[sessionId][targets[i]] = true;
            unchecked {
                ++i;
            }
        }
        for (uint256 i; i < selectors.length;) {
            _selectors[sessionId][selectors[i]] = true;
            unchecked {
                ++i;
            }
        }

        emit SessionCreated(sessionId, msg.sender, delegate, maxCalls, validUntil, spendCap);
    }

    // ---------------------------------------------------------------- execute

    /// @notice The session key runs an allowlisted call (e.g. submitEvidence on the escrow).
    function execute(bytes32 sessionId, address target, bytes calldata data)
        external
        nonReentrant
        returns (bytes memory result)
    {
        Session storage s = _session(sessionId, msg.sender);
        if (data.length < 4) revert SelectorNotAllowed();
        if (!_targets[sessionId][target]) revert TargetNotAllowed();
        bytes4 sel;
        assembly {
            sel := and(calldataload(data.offset), 0xffffffff00000000000000000000000000000000000000000000000000000000)
        }
        if (!_selectors[sessionId][sel]) revert SelectorNotAllowed();
        if (s.callsUsed >= s.maxCalls) revert CallLimitReached();

        s.callsUsed += 1; // effect first: a reentering call sees the bumped counter

        (bool ok, bytes memory ret) = target.call(data);
        emit Executed(sessionId, target, sel, ok);
        if (!ok) revert CallFailed();
        return ret;
    }

    /// @notice The session key spends owner stablecoin inside a per-session cumulative cap
    ///         (e.g. auto-releasing a milestone without opening the main wallet).
    function spend(bytes32 sessionId, address to, uint96 amount) external nonReentrant {
        Session storage s = _session(sessionId, msg.sender);
        if (address(s.spendToken) == address(0)) revert WrongToken();
        if (to == address(0)) revert ZeroAddress();
        if (s.callsUsed >= s.maxCalls) revert CallLimitReached();

        uint96 newSpent = s.spent + amount;
        if (newSpent > s.spendCap) revert SpendCapExceeded();
        uint32 used = s.callsUsed + 1;

        s.spent = newSpent;
        s.callsUsed = used;

        s.spendToken.safeTransferFrom(ownerOf[sessionId], to, amount);
        emit Spent(sessionId, to, amount, newSpent);
    }

    // ---------------------------------------------------------------- manage

    /// @notice The owner kills a session immediately (lost laptop, suspicious agent, done).
    function revokeSession(bytes32 sessionId) external {
        if (ownerOf[sessionId] == address(0)) revert UnknownSession();
        if (msg.sender != ownerOf[sessionId]) revert NotOwner();
        _sessions[sessionId].active = false;
        emit SessionRevoked(sessionId, msg.sender);
    }

    // ---------------------------------------------------------------- views

    function sessionOf(bytes32 sessionId) external view returns (Session memory, address owner) {
        if (ownerOf[sessionId] == address(0)) revert UnknownSession();
        return (_sessions[sessionId], ownerOf[sessionId]);
    }

    function isAllowed(bytes32 sessionId, address target, bytes4 selector) external view returns (bool) {
        return _targets[sessionId][target] && _selectors[sessionId][selector];
    }

    // ---------------------------------------------------------------- internal

    function _session(bytes32 sessionId, address caller) private view returns (Session storage s) {
        address owner = ownerOf[sessionId];
        if (owner == address(0)) revert UnknownSession();
        s = _sessions[sessionId];
        if (s.delegate != caller) revert NotDelegate();
        if (!s.active) revert SessionInactive();
        if (block.timestamp < s.validAfter) revert SessionNotStarted();
        if (block.timestamp > s.validUntil) revert SessionExpired();
    }
}
