/**
 * Reads a non-negative integer from the environment, falling back to
 * `fallback` when the variable is unset or empty. Anything that isn't a
 * plain integer throws rather than becoming `NaN` -- a `NaN` ceiling or
 * hold period compares false against everything and would silently disable
 * the check it configures.
 *
 * Values are read fresh on every call (not memoized) so tests can set and
 * unset them freely; the parse is cheap.
 */
import { isAddress, type Address } from "viem";

/** Reads a required environment variable, throwing when it's unset or empty. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} environment variable is not set`);
  }
  return value;
}

/** Reads a required environment variable that must be an EVM address. */
export function envAddress(name: string): Address {
  const value = requireEnv(name);
  if (!isAddress(value)) {
    throw new Error(`${name} must be a 0x-prefixed 20-byte hex address, got: ${value}`);
  }
  return value;
}

export function envBigInt(name: string, fallback: bigint): bigint {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a non-negative integer, got: ${raw}`);
  }
  return BigInt(raw);
}
