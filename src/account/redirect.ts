import { isAddress, type Address, type Hex } from "viem";
import { normalizeEmail } from "../auth/magic.js";
import {
  feePaymentId,
  getEntry,
  paymentIdBytes32,
  setBeneficiary,
  type EscrowClients,
} from "../chain/escrow.js";
import { enqueue } from "../db/jobs.js";
import type { PaymentRow, Queryable } from "../db/payments.js";

/**
 * How many destination changes one payment may make in a day. Redirects are
 * the power-user path -- nobody needs to use it at all -- so a low ceiling
 * costs a legitimate payer nothing and denies a stolen session the ability to
 * walk an escrow entry through addresses faster than the 48h onchain redirect
 * delay lets anyone notice.
 */
const MAX_REDIRECTS_PER_DAY = 3;

export type RedirectErrorCode =
  | "not_found"
  | "forbidden"
  | "invalid_address"
  | "not_redirectable"
  | "rate_limited"
  | "fee_leg_failed";

const STATUS_BY_CODE: Record<RedirectErrorCode, number> = {
  not_found: 404,
  forbidden: 403,
  invalid_address: 400,
  not_redirectable: 409,
  rate_limited: 429,
  fee_leg_failed: 502,
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

/** The two escrow operations a redirect makes. */
export interface RedirectEscrow {
  hasEntry(paymentId: Hex): Promise<boolean>;
  setBeneficiary(paymentId: Hex, to: Address): Promise<Hex>;
}

/** The live implementation, bound to a viem client pair. */
export function liveRedirectEscrow(clients: EscrowClients): RedirectEscrow {
  return {
    hasEntry: async (paymentId) => (await getEntry(clients, paymentId)) !== null,
    setBeneficiary: async (paymentId, to) =>
      (await setBeneficiary(clients, { paymentId, to })).txHash,
  };
}

export interface RedirectDeps {
  pool: Queryable;
  escrow: RedirectEscrow;
}

export interface RedirectInput {
  paymentId: string;
  address: string;
  /** The email the session cookie proves. */
  sessionEmail: string;
}

export interface RedirectResult {
  txHash: Hex;
  /** Present only when the payment had a fee leg to move as well. */
  feeTxHash?: Hex;
}

/** Payload of the `redirect-email` job. Task 9's mailer consumes it. */
export interface RedirectEmailJobPayload {
  paymentId: string;
  toAddress: string;
}

/**
 * Points a payment's escrowed tokens at a different address.
 *
 * Every gate runs before anything is sent, because a `setBeneficiary` can't be
 * taken back -- only superseded, and only after the contract's 48h delay. The
 * legs are ordered donation-first: a payer who supplies a new address cares
 * about the donation tokens, and a fee leg that fails afterwards leaves the
 * thing they asked for done. That is also why a fee-leg failure still leaves
 * the donation redirect recorded (and reported as a 502): the row must reflect
 * what is actually onchain, or the account page would show the old address
 * while the escrow points at the new one.
 */
export async function requestRedirect(
  deps: RedirectDeps,
  input: RedirectInput,
): Promise<RedirectResult> {
  if (!isAddress(input.address)) {
    throw new RedirectError("invalid_address", `not a valid address: ${input.address}`);
  }
  const destination: Address = input.address;

  const payment = await loadPayment(deps.pool, input.paymentId);
  if (!payment) {
    throw new RedirectError("not_found", `no payment with id ${input.paymentId}`);
  }
  if (normalizeEmail(payment.email) !== normalizeEmail(input.sessionEmail)) {
    throw new RedirectError("forbidden", `payment ${payment.id} belongs to another payer`);
  }
  if (
    (payment.state !== "held" && payment.state !== "unlocked") ||
    payment.release_tx !== null
  ) {
    throw new RedirectError(
      "not_redirectable",
      `payment ${payment.id} is '${payment.state}' and cannot be redirected`,
    );
  }

  const { rows: counted } = await deps.pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM redirects
      WHERE payment_id = $1 AND created_at > now() - interval '1 day'`,
    [payment.id],
  );
  if ((counted[0]?.n ?? 0) >= MAX_REDIRECTS_PER_DAY) {
    throw new RedirectError(
      "rate_limited",
      `payment ${payment.id} has already been redirected ${MAX_REDIRECTS_PER_DAY} times today`,
    );
  }

  const escrowPaymentId = paymentIdBytes32(payment.id);
  const txHash = await deps.escrow.setBeneficiary(escrowPaymentId, destination);

  // One statement, so the audit row and the destination can never disagree:
  // the rate limit counts the audit rows, and the account page reads the
  // destination.
  const { rows: recorded } = await deps.pool.query<{ id: string }>(
    `WITH audit AS (
       INSERT INTO redirects (payment_id, to_address) VALUES ($1, $2) RETURNING id
     ), updated AS (
       UPDATE payments SET claim_address = $2, updated_at = now() WHERE id = $1
     )
     SELECT id FROM audit`,
    [payment.id, destination],
  );
  const auditId = recorded[0]?.id;

  const feeId = feePaymentId(escrowPaymentId);
  let feeTxHash: Hex | undefined;
  if (await deps.escrow.hasEntry(feeId)) {
    try {
      feeTxHash = await deps.escrow.setBeneficiary(feeId, destination);
    } catch (err) {
      throw new RedirectError(
        "fee_leg_failed",
        `payment ${payment.id}: donation redirect landed, fee leg did not: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  const payload: RedirectEmailJobPayload = {
    paymentId: payment.id,
    toAddress: destination,
  };
  await enqueue(deps.pool, "redirect-email", payload, {
    // Keyed on the audit row, not the payment: a payer who moves their tokens
    // twice is owed two confirmations.
    dedupeKey: auditId ? `redirect-email:${auditId}` : undefined,
  });

  return feeTxHash ? { txHash, feeTxHash } : { txHash };
}

async function loadPayment(db: Queryable, id: string): Promise<PaymentRow | null> {
  if (
    !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id)
  ) {
    return null;
  }
  const { rows } = await db.query<PaymentRow>("SELECT * FROM payments WHERE id = $1", [id]);
  return rows[0] ?? null;
}
