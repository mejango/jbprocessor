import type { Pool } from "pg";
import Stripe from "stripe";
import { isEmailish } from "../auth/magic.js";
import { publicClient } from "../chain/client.js";
import { liveQuoteReads } from "../chain/quote.js";
import { getPool, withTransaction } from "../db/index.js";
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
 * An `INSERT ... SELECT` gate is NOT self-serialising the way the redirect
 * limiter's is. That one runs under a `FOR UPDATE` row lock on the payment it
 * is limiting; this one has no such row. Under READ COMMITTED every statement
 * takes its own snapshot, so a batch of simultaneous requests from one address
 * all count the same pre-batch set of rows, all find themselves under the
 * limit, and all insert. The gate would cap a *sequence* of requests and let a
 * *burst* straight through -- which is the only shape of traffic a rate limit
 * exists to stop.
 *
 * So requests from one address are serialised explicitly, on an advisory lock
 * keyed by the address itself. It is held for the transaction only, costs
 * nothing when addresses differ (different keys never contend), and makes each
 * request in a burst see every earlier one's committed row.
 *
 * The prune is global, not scoped to this address. Scoping it would only ever
 * clean up after addresses that come back, so a flood from rotating addresses
 * -- exactly the traffic that produces the most rows -- would leave every one
 * of them behind forever. Deleting rows that have fallen out of the window
 * cannot change any gate's answer, because no gate counts them.
 */
export async function recordCheckoutAttempt(pool: Pool, ip: string): Promise<boolean> {
  return withTransaction(pool, async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [ip]);

    await db.query(
      "DELETE FROM checkout_attempts WHERE created_at <= now() - interval '1 minute'",
    );

    const { rows } = await db.query<{ id: string }>(
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
  });
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
  deps: CheckoutRouteDeps,
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
export function liveCheckoutDeps(): CheckoutRouteDeps {
  const pool = getPool();
  return {
    pool,
    stripe: new Stripe(requireEnv("STRIPE_SECRET_KEY")),
    quoteReads: liveQuoteReads(publicClient()),
    wallets: paraWalletProvider({ pool, para: liveParaClient() }),
  };
}
