import type { Pool } from "pg";
import { requestMagicLink } from "../account/login.js";
import { getPool } from "../db/index.js";
import { readRequestFields } from "./fields.js";
import { clientIp, recordAttempt } from "./rateLimit.js";

/**
 * How many sign-in requests one source address may make per minute.
 *
 * `requestMagicLink` already throttles per *address* (one mail per address per
 * minute), which stops a mail bomb aimed at one person. This limit covers the
 * other direction: one caller walking a list of addresses, where every request
 * is a distinct dedupe key and therefore a real job, a real Resend call and a
 * real row. Ten a minute is far more than any human signing in.
 */
const MAX_LOGIN_ATTEMPTS_PER_MINUTE = 10;

export interface LoginRouteDeps {
  pool: Pool;
}

/**
 * Handles `POST /api/login`: rate-limit, then start a login.
 *
 * The response is the same whatever the address -- see `requestMagicLink`;
 * telling a caller "no such account" would turn this endpoint into a way to
 * ask whether a given person has donated. A refusal for rate limiting is a
 * different thing entirely and says so with a 429: it is a fact about the
 * caller's own traffic, not about anyone's account, so hiding it behind a
 * fake success would only mean an honest client retries into the same wall.
 *
 * Serves both callers of the same handler: the no-JavaScript form on /login
 * (which wants a redirect back to a "check your email" page) and a
 * programmatic client (which wants JSON).
 */
export async function handleLoginRequest(
  deps: LoginRouteDeps,
  request: Request,
): Promise<Response> {
  // Before parsing anything, exactly as checkout does: an attempt that is
  // refused for being malformed still costs this service a round trip.
  if (!(await recordAttempt(deps.pool, "login", clientIp(request), MAX_LOGIN_ATTEMPTS_PER_MINUTE))) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  const { fields, isForm } = await readRequestFields(request);

  await requestMagicLink({ pool: deps.pool }, fields.email ?? "");

  if (isForm) {
    return Response.redirect(new URL("/login?sent=1", request.url), 303);
  }
  return Response.json({ ok: true });
}

/** The production dependency bag. */
export function liveLoginDeps(): LoginRouteDeps {
  return { pool: getPool() };
}
