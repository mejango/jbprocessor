import type { Pool } from "pg";
import { isAddress, zeroAddress, type Address, type Hex } from "viem";
import {
  feePaymentId,
  getEntry,
  paymentIdBytes32,
  setBeneficiary,
  type EscrowClients,
  type EscrowEntry,
} from "../chain/escrow.js";
import { enqueue, type JobRow } from "../db/jobs.js";
import type { PaymentRow } from "../db/payments.js";

/** Enqueued by `requestRedirect` once a payer's request has passed its gates. */
export interface RedirectJobPayload {
  paymentId: string;
  to: string;
}

/** Payload of the `redirect-email` job. Task 9's mailer consumes it. */
export interface RedirectEmailJobPayload {
  paymentId: string;
  toAddress: string;
}

/** The escrow operations a redirect makes. */
export interface RedirectChain {
  getEntry(paymentId: Hex): Promise<EscrowEntry | null>;
  setBeneficiary(paymentId: Hex, to: Address): Promise<Hex>;
}

export interface RedirectJobDeps {
  pool: Pool;
  escrow: RedirectChain;
}

/** The live implementation, bound to a viem client pair. */
export function liveRedirectChain(clients: EscrowClients): RedirectChain {
  return {
    getEntry: (paymentId) => getEntry(clients, paymentId),
    setBeneficiary: async (paymentId, to) =>
      (await setBeneficiary(clients, { paymentId, to })).txHash,
  };
}

function payloadField(job: JobRow, field: "paymentId" | "to"): string {
  const payload = job.payload as Record<string, unknown> | null;
  const value = payload?.[field];
  if (typeof value !== "string" || value === "") {
    throw new Error(`job ${job.id}: payload has no ${field}`);
  }
  return value;
}

/**
 * Sends a payer's redirect onchain. This is the only place the escrow
 * operator key is used for a redirect -- the web process validates and
 * enqueues, the worker signs.
 *
 * Retry-safe in both directions. A leg whose beneficiary is already pending
 * for this exact address is skipped, so a retry after a fee-leg failure
 * doesn't re-send the donation leg and push its 48h delay out again; and the
 * database is only touched after both legs are onchain, so a payment's
 * recorded destination never runs ahead of the escrow.
 *
 * A fee-leg failure throws, because the fee leg is the payer's tokens too:
 * unlike the keeper's release (where the donation is already delivered and the
 * fee is the processor's own problem), leaving the fee entry pointing at the
 * old address would split one payer's tokens across two destinations.
 */
export async function handleRedirect(deps: RedirectJobDeps, job: JobRow): Promise<void> {
  const paymentId = payloadField(job, "paymentId");
  const to = payloadField(job, "to");
  if (!isAddress(to)) {
    throw new Error(`job ${job.id}: '${to}' is not a valid address`);
  }

  const { rows } = await deps.pool.query<PaymentRow>(
    "SELECT * FROM payments WHERE id = $1",
    [paymentId],
  );
  const payment = rows[0];
  if (!payment) {
    console.warn(`redirect job ${job.id}: payment ${paymentId} not found -- dropping`);
    return;
  }
  if (
    (payment.state !== "held" && payment.state !== "unlocked") ||
    payment.release_tx !== null
  ) {
    // The payment moved on while the job waited -- released, refunded or
    // forfeited. There is nothing left to point anywhere, and the escrow would
    // revert if we tried.
    console.warn(
      `redirect job ${job.id}: payment ${paymentId} is '${payment.state}' -- not redirecting`,
    );
    return;
  }

  const escrowPaymentId = paymentIdBytes32(paymentId);
  const mainEntry = await deps.escrow.getEntry(escrowPaymentId);
  if (!mainEntry) {
    throw new Error(`redirect job ${job.id}: escrow has no entry for payment ${paymentId}`);
  }
  if (mainEntry.settled) {
    console.warn(
      `redirect job ${job.id}: payment ${paymentId} was already released onchain -- not redirecting`,
    );
    return;
  }

  await redirectLeg(deps, escrowPaymentId, mainEntry, to);

  const feeId = feePaymentId(escrowPaymentId);
  const feeEntry = await deps.escrow.getEntry(feeId);
  if (feeEntry && !feeEntry.settled) {
    await redirectLeg(deps, feeId, feeEntry, to);
  }

  // Recorded only once both legs are onchain, and only while the payment is
  // still redirectable, so a state change during the send can't be overwritten.
  await deps.pool.query(
    `UPDATE payments SET claim_address = $2, updated_at = now()
      WHERE id = $1 AND state IN ('held', 'unlocked') AND release_tx IS NULL`,
    [paymentId, to],
  );

  const payload: RedirectEmailJobPayload = { paymentId, toAddress: to };
  await enqueue(deps.pool, "redirect-email", payload, {
    dedupeKey: `redirect-email:${job.id}`,
  });
}

/** Queues one leg's beneficiary change, unless it is already queued for `to`. */
async function redirectLeg(
  deps: RedirectJobDeps,
  escrowPaymentId: Hex,
  entry: EscrowEntry,
  to: Address,
): Promise<void> {
  const alreadyQueued =
    entry.pendingBeneficiary !== zeroAddress &&
    entry.pendingBeneficiary.toLowerCase() === to.toLowerCase();
  if (alreadyQueued) return;

  await deps.escrow.setBeneficiary(escrowPaymentId, to);
}
