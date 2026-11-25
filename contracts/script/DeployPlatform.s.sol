// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {SessionPolicy} from "../src/SessionPolicy.sol";
import {DocRegistry} from "../src/DocRegistry.sol";

/// @notice Deploys the ExportFlow platform contracts (Escrow is deployed separately by
///         DeployEscrow.s.sol so its response window can be set per environment).
///
///   forge script script/DeployPlatform.s.sol --rpc-url https://rpc-test.qday.info \
///     --broadcast --legacy --account <keystore-name>
contract DeployPlatform is Script {
    function run() external returns (SessionPolicy policy, DocRegistry registry) {
        vm.startBroadcast();
        policy = new SessionPolicy();
        registry = new DocRegistry();
        vm.stopBroadcast();

        console.log("chainId        ", block.chainid);
        console.log("SessionPolicy  ", address(policy));
        console.log("DocRegistry    ", address(registry));
    }
}
