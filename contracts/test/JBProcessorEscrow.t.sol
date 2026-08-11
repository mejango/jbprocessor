// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IJBTerminal} from "@bananapus/core/src/interfaces/IJBTerminal.sol";

import {JBProcessorEscrow} from "../src/JBProcessorEscrow.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockTerminal} from "./mocks/MockTerminal.sol";

contract JBProcessorEscrowTest is Test {
    JBProcessorEscrow escrow;
    MockERC20 usdc;
    MockERC20 projectToken;
    MockTerminal terminal;

    address owner = makeAddr("owner");
    address operator = makeAddr("operator");
    address beneficiary = makeAddr("beneficiary");
    address stranger = makeAddr("stranger");

    uint256 constant PROJECT_ID = 1;
    uint256 constant USDC_AMOUNT = 100e6;
    // MockTerminal issues project tokens 1:1 (18-decimal) per USDC unit paid.
    uint256 constant TOKENS_ISSUED = USDC_AMOUNT;

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        projectToken = new MockERC20("Project Token", "PRJ", 18);
        terminal = new MockTerminal(usdc, projectToken);
        escrow = new JBProcessorEscrow(owner, operator, IERC20(address(usdc)));

        usdc.mint(operator, 1_000_000e6);
        vm.prank(operator);
        usdc.approve(address(escrow), type(uint256).max);
    }

    function _processPayment(bytes32 paymentId, address to, uint48 unlockAt) internal returns (uint256) {
        vm.prank(operator);
        return escrow.processPayment(
            paymentId,
            IJBTerminal(address(terminal)),
            PROJECT_ID,
            USDC_AMOUNT,
            0,
            address(projectToken),
            to,
            unlockAt,
            "memo"
        );
    }

    function test_processPayment_pullsUsdcPaysAndRecordsEntry() public {
        bytes32 paymentId = keccak256("payment-1");
        uint48 unlockAt = uint48(block.timestamp + 7 days);

        uint256 operatorUsdcBefore = usdc.balanceOf(operator);

        vm.expectEmit(true, true, false, true, address(escrow));
        emit JBProcessorEscrow.Processed(paymentId, PROJECT_ID, USDC_AMOUNT, TOKENS_ISSUED, beneficiary, unlockAt);

        uint256 tokensHeld = _processPayment(paymentId, beneficiary, unlockAt);

        assertEq(tokensHeld, TOKENS_ISSUED, "tokensHeld return value");
        assertEq(usdc.balanceOf(operator), operatorUsdcBefore - USDC_AMOUNT, "USDC pulled from operator");
        assertEq(projectToken.balanceOf(address(escrow)), TOKENS_ISSUED, "escrow holds project tokens");

        (
            address token,
            uint160 amount,
            uint48 storedUnlockAt,
            bool settled,
            address storedBeneficiary,
            address pendingBeneficiary,
            uint48 redirectEffectiveAt
        ) = escrow.entries(paymentId);

        assertEq(token, address(projectToken), "entry token");
        assertEq(amount, TOKENS_ISSUED, "entry amount");
        assertEq(storedUnlockAt, unlockAt, "entry unlockAt");
        assertFalse(settled, "entry not settled");
        assertEq(storedBeneficiary, beneficiary, "entry beneficiary");
        assertEq(pendingBeneficiary, address(0), "entry pendingBeneficiary");
        assertEq(redirectEffectiveAt, 0, "entry redirectEffectiveAt");
    }

    function test_processPayment_revertsOnDuplicatePaymentId() public {
        bytes32 paymentId = keccak256("payment-1");
        uint48 unlockAt = uint48(block.timestamp + 7 days);
        _processPayment(paymentId, beneficiary, unlockAt);

        vm.expectRevert(JBProcessorEscrow.EntryExists.selector);
        _processPayment(paymentId, beneficiary, unlockAt);
    }

    function test_processPayment_revertsOnZeroBeneficiary() public {
        bytes32 paymentId = keccak256("payment-1");
        uint48 unlockAt = uint48(block.timestamp + 7 days);

        vm.expectRevert(JBProcessorEscrow.ZeroBeneficiary.selector);
        _processPayment(paymentId, address(0), unlockAt);
    }

    function test_processPayment_onlyOperator() public {
        bytes32 paymentId = keccak256("payment-1");
        uint48 unlockAt = uint48(block.timestamp + 7 days);

        vm.prank(stranger);
        vm.expectRevert(JBProcessorEscrow.NotOperator.selector);
        escrow.processPayment(
            paymentId,
            IJBTerminal(address(terminal)),
            PROJECT_ID,
            USDC_AMOUNT,
            0,
            address(projectToken),
            beneficiary,
            unlockAt,
            "memo"
        );
    }

    function test_release_revertsBeforeUnlock() public {
        bytes32 paymentId = keccak256("payment-1");
        uint48 unlockAt = uint48(block.timestamp + 7 days);
        _processPayment(paymentId, beneficiary, unlockAt);

        vm.expectRevert(JBProcessorEscrow.StillLocked.selector);
        escrow.release(paymentId);
    }

    function test_release_permissionless_paysBeneficiaryAfterUnlock_singleUse() public {
        bytes32 paymentId = keccak256("payment-1");
        uint48 unlockAt = uint48(block.timestamp + 7 days);
        _processPayment(paymentId, beneficiary, unlockAt);

        vm.warp(unlockAt);

        vm.expectEmit(true, false, false, true, address(escrow));
        emit JBProcessorEscrow.Released(paymentId, beneficiary, TOKENS_ISSUED);

        vm.prank(stranger);
        escrow.release(paymentId);

        assertEq(projectToken.balanceOf(beneficiary), TOKENS_ISSUED, "beneficiary received tokens");
        assertEq(projectToken.balanceOf(address(escrow)), 0, "escrow drained");

        (,,, bool settled,,,) = escrow.entries(paymentId);
        assertTrue(settled, "entry settled");

        vm.expectRevert(JBProcessorEscrow.AlreadySettled.selector);
        escrow.release(paymentId);
    }

    function test_setBeneficiary_onlyOperator_pendingUntilDelay() public {
        bytes32 paymentId = keccak256("payment-1");
        uint48 unlockAt = uint48(block.timestamp + 7 days);
        _processPayment(paymentId, beneficiary, unlockAt);

        address newBeneficiary = makeAddr("newBeneficiary");

        vm.prank(stranger);
        vm.expectRevert(JBProcessorEscrow.NotOperator.selector);
        escrow.setBeneficiary(paymentId, newBeneficiary);

        uint48 expectedEffectiveAt = uint48(block.timestamp + escrow.REDIRECT_DELAY());

        vm.expectEmit(true, false, false, true, address(escrow));
        emit JBProcessorEscrow.BeneficiaryChanged(paymentId, newBeneficiary, expectedEffectiveAt);

        vm.prank(operator);
        escrow.setBeneficiary(paymentId, newBeneficiary);

        (,,,, address storedBeneficiary, address pendingBeneficiary, uint48 redirectEffectiveAt) =
            escrow.entries(paymentId);
        assertEq(storedBeneficiary, beneficiary, "beneficiary unchanged until delay passes");
        assertEq(pendingBeneficiary, newBeneficiary, "pendingBeneficiary recorded");
        assertEq(redirectEffectiveAt, expectedEffectiveAt, "redirectEffectiveAt recorded");
    }

    function test_release_revertsWhileRedirectPending() public {
        bytes32 paymentId = keccak256("payment-1");
        // Unlock is sooner than the redirect delay, so the redirect is still pending at unlock.
        uint48 unlockAt = uint48(block.timestamp + 1 hours);
        _processPayment(paymentId, beneficiary, unlockAt);

        address newBeneficiary = makeAddr("newBeneficiary");
        vm.prank(operator);
        escrow.setBeneficiary(paymentId, newBeneficiary);

        vm.warp(unlockAt);

        vm.expectRevert(JBProcessorEscrow.RedirectPending.selector);
        escrow.release(paymentId);
    }

    function test_release_usesNewBeneficiaryAfterDelay() public {
        bytes32 paymentId = keccak256("payment-1");
        uint48 unlockAt = uint48(block.timestamp + 7 days);
        _processPayment(paymentId, beneficiary, unlockAt);

        address newBeneficiary = makeAddr("newBeneficiary");
        vm.prank(operator);
        escrow.setBeneficiary(paymentId, newBeneficiary);

        vm.warp(unlockAt + escrow.REDIRECT_DELAY());

        escrow.release(paymentId);

        assertEq(projectToken.balanceOf(newBeneficiary), TOKENS_ISSUED, "new beneficiary received tokens");
        assertEq(projectToken.balanceOf(beneficiary), 0, "old beneficiary received nothing");
    }

    function test_forfeit_onlyBeforeUnlock_sendsToOwner() public {
        // A separate entry proves forfeit reverts once the unlock has passed, before it's ever settled.
        bytes32 latePaymentId = keccak256("payment-late");
        uint48 shortUnlockAt = uint48(block.timestamp + 1 hours);
        _processPayment(latePaymentId, beneficiary, shortUnlockAt);
        vm.warp(shortUnlockAt);
        vm.prank(operator);
        vm.expectRevert(JBProcessorEscrow.UnlockPassed.selector);
        escrow.forfeit(latePaymentId);

        bytes32 paymentId = keccak256("payment-1");
        uint48 unlockAt = uint48(block.timestamp + 7 days);
        _processPayment(paymentId, beneficiary, unlockAt);

        vm.prank(stranger);
        vm.expectRevert(JBProcessorEscrow.NotOperator.selector);
        escrow.forfeit(paymentId);

        uint256 escrowBalanceBefore = projectToken.balanceOf(address(escrow));

        vm.expectEmit(true, false, false, true, address(escrow));
        emit JBProcessorEscrow.Forfeited(paymentId, TOKENS_ISSUED);

        vm.prank(operator);
        escrow.forfeit(paymentId);

        assertEq(projectToken.balanceOf(owner), TOKENS_ISSUED, "owner received forfeited tokens");
        assertEq(
            projectToken.balanceOf(address(escrow)),
            escrowBalanceBefore - TOKENS_ISSUED,
            "escrow released only the forfeited entry's tokens"
        );

        (,,, bool settled,,,) = escrow.entries(paymentId);
        assertTrue(settled, "entry settled");
    }

    function test_forfeit_thenRelease_reverts() public {
        bytes32 paymentId = keccak256("payment-1");
        uint48 unlockAt = uint48(block.timestamp + 7 days);
        _processPayment(paymentId, beneficiary, unlockAt);

        vm.prank(operator);
        escrow.forfeit(paymentId);

        vm.warp(unlockAt);
        vm.expectRevert(JBProcessorEscrow.AlreadySettled.selector);
        escrow.release(paymentId);
    }

    function test_setOperator_onlyOwner() public {
        address newOperator = makeAddr("newOperator");

        vm.prank(stranger);
        vm.expectRevert();
        escrow.setOperator(newOperator);

        vm.prank(owner);
        escrow.setOperator(newOperator);

        assertEq(escrow.operator(), newOperator);
    }
}
