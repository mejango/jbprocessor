import type { Address } from "viem";
import { terminalAbi } from "./abi/terminal.js";

/** USDC on Base -- 6 decimals. */
export const USDC_ON_BASE: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

const BPS_DENOMINATOR = 10_000n;
const DEFAULT_DRIFT_TOLERANCE_BPS = 200n;

export interface QuoteTokensParams {
  terminal: Address;
  projectId: bigint;
  usdcAmountWei: bigint;
}

/** The minimal slice of a viem PublicClient that quoteTokens needs -- lets tests pass a stub. */
export interface ReadContractClient {
  readContract(args: {
    address: Address;
    abi: typeof terminalAbi;
    functionName: "previewPayFor";
    args: readonly [bigint, Address, bigint, Address, `0x${string}`];
  }): Promise<readonly [unknown, bigint, bigint, unknown]>;
}

/**
 * Simulates a USDC payment through `previewPayFor` on the given Juicebox V6
 * terminal and returns the number of project tokens a payer would receive
 * (`beneficiaryTokenCount`, the preview's 2nd return value).
 *
 * `beneficiary` is passed as the zero address and `metadata` as empty bytes
 * -- the actual beneficiary is decided at payout time and doesn't affect the
 * issuance math this preview reports.
 */
export async function quoteTokens(
  client: ReadContractClient,
  { terminal, projectId, usdcAmountWei }: QuoteTokensParams,
): Promise<bigint> {
  const result = await client.readContract({
    address: terminal,
    abi: terminalAbi,
    functionName: "previewPayFor",
    args: [projectId, USDC_ON_BASE, usdcAmountWei, ZERO_ADDRESS, "0x"],
  });
  return result[1];
}

function driftToleranceBps(): bigint {
  const raw = process.env.DRIFT_TOLERANCE_BPS;
  if (raw === undefined || raw === "") {
    return DEFAULT_DRIFT_TOLERANCE_BPS;
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(`DRIFT_TOLERANCE_BPS must be a non-negative integer, got: ${raw}`);
  }
  const parsed = BigInt(raw);
  if (parsed > BPS_DENOMINATOR) {
    throw new Error(`DRIFT_TOLERANCE_BPS must be between 0 and 10000, got: ${raw}`);
  }
  return parsed;
}

/**
 * True when `quoteNow` has drifted downward from `quoteAtCheckout` by more
 * than the configured tolerance (`DRIFT_TOLERANCE_BPS`, default 200 = 2%).
 * Upside drift (quoteNow >= quoteAtCheckout) is always false -- a payer
 * receiving more tokens than quoted is never a problem worth blocking on.
 *
 * All-bigint integer math: the floor is
 * `quoteAtCheckout * (10000 - toleranceBps) / 10000`, rounded down by
 * integer division (matching Solidity's own truncation), and exceeded means
 * strictly below that floor.
 */
export function driftExceeded(quoteAtCheckout: bigint, quoteNow: bigint): boolean {
  const toleranceBps = driftToleranceBps();
  const floor = (quoteAtCheckout * (BPS_DENOMINATOR - toleranceBps)) / BPS_DENOMINATOR;
  return quoteNow < floor;
}
