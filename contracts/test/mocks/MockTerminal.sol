// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {MockERC20} from "./MockERC20.sol";

/// @notice Minimal stand-in for a Juicebox terminal: pulls the payment token from the caller and
/// mints project tokens to the beneficiary 1:1 with the amount paid, matching `IJBTerminal.pay`'s
/// signature so `JBProcessorEscrow` can call it unmodified.
contract MockTerminal {
    error UnderMin();

    IERC20 public immutable paymentToken;
    MockERC20 public immutable token;

    constructor(IERC20 paymentToken_, MockERC20 token_) {
        paymentToken = paymentToken_;
        token = token_;
    }

    function pay(
        uint256, /* projectId */
        address, /* token */
        uint256 amount,
        address beneficiary,
        uint256 minReturnedTokens,
        string calldata, /* memo */
        bytes calldata /* metadata */
    ) external payable returns (uint256 beneficiaryTokenCount) {
        paymentToken.transferFrom(msg.sender, address(this), amount);
        beneficiaryTokenCount = amount;
        if (beneficiaryTokenCount < minReturnedTokens) revert UnderMin();
        token.mint(beneficiary, beneficiaryTokenCount);
    }
}
