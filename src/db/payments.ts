import type { Pool } from "pg";

/**
 * Anything that can run a query: a `Pool` or a `PoolClient` checked out of
 * one. Taking the narrower type lets callers run these helpers inside a
 * transaction (`BEGIN`/`COMMIT` on a single client) rather than only on
 * autocommit connections from the pool -- the Stripe webhook needs exactly
 * that so a mid-handler failure rolls back its idempotency marker too.
 */
export type Queryable = Pick<Pool, "query">;

export type PaymentState =
  | "created"
  | "paid"
  | "settled"
  | "paying"
  | "held"
  | "unlocked"
  | "claimed"
  | "refunded"
  | "forfeited"
  | "canceled";

export interface PaymentRow {
  id: string;
  project_id: string;
  email: string;
  amount_usd_cents: string;
  premium_usd_cents: string;
  instant: boolean;
  method: "card" | "bank" | null;
  state: PaymentState;
  stripe_session_id: string | null;
  stripe_payment_intent: string | null;
  quote_tokens: string | null;
  tokens_held: string | null;
  pay_tx: string | null;
  unlock_at: Date | null;
  claim_address: string | null;
  release_tx: string | null;
  /** Set once the worker has drawn this payment's USDC from the instant pool. */
  pool_draw_tx: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreatePaymentInput {
  projectId: number;
  email: string;
  amountUsdCents: bigint;
  instant: boolean;
  /**
   * Service fee charged on top of the donation (instant payments only). The
   * payer is charged `amountUsdCents + premiumUsdCents`; only
   * `amountUsdCents` is ever paid on-chain.
   */
  premiumUsdCents?: bigint;
  /** Beneficiary of the escrowed tokens, known before the payer ever reaches Stripe. */
  claimAddress?: string;
  /** Tokens the terminal previewed for this donation, as an integer string. */
  quoteTokens?: bigint | string;
}

export async function createPayment(
  pool: Queryable,
  input: CreatePaymentInput,
): Promise<PaymentRow> {
  const {
    projectId,
    email,
    amountUsdCents,
    instant,
    premiumUsdCents,
    claimAddress,
    quoteTokens,
  } = input;
  const result = await pool.query<PaymentRow>(
    `INSERT INTO payments
       (project_id, email, amount_usd_cents, premium_usd_cents, instant, claim_address, quote_tokens)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      projectId,
      email,
      amountUsdCents,
      premiumUsdCents ?? 0n,
      instant,
      claimAddress ?? null,
      quoteTokens === undefined ? null : quoteTokens.toString(),
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("createPayment: insert returned no row");
  }
  return row;
}

export class TransitionError extends Error {
  readonly id: string;
  readonly from: PaymentState[];
  readonly to: PaymentState;

  constructor(id: string, from: PaymentState[], to: PaymentState) {
    super(
      `payment ${id}: cannot transition to '${to}' (not currently in one of [${from.join(", ")}])`,
    );
    this.name = "TransitionError";
    this.id = id;
    this.from = from;
    this.to = to;
  }
}

/**
 * Columns `transition` is allowed to patch alongside a state change. Keys
 * are always checked against this set before being interpolated as SQL
 * identifiers -- patch values themselves are always passed as bound
 * parameters, never interpolated.
 */
const PATCHABLE_COLUMNS = new Set([
  "method",
  "stripe_session_id",
  "stripe_payment_intent",
  "quote_tokens",
  "tokens_held",
  "pay_tx",
  "unlock_at",
  "claim_address",
  "release_tx",
]);

export type PaymentPatch = Partial<{
  method: "card" | "bank";
  stripe_session_id: string;
  stripe_payment_intent: string;
  quote_tokens: string;
  tokens_held: string;
  pay_tx: string;
  unlock_at: Date;
  claim_address: string;
  release_tx: string;
}>;

/**
 * Moves a payment from one of `from` to `to`, at most once. The guarantee
 * comes from a single UPDATE with `WHERE id = $id AND state = ANY($from)`:
 * if the row isn't currently in one of the `from` states (e.g. a concurrent
 * caller already moved it), rowCount is 0 and we throw TransitionError
 * instead of silently no-op'ing.
 */
export async function transition(
  pool: Queryable,
  id: string,
  from: PaymentState[],
  to: PaymentState,
  patch?: PaymentPatch,
): Promise<PaymentRow> {
  const setClauses = ["state = $1", "updated_at = now()"];
  const values: unknown[] = [to];

  if (patch) {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (!PATCHABLE_COLUMNS.has(key)) {
        throw new Error(`transition: '${key}' is not a patchable column`);
      }
      values.push(value);
      setClauses.push(`${key} = $${values.length}`);
    }
  }

  values.push(id);
  const idParamIndex = values.length;
  values.push(from);
  const fromParamIndex = values.length;

  const sql = `UPDATE payments SET ${setClauses.join(", ")} WHERE id = $${idParamIndex} AND state = ANY($${fromParamIndex}) RETURNING *`;
  const result = await pool.query<PaymentRow>(sql, values);

  if (result.rowCount !== 1) {
    throw new TransitionError(id, from, to);
  }

  const row = result.rows[0];
  if (!row) {
    throw new TransitionError(id, from, to);
  }
  return row;
}
