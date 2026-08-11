import { handleCheckoutRequest, liveCheckoutDeps } from "../../../src/http/checkout.js";

/**
 * Starts a donation: `{projectId, amountUsd, email, instant?, walletAddress?}`
 * in, `{url, paymentId}` out. The payer is sent to `url`, Stripe takes the
 * money, and the webhook drives everything after that.
 *
 * The handler itself lives in `src/http/checkout.ts` so it can be tested as a
 * plain `Request -> Response` function with stubbed dependencies; this file is
 * only the binding to the live Stripe/Para/RPC clients.
 */
export async function POST(request: Request): Promise<Response> {
  return handleCheckoutRequest(liveCheckoutDeps(), request);
}
