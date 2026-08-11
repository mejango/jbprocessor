import type { Pool } from "pg";
import Stripe from "stripe";
import { getPool } from "../db/index.js";
import { requireEnv } from "../env.js";
import {
  constructStripeEvent,
  handleStripeEvent,
  type StripePaymentIntentReader,
  type StripeWebhookVerifier,
} from "../stripe/webhook.js";

export interface WebhookRouteDeps {
  pool: Pool;
  stripe: StripePaymentIntentReader & StripeWebhookVerifier;
}

/**
 * Handles `POST /api/stripe-webhook`.
 *
 * The three status codes each mean something specific to Stripe, and getting
 * them wrong is how deliveries are lost:
 *
 *   400 -- the payload is not from Stripe (bad or missing signature, or a
 *          body that has been modified in transit). Stripe does not retry a
 *          4xx, which is correct: nothing about this delivery will improve.
 *   500 -- we could not process a delivery we believe is genuine. Stripe
 *          retries with backoff for days, which is exactly what a database
 *          outage or an unset webhook secret needs.
 *   200 -- consumed. `handleStripeEvent` has already committed both the
 *          idempotency marker and the state change in one transaction, so a
 *          duplicate delivery after this point is a no-op.
 *
 * The secret is required *before* verification is attempted, so a deployment
 * that is missing it answers 500 (retry later, once configured) rather than
 * 400 (never seen again) to every live event.
 */
export async function handleWebhookRequest(
  deps: WebhookRouteDeps,
  request: Request,
): Promise<Response> {
  requireEnv("STRIPE_WEBHOOK_SECRET");

  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return Response.json({ error: "missing_signature" }, { status: 400 });
  }

  // The raw body, byte for byte. The signature covers the exact bytes Stripe
  // sent, so anything that re-serialises the payload (parsing it as JSON and
  // stringifying it back) invalidates every signature it touches.
  const rawBody = await request.text();

  let event: Stripe.Event;
  try {
    event = constructStripeEvent(deps.stripe, rawBody, signature);
  } catch (err) {
    console.warn(
      `stripe webhook: signature verification failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return Response.json({ error: "invalid_signature" }, { status: 400 });
  }

  await handleStripeEvent(deps, event);
  return Response.json({ received: true }, { status: 200 });
}

/** The production dependency bag. */
export function liveWebhookDeps(): WebhookRouteDeps {
  return {
    pool: getPool(),
    stripe: new Stripe(requireEnv("STRIPE_SECRET_KEY")),
  };
}
