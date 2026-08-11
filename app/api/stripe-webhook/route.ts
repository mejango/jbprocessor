import { handleWebhookRequest, liveWebhookDeps } from "../../../src/http/webhook.js";

/**
 * Stripe's delivery endpoint. Everything that happens after a payer submits
 * the checkout form starts here.
 *
 * The signature is verified against the raw request body, so this route must
 * never sit behind anything that rewrites it. In the App Router `req.text()`
 * gives the untouched bytes -- there is no body parser in front of it to
 * disable.
 */
export async function POST(request: Request): Promise<Response> {
  return handleWebhookRequest(liveWebhookDeps(), request);
}
