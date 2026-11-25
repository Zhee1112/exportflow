// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC3009} from "./IERC3009.sol";

/// @title Escrow
/// @notice Milestone escrow for cross-border trade (ExportFlow). The buyer locks stablecoin;
///         funds release per milestone on buyer approval, on seller proof plus a response
///         window, or by arbiter decision after a dispute.
/// @dev Gas notes (Aevum = Shanghai EVM, ~1 gwei):
///      - `Deal` packs into 3 storage slots + the array length slot; `Milestone` into 2
///        (1 until proof is filed — `evidence` is written lazily).
///      - `token` and `responseWindow` are immutable (read from code, not storage).
///      - custom errors, `calldata` inputs, `unchecked` loop increments.
///      - money-moving functions are `nonReentrant` and follow checks-effects-interactions;
///        read-only paths (filing proof, views) pay no guard slot.
///      - EIP-1153 transient-storage locks are NOT used: Aevum runs Shanghai, not Cancun.
///      - The buyer can fund with one EIP-3009 signature (no native gas for the buyer).
contract Escrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum State {
        None, // escrowId unused
        Created, // milestones set, waiting for the buyer to fund
        Funded, // tokens locked, milestones in progress
        Disputed, // locked for the arbiter
        Completed, // every token disbursed
        Refunded, // deadline passed with no progress: everything back to the buyer
        Cancelled // buyer cancelled before funding
    }

    struct Milestone {
        // slot 1 (30 of 32 bytes)
        uint96 amount;
        uint64 deadline;
        uint64 evidenceAt; // 0 = the seller has not filed proof yet
        bool approved;
        bool released;
        // slot 2, written lazily on submitEvidence
        bytes32 evidence;
    }

    struct Deal {
        address buyer; // slot 1 (29 of 32 bytes)
        State state;
        uint64 createdAt;
        address seller; // slot 2 (32 bytes)
        uint96 totalReleased;
        address arbiter; // slot 3 (32 bytes)
        uint96 total;
        Milestone[] milestones; // slot 4 = length; elements at keccak256(slot4)+i
    }

    struct MilestoneInput {
        uint96 amount;
        uint64 deadline;
    }

    IERC20 public immutable token;
    /// @notice How long the buyer gets to act after the seller files proof before the
    ///         seller may claim that milestone unilaterally. Set once per deployment.
    uint64 public immutable responseWindow;

    uint256 public constant MAX_MILESTONES = 64;

    mapping(bytes32 escrowId => Deal) private _deals;

    event Created(
        bytes32 indexed escrowId,
        address indexed buyer,
        address indexed seller,
        address arbiter,
        uint96 total,
        uint64 deadline
    );
    event Funded(bytes32 indexed escrowId, uint96 total);
    event EvidenceFiled(bytes32 indexed escrowId, uint256 indexed index, bytes32 evidence);
    event MilestoneReleased(bytes32 indexed escrowId, uint256 indexed index, uint96 amount, bool byBuyer);
    event Refunded(bytes32 indexed escrowId, uint96 amount);
    event DisputeRaised(bytes32 indexed escrowId, address indexed by, string reason);
    event DisputeResolved(bytes32 indexed escrowId, uint96 toSeller, uint96 toBuyer);
    event Cancelled(bytes32 indexed escrowId);

    error UnknownEscrow();
    error IdAlreadyUsed();
    error WrongState(State expected, State actual);
    error NotBuyer();
    error NotSeller();
    error NotArbiter();
    error NotParty();
    error ZeroAddress();
    error SameAddress();
    error EmptyMilestones();
    error TooManyMilestones();
    error ZeroAmount();
    error DeadlineInPast();
    error TotalTooLarge();
    error IndexOutOfBounds();
    error AlreadyReleased();
    error EvidenceRequired();
    error EvidenceAlreadyFiled();
    error ZeroEvidence();
    error ResponseWindowOpen();
    error DeadlineNotPassed();
    error NotRefundable();
    error AmountTooLarge();

    constructor(IERC20 token_, uint64 responseWindow_) {
        if (address(token_) == address(0)) revert ZeroAddress();
        if (responseWindow_ == 0) revert ZeroAddress();
        token = token_;
        responseWindow = responseWindow_;
    }

    // ---------------------------------------------------------------- create

    /// @notice Register a deal. `total` is computed here from the milestone amounts, so the
    ///         locked sum and the release sum can never disagree.
    function create(bytes32 escrowId, address seller, address arbiter, MilestoneInput[] calldata milestones)
        external
    {
        if (_deals[escrowId].state != State.None) revert IdAlreadyUsed();
        if (seller == address(0) || arbiter == address(0)) revert ZeroAddress();
        if (seller == msg.sender || arbiter == msg.sender || seller == arbiter) revert SameAddress();

        uint256 n = milestones.length;
        if (n == 0) revert EmptyMilestones();
        if (n > MAX_MILESTONES) revert TooManyMilestones();

        Deal storage d = _deals[escrowId];
        d.buyer = msg.sender;
        d.seller = seller;
        d.arbiter = arbiter;
        d.state = State.Created;
        d.createdAt = uint64(block.timestamp);

        uint256 total;
        uint64 latest;
        Milestone[] storage ms = d.milestones;
        for (uint256 i; i < n;) {
            MilestoneInput calldata mi = milestones[i];
            if (mi.amount == 0) revert ZeroAmount();
            if (mi.deadline <= block.timestamp) revert DeadlineInPast();
            if (mi.deadline > latest) latest = mi.deadline;
            total += mi.amount;
            // push() only grows the length slot; element slots are still zero in storage, so
            // assign just the two fields we need and leave evidenceAt/approved/released/
            // evidence at their defaults (no zero-writes, ~2.2k gas saved per milestone).
            ms.push();
            Milestone storage m = ms[i];
            m.amount = mi.amount;
            m.deadline = mi.deadline;
            unchecked {
                ++i;
            }
        }
        if (total > type(uint96).max) revert TotalTooLarge();
        d.total = uint96(total);

        emit Created(escrowId, msg.sender, seller, arbiter, uint96(total), latest);
    }

    // ---------------------------------------------------------------- funding

    /// @notice Lock the full escrow value. The buyer approves this contract first, then calls.
    function fund(bytes32 escrowId) external nonReentrant {
        Deal storage d = _deal(escrowId);
        if (d.state != State.Created) revert WrongState(State.Created, d.state);
        if (msg.sender != d.buyer) revert NotBuyer();

        d.state = State.Funded; // effects before interaction
        uint96 total = d.total;
        token.safeTransferFrom(d.buyer, address(this), total);
        emit Funded(escrowId, total);
    }

    /// @notice Gasless funding: the buyer signs EIP-3009 off-chain, anyone may relay it.
    /// @dev The signed nonce binds the signature to this contract and this escrow, so it can
    ///      be neither replayed on another escrow nor on another deployment.
    function fundWithAuthorization(bytes32 escrowId, uint256 validAfter, uint256 validBefore, uint8 v, bytes32 r, bytes32 s)
        external
        nonReentrant
    {
        Deal storage d = _deal(escrowId);
        if (d.state != State.Created) revert WrongState(State.Created, d.state);

        d.state = State.Funded;
        uint96 total = d.total;
        IERC3009(address(token)).receiveWithAuthorization(
            d.buyer, address(this), total, validAfter, validBefore, authorizationNonce(escrowId), v, r, s
        );
        emit Funded(escrowId, total);
    }

    /// @notice The EIP-3009 nonce the buyer must sign to fund `escrowId` through this contract.
    function authorizationNonce(bytes32 escrowId) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), escrowId));
    }

    // ---------------------------------------------------------------- milestones

    /// @notice The seller files proof of progress (hash of the document off-chain).
    function submitEvidence(bytes32 escrowId, uint256 index, bytes32 evidence) external {
        Deal storage d = _deal(escrowId);
        if (d.state != State.Funded) revert WrongState(State.Funded, d.state);
        if (msg.sender != d.seller) revert NotSeller();
        if (evidence == bytes32(0)) revert ZeroEvidence();

        Milestone storage m = _milestone(d, index);
        if (m.released) revert AlreadyReleased();
        if (m.evidence != bytes32(0)) revert EvidenceAlreadyFiled();

        m.evidence = evidence;
        m.evidenceAt = uint64(block.timestamp);
        emit EvidenceFiled(escrowId, index, evidence);
    }

    /// @notice The buyer approves a milestone: it releases to the seller immediately.
    function approveMilestone(bytes32 escrowId, uint256 index) external nonReentrant {
        Deal storage d = _deal(escrowId);
        if (d.state != State.Funded) revert WrongState(State.Funded, d.state);
        if (msg.sender != d.buyer) revert NotBuyer();

        Milestone storage m = _milestone(d, index);
        if (m.released) revert AlreadyReleased();

        m.approved = true;
        m.released = true;
        _disburse(d, escrowId, index, m.amount, true);
    }

    /// @notice The seller claims a milestone after filing proof and waiting out the buyer's
    ///         response window — a silent buyer cannot block payment forever.
    function claimAfterDeadline(bytes32 escrowId, uint256 index) external nonReentrant {
        Deal storage d = _deal(escrowId);
        if (d.state != State.Funded) revert WrongState(State.Funded, d.state);
        if (msg.sender != d.seller) revert NotSeller();

        Milestone storage m = _milestone(d, index);
        if (m.released) revert AlreadyReleased();
        if (m.evidence == bytes32(0)) revert EvidenceRequired();
        if (block.timestamp < uint256(m.evidenceAt) + responseWindow) revert ResponseWindowOpen();

        m.released = true;
        _disburse(d, escrowId, index, m.amount, false);
    }

    // ---------------------------------------------------------------- refund / dispute

    /// @notice If the deadline passed with no proof filed and nothing released, anyone may
    ///         return the funds to the buyer so the escrow cannot stay locked forever.
    function refund(bytes32 escrowId) external nonReentrant {
        Deal storage d = _deal(escrowId);
        if (d.state != State.Funded) revert WrongState(State.Funded, d.state);
        if (d.totalReleased != 0) revert NotRefundable();

        uint64 latest;
        Milestone[] storage ms = d.milestones;
        uint256 n = ms.length;
        for (uint256 i; i < n;) {
            Milestone storage m = ms[i];
            if (m.evidence != bytes32(0)) revert NotRefundable(); // proof exists: the claim path owns it
            if (m.deadline > latest) latest = m.deadline;
            unchecked {
                ++i;
            }
        }
        if (block.timestamp <= latest) revert DeadlineNotPassed();

        d.state = State.Refunded;
        uint96 total = d.total;
        token.safeTransfer(d.buyer, total);
        emit Refunded(escrowId, total);
    }

    /// @notice Either party freezes the escrow and hands it to the arbiter.
    function raiseDispute(bytes32 escrowId, string calldata reason) external {
        Deal storage d = _deal(escrowId);
        if (d.state != State.Funded) revert WrongState(State.Funded, d.state);
        if (msg.sender != d.buyer && msg.sender != d.seller) revert NotParty();

        d.state = State.Disputed;
        emit DisputeRaised(escrowId, msg.sender, reason);
    }

    /// @notice The arbiter splits whatever has not been released yet between the parties.
    function resolveDispute(bytes32 escrowId, uint96 toSeller) external nonReentrant {
        Deal storage d = _deal(escrowId);
        if (d.state != State.Disputed) revert WrongState(State.Disputed, d.state);
        if (msg.sender != d.arbiter) revert NotArbiter();

        uint96 unreleased = d.total - d.totalReleased;
        if (toSeller > unreleased) revert AmountTooLarge();
        uint96 toBuyer = unreleased - toSeller;

        uint96 released = d.totalReleased + toSeller;
        d.totalReleased = released;
        d.state = released == 0 ? State.Refunded : State.Completed;

        if (toSeller > 0) token.safeTransfer(d.seller, toSeller);
        if (toBuyer > 0) token.safeTransfer(d.buyer, toBuyer);
        emit DisputeResolved(escrowId, toSeller, toBuyer);
    }

    /// @notice The buyer drops a deal that was never funded.
    function cancel(bytes32 escrowId) external {
        Deal storage d = _deal(escrowId);
        if (d.state != State.Created) revert WrongState(State.Created, d.state);
        if (msg.sender != d.buyer) revert NotBuyer();

        d.state = State.Cancelled;
        emit Cancelled(escrowId);
    }

    // ---------------------------------------------------------------- views

    function dealOf(bytes32 escrowId) external view returns (Deal memory) {
        return _deals[escrowId];
    }

    function milestoneOf(bytes32 escrowId, uint256 index) external view returns (Milestone memory) {
        return _milestone(_deal(escrowId), index);
    }

    // ---------------------------------------------------------------- internal

    function _deal(bytes32 escrowId) private view returns (Deal storage d) {
        d = _deals[escrowId];
        if (d.state == State.None) revert UnknownEscrow();
    }

    function _milestone(Deal storage d, uint256 index) private view returns (Milestone storage m) {
        if (index >= d.milestones.length) revert IndexOutOfBounds();
        m = d.milestones[index];
    }

    /// @dev Effects first, then the single transfer; called only by nonReentrant functions.
    function _disburse(Deal storage d, bytes32 escrowId, uint256 index, uint96 amount, bool byBuyer) private {
        uint96 released = d.totalReleased + amount;
        d.totalReleased = released;
        if (released == d.total) d.state = State.Completed;
        token.safeTransfer(d.seller, amount);
        emit MilestoneReleased(escrowId, index, amount, byBuyer);
    }
}
