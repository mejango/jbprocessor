import { formatUnits } from "viem";

/** Project tokens are 18-decimal ERC-20s, like every Juicebox project token. */
const TOKEN_DECIMALS = 18;

/** `2500` -> `$25.00`. Cents arrive as strings straight out of Postgres. */
export function formatUsdCents(cents: string | bigint): string {
  const value = typeof cents === "bigint" ? cents : BigInt(cents);
  const whole = value / 100n;
  const remainder = value % 100n;
  return `$${whole.toLocaleString("en-US")}.${remainder.toString().padStart(2, "0")}`;
}

/**
 * Token base units -> a readable amount, trimmed to 4 decimal places. Display
 * only: nothing downstream ever parses this back into a number.
 */
export function formatTokens(baseUnits: string | bigint | null): string {
  if (baseUnits === null) return "--";
  const value = typeof baseUnits === "bigint" ? baseUnits : BigInt(baseUnits);
  const asDecimal = formatUnits(value, TOKEN_DECIMALS);
  const [whole = "0", fraction = ""] = asDecimal.split(".");
  const trimmed = fraction.slice(0, 4).replace(/0+$/, "");
  const grouped = Number(whole).toLocaleString("en-US");
  return trimmed ? `${grouped}.${trimmed}` : grouped;
}

/** Base transaction link. Base is the only chain this service touches. */
export function basescanTx(hash: string): string {
  return `https://basescan.org/tx/${hash}`;
}

/** `0x1234...cdef`, for addresses shown inline. */
export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}...${address.slice(-4)}` : address;
}
