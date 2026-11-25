// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Escrow} from "../src/Escrow.sol";
import {MockUSD8} from "../src/mocks/MockUSD8.sol";

/// @notice Deploys Escrow.
///   - Aevum testnet and `make fork`: uses the real tUSD8.
///   - `make anvil` (chain 31337) only: deploys MockUSD8 first.
///   RESPONSE_WINDOW (optional env, seconds) is the buyer's window to act after the seller
///   files proof. Defaults to 600s (10 minutes) so timeout scenarios can be demonstrated
///   live on testnet; production value would be 24 hours.
///
///   forge script script/DeployEscrow.s.sol --rpc-url https://rpc-test.qday.info \
///     --broadcast --legacy --account <keystore-name>
contract DeployEscrow is Script {
    address constant AEVUM_TUSD8 = 0x456569838f1d43009A91ebA4263147Afd7233483;
    uint256 constant ANVIL_CHAIN = 31337;
    uint64 constant DEFAULT_WINDOW = 600;

    function run() external returns (Escrow escrow, address token) {
        uint64 window = uint64(vm.envOr("RESPONSE_WINDOW", DEFAULT_WINDOW));

        vm.startBroadcast();
        if (AEVUM_TUSD8.code.length > 0) {
            token = AEVUM_TUSD8;
        } else {
            require(block.chainid == ANVIL_CHAIN, "tUSD8 not found on this chain. Check the RPC (Aevum testnet is 44005).");
            token = address(new MockUSD8());
        }
        escrow = new Escrow(IERC20(token), window);
        vm.stopBroadcast();

        console.log("chainId  ", block.chainid);
        console.log("token    ", token);
        console.log("Escrow   ", address(escrow));
        console.log("window   ", uint256(window), "seconds");
    }
}
