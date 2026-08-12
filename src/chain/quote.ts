import type { Address } from "viem";
import { controllerAbi } from "./abi/controller.js";
import { pricesAbi } from "./abi/prices.js";
import { terminalAbi } from "./abi/terminal.js";
import type { AppPublicClient } from "./client.js";
import { envAddress } from "../env.js";

/** USDC on Base -- 6 decimals. */
export const USDC_ON_BASE: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/** USDC has 6 decimals; a US cent is 10^4 of its base units. */
export const USDC_WEI_PER_CENT = 10_000n;

/** USDC's own decimals, as the terminal's accounting context reports them. */
const USDC_DECIMALS = 6n;

/**
 * The currency id a Juicebox accounting context uses for USDC.
 *
 * `JBAccountingContext.currency` is `uint32(uint160(token))` -- the low 4 bytes
 * of the token's address -- which for USDC on Base is 0xbdA02913 (3181390099).
 * Derived here rather than written out, so it cannot drift from the address
 * above. Note this is a *different* namespace from `JBCurrencyIds` (ETH = 1,
 * USD = 2), which is what a ruleset's `baseCurrency` usually holds; telling the
 * two apart is the whole job of the weight ratio below.
 */
const USDC_CURRENCY_ID = BigInt(`0x${USDC_ON_BASE.slice(-8)}`);

const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

const BPS_DENOMINATOR = 10_000n;
const DEFAULT_DRIFT_TOLERANCE_BPS = 200n;

/** `JBConstants.MAX_RESERVED_PERCENT`. */
const MAX_RESERVED_PERCENT = 10_000n;

export interface QuoteTokensParams {
  terminal: Address;
  projectId: bigint;
  usdcAmountWei: bigint;
}

/** As much of `previewPayFor`'s answer as the quote reasons about. */
export interface PayPreview {
  /** Issuance rate, 18-decimal fixed point, per unit of the ruleset's base currency. */
  weight: bigint;
  /** The ruleset's packed metadata word. */
  rulesetMetadata: bigint;
  /** What the terminal itself would mint for the payer. */
  beneficiaryTokenCount: bigint;
  /** USDC each pay hook has claimed out of the payment. */
  hookAmounts: readonly bigint[];
}

/**
 * The onchain reads the quote makes, behind one injectable surface -- the same
 * shape as `PayChain`, `ReleaseChain` and `RulesetReads` elsewhere in this
 * service. `liveQuoteReads` is the production implementation.
 */
export interface QuoteReads {
  previewPayFor(params: QuoteTokensParams): Promise<PayPreview>;
  /**
   * `JBPrices.pricePerUnitOf`: the price of one `pricingCurrency` unit in
   * `unitCurrency`, as fixed point with `decimals` decimals. Only called on the
   * fallback path, and only when the two currencies differ.
   */
  pricePerUnit(args: {
    projectId: bigint;
    pricingCurrency: bigint;
    unitCurrency: bigint;
    decimals: bigint;
  }): Promise<bigint>;
}

/**
 * The live reads, bound to a viem public client.
 *
 * JBPrices is resolved from the controller (`JB_CONTROLLER_ADDRESS`, already
 * required for the ruleset watcher) rather than configured separately, and
 * memoized per instance: it is an immutable on JBController, so one read per
 * process is one read too many to repeat.
 */
export function liveQuoteReads(client: AppPublicClient): QuoteReads {
  let pricesAddress: Promise<Address> | undefined;

  const resolvePrices = (): Promise<Address> => {
    pricesAddress ??= client.readContract({
      address: envAddress("JB_CONTROLLER_ADDRESS"),
      abi: controllerAbi,
      functionName: "PRICES",
    });
    return pricesAddress;
  };

  return {
    previewPayFor: async ({ terminal, projectId, usdcAmountWei }) => {
      const [ruleset, beneficiaryTokenCount, , hookSpecifications] = await client.readContract({
        address: terminal,
        abi: terminalAbi,
        functionName: "previewPayFor",
        args: [projectId, USDC_ON_BASE, usdcAmountWei, ZERO_ADDRESS, "0x"],
      });
      return {
        weight: ruleset.weight,
        rulesetMetadata: ruleset.metadata,
        beneficiaryTokenCount,
        hookAmounts: hookSpecifications.map((spec) => spec.amount),
      };
    },
    pricePerUnit: async ({ projectId, pricingCurrency, unitCurrency, decimals }) =>
      client.readContract({
        address: await resolvePrices(),
        abi: pricesAbi,
        functionName: "pricePerUnitOf",
        args: [projectId, pricingCurrency, unitCurrency, decimals],
      }),
  };
}

/**
 * `JBRulesetMetadataResolver`'s bit layout, for the two fields the floor needs.
 * Read off the packed word the preview already returned rather than made into
 * a second `currentRulesetOf` call -- `previewPayFor` hands back the very
 * ruleset it priced against, so unpacking it is both cheaper and free of the
 * race where the ruleset cycles between the two reads.
 */
function reservedPercentOf(metadata: bigint): bigint {
  return (metadata >> 4n) & 0xffffn;
}

function baseCurrencyOf(metadata: bigint): bigint {
  return (metadata >> 36n) & 0xffffffffn;
}

/**
 * The number of tokens the *terminal itself* would mint for the payer, ignoring
 * any pay hook.
 *
 * This mirrors `JBTerminalStore._computePayFrom` exactly, and the derivation is
 * worth spelling out because every factor in it is a place to go wrong:
 *
 *   weightRatio = amount.currency == ruleset.baseCurrency
 *                   ? 10 ** amount.decimals
 *                   : PRICES.pricePerUnitOf(projectId, amount.currency,
 *                                           ruleset.baseCurrency, amount.decimals)
 *   tokenCount  = amount.value * weight / weightRatio
 *
 * `weight` is 18-decimal fixed point and denominates tokens per ONE unit of the
 * ruleset's base currency. `amount.value` is in the payment token's own base
 * units (6 for USDC), so the ratio has to carry the payment token's decimals --
 * which is why `decimals` is passed to the price read too, rather than the
 * price being fetched at some canonical precision and rescaled here.
 *
 * The two currency namespaces are the trap. An accounting context's currency is
 * `uint32(uint160(token))`, while a ruleset's `baseCurrency` is normally a
 * `JBCurrencyIds` value (USD = 2). They are almost never equal, so the price
 * read is the normal path and the `10 ** decimals` short-circuit is the
 * exception -- and the price is genuinely not 1. On Base at the time of
 * writing, `pricePerUnitOf(6, USDC, USD, 6)` returns 1000189, i.e. a live
 * Chainlink USDC/USD feed reading $1.000189. Assuming 10^6 here would inflate
 * the floor by ~0.02% and quietly break the lower-bound property this whole
 * function exists to provide.
 *
 * Then the reserved split, matching `JBController._splitTokenCount`:
 *
 *   beneficiaryTokenCount = tokenCount * (MAX_RESERVED_PERCENT - reservedPercent)
 *                             / MAX_RESERVED_PERCENT
 *
 * All integer math, truncating in the same direction Solidity's does, so the
 * result is never above what the chain would produce.
 */
async function mintPathFloor(
  reads: QuoteReads,
  preview: PayPreview,
  { projectId, usdcAmountWei }: QuoteTokensParams,
): Promise<bigint> {
  if (preview.weight === 0n) return 0n;

  const baseCurrency = baseCurrencyOf(preview.rulesetMetadata);
  const weightRatio =
    baseCurrency === USDC_CURRENCY_ID
      ? 10n ** USDC_DECIMALS
      : await reads.pricePerUnit({
          projectId,
          pricingCurrency: USDC_CURRENCY_ID,
          unitCurrency: baseCurrency,
          decimals: USDC_DECIMALS,
        });
  if (weightRatio === 0n) return 0n;

  const tokenCount = (usdcAmountWei * preview.weight) / weightRatio;
  const reservedPercent = reservedPercentOf(preview.rulesetMetadata);
  return (tokenCount * (MAX_RESERVED_PERCENT - reservedPercent)) / MAX_RESERVED_PERCENT;
}

/**
 * How many project tokens a USDC donation buys.
 *
 * The simple answer is `previewPayFor`'s `beneficiaryTokenCount`, and when the
 * terminal reports a non-zero one that is the answer, unchanged.
 *
 * The complication is a project whose ruleset sets `useDataHookForPay`. A
 * revnet's data hook hands the whole payment to the buyback hook, which
 * acquires tokens by swapping on an AMM instead of minting -- and
 * `previewPayFor` reports only what the TERMINAL mints, so it returns zero for
 * such a project while the payer in fact receives plenty. Taken at face value
 * that zero is corrosive: the payer is quoted nothing, the drift gate compares
 * zero against zero and never refunds, and `minTokensForQuote(0)` is 0, so the
 * on-chain send goes out with no slippage floor at all.
 *
 * So when the preview is zero *because* a hook claimed the entire payment, the
 * quote falls back to the mint-path floor -- what the terminal would have
 * minted had no hook intervened. That is a true lower bound on what the payer
 * receives, because the buyback hook only routes to the AMM when the swap beats
 * minting; when it doesn't, the hook mints, and the payer gets exactly this
 * number. Using it restores all three: a quote to display, a drift gate with
 * something to compare, and a real `minReturnedTokens`.
 *
 * The fallback is deliberately narrow. A zero preview with no hook claiming the
 * payment is a project that genuinely issues nothing -- a zero weight, or 100%
 * reserved -- and inventing a floor for it would be a lie. Checkout refuses a
 * quote of zero from either path.
 */
export async function quoteTokens(
  reads: QuoteReads,
  params: QuoteTokensParams,
): Promise<bigint> {
  const preview = await reads.previewPayFor(params);
  if (preview.beneficiaryTokenCount > 0n) return preview.beneficiaryTokenCount;

  const claimedByHooks = preview.hookAmounts.reduce((sum, amount) => sum + amount, 0n);
  if (claimedByHooks !== params.usdcAmountWei) return 0n;

  return mintPathFloor(reads, preview, params);
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
  return quoteNow < minTokensForQuote(quoteAtCheckout);
}

/**
 * The floor a quote may fall to before it counts as drift: `quote * (10000 -
 * DRIFT_TOLERANCE_BPS) / 10000`. Shared by `driftExceeded` (which compares a
 * fresh quote against the checkout quote's floor) and the payer worker (which
 * passes the *fresh* quote's floor to the terminal as `minReturnedTokens`, so
 * the on-chain send can't drift further between simulation and inclusion).
 */
export function minTokensForQuote(quote: bigint): bigint {
  return (quote * (BPS_DENOMINATOR - driftToleranceBps())) / BPS_DENOMINATOR;
}
