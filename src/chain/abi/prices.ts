/**
 * Minimal, hand-vendored ABI for the Juicebox V6 price oracle (`JBPrices` /
 * `IJBPrices`). Only the one read the mint-path floor quote makes. Sourced
 * from contracts/lib/nana-core-v6/src/JBPrices.sol.
 *
 * `pricePerUnitOf` returns the price of one `pricingCurrency` unit denominated
 * in `unitCurrency`, as a fixed-point number with `decimals` decimals. It
 * short-circuits to `10 ** decimals` when the two currencies are the same, and
 * reverts `JBPrices_PriceFeedNotFound` when neither the project's own feeds nor
 * the protocol defaults cover the pair.
 *
 * This is a TS `as const` array (viem-style ABI), not raw ABI JSON.
 */
export const pricesAbi = [
  {
    type: "function",
    name: "pricePerUnitOf",
    stateMutability: "view",
    inputs: [
      { name: "projectId", type: "uint256" },
      { name: "pricingCurrency", type: "uint256" },
      { name: "unitCurrency", type: "uint256" },
      { name: "decimals", type: "uint256" },
    ],
    outputs: [{ name: "price", type: "uint256" }],
  },
] as const;
