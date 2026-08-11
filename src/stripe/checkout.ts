import type Stripe from "stripe";
import { isAddress, type Address } from "viem";
import { erc20Abi } from "../chain/abi/erc20.js";
import { publicClient } from "../chain/client.js";
import {
  quoteTokens,
  USDC_ON_BASE,
  USDC_WEI_PER_CENT,
  type ReadContractClient,
} from "../chain/quote.js";
import { createPayment, type Queryable } from "../db/payments.js";
import { envAddress, envBigInt, requireEnv } from "../env.js";
import type { WalletProvider } from "../wallets/types.js";

const BPS_DENOMINATOR = 10_000n;

const DEFAULT_CARD_CEILING_USD_CENTS = 50_000n;
const DEFAULT_PREMIUM_BPS = 150n;

/**
 * Payment states whose USDC is committed to the instant pool but not yet
 * drawn from it: the row will (or already did) ask the worker to spend pool
 * funds, and hasn't been settled by the payer's own Stripe money landing.
 * Anything terminal (`refunded`, `canceled`, `forfeited`) or already
 * reimbursed (`held` onward) is not counted against headroom.
 */
const IN_FLIGHT_INSTANT_STATES = ["created", "paid", "paying"] as const;

export type CheckoutErrorCode =
  | "unknown_project"
  | "project_suspended"
  | "invalid_amount"
  | "invalid_wallet_address"
  | "insufficient_pool_headroom"
  | "stripe_session_missing_url";

/** A rejection the caller can map to a 4xx, as opposed to an unexpected fault. */
export class CheckoutError extends Error {
  readonly code: CheckoutErrorCode;

  constructor(code: CheckoutErrorCode, message: string) {
    super(message);
    this.name = "CheckoutError";
    this.code = code;
  }
}

/**
 * The slice of the Stripe SDK checkout needs. A real `Stripe` instance
 * satisfies it structurally (its `create` returns `Response<Session>`, which
 * is a `Session` plus response metadata), and a test can supply a two-field
 * object instead of a network client.
 */
export interface StripeCheckoutClient {
  checkout: {
    sessions: {
      create(
        params: Stripe.Checkout.SessionCreateParams,
      ): Promise<{ id: string; url: string | null }>;
    };
  };
}

export interface CheckoutDeps {
  pool: Queryable;
  stripe: StripeCheckoutClient;
  quoteClient: ReadContractClient;
  wallets: WalletProvider;
  /**
   * Reads the USDC allowance the instant pool has granted an address.
   * Defaults to a live Base read; injectable so tests (and the headroom
   * check's callers) don't need an RPC.
   */
  readAllowance?: (owner: Address, spender: Address) => Promise<bigint>;
}

export interface CreateCheckoutSessionInput {
  projectId: number;
  amountUsdCents: bigint;
  email: string;
  instant: boolean;
  /** Payer-supplied beneficiary. When omitted, a pregen wallet is minted for `email`. */
  walletAddress?: string;
}

export interface CreateCheckoutSessionResult {
  url: string;
  paymentId: string;
}

/**
 * Stripe's `unit_amount` is a JSON number. Money is tracked as bigint cents
 * everywhere else in this service; this is the single conversion point, and
 * it refuses anything outside the exactly-representable integer range rather
 * than letting a float round a charge.
 */
function centsToStripeAmount(cents: bigint): number {
  if (cents <= 0n || cents > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new CheckoutError(
      "invalid_amount",
      `amount must be a positive integer number of cents within Number's safe range, got: ${cents}`,
    );
  }
  return Number(cents);
}

async function defaultReadAllowance(owner: Address, spender: Address): Promise<bigint> {
  return publicClient().readContract({
    address: USDC_ON_BASE,
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner, spender],
  });
}

interface ProjectRow {
  project_id: string;
  name: string;
  terminal_address: string;
  status: string;
}

/**
 * How much instant-pool USDC is still uncommitted: the pool's standing
 * allowance to the worker, minus every in-flight instant payment's donation.
 *
 * The worker address comes from `WORKER_ADDRESS`, deliberately *not* derived
 * from `WORKER_PRIVATE_KEY` -- checkout runs in the web process, which must
 * never hold the signing key.
 */
export async function instantPoolHeadroomWei(
  pool: Queryable,
  readAllowance: (owner: Address, spender: Address) => Promise<bigint>,
): Promise<bigint> {
  const allowance = await readAllowance(
    envAddress("INSTANT_POOL_ADDRESS"),
    envAddress("WORKER_ADDRESS"),
  );

  const { rows } = await pool.query<{ committed_cents: string }>(
    `SELECT COALESCE(SUM(amount_usd_cents), 0)::text AS committed_cents
       FROM payments
      WHERE instant AND state = ANY($1)`,
    [IN_FLIGHT_INSTANT_STATES],
  );
  const committedCents = BigInt(rows[0]?.committed_cents ?? "0");

  const headroom = allowance - committedCents * USDC_WEI_PER_CENT;
  return headroom > 0n ? headroom : 0n;
}

/**
 * Creates a Stripe Checkout Session for a donation and the `payments` row
 * that tracks it. Order matters: everything that can reject (project state,
 * ceiling, headroom, beneficiary, quote) happens before any row is written,
 * so a rejected request leaves no trace; and the row is written before the
 * Stripe call so `metadata.payment_id` can carry our id into every webhook.
 *
 * Money is bigint cents throughout -- the only conversions are cents ->
 * 6-decimal USDC base units for the on-chain quote, and cents -> `number`
 * at the Stripe boundary.
 */
export async function createCheckoutSession(
  deps: CheckoutDeps,
  input: CreateCheckoutSessionInput,
): Promise<CreateCheckoutSessionResult> {
  const { pool, stripe, quoteClient, wallets } = deps;
  const readAllowance = deps.readAllowance ?? defaultReadAllowance;
  const { projectId, amountUsdCents, email, instant } = input;

  if (amountUsdCents <= 0n) {
    throw new CheckoutError(
      "invalid_amount",
      `amountUsdCents must be positive, got: ${amountUsdCents}`,
    );
  }

  const { rows } = await pool.query<ProjectRow>(
    "SELECT project_id, name, terminal_address, status FROM projects WHERE project_id = $1",
    [projectId],
  );
  const project = rows[0];
  if (!project) {
    throw new CheckoutError("unknown_project", `no project with id ${projectId}`);
  }
  if (project.status !== "active") {
    throw new CheckoutError(
      "project_suspended",
      `project ${projectId} is not accepting payments (status: ${project.status})`,
    );
  }

  // Above the ceiling the card rail is refused outright: card chargebacks
  // run 120 days and the escrow can't cover an unbounded one, so large
  // donations are bank-only rather than merely held longer.
  const ceiling = envBigInt("CARD_CEILING_USD_CENTS", DEFAULT_CARD_CEILING_USD_CENTS);
  const cardAllowed = amountUsdCents <= ceiling;
  const paymentMethodTypes: Stripe.Checkout.SessionCreateParams.PaymentMethodType[] =
    cardAllowed ? ["card", "us_bank_account"] : ["us_bank_account"];

  const usdcAmountWei = amountUsdCents * USDC_WEI_PER_CENT;

  if (instant) {
    const headroom = await instantPoolHeadroomWei(pool, readAllowance);
    if (usdcAmountWei > headroom) {
      throw new CheckoutError(
        "insufficient_pool_headroom",
        `instant pool has ${headroom} USDC base units of headroom, need ${usdcAmountWei}`,
      );
    }
  }

  let claimAddress: Address;
  if (input.walletAddress !== undefined) {
    if (!isAddress(input.walletAddress)) {
      throw new CheckoutError(
        "invalid_wallet_address",
        `not a valid address: ${input.walletAddress}`,
      );
    }
    claimAddress = input.walletAddress;
  } else {
    claimAddress = await wallets.getOrCreatePregenWallet(email);
  }

  const quotedTokens = await quoteTokens(quoteClient, {
    terminal: project.terminal_address as Address,
    projectId: BigInt(projectId),
    usdcAmountWei,
  });

  // The premium buys the payer an immediate on-chain pay out of the instant
  // pool; it's a service fee on top of the donation, so it's charged by
  // Stripe but never quoted or paid on-chain. Integer bigint math: truncated,
  // never rounded up.
  const premiumCents = instant
    ? (amountUsdCents * envBigInt("PREMIUM_BPS", DEFAULT_PREMIUM_BPS)) / BPS_DENOMINATOR
    : 0n;

  // Both of these can throw, so both happen before the insert -- nothing
  // between `createPayment` and the Stripe call may fail, or we'd orphan a
  // row that no session will ever reference.
  const unitAmount = centsToStripeAmount(amountUsdCents + premiumCents);
  const baseUrl = requireEnv("BASE_URL").replace(/\/+$/, "");

  const payment = await createPayment(pool, {
    projectId,
    email,
    amountUsdCents,
    premiumUsdCents: premiumCents,
    instant,
    claimAddress,
    quoteTokens: quotedTokens,
  });

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    payment_method_types: paymentMethodTypes,
    // Force a 3DS challenge on every card: it shifts liability for
    // fraudulent-use chargebacks, the one dispute class the escrow can't
    // recover from.
    ...(cardAllowed
      ? { payment_method_options: { card: { request_three_d_secure: "any" as const } } }
      : {}),
    customer_email: email,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: unitAmount,
          product_data: {
            name: instant ? `${project.name} (instant)` : project.name,
          },
        },
      },
    ],
    metadata: { payment_id: payment.id },
    success_url: `${baseUrl}/checkout/success?payment_id=${payment.id}`,
    cancel_url: `${baseUrl}/checkout/cancel?payment_id=${payment.id}`,
  });

  // Validate before persisting: a session with no redirect URL is one the
  // payer can never reach, so recording its id would only make the dead
  // session look live to reconciliation.
  if (!session.url) {
    throw new CheckoutError(
      "stripe_session_missing_url",
      `Stripe session ${session.id} has no redirect URL`,
    );
  }

  await pool.query("UPDATE payments SET stripe_session_id = $2, updated_at = now() WHERE id = $1", [
    payment.id,
    session.id,
  ]);

  return { url: session.url, paymentId: payment.id };
}
