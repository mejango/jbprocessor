import { describe, expect, it } from "vitest";
import { feePaymentId, paymentIdBytes32 } from "../src/chain/escrow.js";

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
