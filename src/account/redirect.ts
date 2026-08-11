import type { Pool } from "pg";
import { isAddress, type Address } from "viem";
import { normalizeEmail } from "../auth/magic.js";
import { withTransaction } from "../db/index.js";
import { enqueue } from "../db/jobs.js";
import type { PaymentRow } from "../db/payments.js";
import type { RedirectJobPayload } from "../worker/redirect.js";

/**
 * How many destination changes one payment may make in a day. Redirects are
 * the power-user path -- nobody needs to use it at all -- so a low ceiling
 * costs a legitimate payer nothing and denies a stolen session the ability to
 * walk an escrow entry through addresses faster than the 48h onchain redirect
 * delay lets anyone notice.
 */
const MAX_REDIRECTS_PER_DAY = 3;

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export type RedirectErrorCode =
  | "not_found"
  | "forbidden"
  | "invalid_address"
  | "not_redirectable"
  | "redirect_pending"
  | "rate_limited";

const STATUS_BY_CODE: Record<RedirectErrorCode, number> = {
  not_found: 404,
  forbidden: 403,
  invalid_address: 400,
  not_redirectable: 409,
  redirect_pending: 409,
  rate_limited: 429,
};

/** A rejection the route maps straight to a status, as opposed to a fault. */
export class RedirectError extends Error {
  readonly code: RedirectErrorCode;
  readonly status: number;

  constructor(code: RedirectErrorCode, message: string) {
    super(message);
    this.name = "RedirectError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
  }
}

export interface RedirectDeps {
  pool: Pool;
}

export interface RedirectInput {
  paymentId: string;
  address: string;
  /** The email the session cookie proves. */
  sessionEmail: string;
}

export interface RedirectResult {
  status: "pending";
  /** The audit row that reserved this redirect's daily slot. */
  redirectId: string;
  jobId: string;
}

/**
 * Accepts a request to point a payment's escrowed tokens at a different
 * address, and hands the onchain work to the worker.
 *
 * The web process never signs. `setBeneficiary` is an operator-only call on
 * the escrow, and the operator can also `forfeit` -- so the key lives with the
 * worker, and this function's whole job is to decide whether the redirect is
 * allowed and then enqueue it. The caller gets a 202-shaped answer, not a
 * transaction hash.
 *
 * Everything happens in one transaction that starts by locking the payment
 * row, because all three gates -- state, "no redirect already in flight", and
 * the daily ceiling -- are read-then-act checks that a concurrent request
 * would otherwise slip between. With the lock, requests for the same payment
 * queue up and each one sees the previous one's committed effects. The daily
 * ceiling is additionally written as its own gate: the audit row is inserted
 * by a statement that only inserts when the count is still under the limit, so
 * even without the lock the ceiling could not be exceeded by a race.
 *
 * The slot is claimed *before* the send is scheduled, so a redirect that
 * fails onchain still costs its slot. That is the deliberate direction to err
 * in: the alternative is a failed send that costs nothing and can be retried
 * without limit.
 */
export async function requestRedirect(
  deps: RedirectDeps,
  input: RedirectInput,
): Promise<RedirectResult> {
  if (!isAddress(input.address)) {
    throw new RedirectError("invalid_address", `not a valid address: ${input.address}`);
  }
  const destination: Address = input.address;

  if (!UUID_PATTERN.test(input.paymentId)) {
    throw new RedirectError("not_found", `no payment with id ${input.paymentId}`);
  }

  return withTransaction(deps.pool, async (db) => {
    const { rows } = await db.query<PaymentRow>(
      "SELECT * FROM payments WHERE id = $1 FOR UPDATE",
      [input.paymentId],
    );
    const payment = rows[0];
    if (!payment) {
      throw new RedirectError("not_found", `no payment with id ${input.paymentId}`);
    }
    if (normalizeEmail(payment.email) !== normalizeEmail(input.sessionEmail)) {
      throw new RedirectError("forbidden", `payment ${payment.id} belongs to another payer`);
    }
    if (!isRedirectable(payment)) {
      throw new RedirectError(
        "not_redirectable",
        `payment ${payment.id} is '${payment.state}' and cannot be redirected`,
      );
    }

    const pending = await db.query(
      `SELECT 1 FROM jobs
        WHERE kind = 'redirect' AND done_at IS NULL AND payload->>'paymentId' = $1
        LIMIT 1`,
      [payment.id],
    );
    if (pending.rowCount) {
      throw new RedirectError(
        "redirect_pending",
        `payment ${payment.id} already has a redirect in flight`,
      );
    }

    // The gate and the write are the same statement: no row comes back when
    // the payment moved out of a redirectable state or the daily ceiling is
    // already reached, and there is no window between deciding and recording.
    const claimed = await db.query<{ id: string }>(
      `INSERT INTO redirects (payment_id, to_address)
       SELECT p.id, $2 FROM payments p
        WHERE p.id = $1
          AND p.state IN ('held', 'unlocked')
          AND p.release_tx IS NULL
          AND (
            SELECT count(*) FROM redirects r
             WHERE r.payment_id = p.id AND r.created_at > now() - interval '1 day'
          ) < $3
       RETURNING id`,
      [payment.id, destination, MAX_REDIRECTS_PER_DAY],
    );
    const redirectId = claimed.rows[0]?.id;
    if (!redirectId) {
      throw new RedirectError(
        "rate_limited",
        `payment ${payment.id} has already been redirected ${MAX_REDIRECTS_PER_DAY} times today`,
      );
    }

    const payload: RedirectJobPayload = { paymentId: payment.id, to: destination };
    // Keyed on the audit row rather than the payment: this queue keeps a
    // dedupe key after a job completes, so a payment-scoped key would make a
    // payer's second redirect permanently unschedulable. "Only one in flight"
    // is enforced by the pending check above instead.
    const job = await enqueue(db, "redirect", payload, {
      dedupeKey: `redirect:${redirectId}`,
    });

    return { status: "pending", redirectId, jobId: job.id };
  });
}

function isRedirectable(payment: PaymentRow): boolean {
  return (
    (payment.state === "held" || payment.state === "unlocked") && payment.release_tx === null
  );
}
