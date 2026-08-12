import type { Pool } from "pg";
import Stripe from "stripe";
import { isEmailish } from "../auth/magic.js";
import { publicClient } from "../chain/client.js";
import { liveQuoteReads } from "../chain/quote.js";
import { getPool } from "../db/index.js";
import { requireEnv } from "../env.js";
import { liveParaClient, paraWalletProvider } from "../wallets/para.js";
import {
  createCheckoutSession,
  CheckoutError,
  type CheckoutDeps,
  type CheckoutErrorCode,
} from "../stripe/checkout.js";
import { readRequestFields } from "./fields.js";
import { clientIp, recordAttempt } from "./rateLimit.js";

/**
 * How many checkout attempts one source address may make per minute.
 *
 * A donation takes a human at least that long to fill in, so the limit costs a
 * real payer nothing. What it buys is a ceiling on the two things an unlimited
 * public endpoint gives away for free: pregenerated Para wallets (one network
 * call each, per distinct email) and `previewPayFor` reads against the RPC
 * provider.
 */
const MAX_ATTEMPTS_PER_MINUTE = 10;

/** Dollars with at most two decimal places. Anything else is a typo or a float artifact. */
const AMOUNT_PATTERN = /^\d+(?:\.\d{1,2})?$/;

const PROJECT_ID_PATTERN = /^\d+$/;

/** Status per rejection reason. Everything else is a 500 the caller may retry. */
const STATUS_BY_CHECKOUT_CODE: Record<CheckoutErrorCode, number> = {
  unknown_project: 404,
  project_suspended: 409,
  invalid_amount: 400,
  invalid_wallet_address: 400,
  // Nothing the caller can change: this project cannot be quoted, so it
  // cannot be sold. Same shape as a suspension.
  project_unquotable: 409,
  // Not the caller's fault and not permanent: the pool needs topping up, or
  // an in-flight payment needs to clear. A retry later is the right advice.
  insufficient_pool_headroom: 503,
  stripe_session_missing_url: 502,
};

/** A malformed request, reported with the field that was wrong. */
class BadRequestError extends Error {}

/**
 * Checkout's own dependencies plus a real `Pool`. The rate limiter needs a
 * transaction (for its advisory lock), which a bare `Queryable` cannot open.
 */
export interface CheckoutRouteDeps extends CheckoutDeps {
  pool: Pool;
}

/** Records a checkout attempt from `ip`, or refuses it. See `recordAttempt`. */
export async function recordCheckoutAttempt(pool: Pool, ip: string): Promise<boolean> {
  return recordAttempt(pool, "checkout", ip, MAX_ATTEMPTS_PER_MINUTE);
}

/**
 * Dollars (`"25"`, `"25.5"`, `"25.50"`) to integer cents.
 *
 * The whole service counts money in bigint cents; this is the only place a
 * human-facing dollar amount enters, so it is also the only place that can
 * introduce a rounding error. It refuses rather than rounds -- a request for
 * `25.555` is a bug in the caller, and silently charging either 25.55 or 25.56
 * would hide it. A JSON float that can't represent itself in two places
 * (`0.1 + 0.2`) stringifies to enough digits to be caught here too.
 */
export function centsFromDollars(raw: string): bigint {
  if (!AMOUNT_PATTERN.test(raw)) {
    throw new BadRequestError(
      `amountUsd must be a dollar amount with at most two decimal places, got: ${raw}`,
    );
  }
  const [whole = "0", fraction = ""] = raw.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}

function parseInstant(raw: string | undefined): boolean {
  if (raw === undefined || raw === "") return false;
  if (raw === "true" || raw === "1" || raw === "on") return true;
  if (raw === "false" || raw === "0") return false;
  throw new BadRequestError(`instant must be a boolean, got: ${raw}`);
}

/**
 * Handles `POST /api/checkout`: validate, rate-limit, and hand off to
 * `createCheckoutSession`.
 *
 * Deps are injected rather than built here so the route is testable without
 * Stripe or Para credentials; `liveCheckoutDeps` is what the route passes in
 * production.
 */
export async function handleCheckoutRequest(
  deps: CheckoutRouteDeps,
  request: Request,
): Promise<Response> {
  // Before parsing anything: an attempt that is refused for being malformed
  // still costs this service a round trip, so it still costs the caller a
  // slot. Otherwise a flood of garbage would be free.
  if (!(await recordCheckoutAttempt(deps.pool, clientIp(request)))) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  const { fields, isForm } = await readRequestFields(request);

  // The no-JavaScript donate form gets redirects instead of JSON: straight to
  // Stripe on success, back to the form with an error code otherwise. Same
  // shape as /api/login's form branch.
  const formErrorRedirect = (code: string) => {
    const back = new URL(`/donate/${fields.projectId ?? ""}`, request.url);
    back.searchParams.set("error", code);
    if (fields.amountUsd) back.searchParams.set("amount", fields.amountUsd);
    return Response.redirect(back, 303);
  };

  try {
    const projectId = fields.projectId ?? "";
    if (!PROJECT_ID_PATTERN.test(projectId) || Number(projectId) > Number.MAX_SAFE_INTEGER) {
      throw new BadRequestError(`projectId must be a non-negative integer, got: ${projectId}`);
    }

    const email = fields.email ?? "";
    if (!isEmailish(email)) {
      throw new BadRequestError("email must be a valid email address");
    }

    const amountUsdCents = centsFromDollars(fields.amountUsd ?? "");
    const instant = parseInstant(fields.instant);

    const result = await createCheckoutSession(deps, {
      projectId: Number(projectId),
      amountUsdCents,
      email,
      instant,
      ...(fields.walletAddress ? { walletAddress: fields.walletAddress } : {}),
    });
    if (isForm) return Response.redirect(result.url, 303);
    return Response.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof BadRequestError) {
      if (isForm) return formErrorRedirect("invalid_request");
      return Response.json({ error: "invalid_request", message: err.message }, { status: 400 });
    }
    if (err instanceof CheckoutError) {
      if (isForm) return formErrorRedirect(err.code);
      return Response.json(
        { error: err.code, message: err.message },
        { status: STATUS_BY_CHECKOUT_CODE[err.code] },
      );
    }
    // A donor clicking the hosted form shouldn't see a bare 500 because this
    // environment is missing its Stripe/Para configuration. JSON callers
    // still get the throw -- integrators want the real error.
    if (isForm && err instanceof Error && / environment variable is not set$/.test(err.message)) {
      console.error(`checkout unavailable: ${err.message}`);
      return formErrorRedirect("not_configured");
    }
    throw err;
  }
}

/**
 * The production dependency bag.
 *
 * Note what is *not* here: a wallet client. Checkout runs in the web process,
 * which never signs anything -- the quote is a read, and the beneficiary comes
 * from Para. The escrow operator key lives only in the worker.
 */
/**
 * The response for an environment that cannot build its live deps (missing
 * Stripe/Para configuration). The donate form gets a friendly bounce; JSON
 * callers get a 503 naming the problem class without leaking which variable.
 */
export async function unconfiguredResponse(request: Request, err: unknown): Promise<Response> {
  console.error(`checkout unavailable: ${err instanceof Error ? err.message : String(err)}`);
  const { fields, isForm } = await readRequestFields(request);
  if (isForm) {
    const back = new URL(`/donate/${fields.projectId ?? ""}`, request.url);
    back.searchParams.set("error", "not_configured");
    if (fields.amountUsd) back.searchParams.set("amount", fields.amountUsd);
    return Response.redirect(back, 303);
  }
  return Response.json({ error: "not_configured" }, { status: 503 });
}

export function liveCheckoutDeps(): CheckoutRouteDeps {
  const pool = getPool();
  return {
    pool,
    stripe: new Stripe(requireEnv("STRIPE_SECRET_KEY")),
    quoteReads: liveQuoteReads(publicClient()),
    wallets: paraWalletProvider({ pool, para: liveParaClient() }),
  };
}
