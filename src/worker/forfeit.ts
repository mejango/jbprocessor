import type { Pool } from "pg";
import type { Hex } from "viem";
import { formatUsdCents } from "../account/format.js";
import {
  feePaymentId,
  forfeit,
  getEntry,
  paymentIdBytes32,
  type EscrowClients,
  type EscrowEntry,
} from "../chain/escrow.js";
import type { JobRow } from "../db/jobs.js";
import type { PaymentState } from "../db/payments.js";
import { sendAlert, type EmailDeps } from "../email/send.js";

/** The escrow operations a forfeit makes. */
export interface ForfeitChain {
  getEntry(paymentId: Hex): Promise<EscrowEntry | null>;
  forfeit(paymentId: Hex): Promise<Hex>;
}

export interface ForfeitDeps extends EmailDeps {
  pool: Pool;
  escrow: ForfeitChain;
}

/** The live implementation, bound to a viem client pair. */
export function liveForfeitChain(clients: EscrowClients): ForfeitChain {
  return {
    getEntry: (paymentId) => getEntry(clients, paymentId),
    forfeit: async (paymentId) => (await forfeit(clients, { paymentId })).txHash,
  };
}

interface ForfeitRow {
  id: string;
  state: PaymentState;
  email: string;
  amount_usd_cents: string;
  premium_usd_cents: string;
  tokens_held: string | null;
  claim_address: string | null;
  stripe_payment_intent: string | null;
  project_id: string;
  project_name: string;
}

/**
 * Contract reverts that mean "this leg has nothing left to forfeit".
 *
 * Both are races, not faults. `AlreadySettled` is the release scan having
 * won: the dispute landed while the keeper was mid-crank, and the tokens are
 * already with the payer. `NoEntry` is a payment the escrow never recorded.
 * Neither becomes false on a retry, and both need a human rather than another
 * attempt -- so they become alert lines instead of a throw.
 */
function isTerminalEscrowRevert(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /NoEntry|AlreadySettled/i.test(message);
}

function payloadPaymentId(job: JobRow): string {
  const payload = job.payload as { paymentId?: unknown } | null;
  const paymentId = payload?.paymentId;
  if (typeof paymentId !== "string" || paymentId === "") {
    throw new Error(`job ${job.id}: payload has no paymentId`);
  }
  return paymentId;
}

/**
 * Forfeits one escrow leg, appending what happened to `notes`.
 *
 * Reads the entry first so the common no-op cases (no entry, already settled)
 * are decided without spending a transaction, and still catches the same
 * conditions as reverts -- the read and the write are separate blocks, and
 * the release scan can land between them.
 */
async function forfeitLeg(
  deps: ForfeitDeps,
  label: string,
  escrowPaymentId: Hex,
  notes: string[],
): Promise<void> {
  const entry = await deps.escrow.getEntry(escrowPaymentId);
  if (!entry) {
    notes.push(`${label} leg: no escrow entry -- nothing to forfeit`);
    return;
  }
  if (entry.settled) {
    notes.push(
      `${label} leg: already settled onchain (${entry.amount} tokens went to ${entry.beneficiary}) -- the release won the race`,
    );
    return;
  }

  try {
    const txHash = await deps.escrow.forfeit(escrowPaymentId);
    notes.push(`${label} leg: forfeited ${entry.amount} tokens, tx ${txHash}`);
  } catch (err) {
    if (!isTerminalEscrowRevert(err)) throw err;
    notes.push(
      `${label} leg: already resolved onchain (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
  }
}

/**
 * Claws a disputed payment's escrowed tokens back to the operator.
 *
 * Enqueued by the Stripe webhook when a chargeback lands on a payment whose
 * tokens are already escrowed. The webhook owns the row's state -- it has
 * already moved the payment to `forfeited` -- so this handler only touches the
 * chain, and refuses to act on a payment in any other state rather than
 * racing whoever does own it.
 *
 * The alert at the end is the point, not a nicety: forfeiting puts project
 * tokens in the operator's hands, and turning those back into the dollars the
 * card network just took is a manual cash-out an operator has to perform. A
 * silent success here would be an unnoticed loss.
 */
export async function handleForfeit(deps: ForfeitDeps, job: JobRow): Promise<void> {
  const paymentId = payloadPaymentId(job);

  const { rows } = await deps.pool.query<ForfeitRow>(
    `SELECT p.id, p.state, p.email, p.amount_usd_cents, p.premium_usd_cents,
            p.tokens_held, p.claim_address, p.stripe_payment_intent,
            p.project_id, pr.name AS project_name
       FROM payments p
       JOIN projects pr ON pr.project_id = p.project_id
      WHERE p.id = $1`,
    [paymentId],
  );
  const payment = rows[0];
  if (!payment) {
    console.warn(`forfeit job ${job.id}: payment ${paymentId} not found -- dropping`);
    return;
  }
  if (payment.state !== "forfeited") {
    // The webhook is the only writer of this state, and it writes it before
    // enqueueing. Anything else means the row moved on -- an operator refund,
    // a manual correction -- and clawing tokens back off the back of a stale
    // job would be the processor stealing from a payer.
    console.warn(
      `forfeit job ${job.id}: payment ${paymentId} is '${payment.state}', not 'forfeited' -- not forfeiting`,
    );
    return;
  }

  const escrowPaymentId = paymentIdBytes32(paymentId);
  const notes: string[] = [];

  await forfeitLeg(deps, "donation", escrowPaymentId, notes);
  await forfeitLeg(deps, "fee", feePaymentId(escrowPaymentId), notes);

  const total = BigInt(payment.amount_usd_cents) + BigInt(payment.premium_usd_cents);
  await sendAlert(
    deps,
    `Payment forfeited after a dispute (${payment.project_name})`,
    [
      "A chargeback landed on a payment whose tokens were already escrowed, so",
      "the escrow entry has been forfeited back to the operator.",
      "",
      `Payment: ${paymentId}`,
      `Project: ${payment.project_name} (#${payment.project_id})`,
      `Charged: ${formatUsdCents(total)} (donation ${formatUsdCents(
        payment.amount_usd_cents,
      )}, fee ${formatUsdCents(payment.premium_usd_cents)})`,
      `Tokens held: ${payment.tokens_held ?? "unknown"}`,
      `Payer's address: ${payment.claim_address ?? "unknown"}`,
      `Stripe payment intent: ${payment.stripe_payment_intent ?? "unknown"}`,
      "",
      "What happened onchain:",
      ...notes.map((note) => `  - ${note}`),
      "",
      "Next step is manual: cash the forfeited tokens out of the operator wallet",
      "to cover the chargeback. See the forfeit runbook.",
      "",
      "-- JBProcessor",
    ].join("\n"),
  );
}
