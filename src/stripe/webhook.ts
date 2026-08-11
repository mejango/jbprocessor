import type { Pool } from "pg";
import type Stripe from "stripe";
import { enqueue } from "../db/jobs.js";
import {
  transition,
  TransitionError,
  type PaymentState,
  type Queryable,
} from "../db/payments.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Card chargebacks can arrive up to 120 days after the charge, so card-funded
 * tokens stay escrowed that long. Not configurable: it's a property of the
 * card networks, not of this deployment.
 */
const CARD_HOLD_DAYS = 120n;
const DEFAULT_BANK_HOLD_DAYS = 7n;

/** Used when Stripe hasn't attached a balance transaction yet. */
const SETTLEMENT_FALLBACK_DAYS = 3;

/** Job payloads this router enqueues; consumed by the worker (Task 7). */
export interface PayJobPayload {
  paymentId: string;
}
export interface ForfeitJobPayload {
  paymentId: string;
}

/** The slice of the Stripe SDK the webhook router reads from. */
export interface StripePaymentIntentReader {
  paymentIntents: {
    retrieve(id: string, params?: { expand?: string[] }): Promise<Stripe.PaymentIntent>;
  };
}

/** The slice used for signature verification (a real `Stripe` instance fits). */
export interface StripeWebhookVerifier {
  webhooks: {
    constructEvent(
      payload: string | Uint8Array,
      header: string | string[] | Uint8Array,
      secret: string,
    ): Stripe.Event;
  };
}

export interface WebhookDeps {
  pool: Pool;
  stripe: StripePaymentIntentReader;
}

function envBigInt(name: string, fallback: bigint): bigint {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a non-negative integer, got: ${raw}`);
  }
  return BigInt(raw);
}

/**
 * Verifies a raw webhook body against `STRIPE_WEBHOOK_SECRET` and parses it.
 * Throws if the signature doesn't match, the payload was tampered with, or
 * the timestamp is outside Stripe's replay tolerance -- callers must let that
 * become a 400 and must never fall back to parsing the body themselves.
 */
export function constructStripeEvent(
  stripe: StripeWebhookVerifier,
  payload: string | Uint8Array,
  signature: string | string[] | Uint8Array,
): Stripe.Event {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error("STRIPE_WEBHOOK_SECRET environment variable is not set");
  }
  return stripe.webhooks.constructEvent(payload, signature, secret);
}

/** Unwraps an `id | expanded object | null` Stripe reference to its id. */
function refId(ref: string | { id: string } | null | undefined): string | null {
  if (!ref) return null;
  return typeof ref === "string" ? ref : ref.id;
}

/**
 * Returns the expanded object behind a Stripe reference, or null when the
 * field is absent or came back as a bare id string (i.e. the `expand` didn't
 * take -- older API versions, or a charge Stripe hasn't attached yet).
 */
function expanded<T extends object>(ref: string | T | null | undefined): T | null {
  return ref && typeof ref !== "string" ? ref : null;
}

function unlockAtFor(method: "card" | "bank", now: number): Date {
  const days =
    method === "card" ? CARD_HOLD_DAYS : envBigInt("BANK_HOLD_DAYS", DEFAULT_BANK_HOLD_DAYS);
  return new Date(now + Number(days) * DAY_MS);
}

/**
 * Which rail actually funded the charge. `payment_method_details.type` is the
 * authoritative answer (the session's `payment_method_types` is only the menu
 * that was offered). An unrecognised type falls back to `card`, the
 * longer-hold, more conservative treatment.
 */
function methodFromCharge(charge: Stripe.Charge | null): "card" | "bank" {
  return charge?.payment_method_details?.type === "us_bank_account" ? "bank" : "card";
}

async function findPaymentByIntent(
  pool: Queryable,
  paymentIntentId: string,
): Promise<{ id: string; state: PaymentState } | null> {
  const { rows } = await pool.query<{ id: string; state: PaymentState }>(
    "SELECT id, state FROM payments WHERE stripe_payment_intent = $1",
    [paymentIntentId],
  );
  return rows[0] ?? null;
}

async function handleSessionCompleted(
  deps: WebhookDeps,
  db: Queryable,
  session: Stripe.Checkout.Session,
): Promise<void> {
  const paymentId = session.metadata?.payment_id;
  if (!paymentId) {
    // Not one of ours (e.g. a session created by another integration on the
    // same Stripe account). Recording the event id is still correct: there's
    // nothing to retry.
    return;
  }

  const paymentIntentId = refId(session.payment_intent);
  if (!paymentIntentId) {
    throw new Error(
      `checkout.session.completed for payment ${paymentId} has no payment_intent`,
    );
  }

  // One retrieve gets both facts we need: which rail funded the charge, and
  // when Stripe's money becomes available (the default path's pay schedule).
  const intent = await deps.stripe.paymentIntents.retrieve(paymentIntentId, {
    expand: ["latest_charge.balance_transaction"],
  });
  const charge = expanded(intent.latest_charge);
  const method = methodFromCharge(charge);

  const paid = await transition(db, paymentId, ["created"], "paid", {
    stripe_payment_intent: paymentIntentId,
    method,
    unlock_at: unlockAtFor(method, Date.now()),
  });

  const payload: PayJobPayload = { paymentId };

  if (paid.instant) {
    // Instant: the pool fronts the USDC now, so pay immediately rather than
    // waiting for Stripe to settle.
    await enqueue(db, "pay", payload, { dedupeKey: `pay:${paymentId}` });
    return;
  }

  // Default path: pay when Stripe's money actually lands, not when the payer
  // checks out. `available_on` is that date straight from the ledger.
  const availableOn = expanded(charge?.balance_transaction)?.available_on;
  const runAt =
    typeof availableOn === "number"
      ? new Date(availableOn * 1000)
      : new Date(Date.now() + SETTLEMENT_FALLBACK_DAYS * DAY_MS);

  await enqueue(db, "pay", payload, { runAt, dedupeKey: `pay:${paymentId}` });
}

async function handleDisputeCreated(
  db: Queryable,
  dispute: Stripe.Dispute,
): Promise<void> {
  const paymentIntentId = refId(dispute.payment_intent);
  if (!paymentIntentId) return;

  const payment = await findPaymentByIntent(db, paymentIntentId);
  if (!payment) return;

  // Nothing is on-chain yet: cancel before the worker can spend on it.
  if (payment.state === "paid" || payment.state === "settled") {
    await transition(db, payment.id, ["paid", "settled"], "canceled");
    return;
  }

  // Tokens are escrowed: claw them back to the operator instead of releasing
  // them to a payer who has taken their money back.
  if (payment.state === "held") {
    await transition(db, payment.id, ["held"], "forfeited");
    const payload: ForfeitJobPayload = { paymentId: payment.id };
    await enqueue(db, "forfeit", payload, { dedupeKey: `forfeit:${payment.id}` });
    return;
  }

  // 'paying' is mid-transaction and owned by the worker -- transitioning it
  // here would race the on-chain send. The worker's own completion moves it
  // to 'held', and reconciliation (Task 9) picks the dispute up from there.
  // Every other state is terminal or already resolved.
}

async function handleChargeRefunded(db: Queryable, charge: Stripe.Charge): Promise<void> {
  const paymentIntentId = refId(charge.payment_intent);
  if (!paymentIntentId) return;

  const payment = await findPaymentByIntent(db, paymentIntentId);
  if (!payment) return;

  try {
    await transition(db, payment.id, ["paid"], "refunded");
  } catch (err) {
    if (!(err instanceof TransitionError)) throw err;
    // The payment has already moved past 'paid' (e.g. the worker paid it
    // on-chain, or a dispute canceled it first). Refund accounting for those
    // states is the escrow's job, not a state change here -- no-op.
  }
}

/**
 * Routes one verified Stripe event, exactly once.
 *
 * The whole handler runs in a single transaction that opens with an insert
 * into `stripe_events`: a duplicate delivery finds the id taken and returns
 * without doing anything, and a failed delivery rolls the id back out so
 * Stripe's retry gets a real second attempt. Doing the insert on autocommit
 * instead would burn the id on any downstream failure and strand the payment.
 */
export async function handleStripeEvent(
  deps: WebhookDeps,
  event: Stripe.Event,
): Promise<void> {
  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");

    const inserted = await client.query(
      "INSERT INTO stripe_events (id) VALUES ($1) ON CONFLICT DO NOTHING",
      [event.id],
    );
    if (inserted.rowCount === 0) {
      await client.query("ROLLBACK");
      return;
    }

    switch (event.type) {
      case "checkout.session.completed":
        await handleSessionCompleted(deps, client, event.data.object);
        break;
      case "charge.dispute.created":
        await handleDisputeCreated(client, event.data.object);
        break;
      case "charge.refunded":
        await handleChargeRefunded(client, event.data.object);
        break;
      default:
        // Unsubscribed event types are recorded and ignored.
        break;
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
