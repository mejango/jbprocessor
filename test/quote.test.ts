import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  driftExceeded,
  liveQuoteReads,
  quoteTokens,
  type PayPreview,
  type QuoteReads,
} from "../src/chain/quote.js";

describe("driftExceeded", () => {
  const ORIGINAL_ENV = process.env.DRIFT_TOLERANCE_BPS;

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.DRIFT_TOLERANCE_BPS;
    } else {
      process.env.DRIFT_TOLERANCE_BPS = ORIGINAL_ENV;
    }
  });

  it("is false exactly at the tolerance boundary (default 200 bps)", () => {
    delete process.env.DRIFT_TOLERANCE_BPS;
    // 10_000 * (10_000 - 200) / 10_000 = 9_800 -- exactly at the floor.
    expect(driftExceeded(10_000n, 9_800n)).toBe(false);
  });

  it("is true one wei below the tolerance boundary", () => {
    delete process.env.DRIFT_TOLERANCE_BPS;
    expect(driftExceeded(10_000n, 9_799n)).toBe(true);
  });

  it("is false for upside drift (quoteNow greater than quoteAtCheckout)", () => {
    delete process.env.DRIFT_TOLERANCE_BPS;
    expect(driftExceeded(10_000n, 50_000n)).toBe(false);
  });

  it("is false when quoteNow equals quoteAtCheckout (zero drift)", () => {
    delete process.env.DRIFT_TOLERANCE_BPS;
    expect(driftExceeded(10_000n, 10_000n)).toBe(false);
  });

  it("is false when both quotes are zero", () => {
    delete process.env.DRIFT_TOLERANCE_BPS;
    expect(driftExceeded(0n, 0n)).toBe(false);
  });

  it("is true when checkout quote was positive but the current quote collapsed to zero", () => {
    delete process.env.DRIFT_TOLERANCE_BPS;
    expect(driftExceeded(10_000n, 0n)).toBe(true);
  });

  it("respects a custom DRIFT_TOLERANCE_BPS from the environment", () => {
    process.env.DRIFT_TOLERANCE_BPS = "1000"; // 10%
    // Floor = 10_000 * 9_000 / 10_000 = 9_000.
    expect(driftExceeded(10_000n, 9_000n)).toBe(false);
    expect(driftExceeded(10_000n, 8_999n)).toBe(true);
  });

  it("throws for an out-of-range DRIFT_TOLERANCE_BPS", () => {
    process.env.DRIFT_TOLERANCE_BPS = "10001";
    expect(() => driftExceeded(10_000n, 10_000n)).toThrow();
  });

  it("throws for a non-numeric DRIFT_TOLERANCE_BPS", () => {
    process.env.DRIFT_TOLERANCE_BPS = "not-a-number";
    expect(() => driftExceeded(10_000n, 10_000n)).toThrow();
  });
});

describe("quoteTokens", () => {
  const TERMINAL = "0x1111111111111111111111111111111111111111" as const;
  const USDC_ON_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
  const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

  /**
   * Project #6 (Artizen) on Base, read off chain on 2026-08-11. A real packed
   * ruleset metadata word rather than a hand-built one, so the bit offsets
   * this module unpacks are checked against the layout the protocol actually
   * writes: reservedPercent = 4000, baseCurrency = 2 (JBCurrencyIds.USD).
   */
  const ART_METADATA =
    29474386462456112119793881700294017108945869861533066439326247206422379009n;
  const ART_WEIGHT = 625_000_000_000_000_000_000n; // 625e18 tokens per USD
  /** `JBPrices.pricePerUnitOf(6, USDC, USD, 6)` on Base -- a live USDC/USD feed. */
  const USDC_PER_USD = 1_000_189n;
  const TWENTY_FIVE_USDC = 25_000_000n;

  const PARAMS = { terminal: TERMINAL, projectId: 6n, usdcAmountWei: TWENTY_FIVE_USDC };

  function reads(
    preview: Partial<PayPreview>,
    price: bigint = USDC_PER_USD,
  ): QuoteReads & { priceCalls: unknown[] } {
    const priceCalls: unknown[] = [];
    return {
      priceCalls,
      previewPayFor: async () => ({
        weight: ART_WEIGHT,
        rulesetMetadata: ART_METADATA,
        beneficiaryTokenCount: 0n,
        hookAmounts: [],
        ...preview,
      }),
      pricePerUnit: async (args) => {
        priceCalls.push(args);
        return price;
      },
    };
  }

  it("returns the terminal's own preview when it reports one", async () => {
    const client = reads({ beneficiaryTokenCount: 123_456n });

    expect(await quoteTokens(client, PARAMS)).toBe(123_456n);
    // The simple path must stay a single read -- no price lookup.
    expect(client.priceCalls).toHaveLength(0);
  });

  it("falls back to the mint-path floor when a hook claimed the whole payment", async () => {
    const client = reads({ hookAmounts: [0n, TWENTY_FIVE_USDC] });

    // tokenCount = 25000000 * 625e18 / 1000189, then 60% after the 40% reserve.
    const tokenCount = (TWENTY_FIVE_USDC * ART_WEIGHT) / USDC_PER_USD;
    expect(await quoteTokens(client, PARAMS)).toBe((tokenCount * 6000n) / 10_000n);
    expect(await quoteTokens(client, PARAMS)).toBe(9_373_228_459_821_093_813_268n);

    expect(client.priceCalls[0]).toEqual({
      projectId: 6n,
      // uint32(uint160(USDC)) -- the accounting-context namespace.
      pricingCurrency: 3_181_390_099n,
      // JBCurrencyIds.USD, out of the packed ruleset metadata.
      unitCurrency: 2n,
      decimals: 6n,
    });
  });

  it("does not invent a floor when no hook claimed the payment", async () => {
    // A genuinely zero-issuance project: nothing was diverted, the terminal
    // simply mints nothing. Inventing a floor here would be a lie.
    expect(await quoteTokens(reads({ hookAmounts: [] }), PARAMS)).toBe(0n);
  });

  it("does not invent a floor when a hook claimed only part of the payment", async () => {
    const client = reads({ hookAmounts: [TWENTY_FIVE_USDC - 1n] });

    expect(await quoteTokens(client, PARAMS)).toBe(0n);
    expect(client.priceCalls).toHaveLength(0);
  });

  it("skips the price read when the payment currency is the base currency", async () => {
    // baseCurrency = uint32(uint160(USDC)) = 3181390099, packed at bit 36.
    const usdcBase = (ART_METADATA & ~(0xffffffffn << 36n)) | (3_181_390_099n << 36n);
    const client = reads({ rulesetMetadata: usdcBase, hookAmounts: [TWENTY_FIVE_USDC] });

    const tokenCount = (TWENTY_FIVE_USDC * ART_WEIGHT) / 1_000_000n;
    expect(await quoteTokens(client, PARAMS)).toBe((tokenCount * 6000n) / 10_000n);
    expect(client.priceCalls).toHaveLength(0);
  });

  it("floors to zero for a ruleset with no issuance weight", async () => {
    const client = reads({ weight: 0n, hookAmounts: [TWENTY_FIVE_USDC] });

    expect(await quoteTokens(client, PARAMS)).toBe(0n);
    expect(client.priceCalls).toHaveLength(0);
  });
});

describe("liveQuoteReads", () => {
  const TERMINAL = "0x1111111111111111111111111111111111111111" as const;
  const USDC_ON_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
  const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

  it("calls previewPayFor on the given terminal with the expected args", async () => {
    const readContract = vi.fn().mockResolvedValue([
      { weight: 5n, metadata: 9n },
      123_456n,
      0n,
      [{ hook: ZERO_ADDRESS, noop: false, amount: 7n, metadata: "0x" }],
    ]);

    const preview = await liveQuoteReads(
      { readContract } as unknown as Parameters<typeof liveQuoteReads>[0],
    ).previewPayFor({ terminal: TERMINAL, projectId: 7n, usdcAmountWei: 1_000_000n });

    expect(preview).toEqual({
      weight: 5n,
      rulesetMetadata: 9n,
      beneficiaryTokenCount: 123_456n,
      hookAmounts: [7n],
    });

    const call = readContract.mock.calls[0]?.[0];
    expect(call.address).toBe(TERMINAL);
    expect(call.functionName).toBe("previewPayFor");
    expect(call.args).toEqual([7n, USDC_ON_BASE, 1_000_000n, ZERO_ADDRESS, "0x"]);
  });

  it("resolves JBPrices from the controller once and reuses it", async () => {
    process.env.JB_CONTROLLER_ADDRESS = "0x3Fcec3572e84b624477BcfF4E2CF1f7dEAb648F1";
    const prices = "0xad45E4627f068d1e6b21E5301870d807543a8401";
    const readContract = vi.fn(async (args: { functionName: string }) =>
      args.functionName === "PRICES" ? prices : 1_000_189n,
    );

    try {
      const live = liveQuoteReads(
        { readContract } as unknown as Parameters<typeof liveQuoteReads>[0],
      );
      const args = { projectId: 6n, pricingCurrency: 1n, unitCurrency: 2n, decimals: 6n };
      expect(await live.pricePerUnit(args)).toBe(1_000_189n);
      expect(await live.pricePerUnit(args)).toBe(1_000_189n);

      const priceReads = readContract.mock.calls.filter(
        (call) => call[0].functionName === "PRICES",
      );
      expect(priceReads).toHaveLength(1);
      expect(readContract.mock.calls.at(-1)?.[0]).toMatchObject({ address: prices });
    } finally {
      delete process.env.JB_CONTROLLER_ADDRESS;
    }
  });
});
