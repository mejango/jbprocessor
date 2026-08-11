import { isAddress, type Address } from "viem";
import { normalizeEmail } from "../auth/magic.js";
import type { Queryable } from "../db/payments.js";
import { requireEnv } from "../env.js";
import type { WalletProvider } from "./types.js";

/**
 * The whole of Para this service uses: mint one EVM wallet that the payer can
 * later claim with their email. Everything else about Para -- MPC shares,
 * sessions, signing -- happens in the payer's own browser when they claim, so
 * the server never holds anything that can move their tokens.
 *
 * The interface exists so that the DB memoization below (the part with the
 * correctness burden) is testable without Para credentials or a network.
 */
export interface ParaClient {
  /** Returns the address of a freshly pregenerated wallet keyed to `email`. */
  createPregenWallet(email: string): Promise<string>;
}

export interface ParaDeps {
  pool: Queryable;
  para: ParaClient;
}

/**
 * Returns the payer's pregenerated wallet, minting one the first time.
 *
 * One email must map to one address forever: the address is baked into an
 * escrow entry at pay time, and a payer who later got a *second* wallet would
 * claim an account that holds none of their tokens. The `pregen_wallets`
 * primary key is what enforces that, not this function's read -- two
 * concurrent checkouts both mint at Para, but only one row is ever written and
 * both callers return the winner's address. The loser's Para wallet is simply
 * never referenced (Para has no delete, and an unreferenced pregen wallet
 * costs nothing); what matters is that the payer is never told about two.
 */
export async function getOrCreatePregenWallet(
  deps: ParaDeps,
  email: string,
): Promise<Address> {
  const normalized = normalizeEmail(email);

  const existing = await deps.pool.query<{ address: string }>(
    "SELECT address FROM pregen_wallets WHERE email = $1",
    [normalized],
  );
  const found = existing.rows[0]?.address;
  if (found) return requireAddress(found);

  const minted = requireAddress(await deps.para.createPregenWallet(normalized));

  const inserted = await deps.pool.query<{ address: string }>(
    `INSERT INTO pregen_wallets (email, address) VALUES ($1, $2)
     ON CONFLICT (email) DO NOTHING
     RETURNING address`,
    [normalized, minted],
  );
  const winner = inserted.rows[0]?.address;
  if (winner) return requireAddress(winner);

  // Lost the race: another caller's row is authoritative.
  const settled = await deps.pool.query<{ address: string }>(
    "SELECT address FROM pregen_wallets WHERE email = $1",
    [normalized],
  );
  const settledAddress = settled.rows[0]?.address;
  if (!settledAddress) {
    throw new Error(`pregen wallet for ${normalized}: insert conflicted but no row exists`);
  }
  console.warn(
    `pregen wallet for ${normalized}: lost the insert race, using the stored address`,
  );
  return requireAddress(settledAddress);
}

function requireAddress(value: string): Address {
  if (!isAddress(value)) {
    throw new Error(`pregen wallet: not a valid EVM address: ${value}`);
  }
  return value;
}

/** Adapts the memoized lookup to the `WalletProvider` checkout depends on. */
export function paraWalletProvider(deps: ParaDeps): WalletProvider {
  return {
    getOrCreatePregenWallet: (email) => getOrCreatePregenWallet(deps, email),
  };
}

const PARA_ENVIRONMENTS = ["DEV", "SANDBOX", "BETA", "PROD"] as const;

/**
 * The live client, bound to `PARA_API_KEY` / `PARA_ENVIRONMENT`.
 *
 * The SDK is imported dynamically, and the instance is built per call rather
 * than at module load: `@getpara/server-sdk` pulls in a WASM MPC bundle and a
 * large dependency tree, and no process that never mints a wallet (the worker,
 * the account pages) should pay to load it -- or fail to boot because the Para
 * credentials aren't configured in that deployment.
 */
export function liveParaClient(): ParaClient {
  return {
    createPregenWallet: async (email: string) => {
      const apiKey = requireEnv("PARA_API_KEY");
      const environment = process.env.PARA_ENVIRONMENT ?? "PROD";
      if (!(PARA_ENVIRONMENTS as readonly string[]).includes(environment)) {
        throw new Error(
          `PARA_ENVIRONMENT must be one of ${PARA_ENVIRONMENTS.join(", ")}, got: ${environment}`,
        );
      }

      const { Para } = await import("@getpara/server-sdk");
      const para = new Para(environment as never, apiKey);
      const wallet = await para.createPregenWallet({
        type: "EVM",
        pregenId: { email },
      });

      if (!wallet.address) {
        throw new Error(`Para returned a pregen wallet with no address for ${email}`);
      }
      return wallet.address;
    },
  };
}
