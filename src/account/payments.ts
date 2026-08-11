import { normalizeEmail } from "../auth/magic.js";
import type { PaymentState, Queryable } from "../db/payments.js";

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * What a payer is told their payment is doing. Sentence case, no jargon the
 * donor didn't sign up for: they gave money to a project, and these are the
 * stops between that and tokens in a wallet.
 */
const STATE_LABELS: Record<PaymentState, string> = {
  created: "Awaiting payment",
  paid: "Payment received",
  settled: "Payment settled",
  paying: "Buying tokens onchain",
  held: "Tokens held in escrow",
  unlocked: "Unlocked, delivery pending",
  claimed: "Tokens delivered",
  refunded: "Refunded",
  forfeited: "Forfeited after a dispute",
  canceled: "Canceled",
};

export function stateLabel(state: PaymentState): string {
  return STATE_LABELS[state];
}

/**
 * The public, integrator-facing view of a payment (Artizen polls this to show
 * a donor their status). Deliberately email-free: the id is a capability
 * anyone with the checkout link holds, and it must not turn into a lookup from
 * payment id to the payer's address.
 */
export interface PublicPaymentView {
  state: PaymentState;
  amountUsdCents: string;
  premiumUsdCents: string;
  quoteTokens: string | null;
  tokensHeld: string | null;
  beneficiary: string | null;
  unlockAt: string | null;
  payTx: string | null;
  releaseTx: string | null;
}

interface PublicRow {
  state: PaymentState;
  amount_usd_cents: string;
  premium_usd_cents: string;
  quote_tokens: string | null;
  tokens_held: string | null;
  claim_address: string | null;
  unlock_at: Date | null;
  pay_tx: string | null;
  release_tx: string | null;
}

/**
 * Returns the public view, or null when there's no such payment. A malformed
 * id is null too rather than an error: the id comes straight off a URL, and a
 * typo is a 404, not a 500.
 */
export async function publicPaymentView(
  pool: Queryable,
  id: string,
): Promise<PublicPaymentView | null> {
  if (!UUID_PATTERN.test(id)) return null;

  const { rows } = await pool.query<PublicRow>(
    `SELECT state, amount_usd_cents, premium_usd_cents, quote_tokens, tokens_held,
            claim_address, unlock_at, pay_tx, release_tx
       FROM payments WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;

  return {
    state: row.state,
    amountUsdCents: row.amount_usd_cents,
    premiumUsdCents: row.premium_usd_cents,
    quoteTokens: row.quote_tokens,
    tokensHeld: row.tokens_held,
    beneficiary: row.claim_address,
    unlockAt: row.unlock_at ? row.unlock_at.toISOString() : null,
    payTx: row.pay_tx,
    releaseTx: row.release_tx,
  };
}

/** One row of the account page. */
export interface AccountPaymentView {
  id: string;
  projectId: string;
  projectName: string;
  amountUsdCents: string;
  premiumUsdCents: string;
  state: PaymentState;
  stateLabel: string;
  quoteTokens: string | null;
  tokensHeld: string | null;
  destination: string | null;
  /** A destination change that is queued but not yet onchain, if there is one. */
  pendingDestination: string | null;
  unlockAt: string | null;
  /** Whole days until unlock, or null when there's nothing left to wait for. */
  unlockInDays: number | null;
  payTx: string | null;
  releaseTx: string | null;
  canRedirect: boolean;
  createdAt: string;
}

interface AccountRow extends PublicRow {
  id: string;
  project_id: string;
  project_name: string;
  created_at: Date;
  pending_to_address: string | null;
}

export interface ListOptions {
  now?: () => number;
}

/**
 * Every payment made from `email`, newest first. Matched case-insensitively:
 * the session email comes from what the payer typed, the payment's from what
 * Stripe recorded, and those differ in case often enough to matter.
 */
export async function listAccountPayments(
  pool: Queryable,
  email: string,
  options: ListOptions = {},
): Promise<AccountPaymentView[]> {
  const now = options.now?.() ?? Date.now();

  const { rows } = await pool.query<AccountRow>(
    // The pending redirect is read from the job queue rather than a column:
    // the destination isn't recorded until both escrow legs are onchain, so
    // the queued job is the only place a payer's in-flight change exists.
    `SELECT p.id, p.project_id, pr.name AS project_name, p.state,
            p.amount_usd_cents, p.premium_usd_cents, p.quote_tokens, p.tokens_held,
            p.claim_address, p.unlock_at, p.pay_tx, p.release_tx, p.created_at,
            pending.to_address AS pending_to_address
       FROM payments p
       JOIN projects pr ON pr.project_id = p.project_id
       LEFT JOIN LATERAL (
         SELECT j.payload->>'to' AS to_address
           FROM jobs j
          WHERE j.kind = 'redirect'
            AND j.done_at IS NULL
            AND j.payload->>'paymentId' = p.id::text
          ORDER BY j.id DESC
          LIMIT 1
       ) pending ON true
      WHERE lower(p.email) = $1
      ORDER BY p.created_at DESC`,
    [normalizeEmail(email)],
  );

  return rows.map((row) => {
    // A payment with a redirect in flight can't take another one -- the same
    // rule the request path enforces, shown as a disabled form rather than a
    // rejection the payer has to discover by submitting.
    const canRedirect =
      (row.state === "held" || row.state === "unlocked") &&
      row.release_tx === null &&
      row.pending_to_address === null;

    return {
      id: row.id,
      projectId: row.project_id,
      projectName: row.project_name,
      amountUsdCents: row.amount_usd_cents,
      premiumUsdCents: row.premium_usd_cents,
      state: row.state,
      stateLabel: stateLabel(row.state),
      quoteTokens: row.quote_tokens,
      tokensHeld: row.tokens_held,
      destination: row.claim_address,
      pendingDestination: row.pending_to_address,
      unlockAt: row.unlock_at ? row.unlock_at.toISOString() : null,
      unlockInDays: unlockInDays(row, now),
      payTx: row.pay_tx,
      releaseTx: row.release_tx,
      canRedirect,
      createdAt: row.created_at.toISOString(),
    };
  });
}

/**
 * The address of the wallet this service pregenerated for `email`, if it made
 * one. The account page uses it to tell "tokens are going to a wallet you
 * already control" apart from "tokens are going to a wallet you still have to
 * claim with your email" -- the same address string, two very different things
 * for the payer to do.
 */
export async function pregenAddressFor(
  pool: Queryable,
  email: string,
): Promise<string | null> {
  const { rows } = await pool.query<{ address: string }>(
    "SELECT address FROM pregen_wallets WHERE email = $1",
    [normalizeEmail(email)],
  );
  return rows[0]?.address ?? null;
}

/**
 * Days left on the hold, rounded up so "less than a day" reads as 1 rather
 * than 0. Null once there is nothing to count down to -- the tokens have been
 * released, or the payment never reached the escrow at all.
 */
function unlockInDays(row: AccountRow, now: number): number | null {
  if (!row.unlock_at) return null;
  if (row.release_tx) return null;
  if (row.state !== "held" && row.state !== "paying" && row.state !== "unlocked") return null;

  const remaining = row.unlock_at.getTime() - now;
  if (remaining <= 0) return 0;
  return Math.ceil(remaining / DAY_MS);
}
