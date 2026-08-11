import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} environment variable is not set`);
  }
  return value;
}

// Builder functions, called with the exact arguments used below, so the
// exported types below (`ReturnType<typeof buildPublicClient>`) resolve to
// whichever overload of createPublicClient/createWalletClient those
// arguments actually select. Deriving the type from the bare, ungenericized
// `createPublicClient`/`createWalletClient` reference instead picks a
// different (and here incompatible) overload and trips a TS "two different
// types with this name exist, but they are unrelated" error.
function buildPublicClient(rpcUrl: string) {
  return createPublicClient({ chain: base, transport: http(rpcUrl) });
}

function buildWalletClient(rpcUrl: string, privateKey: `0x${string}`) {
  return createWalletClient({
    account: privateKeyToAccount(privateKey),
    chain: base,
    transport: http(rpcUrl),
  });
}

export type AppPublicClient = ReturnType<typeof buildPublicClient>;
export type AppWalletClient = ReturnType<typeof buildWalletClient>;

let cachedPublicClient: AppPublicClient | undefined;
let cachedWalletClient: AppWalletClient | undefined;

/**
 * Returns the process-wide viem public client for Base (chainId 8453),
 * memoized on first use. RPC URL comes from `BASE_RPC_URL`.
 *
 * Pass `override` to inject a client (e.g. an anvil-fork client, or a stub
 * for unit tests) without touching the memoized singleton -- the override is
 * returned as-is and never cached.
 */
export function publicClient(override?: AppPublicClient): AppPublicClient {
  if (override) return override;
  if (!cachedPublicClient) {
    cachedPublicClient = buildPublicClient(requireEnv("BASE_RPC_URL"));
  }
  return cachedPublicClient;
}

/**
 * Returns the process-wide viem wallet client for Base, memoized on first
 * use. RPC URL comes from `BASE_RPC_URL`; the signing key comes from
 * `WORKER_PRIVATE_KEY` (a `0x`-prefixed 32-byte hex string).
 *
 * Pass `override` to inject a client without touching the memoized
 * singleton, same as `publicClient`.
 */
export function walletClient(override?: AppWalletClient): AppWalletClient {
  if (override) return override;
  if (!cachedWalletClient) {
    const privateKey = requireEnv("WORKER_PRIVATE_KEY");
    if (!PRIVATE_KEY_PATTERN.test(privateKey)) {
      throw new Error(
        "WORKER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string",
      );
    }
    cachedWalletClient = buildWalletClient(
      requireEnv("BASE_RPC_URL"),
      privateKey as `0x${string}`,
    );
  }
  return cachedWalletClient;
}

/**
 * Clears both memoized clients. Tests that set/unset `BASE_RPC_URL` or
 * `WORKER_PRIVATE_KEY` between cases should call this in `beforeEach` /
 * `afterEach` so a client built under a previous env doesn't leak in.
 */
export function resetClients(): void {
  cachedPublicClient = undefined;
  cachedWalletClient = undefined;
}
