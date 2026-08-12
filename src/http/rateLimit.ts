import type { Pool } from "pg";
import { withTransaction } from "../db/index.js";

/**
 * The address a rate limit counts against.
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
 * The key one endpoint's limit counts under: the scope, then the address.
 *
 * Every limited endpoint shares the `checkout_attempts` table, and each one
 * gets its own budget per address -- a payer who has used up their checkout
 * attempts can still sign in. Prefixing rather than adding a column keeps the
 * single index (and the advisory lock below) doing the same work it already
 * did, and a scope name never contains a colon, so two scopes can't collide.
 */
export function attemptKey(scope: string, ip: string): string {
  return `${scope}:${ip}`;
}

/**
 * Records an attempt from `ip` against `scope`, or returns false when that
 * address has already used that scope's budget for the minute.
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
 * So requests under one key are serialised explicitly, on an advisory lock
 * keyed by that key. It is held for the transaction only, costs nothing when
 * keys differ (different keys never contend), and makes each request in a
 * burst see every earlier one's committed row.
 *
 * The prune is global, not scoped to this key. Scoping it would only ever
 * clean up after addresses that come back, so a flood from rotating addresses
 * -- exactly the traffic that produces the most rows -- would leave every one
 * of them behind forever. Deleting rows that have fallen out of the window
 * cannot change any gate's answer, because no gate counts them.
 */
export async function recordAttempt(
  pool: Pool,
  scope: string,
  ip: string,
  maxPerMinute: number,
): Promise<boolean> {
  const key = attemptKey(scope, ip);

  return withTransaction(pool, async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [key]);

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
      [key, maxPerMinute],
    );
    return rows.length > 0;
  });
}
