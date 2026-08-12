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

        // The owner's whole job is to be the recovery path when the operator key leaks: it rotates
        // the operator and receives forfeited tokens. One address in both roles has no such path --
        // the key that was stolen is the key that would have to fix it -- so this is refused at
        // deploy time rather than left as a line in the runbook.
        require(owner != operator, "owner and operator must differ");

        vm.startBroadcast();
        escrow = new JBProcessorEscrow(owner, operator, IERC20(BASE_USDC));
        vm.stopBroadcast();

        console2.log("JBProcessorEscrow deployed:", address(escrow));
        console2.log("  owner:   ", owner);
        console2.log("  operator:", operator);
        console2.log("  USDC:    ", BASE_USDC);
    }
}
