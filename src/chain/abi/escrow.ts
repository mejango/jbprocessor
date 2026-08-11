/**
 * Minimal, hand-vendored ABI for `JBProcessorEscrow` -- only the functions
 * and events this service's `src/chain/escrow.ts` module uses. Sourced from
 * the contract itself (`contracts/src/JBProcessorEscrow.sol`), cross-checked
 * against the compiled artifact after `forge build`:
 *   contracts/out/JBProcessorEscrow.sol/JBProcessorEscrow.json
 *
 * This is a TS `as const` array (viem-style ABI), not raw ABI JSON -- viem
 * infers argument/return types from it directly. Follows the same pattern
 * as `src/chain/abi/terminal.ts` (Task 4).
 *
 * Note: the contract's `processPayment` takes `beneficiary` BEFORE
 * `unlockAt`, and reverts on a zero `unlockAt` -- this is a deliberate
 * deviation from the original task plan that the deployed source now
 * reflects; the ABI below matches the deployed source, not the plan.
 */
export const escrowAbi = [
  {
    type: "function",
    name: "processPayment",
    stateMutability: "nonpayable",
    inputs: [
      { name: "paymentId", type: "bytes32" },
      { name: "terminal", type: "address" },
      { name: "projectId", type: "uint256" },
      { name: "usdcAmount", type: "uint256" },
      { name: "minReturnedTokens", type: "uint256" },
      { name: "projectToken", type: "address" },
      { name: "beneficiary", type: "address" },
      { name: "unlockAt", type: "uint48" },
      { name: "memo", type: "string" },
    ],
    outputs: [{ name: "tokensHeld", type: "uint256" }],
  },
  {
    type: "function",
    name: "setBeneficiary",
    stateMutability: "nonpayable",
    inputs: [
      { name: "paymentId", type: "bytes32" },
      { name: "to", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "release",
    stateMutability: "nonpayable",
    inputs: [{ name: "paymentId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "forfeit",
    stateMutability: "nonpayable",
    inputs: [{ name: "paymentId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "entries",
    stateMutability: "view",
    inputs: [{ name: "paymentId", type: "bytes32" }],
    outputs: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint160" },
      { name: "unlockAt", type: "uint48" },
      { name: "settled", type: "bool" },
      { name: "beneficiary", type: "address" },
      { name: "pendingBeneficiary", type: "address" },
      { name: "redirectEffectiveAt", type: "uint48" },
    ],
  },
  {
    type: "event",
    name: "Processed",
    inputs: [
      { name: "paymentId", type: "bytes32", indexed: true },
      { name: "projectId", type: "uint256", indexed: true },
      { name: "amountPaid", type: "uint256", indexed: false },
      { name: "tokensHeld", type: "uint256", indexed: false },
      { name: "beneficiary", type: "address", indexed: false },
      { name: "unlockAt", type: "uint48", indexed: false },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "BeneficiaryChanged",
    inputs: [
      { name: "paymentId", type: "bytes32", indexed: true },
      { name: "pending", type: "address", indexed: false },
      { name: "effectiveAt", type: "uint48", indexed: false },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "Released",
    inputs: [
      { name: "paymentId", type: "bytes32", indexed: true },
      { name: "to", type: "address", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "Forfeited",
    inputs: [
      { name: "paymentId", type: "bytes32", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
    anonymous: false,
  },
] as const;
