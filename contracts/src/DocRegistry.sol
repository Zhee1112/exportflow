// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title DocRegistry
/// @notice Immutable registry of trade-document hashes (PO, invoice, bill of lading, COO).
///         The document itself stays off-chain (privacy, size); the registry proves that a
///         specific bytes32 digest existed at a specific time, attributed to a specific
///         address — the anchor for the AI reader's audit trail.
/// @dev One storage slot per record (packed: by(20) + at(6) + verifiedByOwner(1)) plus a
///      present-flag. Writes are single-slot; no strings on-chain (type lives in the hash
///      prefix off-chain or in the event).
contract DocRegistry {
    struct Record {
        address registeredBy; // slot 1: 20 + 6 + 1 bytes
        uint64 registeredAt;
        bool claimedByOwner; // the declared owner confirmed this hash is theirs
    }

    mapping(bytes32 docHash => Record) private _records;
    mapping(bytes32 docHash => address) public ownerOf;

    event DocRegistered(bytes32 indexed docHash, address indexed registeredBy, address indexed declaredOwner);
    event DocClaimed(bytes32 indexed docHash, address indexed owner);

    error AlreadyRegistered();
    error UnknownDoc();
    error NotOwner();
    error ZeroHash();

    /// @notice Anchor a document digest. `declaredOwner` (the UMKM or its counterparty) is
    ///         recorded so later verification can say who the doc belongs to; anyone may
    ///         register (the buyer's agent and the seller's agent both anchor their copies).
    function register(bytes32 docHash, address declaredOwner) external {
        if (docHash == bytes32(0)) revert ZeroHash();
        if (_records[docHash].registeredAt != 0) revert AlreadyRegistered();

        _records[docHash] = Record({registeredBy: msg.sender, registeredAt: uint64(block.timestamp), claimedByOwner: false});
        if (declaredOwner != address(0)) ownerOf[docHash] = declaredOwner;
        emit DocRegistered(docHash, msg.sender, declaredOwner);
    }

    /// @notice The declared owner confirms the hash — required before disputes may cite it.
    function claim(bytes32 docHash) external {
        Record storage r = _records[docHash];
        if (r.registeredAt == 0) revert UnknownDoc();
        if (ownerOf[docHash] != msg.sender) revert NotOwner();
        r.claimedByOwner = true;
        emit DocClaimed(docHash, msg.sender);
    }

    function verify(bytes32 docHash) external view returns (bool exists, address registeredBy, uint64 registeredAt, bool claimed) {
        Record storage r = _records[docHash];
        return (r.registeredAt != 0, r.registeredBy, r.registeredAt, r.claimedByOwner);
    }
}
