import {
  isEmailish,
  normalizeEmail,
  signToken,
  verifyToken,
  type ClockOptions,
} from "../auth/magic.js";
import { enqueue } from "../db/jobs.js";
import type { Queryable } from "../db/payments.js";

/** How long a mailed link stays good. Long enough to walk to a laptop, no longer. */
const MAGIC_LINK_TTL_MINUTES = 15;

/** One link per address per minute. See `requestMagicLink`. */
const LINK_BUCKET_MS = 60_000;

export interface LoginDeps {
  pool: Queryable;
}

/** Payload of the `magic-link-email` job. Task 9's mailer consumes it. */
export interface MagicLinkEmailJobPayload {
  email: string;
  token: string;
}

/**
 * Starts a login. Enqueues the mail rather than sending it inline, so a
 * flaky mail provider is a retried job instead of a failed request -- and so
 * the request returns in constant time whether or not the address has ever
 * paid.
 *
 * There is no "unknown account" path on purpose: anyone may request a link
 * for any address, and only the mailbox owner ever sees one. The caller
 * always reports the same thing, so this is not an account-existence oracle.
 * A malformed address is dropped silently for the same reason.
 *
 * At most one link per address per minute, enforced by a bucketed dedupe key.
 * A payer who clicks twice still gets a link (the first one, which is exactly
 * what they wanted), while an attacker pointing a loop at this endpoint can
 * neither mail-bomb the address nor fill the job queue with work that starves
 * the keeper behind it. Extra requests are silent no-ops -- the response never
 * changes, so the throttle isn't observable either.
 */
export async function requestMagicLink(
  deps: LoginDeps,
  email: string,
  options: ClockOptions = {},
): Promise<void> {
  if (!isEmailish(email)) return;

  const now = options.now?.() ?? Date.now();
  const normalized = normalizeEmail(email);
  const payload: MagicLinkEmailJobPayload = {
    email: normalized,
    token: signToken(normalized, MAGIC_LINK_TTL_MINUTES, options),
  };
  await enqueue(deps.pool, "magic-link-email", payload, {
    dedupeKey: `magic-link:${normalized}:${Math.floor(now / LINK_BUCKET_MS)}`,
  });
}

/**
 * Finishes a login: spends the token and returns the email it proves, or null
 * for anything expired, forged or already used. The caller turns a non-null
 * result into a session cookie -- see `sessionSetCookie`.
 */
export async function completeLogin(
  deps: LoginDeps,
  token: string,
  options: ClockOptions = {},
): Promise<string | null> {
  return verifyToken(deps.pool, token, options);
}
