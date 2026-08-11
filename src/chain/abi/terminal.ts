/**
 * Minimal, hand-vendored ABI for the Juicebox V6 multi-terminal contract
 * (`JBMultiTerminal` / `IJBTerminal`). Only the functions this service
 * calls are included -- extend as later tasks need more of the terminal's
 * surface. Sourced from:
 *   contracts/lib/nana-core-v6/src/interfaces/IJBTerminal.sol (previewPayFor)
 *   contracts/lib/nana-core-v6/src/JBMultiTerminal.sol (matching override)
 *   contracts/lib/nana-core-v6/src/structs/JBRuleset.sol
 *   contracts/lib/nana-core-v6/src/structs/JBPayHookSpecification.sol
 *
 * This is a TS `as const` array (viem-style ABI), not raw ABI JSON --
 * viem infers argument/return types from it directly.
 */
export const terminalAbi = [
  {
    type: "function",
    name: "previewPayFor",
    stateMutability: "view",
    inputs: [
      { name: "projectId", type: "uint256" },
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "beneficiary", type: "address" },
      { name: "metadata", type: "bytes" },
    ],
    outputs: [
      {
        name: "ruleset",
        type: "tuple",
        components: [
          { name: "cycleNumber", type: "uint48" },
          { name: "id", type: "uint48" },
          { name: "basedOnId", type: "uint48" },
          { name: "start", type: "uint48" },
          { name: "duration", type: "uint32" },
          { name: "weight", type: "uint112" },
          { name: "weightCutPercent", type: "uint32" },
          { name: "approvalHook", type: "address" },
          { name: "metadata", type: "uint256" },
        ],
      },
      { name: "beneficiaryTokenCount", type: "uint256" },
      { name: "reservedTokenCount", type: "uint256" },
      {
        name: "hookSpecifications",
        type: "tuple[]",
        components: [
          { name: "hook", type: "address" },
          { name: "noop", type: "bool" },
          { name: "amount", type: "uint256" },
          { name: "metadata", type: "bytes" },
        ],
      },
    ],
  },
] as const;
