// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IJBTerminal} from "@bananapus/core/src/interfaces/IJBTerminal.sol";

/// @notice Holds project tokens purchased with fiat until the card-dispute window passes.
/// The unlock is enforced onchain: the operator can never release early, only forfeit
/// (to the owner treasury) while the window is open.
contract JBProcessorEscrow is Ownable {
    using SafeERC20 for IERC20;

    struct Entry {
        address token;
        uint160 amount;
        uint48 unlockAt;
        bool settled;
        address beneficiary;
        address pendingBeneficiary;
        uint48 redirectEffectiveAt;
    }

    error NotOperator();
    error EntryExists();
    error NoEntry();
    error ZeroBeneficiary();
    error ZeroUnlock();
    error StillLocked();
    error AlreadySettled();
    error UnlockPassed();
    error RedirectPending();

    event Processed(
        bytes32 indexed paymentId,
        uint256 indexed projectId,
        uint256 amountPaid,
        uint256 tokensHeld,
        address beneficiary,
        uint48 unlockAt
    );
    event BeneficiaryChanged(bytes32 indexed paymentId, address pending, uint48 effectiveAt);
    event Released(bytes32 indexed paymentId, address to, uint256 amount);
    event Forfeited(bytes32 indexed paymentId, uint256 amount);

    uint256 public constant REDIRECT_DELAY = 48 hours;

    IERC20 public immutable USDC;
    address public operator;
    mapping(bytes32 paymentId => Entry) public entries;

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    constructor(address owner_, address operator_, IERC20 usdc) Ownable(owner_) {
        operator = operator_;
        USDC = usdc;
    }

    function setOperator(address operator_) external onlyOwner {
        operator = operator_;
    }

    function processPayment(
        bytes32 paymentId,
        IJBTerminal terminal,
        uint256 projectId,
        uint256 usdcAmount,
        uint256 minReturnedTokens,
        address projectToken,
        address beneficiary,
        uint48 unlockAt,
        string calldata memo
    ) external onlyOperator returns (uint256 tokensHeld) {
        if (entries[paymentId].unlockAt != 0) revert EntryExists();
        if (unlockAt == 0) revert ZeroUnlock();
        if (beneficiary == address(0)) revert ZeroBeneficiary();
        USDC.safeTransferFrom(msg.sender, address(this), usdcAmount);
        USDC.forceApprove(address(terminal), usdcAmount);
        uint256 balanceBefore = IERC20(projectToken).balanceOf(address(this));
        terminal.pay({
            projectId: projectId,
            token: address(USDC),
            amount: usdcAmount,
            beneficiary: address(this),
            minReturnedTokens: minReturnedTokens,
            memo: memo,
            metadata: bytes("")
        });
        tokensHeld = IERC20(projectToken).balanceOf(address(this)) - balanceBefore;
        entries[paymentId] = Entry(projectToken, uint160(tokensHeld), unlockAt, false, beneficiary, address(0), 0);
        emit Processed(paymentId, projectId, usdcAmount, tokensHeld, beneficiary, unlockAt);
    }

    /// @notice Redirect where a held entry will release to. Takes effect after REDIRECT_DELAY,
    /// giving monitoring public notice before any redirected release can execute.
    function setBeneficiary(bytes32 paymentId, address to) external onlyOperator {
        Entry storage entry = entries[paymentId];
        if (entry.unlockAt == 0) revert NoEntry();
        if (entry.settled) revert AlreadySettled();
        if (to == address(0)) revert ZeroBeneficiary();
        entry.pendingBeneficiary = to;
        entry.redirectEffectiveAt = uint48(block.timestamp + REDIRECT_DELAY);
        emit BeneficiaryChanged(paymentId, to, entry.redirectEffectiveAt);
    }

    /// @notice Permissionless: anyone can crank an unlocked entry to its recorded beneficiary.
    function release(bytes32 paymentId) external {
        Entry storage entry = entries[paymentId];
        if (entry.unlockAt == 0) revert NoEntry();
        if (entry.settled) revert AlreadySettled();
        if (block.timestamp < entry.unlockAt) revert StillLocked();
        if (entry.pendingBeneficiary != address(0)) {
            if (block.timestamp < entry.redirectEffectiveAt) revert RedirectPending();
            entry.beneficiary = entry.pendingBeneficiary;
        }
        entry.settled = true;
        IERC20(entry.token).safeTransfer(entry.beneficiary, entry.amount);
        emit Released(paymentId, entry.beneficiary, entry.amount);
    }

    function forfeit(bytes32 paymentId) external onlyOperator {
        Entry storage entry = entries[paymentId];
        if (entry.unlockAt == 0) revert NoEntry();
        if (entry.settled) revert AlreadySettled();
        if (block.timestamp >= entry.unlockAt) revert UnlockPassed();
        entry.settled = true;
        IERC20(entry.token).safeTransfer(owner(), entry.amount);
        emit Forfeited(paymentId, entry.amount);
    }
}
