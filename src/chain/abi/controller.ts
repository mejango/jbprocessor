/**
 * Minimal, hand-vendored ABI for the Juicebox V6 controller
 * (`JBController` / `IJBController`). Only the two ruleset reads the
 * eligibility watcher makes are included. Sourced from:
 *   contracts/lib/nana-core-v6/src/interfaces/IJBController.sol
 *     (currentRulesetOf, upcomingRulesetOf)
 *   contracts/lib/nana-core-v6/src/structs/JBRuleset.sol
 *   contracts/lib/nana-core-v6/src/structs/JBRulesetMetadata.sol
 *
 * Both functions have the same shape:
 *   function currentRulesetOf(uint256 projectId)
 *     external view returns (JBRuleset memory ruleset, JBRulesetMetadata memory metadata);
 *
 * This is a TS `as const` array (viem-style ABI), not raw ABI JSON -- viem
 * infers argument/return types from it directly. Same pattern as
 * `src/chain/abi/terminal.ts`.
 */
const rulesetOutputs = [
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
  {
    name: "metadata",
    type: "tuple",
    components: [
      { name: "reservedPercent", type: "uint16" },
      { name: "cashOutTaxRate", type: "uint16" },
      { name: "baseCurrency", type: "uint32" },
      { name: "pausePay", type: "bool" },
      { name: "pauseCreditTransfers", type: "bool" },
      { name: "allowOwnerMinting", type: "bool" },
      { name: "allowSetCustomToken", type: "bool" },
      { name: "allowTerminalMigration", type: "bool" },
      { name: "allowSetTerminals", type: "bool" },
      { name: "allowSetController", type: "bool" },
      { name: "allowAddAccountingContext", type: "bool" },
      { name: "allowAddPriceFeed", type: "bool" },
      { name: "ownerMustSendPayouts", type: "bool" },
      { name: "holdFees", type: "bool" },
      { name: "scopeCashOutsToLocalBalances", type: "bool" },
      { name: "useDataHookForPay", type: "bool" },
      { name: "useDataHookForCashOut", type: "bool" },
      { name: "dataHook", type: "address" },
      { name: "metadata", type: "uint16" },
    ],
  },
] as const;

export const controllerAbi = [
  {
    type: "function",
    name: "currentRulesetOf",
    stateMutability: "view",
    inputs: [{ name: "projectId", type: "uint256" }],
    outputs: rulesetOutputs,
  },
  {
    type: "function",
    name: "upcomingRulesetOf",
    stateMutability: "view",
    inputs: [{ name: "projectId", type: "uint256" }],
    outputs: rulesetOutputs,
  },
] as const;
