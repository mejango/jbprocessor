import Stripe from "stripe";
import { isEmailish } from "../auth/magic.js";
import { publicClient } from "../chain/client.js";
import { getPool } from "../db/index.js";
import type { Queryable } from "../db/payments.js";
import { requireEnv } from "../env.js";
import { liveParaClient, paraWalletProvider } from "../wallets/para.js";
import {
  createCheckoutSession,
  CheckoutError,
  type CheckoutDeps,
  type CheckoutErrorCode,
} from "../stripe/checkout.js";

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
  // Not the caller's fault and not permanent: the pool needs topping up, or
  // an in-flight payment needs to clear. A retry later is the right advice.
  insufficient_pool_headroom: 503,
  stripe_session_missing_url: 502,
};

/** A malformed request, reported with the field that was wrong. */
class BadRequestError extends Error {}

/**
 * The address the rate limit counts against.
 *
 * The *last* `x-forwarded-for` hop, not the first. A client can put whatever
 * it likes in that header, and the proxy in front of us appends what it
 * actually saw -- so the first entry is attacker-controlled and the last one
 * is the closest thing to a peer address this process can observe. Getting
 * this backwards would make the limit trivially evadable by rotating a fake
 * prefix.
 *
 * Requests that arrive with no forwarding headers at all share the `unknown`
 * bucket. That is deliberately strict: in a deployment where the proxy always
 * sets the header, anything without one didn't come through the front door.
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const lastHop = forwarded
    ?.split(",")
    .map((hop) => hop.trim())
    .filter((hop) => hop !== "")
    .at(-1);
  if (lastHop) return lastHop;

  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

/**
 * Records an attempt from `ip`, or returns false when that address has
 * already used its budget for the minute.
 *
 * The count and the write are one statement, exactly like the redirect
 * limiter: there is no window between deciding and recording, so N concurrent
 * requests from one address can't all read "9 so far" and all proceed.
 */
export async function recordCheckoutAttempt(pool: Queryable, ip: string): Promise<boolean> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO checkout_attempts (ip)
     SELECT $1
      WHERE (
        SELECT count(*) FROM checkout_attempts
         WHERE ip = $1 AND created_at > now() - interval '1 minute'
      ) < $2
     RETURNING id`,
    [ip, MAX_ATTEMPTS_PER_MINUTE],
  );
  return rows.length > 0;
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

/**
 * Reads the body as flat strings, from either JSON or a form post.
 *
 * JSON numbers and booleans are stringified rather than dropped: `amountUsd`
 * and `instant` are naturally a number and a boolean to a JSON caller and
 * strings to an HTML form, and every field is validated from its string form
 * below anyway.
 */
async function readFields(request: Request): Promise<Record<string, string>> {
  const fields: Record<string, string> = {};
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    try {
      const body = (await request.json()) as Record<string, unknown> | null;
      for (const [key, value] of Object.entries(body ?? {})) {
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          fields[key] = String(value);
        }
      }
    } catch {
      // An unreadable body is an empty one; the validation below names what's missing.
    }
    return fields;
  }

  try {
    const form = await request.formData();
    for (const [key, value] of form.entries()) {
      if (typeof value === "string") fields[key] = value;
    }
  } catch {
    // Same.
  }
  return fields;
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
  deps: CheckoutDeps,
  request: Request,
): Promise<Response> {
  // Before parsing anything: an attempt that is refused for being malformed
  // still costs this service a round trip, so it still costs the caller a
  // slot. Otherwise a flood of garbage would be free.
  if (!(await recordCheckoutAttempt(deps.pool, clientIp(request)))) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  const fields = await readFields(request);

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
    return Response.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof BadRequestError) {
      return Response.json({ error: "invalid_request", message: err.message }, { status: 400 });
    }
    if (err instanceof CheckoutError) {
      return Response.json(
        { error: err.code, message: err.message },
        { status: STATUS_BY_CHECKOUT_CODE[err.code] },
      );
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
export function liveCheckoutDeps(): CheckoutDeps {
  const pool = getPool();
  return {
    pool,
    stripe: new Stripe(requireEnv("STRIPE_SECRET_KEY")),
    quoteClient: publicClient(),
    wallets: paraWalletProvider({ pool, para: liveParaClient() }),
  };
}
