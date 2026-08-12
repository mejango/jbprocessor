import { Pool } from "pg";
import Stripe from "stripe";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../src/db/index.js";
import { createPayment, type PaymentState } from "../src/db/payments.js";
import {
  centsFromDollars,
  clientIp,
  handleCheckoutRequest,
  recordCheckoutAttempt,
} from "../src/http/checkout.js";
import { handleWebhookRequest, type WebhookRouteDeps } from "../src/http/webhook.js";
import type { CheckoutDeps } from "../src/stripe/checkout.js";
import type { WalletProvider } from "../src/wallets/types.js";

/**
 * Route-level tests. Next App Router handlers are plain
 * `(Request) => Promise<Response>` functions, so the handlers behind them are
 * driven here directly with a real `Request` -- no Next server, no HTTP.
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/jbprocessor_test";

const SCHEMA_NAME = `test_routes_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

const PROJECT_ID = 31;
const SUSPENDED_PROJECT_ID = 32;
const TERMINAL = "0x0000000000000000000000000000000000feed01";
const TOKEN = "0x0000000000000000000000000000000000000abc";
const POOL_ADDRESS = "0x1111111111111111111111111111111111111111";
const WORKER = "0x2222222222222222222222222222222222222222";
const PREGEN_WALLET = "0x3333333333333333333333333333333333333333" as `0x${string}`;
const WEBHOOK_SECRET = "whsec_testsecret_0123456789abcdef";

const CHECKOUT_URL = "https://processor.test/api/checkout";

let pool: Pool;

class StripeCheckoutStub {
  calls: Stripe.Checkout.SessionCreateParams[] = [];
  checkout = {
    sessions: {
      create: async (params: Stripe.Checkout.SessionCreateParams) => {
        this.calls.push(params);
        return {
          id: `cs_test_${this.calls.length}_${Math.random().toString(36).slice(2)}`,
          url: "https://checkout.stripe.com/c/pay/cs_test_1",
        };
      },
    },
  };
}

class WalletStub implements WalletProvider {
  async getOrCreatePregenWallet(): Promise<`0x${string}`> {
    return PREGEN_WALLET;
  }
}

function checkoutDeps(): CheckoutDeps & { stripe: StripeCheckoutStub } {
  return {
    pool,
    stripe: new StripeCheckoutStub(),
    wallets: new WalletStub(),
    quoteClient: { readContract: async () => [{}, 4242n, 0n, []] },
    readAllowance: async () => 10n ** 12n,
  } as unknown as CheckoutDeps & { stripe: StripeCheckoutStub };
}

/** A checkout POST from `ip`, JSON-encoded unless `form` is set. */
function checkoutRequest(
  body: Record<string, unknown>,
  options: { ip?: string; forwardedFor?: string; form?: boolean } = {},
): Request {
  const headers: Record<string, string> = {};
  const forwardedFor = options.forwardedFor ?? options.ip ?? "203.0.113.1";
  headers["x-forwarded-for"] = forwardedFor;

  if (options.form) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) params.set(key, String(value));
    headers["content-type"] = "application/x-www-form-urlencoded";
    return new Request(CHECKOUT_URL, { method: "POST", headers, body: params });
  }

  headers["content-type"] = "application/json";
  return new Request(CHECKOUT_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

/** A distinct source address per test, so no test spends another's budget. */
let ipCounter = 0;
function freshIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter % 250}`;
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
    `INSERT INTO projects (project_id, name, token_address, terminal_address, status)
     VALUES ($1, 'Active Project', $2, $3, 'active'),
            ($4, 'Suspended Project', $2, $3, 'suspended')`,
    [PROJECT_ID, TOKEN, TERMINAL, SUSPENDED_PROJECT_ID],
  );
});

afterAll(async () => {
  await pool.end();
  const adminPool = new Pool({ connectionString: TEST_DATABASE_URL });
  await adminPool.query(`DROP SCHEMA "${SCHEMA_NAME}" CASCADE`);
  await adminPool.end();
});

beforeEach(async () => {
  process.env.BASE_URL = "https://processor.test";
  process.env.INSTANT_POOL_ADDRESS = POOL_ADDRESS;
  process.env.WORKER_ADDRESS = WORKER;
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  await pool.query("DELETE FROM payments");
  await pool.query("DELETE FROM checkout_attempts");
  await pool.query("DELETE FROM stripe_events");
});

afterEach(() => {
  delete process.env.BASE_URL;
  delete process.env.INSTANT_POOL_ADDRESS;
  delete process.env.WORKER_ADDRESS;
  delete process.env.STRIPE_WEBHOOK_SECRET;
});

describe("centsFromDollars", () => {
  it("converts whole and fractional dollars", () => {
    expect(centsFromDollars("25")).toBe(2500n);
    expect(centsFromDollars("25.5")).toBe(2550n);
    expect(centsFromDollars("25.50")).toBe(2550n);
    expect(centsFromDollars("0.07")).toBe(7n);
  });

  it("refuses anything that isn't exactly representable in cents", () => {
    for (const bad of ["25.555", "0.30000000000000004", "-5", "1e3", "abc", "", "25."]) {
      expect(() => centsFromDollars(bad)).toThrow();
    }
  });
});

describe("clientIp", () => {
  function requestWith(headers: Record<string, string>): Request {
    return new Request(CHECKOUT_URL, { method: "POST", headers });
  }

  it("takes the last x-forwarded-for hop, which is the one the proxy added", () => {
    expect(clientIp(requestWith({ "x-forwarded-for": "10.0.0.1, 203.0.113.9" }))).toBe(
      "203.0.113.9",
    );
  });

  it("falls back to x-real-ip, then to a shared bucket", () => {
    expect(clientIp(requestWith({ "x-real-ip": "203.0.113.7" }))).toBe("203.0.113.7");
    expect(clientIp(requestWith({}))).toBe("unknown");
  });
});

describe("POST /api/checkout", () => {
  it("creates a session and a payment row", async () => {
    const deps = checkoutDeps();
    const response = await handleCheckoutRequest(
      deps,
      checkoutRequest(
        { projectId: PROJECT_ID, amountUsd: 25.5, email: "payer@example.com" },
        { ip: freshIp() },
      ),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { url: string; paymentId: string };
    expect(body.url).toBe("https://checkout.stripe.com/c/pay/cs_test_1");

    const { rows } = await pool.query<{ amount_usd_cents: string; email: string }>(
      "SELECT amount_usd_cents, email FROM payments WHERE id = $1",
      [body.paymentId],
    );
    expect(rows[0]?.amount_usd_cents).toBe("2550");
    expect(rows[0]?.email).toBe("payer@example.com");
  });

  it("accepts a form post as well as JSON", async () => {
    const response = await handleCheckoutRequest(
      checkoutDeps(),
      checkoutRequest(
        { projectId: PROJECT_ID, amountUsd: "10.00", email: "form@example.com", instant: "on" },
        { ip: freshIp(), form: true },
      ),
    );
    expect(response.status).toBe(200);

    const { rows } = await pool.query<{ instant: boolean }>(
      "SELECT instant FROM payments WHERE email = 'form@example.com'",
    );
    expect(rows[0]?.instant).toBe(true);
  });

  it("rejects an amount with more than two decimal places", async () => {
    const response = await handleCheckoutRequest(
      checkoutDeps(),
      checkoutRequest(
        { projectId: PROJECT_ID, amountUsd: "25.555", email: "payer@example.com" },
        { ip: freshIp() },
      ),
    );
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({
      error: "invalid_request",
    });
    expect((await pool.query("SELECT 1 FROM payments")).rowCount).toBe(0);
  });

  it("rejects a malformed email and a malformed projectId", async () => {
    const badEmail = await handleCheckoutRequest(
      checkoutDeps(),
      checkoutRequest(
        { projectId: PROJECT_ID, amountUsd: "10", email: "not-an-email" },
        { ip: freshIp() },
      ),
    );
    expect(badEmail.status).toBe(400);

    const badProject = await handleCheckoutRequest(
      checkoutDeps(),
      checkoutRequest(
        { projectId: "seven", amountUsd: "10", email: "payer@example.com" },
        { ip: freshIp() },
      ),
    );
    expect(badProject.status).toBe(400);
  });

  it("maps an unknown project to 404 and a suspended one to 409", async () => {
    const unknown = await handleCheckoutRequest(
      checkoutDeps(),
      checkoutRequest(
        { projectId: 9999, amountUsd: "10", email: "payer@example.com" },
        { ip: freshIp() },
      ),
    );
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: string }).error).toBe("unknown_project");

    const suspended = await handleCheckoutRequest(
      checkoutDeps(),
      checkoutRequest(
        { projectId: SUSPENDED_PROJECT_ID, amountUsd: "10", email: "payer@example.com" },
        { ip: freshIp() },
      ),
    );
    expect(suspended.status).toBe(409);
    expect(((await suspended.json()) as { error: string }).error).toBe("project_suspended");
  });

  it("rejects an invalid beneficiary address", async () => {
    const response = await handleCheckoutRequest(
      checkoutDeps(),
      checkoutRequest(
        {
          projectId: PROJECT_ID,
          amountUsd: "10",
          email: "payer@example.com",
          walletAddress: "0xnope",
        },
        { ip: freshIp() },
      ),
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe("invalid_wallet_address");
  });

  it("rate-limits to ten attempts per minute per address", async () => {
    const ip = freshIp();
    const deps = checkoutDeps();
    const body = { projectId: PROJECT_ID, amountUsd: "1", email: "payer@example.com" };

    for (let i = 0; i < 10; i += 1) {
      const ok = await handleCheckoutRequest(deps, checkoutRequest(body, { ip }));
      expect(ok.status).toBe(200);
    }

    const limited = await handleCheckoutRequest(deps, checkoutRequest(body, { ip }));
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { error: string }).error).toBe("rate_limited");

    // The refused attempt reached neither Stripe nor the ledger.
    expect(deps.stripe.calls).toHaveLength(10);
    expect((await pool.query("SELECT 1 FROM payments")).rowCount).toBe(10);

    // A different address still has its own budget.
    const other = await handleCheckoutRequest(deps, checkoutRequest(body, { ip: freshIp() }));
    expect(other.status).toBe(200);
  });

  it("counts a spoofed x-forwarded-for prefix against the same bucket", async () => {
    const realIp = freshIp();
    for (let i = 0; i < 10; i += 1) {
      expect(
        await recordCheckoutAttempt(pool, clientIp(checkoutRequest({}, { ip: realIp }))),
      ).toBe(true);
    }

    // Rotating a fake first hop must not buy a fresh budget.
    const spoofed = await handleCheckoutRequest(
      checkoutDeps(),
      checkoutRequest(
        { projectId: PROJECT_ID, amountUsd: "1", email: "payer@example.com" },
        { forwardedFor: `1.2.3.${ipCounter}, ${realIp}` },
      ),
    );
    expect(spoofed.status).toBe(429);
  });

  it("frees the budget once the window has passed, and keeps no expired rows", async () => {
    const ip = freshIp();
    for (let i = 0; i < 10; i += 1) {
      expect(await recordCheckoutAttempt(pool, ip)).toBe(true);
    }
    expect(await recordCheckoutAttempt(pool, ip)).toBe(false);

    // Age every one of them out of the window.
    await pool.query(
      "UPDATE checkout_attempts SET created_at = now() - interval '2 minutes' WHERE ip = $1",
      [ip],
    );

    expect(await recordCheckoutAttempt(pool, ip)).toBe(true);

    // The expired rows are gone, not merely uncounted: this table is bounded
    // by the limiter itself, with no sweeper behind it.
    const { rows } = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM checkout_attempts WHERE ip = $1",
      [ip],
    );
    expect(rows[0]?.n).toBe("1");
  });

  it("charges a malformed request its rate-limit slot", async () => {
    const ip = freshIp();
    const garbage = await handleCheckoutRequest(checkoutDeps(), checkoutRequest({}, { ip }));
    expect(garbage.status).toBe(400);

    const { rows } = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM checkout_attempts WHERE ip = $1",
      [ip],
    );
    expect(rows[0]?.n).toBe("1");
  });
});

describe("POST /api/stripe-webhook", () => {
  // A real Stripe client with a dummy key, used only for its offline
  // signing/verification helpers -- no network call is ever made.
  const stripe = new Stripe("sk_test_dummy_key_for_offline_signing");

  class PaymentIntentStub {
    intent: unknown = {
      id: "pi_route_1",
      latest_charge: {
        id: "ch_1",
        payment_method_details: { type: "card" },
        balance_transaction: { id: "txn_1", available_on: 1_800_000_000, status: "available" },
      },
    };
    paymentIntents = {
      retrieve: async () => this.intent as Stripe.PaymentIntent,
    };
  }

  function webhookDeps(stub = new PaymentIntentStub()): WebhookRouteDeps {
    return {
      pool,
      stripe: { webhooks: stripe.webhooks, paymentIntents: stub.paymentIntents },
    } as unknown as WebhookRouteDeps;
  }

  let eventCounter = 0;

  /** A raw payload plus the header Stripe would have signed it with. */
  function signedPayload(
    type: string,
    object: unknown,
  ): { payload: string; signature: string } {
    eventCounter += 1;
    const payload = JSON.stringify({
      id: `evt_route_${eventCounter}`,
      object: "event",
      api_version: "2025-03-31.basil",
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      pending_webhooks: 1,
      request: null,
      type,
      data: { object },
    });
    return {
      payload,
      signature: stripe.webhooks.generateTestHeaderString({
        payload,
        secret: WEBHOOK_SECRET,
      }),
    };
  }

  function webhookRequest(payload: string, signature?: string): Request {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (signature !== undefined) headers["stripe-signature"] = signature;
    return new Request("https://processor.test/api/stripe-webhook", {
      method: "POST",
      headers,
      body: payload,
    });
  }

  async function seedPayment(): Promise<string> {
    const payment = await createPayment(pool, {
      projectId: PROJECT_ID,
      email: "payer@example.com",
      amountUsdCents: 2500n,
      instant: false,
      claimAddress: PREGEN_WALLET,
    });
    return payment.id;
  }

  it("400s a request with no signature header", async () => {
    const { payload } = signedPayload("checkout.session.completed", {});
    const response = await handleWebhookRequest(webhookDeps(), webhookRequest(payload));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe("missing_signature");
  });

  it("400s a payload whose signature does not verify", async () => {
    const { payload, signature } = signedPayload("checkout.session.completed", {});
    const tampered = payload.replace("checkout.session.completed", "charge.refunded");

    const response = await handleWebhookRequest(
      webhookDeps(),
      webhookRequest(tampered, signature),
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe("invalid_signature");
    // Nothing was consumed, so Stripe's own retry of a genuine event still works.
    expect((await pool.query("SELECT 1 FROM stripe_events")).rowCount).toBe(0);
  });

  it("verifies a genuine payload and dispatches it", async () => {
    const paymentId = await seedPayment();
    const { payload, signature } = signedPayload("checkout.session.completed", {
      id: "cs_route_1",
      object: "checkout.session",
      metadata: { payment_id: paymentId },
      payment_intent: "pi_route_1",
      payment_status: "paid",
    });

    const response = await handleWebhookRequest(webhookDeps(), webhookRequest(payload, signature));
    expect(response.status).toBe(200);
    expect((await response.json()) as { received: boolean }).toEqual({ received: true });

    const { rows } = await pool.query<{ state: PaymentState; method: string | null }>(
      "SELECT state, method FROM payments WHERE id = $1",
      [paymentId],
    );
    expect(rows[0]?.state).toBe("paid");
    expect(rows[0]?.method).toBe("card");

    // And the pay job the webhook is supposed to schedule.
    const jobs = await pool.query<{ kind: string }>(
      "SELECT kind FROM jobs WHERE dedupe_key = $1",
      [`pay:${paymentId}`],
    );
    expect(jobs.rowCount).toBe(1);
  });

  it("is idempotent across a redelivery of the same event", async () => {
    const paymentId = await seedPayment();
    const { payload, signature } = signedPayload("checkout.session.completed", {
      id: "cs_route_2",
      object: "checkout.session",
      metadata: { payment_id: paymentId },
      payment_intent: "pi_route_2",
      payment_status: "paid",
    });

    expect((await handleWebhookRequest(webhookDeps(), webhookRequest(payload, signature))).status)
      .toBe(200);
    expect((await handleWebhookRequest(webhookDeps(), webhookRequest(payload, signature))).status)
      .toBe(200);

    expect((await pool.query("SELECT 1 FROM stripe_events")).rowCount).toBe(1);
  });

  it("throws (so Stripe retries) when the webhook secret is not configured", async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const { payload, signature } = signedPayload("checkout.session.completed", {});

    await expect(
      handleWebhookRequest(webhookDeps(), webhookRequest(payload, signature)),
    ).rejects.toThrow(/STRIPE_WEBHOOK_SECRET/);
  });
});
