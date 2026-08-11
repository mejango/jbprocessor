// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {JBProcessorEscrow} from "../src/JBProcessorEscrow.sol";

/// @notice Deploys `JBProcessorEscrow`.
/// Required env vars:
///  - OWNER: the treasury/Safe that receives forfeited entries and can rotate the operator.
///  - OPERATOR: the worker EOA that's allowed to process payments, redirect beneficiaries, and forfeit.
/// Base mainnet USDC is hardcoded; deploying to another chain requires a different script or an
/// added env var.
contract DeployScript is Script {
    address constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    function run() public returns (JBProcessorEscrow escrow) {
        address owner = vm.envAddress("OWNER");
        address operator = vm.envAddress("OPERATOR");

        vm.startBroadcast();
        escrow = new JBProcessorEscrow(owner, operator, IERC20(BASE_USDC));
        vm.stopBroadcast();

        console2.log("JBProcessorEscrow deployed:", address(escrow));
        console2.log("  owner:   ", owner);
        console2.log("  operator:", operator);
        console2.log("  USDC:    ", BASE_USDC);
    }
}
