import { describe, expect, it } from "vitest";
import { feePaymentId, paymentIdBytes32, processPayment } from "../src/chain/escrow.js";

describe("paymentIdBytes32", () => {
  it("strips dashes and left-pads a UUID to a 32-byte hex value", () => {
    // Fixed vector: a well-known example UUID.
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const result = paymentIdBytes32(uuid);
    expect(result).toBe(
      "0x00000000000000000000000000000000550e8400e29b41d4a716446655440000",
    );
    expect(result.length).toBe(66); // "0x" + 64 hex chars = 32 bytes.
  });

  it("lower-cases hex digits regardless of input casing", () => {
    const uuid = "550E8400-E29B-41D4-A716-446655440000";
    expect(paymentIdBytes32(uuid)).toBe(
      "0x00000000000000000000000000000000550e8400e29b41d4a716446655440000",
    );
  });

  it("is deterministic (same uuid -> same bytes32)", () => {
    const uuid = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
    expect(paymentIdBytes32(uuid)).toBe(paymentIdBytes32(uuid));
  });

  it("throws for a malformed uuid", () => {
    expect(() => paymentIdBytes32("not-a-uuid")).toThrow();
    expect(() => paymentIdBytes32("550e8400e29b41d4a716446655440000")).toThrow(); // missing dashes
    expect(() => paymentIdBytes32("")).toThrow();
  });
});

describe("feePaymentId", () => {
  it("matches `cast keccak` for a fixed paymentId vector", () => {
    // paymentId = paymentIdBytes32("550e8400-e29b-41d4-a716-446655440000")
    const paymentId =
      "0x00000000000000000000000000000000550e8400e29b41d4a716446655440000" as const;
    // Cross-checked with:
    //   cast keccak 0x00000000000000000000000000000000550e8400e29b41d4a716446655440000666565
    // ("666565" = utf8 "fee" as hex, concatenated onto the 32-byte paymentId
    // before hashing -- matches Solidity's keccak256(abi.encodePacked(paymentId, "fee")).)
    const EXPECTED =
      "0x86b903636417ac91e4b3bd163d555d56ca636282e180254fd94e8afd047960ad" as const;
    expect(feePaymentId(paymentId)).toBe(EXPECTED);
  });

  it("is deterministic (same paymentId -> same feePaymentId)", () => {
    const paymentId = paymentIdBytes32("6ba7b810-9dad-11d1-80b4-00c04fd430c8");
    expect(feePaymentId(paymentId)).toBe(feePaymentId(paymentId));
  });

  it("differs from the underlying paymentId (it's a hash, not an identity)", () => {
    const paymentId = paymentIdBytes32("6ba7b810-9dad-11d1-80b4-00c04fd430c8");
    expect(feePaymentId(paymentId)).not.toBe(paymentId);
  });

  it("throws for a value that isn't a 32-byte hex string", () => {
    expect(() => feePaymentId("0x1234" as `0x${string}`)).toThrow();
  });
});

describe("processPayment", () => {
  const ESCROW = "0x00000000000000000000000000000000000e5c70";
  const PAYMENT_ID = paymentIdBytes32("550e8400-e29b-41d4-a716-446655440000");

  /**
   * A client pair that gets as far as a mined transaction and then reports
   * whatever `status` the case wants. Enough to drive the one branch that
   * cannot be reached on a fork on demand: a transaction that simulates and
   * then reverts.
   */
  function clients(status: "success" | "reverted", logs: unknown[] = []) {
    return {
      publicClient: {
        simulateContract: async () => ({ request: {} }),
        waitForTransactionReceipt: async () => ({ status, logs }),
      },
      walletClient: {
        account: { address: "0x0000000000000000000000000000000000000001" },
        writeContract: async () => `0x${"ab".repeat(32)}`,
      },
    } as unknown as Parameters<typeof processPayment>[0];
  }

  const params = {
    paymentId: PAYMENT_ID,
    terminal: "0x00000000000000000000000000000000000f0001",
    projectId: 1n,
    usdcAmountWei: 1_000_000n,
    minReturnedTokens: 0n,
    projectToken: "0x00000000000000000000000000000000000f0002",
    beneficiary: "0x00000000000000000000000000000000000f0003",
    unlockAt: 1_800_000_000,
    memo: "test",
  } as unknown as Parameters<typeof processPayment>[1];

  it("reports a reverted transaction as a revert, not as a missing event", async () => {
    process.env.ESCROW_ADDRESS = ESCROW;
    try {
      await expect(processPayment(clients("reverted"), params)).rejects.toThrow(
        /reverted onchain/,
      );
    } finally {
      delete process.env.ESCROW_ADDRESS;
    }
  });

  it("still reports a missing event when the transaction did succeed", async () => {
    process.env.ESCROW_ADDRESS = ESCROW;
    try {
      await expect(processPayment(clients("success"), params)).rejects.toThrow(
        /no Processed event/,
      );
    } finally {
      delete process.env.ESCROW_ADDRESS;
    }
  });
});
