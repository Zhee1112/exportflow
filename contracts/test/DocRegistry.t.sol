// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DocRegistry} from "../src/DocRegistry.sol";

contract DocRegistryTest is Test {
    DocRegistry registry;
    address registrar = makeAddr("registrar");
    address umkm = makeAddr("umkm");

    bytes32 constant DOC = keccak256("purchase-order-2026-001");

    function setUp() public {
        registry = new DocRegistry();
    }

    function test_register_recordsHashAttributionAndTime() public {
        vm.expectEmit(true, true, true, true, address(registry));
        emit DocRegistry.DocRegistered(DOC, registrar, umkm);
        vm.prank(registrar);
        registry.register(DOC, umkm);

        (bool exists, address by, uint64 at, bool claimed) = registry.verify(DOC);
        assertTrue(exists);
        assertEq(by, registrar);
        assertEq(at, block.timestamp);
        assertFalse(claimed);
        assertEq(registry.ownerOf(DOC), umkm);
    }

    function test_register_rejectsDuplicatesAndZeroHash() public {
        vm.startPrank(registrar);
        registry.register(DOC, umkm);
        vm.expectRevert(DocRegistry.AlreadyRegistered.selector);
        registry.register(DOC, umkm);

        vm.expectRevert(DocRegistry.ZeroHash.selector);
        registry.register(bytes32(0), umkm);
        vm.stopPrank();
    }

    function test_claim_onlyDeclaredOwnerAndOnlyOnce() public {
        vm.prank(registrar);
        registry.register(DOC, umkm);

        vm.prank(registrar);
        vm.expectRevert(DocRegistry.NotOwner.selector);
        registry.claim(DOC);

        vm.prank(umkm);
        registry.claim(DOC);

        (,,, bool claimed) = registry.verify(DOC);
        assertTrue(claimed);
    }

    function test_claim_unknownDocReverts() public {
        vm.expectRevert(DocRegistry.UnknownDoc.selector);
        registry.claim(keccak256("never-registered"));
    }

    function test_verify_unknownDocIsAbsent() public {
        (bool exists,,,) = registry.verify(keccak256("ghost"));
        assertFalse(exists);
    }
}
