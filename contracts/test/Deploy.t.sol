// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";

import {JBProcessorEscrow} from "../src/JBProcessorEscrow.sol";
import {DeployScript} from "../script/Deploy.s.sol";

/// @notice The deploy script is the only place the owner/operator split is chosen, and the split is
/// the escrow's entire recovery story. So it gets a test.
contract DeployScriptTest is Test {
    DeployScript script;

    address owner = makeAddr("owner");
    address operator = makeAddr("operator");

    function setUp() public {
        script = new DeployScript();
    }

    /// @dev Both cases in one function on purpose: `vm.setEnv` writes the process environment, and
    /// forge runs a contract's test functions in parallel -- split in two, each would race the
    /// other's OWNER/OPERATOR and fail at random.
    function test_run_deploysWithDistinctRolesAndRefusesOneAddressInBoth() public {
        vm.setEnv("OWNER", vm.toString(owner));
        vm.setEnv("OPERATOR", vm.toString(operator));

        JBProcessorEscrow escrow = script.run();

        assertEq(escrow.owner(), owner);
        assertEq(escrow.operator(), operator);
        assertEq(address(escrow.USDC()), 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);

        vm.setEnv("OPERATOR", vm.toString(owner));

        vm.expectRevert("owner and operator must differ");
        script.run();
    }
}
