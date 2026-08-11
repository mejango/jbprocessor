/**
 * Minimal ERC-20 ABI -- only the reads this service makes. Checkout uses
 * `allowance` to size the instant-pool headroom (how much USDC the pool
 * has approved the worker to spend on its behalf).
 */
export const erc20Abi = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;
