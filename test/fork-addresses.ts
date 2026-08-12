import type { Address } from "viem";

/**
 * Live Base mainnet (chainId 8453) addresses the fork suites run against.
 *
 * Every one of these was read back off Base at head on 2026-08-11 and is
 * recorded in the README's fork-testing section with the call that verified
 * it. They are defaults, not constants: each is overridable by the matching
 * environment variable, because a project's terminal or a whale's balance can
 * move and a fork suite that can only be pointed at one target stops being
 * runnable the day it does.
 *
 *   TEST_PROJECT_ID     Juicebox V6 project #6, "Artizen" (ART). Chosen from
 *                       the ten V6 projects on Base because its primary USDC
 *                       terminal is JBMultiTerminal directly rather than the
 *                       router registry, and its current ruleset has
 *                       `pausePay = false`.
 *                       It is a revnet: `useDataHookForPay` is true, so a pay
 *                       may route through the buyback hook instead of minting.
 *                       That is a feature of this test, not a problem with it
 *                       -- the escrow measures the tokens it actually received
 *                       either way, which is exactly the path worth exercising
 *                       against real state.
 *   TEST_TERMINAL       JBMultiTerminal on Base.
 *   TEST_PROJECT_TOKEN  JBTokens.tokenOf(6).
 *   TEST_CONTROLLER     JBController on Base, for the ruleset reads.
 *   TEST_USDC_WHALE     Aave v3's aBasUSDC aToken -- ~17.9M USDC at head, a
 *                       plain market contract with nothing on the USDC side
 *                       that interferes with an impersonated transfer.
 */
export const FORK_PROJECT_ID = BigInt(process.env.TEST_PROJECT_ID ?? "6");

export const FORK_TERMINAL = requireAddress(
  process.env.TEST_TERMINAL ?? "0x130f5Dd2bD8805443Cf41755253D778a75a67f53",
  "TEST_TERMINAL",
);

export const FORK_PROJECT_TOKEN = requireAddress(
  process.env.TEST_PROJECT_TOKEN ?? "0x44c4516768e47cd97cfF2561B81a74699F23f8Ec",
  "TEST_PROJECT_TOKEN",
);

export const FORK_CONTROLLER = requireAddress(
  process.env.TEST_CONTROLLER ?? "0x3Fcec3572e84b624477BcfF4E2CF1f7dEAb648F1",
  "TEST_CONTROLLER",
);

export const FORK_USDC_WHALE = requireAddress(
  process.env.TEST_USDC_WHALE ?? "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB",
  "TEST_USDC_WHALE",
);

/**
 * Every call in a fork suite is a live RPC round trip: anvil serves the fork
 * lazily, so a single `pay()` pulls hundreds of storage slots from the
 * upstream node one request at a time. Vitest's 5s default would be a timeout
 * on the network, not on anything being tested.
 *
 * For the same reason the fork suites must not run in parallel with each
 * other: two anvils fetching state from one public RPC starve each other, and
 * the failure surfaces as a transaction that simulated and then reverted, in
 * whichever suite lost. `npm run test:fork` passes
 * `--no-file-parallelism` for exactly this.
 */
export const FORK_TEST_TIMEOUT_MS = 180_000;

/** anvil's well-known dev account #0, from the deterministic test mnemonic. */
export const ANVIL_DEFAULT_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

function requireAddress(value: string, name: string): Address {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`${name} must be a 0x-prefixed 20-byte hex address, got: ${value}`);
  }
  return value as Address;
}
