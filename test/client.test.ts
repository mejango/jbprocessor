import { afterEach, describe, expect, it } from "vitest";
import { publicClient, resetClients, walletClient } from "../src/chain/client.js";

const ORIGINAL_RPC_URL = process.env.BASE_RPC_URL;
const ORIGINAL_PRIVATE_KEY = process.env.WORKER_PRIVATE_KEY;

function restoreEnv() {
  if (ORIGINAL_RPC_URL === undefined) delete process.env.BASE_RPC_URL;
  else process.env.BASE_RPC_URL = ORIGINAL_RPC_URL;
  if (ORIGINAL_PRIVATE_KEY === undefined) delete process.env.WORKER_PRIVATE_KEY;
  else process.env.WORKER_PRIVATE_KEY = ORIGINAL_PRIVATE_KEY;
}

afterEach(() => {
  restoreEnv();
  resetClients();
});

describe("publicClient", () => {
  it("throws when BASE_RPC_URL is unset", () => {
    delete process.env.BASE_RPC_URL;
    resetClients();
    expect(() => publicClient()).toThrow(/BASE_RPC_URL/);
  });

  it("builds a Base-chain (8453) client and memoizes it across calls", () => {
    process.env.BASE_RPC_URL = "https://example.invalid";
    resetClients();
    const a = publicClient();
    const b = publicClient();
    expect(a.chain?.id).toBe(8453);
    expect(a).toBe(b);
  });

  it("returns an explicit override without touching the memoized singleton", () => {
    process.env.BASE_RPC_URL = "https://example.invalid";
    resetClients();
    const memoized = publicClient();
    const override = { chain: { id: 999 } } as unknown as ReturnType<typeof publicClient>;
    expect(publicClient(override)).toBe(override);
    // The singleton built before the override call is untouched.
    expect(publicClient()).toBe(memoized);
  });
});

describe("walletClient", () => {
  it("throws when WORKER_PRIVATE_KEY is unset", () => {
    process.env.BASE_RPC_URL = "https://example.invalid";
    delete process.env.WORKER_PRIVATE_KEY;
    resetClients();
    expect(() => walletClient()).toThrow(/WORKER_PRIVATE_KEY/);
  });

  it("throws when WORKER_PRIVATE_KEY is malformed", () => {
    process.env.BASE_RPC_URL = "https://example.invalid";
    process.env.WORKER_PRIVATE_KEY = "not-a-key";
    resetClients();
    expect(() => walletClient()).toThrow(/WORKER_PRIVATE_KEY/);
  });

  it("builds a Base-chain client from a valid key and memoizes it", () => {
    process.env.BASE_RPC_URL = "https://example.invalid";
    process.env.WORKER_PRIVATE_KEY = `0x${"11".repeat(32)}`;
    resetClients();
    const a = walletClient();
    const b = walletClient();
    expect(a.chain?.id).toBe(8453);
    expect(a).toBe(b);
  });
});
