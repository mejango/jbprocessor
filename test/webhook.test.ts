import { Pool } from "pg";
import Stripe from "stripe";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../src/db/index.js";
import { createPayment } from "../src/db/payments.js";
import type { PaymentState } from "../src/db/payments.js";
import { constructStripeEvent, handleStripeEvent } from "../src/stripe/webhook.js";
import type { WebhookDeps } from "../src/stripe/webhook.js";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/jbprocessor_test";

const SCHEMA_NAME = `test_webhook_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

const PROJECT_ID = 11;
const WEBHOOK_SECRET = "whsec_testsecret_0123456789abcdef";
const DAY_MS = 24 * 60 * 60 * 1000;

let pool: Pool;

// A real Stripe client with a dummy key: never used for network calls here,
// only for its offline signing/verification helpers.
const stripe = new Stripe("sk_test_dummy_key_for_offline_signing");

/** Stubs the two Stripe reads the webhook makes. */
class PaymentIntentStub {
  retrieved: Array<{ id: string; params: unknown }> = [];
  intent: unknown = null;
  error: Error | null = null;
  paymentIntents = {
    retrieve: async (id: string, params?: unknown) => {
      this.retrieved.push({ id, params });
      if (this.error) throw this.error;
      return this.intent as Stripe.PaymentIntent;
    },
  };
}

function deps(stub = new PaymentIntentStub()): WebhookDeps & { stripe: PaymentIntentStub } {
  return { pool, stripe: stub } as unknown as WebhookDeps & {
    stripe: PaymentIntentStub;
  };
}

let eventCounter = 0;

/**
 * Builds a payload, signs it with `generateTestHeaderString`, and runs it back
 * through `constructStripeEvent` -- so every test exercises real signature
 * verification rather than hand-constructing an Event object.
 */
function signedEvent(type: string, object: unknown, id?: string): Stripe.Event {
  eventCounter += 1;
  const payload = JSON.stringify({
    id: id ?? `evt_${eventCounter}`,
    object: "event",
    api_version: "2025-03-31.basil",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 1,
    request: null,
    type,
    data: { object },
  });
  const signature = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: WEBHOOK_SECRET,
  });
  return constructStripeEvent(stripe, payload, signature);
}

function completedSession(
  paymentId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "cs_test_session",
    object: "checkout.session",
    metadata: { payment_id: paymentId },
    payment_intent: "pi_test_1",
    payment_status: "paid",
    payment_method_types: ["card", "us_bank_account"],
    ...overrides,
  };
}

function paymentIntent(
  methodType: "card" | "us_bank_account",
  availableOn: number,
  id = "pi_test_1",
): unknown {
  return {
    id,
    object: "payment_intent",
    latest_charge: {
      id: "ch_test_1",
      object: "charge",
      payment_method_details: { type: methodType },
      balance_transaction: {
        id: "txn_test_1",
        object: "balance_transaction",
        available_on: availableOn,
      },
    },
  };
}

async function newPayment(
  email: string,
  opts: { instant?: boolean; state?: PaymentState; paymentIntent?: string } = {},
) {
  const payment = await createPayment(pool, {
    projectId: PROJECT_ID,
    email,
    amountUsdCents: 5000n,
    instant: opts.instant ?? false,
  });
  if (opts.state && opts.state !== "created") {
    await pool.query("UPDATE payments SET state = $2 WHERE id = $1", [
      payment.id,
      opts.state,
    ]);
  }
  if (opts.paymentIntent) {
    await pool.query("UPDATE payments SET stripe_payment_intent = $2 WHERE id = $1", [
      payment.id,
      opts.paymentIntent,
    ]);
  }
  return payment;
}

async function readPayment(id: string) {
  const { rows } = await pool.query<{
    state: PaymentState;
    method: string | null;
    unlock_at: Date | null;
    stripe_payment_intent: string | null;
  }>("SELECT state, method, unlock_at, stripe_payment_intent FROM payments WHERE id = $1", [
    id,
  ]);
  const row = rows[0];
  if (!row) throw new Error(`payment ${id} not found`);
  return row;
}

async function readJobs(dedupeKey: string) {
  const { rows } = await pool.query<{ kind: string; run_at: Date; payload: unknown }>(
    "SELECT kind, run_at, payload FROM jobs WHERE dedupe_key = $1",
    [dedupeKey],
  );
  return rows;
}

beforeAll(async () => {
  const adminPool = new Pool({ connectionString: TEST_DATABASE_URL });
  await adminPool.query(`CREATE SCHEMA "${SCHEMA_NAME}"`);
  await adminPool.end();

  pool = new Pool({
    connectionString: TEST_DATABASE_URL,
    options: `-c search_path=${SCHEMA_NAME}`,
  });
  await migrate(pool);

  await pool.query(
    `INSERT INTO projects (project_id, name, token_address, terminal_address)
     VALUES ($1, 'Webhook Project', $2, $3)`,
    [
      PROJECT_ID,
      "0x0000000000000000000000000000000000000abc",
      "0x0000000000000000000000000000000000feed01",
    ],
  );
});

afterAll(async () => {
  await pool.end();
  const adminPool = new Pool({ connectionString: TEST_DATABASE_URL });
  await adminPool.query(`DROP SCHEMA "${SCHEMA_NAME}" CASCADE`);
  await adminPool.end();
});

beforeEach(async () => {
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.BANK_HOLD_DAYS = "7";
  await pool.query("DELETE FROM jobs");
  await pool.query("DELETE FROM payments");
  await pool.query("DELETE FROM stripe_events");
});

afterEach(() => {
  delete process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.BANK_HOLD_DAYS;
});

describe("constructStripeEvent", () => {
  it("accepts a correctly signed payload", () => {
    const event = signedEvent("checkout.session.completed", completedSession("x"));
    expect(event.type).toBe("checkout.session.completed");
  });

  it("rejects a payload signed with the wrong secret", () => {
    const payload = JSON.stringify({ id: "evt_bad", object: "event", type: "ping" });
    const signature = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: "whsec_a_different_secret",
    });
    expect(() => constructStripeEvent(stripe, payload, signature)).toThrow();
  });

  it("rejects a tampered payload", () => {
    const payload = JSON.stringify({ id: "evt_ok", object: "event", type: "ping" });
    const signature = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: WEBHOOK_SECRET,
    });
    expect(() =>
      constructStripeEvent(stripe, payload.replace("evt_ok", "evt_no"), signature),
    ).toThrow();
  });

  it("throws when STRIPE_WEBHOOK_SECRET is unset", () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const payload = JSON.stringify({ id: "evt_x", object: "event", type: "ping" });
    expect(() => constructStripeEvent(stripe, payload, "t=1,v1=deadbeef")).toThrow(
      /STRIPE_WEBHOOK_SECRET/,
    );
  });
});

describe("handleStripeEvent -- idempotency", () => {
  it("processes an event id exactly once", async () => {
    const payment = await newPayment("dupe@example.com");
    const stub = new PaymentIntentStub();
    stub.intent = paymentIntent("card", Math.floor(Date.now() / 1000) + 3 * 86400);

    const event = signedEvent(
      "checkout.session.completed",
      completedSession(payment.id),
      "evt_duplicate",
    );

    await handleStripeEvent(deps(stub), event);
    // A second delivery of the same event id must short-circuit before the
    // transition -- which would otherwise throw TransitionError.
    await expect(handleStripeEvent(deps(stub), event)).resolves.toBeUndefined();

    expect(stub.retrieved).toHaveLength(1);
    expect((await readPayment(payment.id)).state).toBe("paid");
    const { rows } = await pool.query("SELECT id FROM stripe_events");
    expect(rows).toHaveLength(1);
  });

  it("does not consume the event id when handling fails, so Stripe can retry", async () => {
    const payment = await newPayment("retry@example.com");
    const stub = new PaymentIntentStub();
    stub.error = new Error("stripe is down");

    const event = signedEvent(
      "checkout.session.completed",
      completedSession(payment.id),
      "evt_transient",
    );
    await expect(handleStripeEvent(deps(stub), event)).rejects.toThrow("stripe is down");

    const { rows } = await pool.query("SELECT id FROM stripe_events");
    expect(rows).toHaveLength(0);
    expect((await readPayment(payment.id)).state).toBe("created");

    // The retry succeeds and is not blocked by the failed attempt.
    stub.error = null;
    stub.intent = paymentIntent("card", Math.floor(Date.now() / 1000) + 3 * 86400);
    await handleStripeEvent(deps(stub), event);
    expect((await readPayment(payment.id)).state).toBe("paid");
  });

  it("ignores unknown event types but still records them", async () => {
    const event = signedEvent("invoice.paid", { id: "in_1" }, "evt_unknown");
    await expect(handleStripeEvent(deps(), event)).resolves.toBeUndefined();
    const { rows } = await pool.query("SELECT id FROM stripe_events");
    expect(rows).toHaveLength(1);
  });
});

describe("handleStripeEvent -- checkout.session.completed", () => {
  it("marks a card payment paid, holds it 120 days, and schedules pay at available_on", async () => {
    const payment = await newPayment("card@example.com");
    const availableOn = Math.floor(Date.now() / 1000) + 3 * 86400;
    const stub = new PaymentIntentStub();
    stub.intent = paymentIntent("card", availableOn);

    await handleStripeEvent(
      deps(stub),
      signedEvent("checkout.session.completed", completedSession(payment.id)),
    );

    const row = await readPayment(payment.id);
    expect(row.state).toBe("paid");
    expect(row.method).toBe("card");
    expect(row.stripe_payment_intent).toBe("pi_test_1");
    const unlockAt = new Date(row.unlock_at as unknown as string).getTime();
    expect(unlockAt).toBeGreaterThan(Date.now() + 119 * DAY_MS);
    expect(unlockAt).toBeLessThan(Date.now() + 121 * DAY_MS);

    const jobs = await readJobs(`pay:${payment.id}`);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.kind).toBe("pay");
    expect(jobs[0]?.payload).toMatchObject({ paymentId: payment.id });
    expect(new Date(jobs[0]?.run_at as unknown as string).getTime()).toBe(
      availableOn * 1000,
    );
  });

  it("uses BANK_HOLD_DAYS for a us_bank_account payment", async () => {
    const payment = await newPayment("bank@example.com");
    const stub = new PaymentIntentStub();
    stub.intent = paymentIntent(
      "us_bank_account",
      Math.floor(Date.now() / 1000) + 86400,
    );

    await handleStripeEvent(
      deps(stub),
      signedEvent("checkout.session.completed", completedSession(payment.id)),
    );

    const row = await readPayment(payment.id);
    expect(row.method).toBe("bank");
    const unlockAt = new Date(row.unlock_at as unknown as string).getTime();
    expect(unlockAt).toBeGreaterThan(Date.now() + 6 * DAY_MS);
    expect(unlockAt).toBeLessThan(Date.now() + 8 * DAY_MS);
  });

  it("schedules an instant payment immediately, ignoring available_on", async () => {
    const payment = await newPayment("instant@example.com", { instant: true });
    const stub = new PaymentIntentStub();
    stub.intent = paymentIntent("card", Math.floor(Date.now() / 1000) + 3 * 86400);

    const before = Date.now();
    await handleStripeEvent(
      deps(stub),
      signedEvent("checkout.session.completed", completedSession(payment.id)),
    );

    const jobs = await readJobs(`pay:${payment.id}`);
    expect(jobs).toHaveLength(1);
    const runAt = new Date(jobs[0]?.run_at as unknown as string).getTime();
    expect(runAt).toBeLessThan(before + 60_000);
  });

  it("falls back to now + 3 days when the balance transaction has no available_on", async () => {
    const payment = await newPayment("nobt@example.com");
    const stub = new PaymentIntentStub();
    stub.intent = {
      id: "pi_test_1",
      object: "payment_intent",
      latest_charge: {
        id: "ch_test_1",
        object: "charge",
        payment_method_details: { type: "card" },
        balance_transaction: null,
      },
    };

    await handleStripeEvent(
      deps(stub),
      signedEvent("checkout.session.completed", completedSession(payment.id)),
    );

    const jobs = await readJobs(`pay:${payment.id}`);
    const runAt = new Date(jobs[0]?.run_at as unknown as string).getTime();
    expect(runAt).toBeGreaterThan(Date.now() + 2.9 * DAY_MS);
    expect(runAt).toBeLessThan(Date.now() + 3.1 * DAY_MS);
  });

  it("ignores a session that carries no payment_id metadata", async () => {
    const stub = new PaymentIntentStub();
    const event = signedEvent(
      "checkout.session.completed",
      completedSession("unused", { metadata: {} }),
    );
    await expect(handleStripeEvent(deps(stub), event)).resolves.toBeUndefined();
    expect(stub.retrieved).toHaveLength(0);
  });
});

describe("handleStripeEvent -- charge.dispute.created", () => {
  it("cancels a payment that has not been paid on-chain yet", async () => {
    const payment = await newPayment("disputed@example.com", {
      state: "paid",
      paymentIntent: "pi_dispute_1",
    });

    await handleStripeEvent(
      deps(),
      signedEvent("charge.dispute.created", {
        id: "dp_1",
        object: "dispute",
        charge: "ch_1",
        payment_intent: "pi_dispute_1",
      }),
    );

    expect((await readPayment(payment.id)).state).toBe("canceled");
    expect(await readJobs(`forfeit:${payment.id}`)).toHaveLength(0);
  });

  it("forfeits a held payment and enqueues the on-chain forfeit", async () => {
    const payment = await newPayment("held@example.com", {
      state: "held",
      paymentIntent: "pi_dispute_2",
    });

    await handleStripeEvent(
      deps(),
      signedEvent("charge.dispute.created", {
        id: "dp_2",
        object: "dispute",
        charge: "ch_2",
        payment_intent: "pi_dispute_2",
      }),
    );

    expect((await readPayment(payment.id)).state).toBe("forfeited");
    const jobs = await readJobs(`forfeit:${payment.id}`);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.kind).toBe("forfeit");
    expect(jobs[0]?.payload).toMatchObject({ paymentId: payment.id });
  });

  it("leaves a payment mid-flight in 'paying' alone -- the worker owns it", async () => {
    const payment = await newPayment("paying@example.com", {
      state: "paying",
      paymentIntent: "pi_dispute_3",
    });

    await handleStripeEvent(
      deps(),
      signedEvent("charge.dispute.created", {
        id: "dp_3",
        object: "dispute",
        charge: "ch_3",
        payment_intent: "pi_dispute_3",
      }),
    );

    expect((await readPayment(payment.id)).state).toBe("paying");
  });

  it("ignores a dispute for a payment intent we do not know", async () => {
    await expect(
      handleStripeEvent(
        deps(),
        signedEvent("charge.dispute.created", {
          id: "dp_4",
          object: "dispute",
          charge: "ch_4",
          payment_intent: "pi_unknown",
        }),
      ),
    ).resolves.toBeUndefined();
  });
});

describe("handleStripeEvent -- charge.refunded", () => {
  it("moves a paid payment to refunded", async () => {
    const payment = await newPayment("refund@example.com", {
      state: "paid",
      paymentIntent: "pi_refund_1",
    });

    await handleStripeEvent(
      deps(),
      signedEvent("charge.refunded", {
        id: "ch_r1",
        object: "charge",
        payment_intent: "pi_refund_1",
        refunded: true,
      }),
    );

    expect((await readPayment(payment.id)).state).toBe("refunded");
  });

  it("is a no-op when the payment has already moved past 'paid'", async () => {
    const payment = await newPayment("late-refund@example.com", {
      state: "held",
      paymentIntent: "pi_refund_2",
    });

    await expect(
      handleStripeEvent(
        deps(),
        signedEvent("charge.refunded", {
          id: "ch_r2",
          object: "charge",
          payment_intent: "pi_refund_2",
          refunded: true,
        }),
      ),
    ).resolves.toBeUndefined();

    expect((await readPayment(payment.id)).state).toBe("held");
  });
});
