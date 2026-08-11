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
export function envBigInt(name: string, fallback: bigint): bigint {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a non-negative integer, got: ${raw}`);
  }
  return BigInt(raw);
}
