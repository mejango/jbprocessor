import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { driftExceeded, quoteTokens } from "../src/chain/quote.js";

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
  const TERMINAL = "0x11111111111111111111111111111111111111" as const;
  const USDC_ON_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
  const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

  it("calls previewPayFor on the given terminal with the expected args and returns beneficiaryTokenCount", async () => {
    const mockRuleset = {
      cycleNumber: 1n,
      id: 1n,
      basedOnId: 0n,
      start: 0n,
      duration: 0,
      weight: 0n,
      weightCutPercent: 0,
      approvalHook: ZERO_ADDRESS,
      metadata: 0n,
    };
    const readContract = vi.fn().mockResolvedValue([mockRuleset, 123_456n, 0n, []]);
    const client = { readContract };

    const result = await quoteTokens(client, {
      terminal: TERMINAL,
      projectId: 7n,
      usdcAmountWei: 1_000_000n,
    });

    expect(result).toBe(123_456n);
    expect(readContract).toHaveBeenCalledTimes(1);
    const firstCall = readContract.mock.calls[0];
    if (!firstCall) throw new Error("readContract was not called");
    const call = firstCall[0];
    expect(call.address).toBe(TERMINAL);
    expect(call.functionName).toBe("previewPayFor");
    expect(call.args).toEqual([7n, USDC_ON_BASE, 1_000_000n, ZERO_ADDRESS, "0x"]);
  });
});
