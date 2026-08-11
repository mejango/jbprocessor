import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Queryable } from "../db/payments.js";
import { requireEnv } from "../env.js";

/**
 * There is no password anywhere in this service. A payer proves they are the
 * person who paid by receiving mail at the address Stripe charged, so the two
 * credentials here -- a magic-link token and a session cookie -- are both just
 * a signed statement of "this email, until this instant", verified with the
 * server's own key.
 *
 * Both are MACs over `email|exp|nonce`, but with different domain-separation
 * prefixes: a session cookie must never be replayable as a login token (it
 * lives in the browser for weeks and rides on every request), and a login
 * token must never be replayable as a session (it is single-use by design).
 * Without the prefix, one signing key would make the two interchangeable.
 */

const MAGIC_DOMAIN = "magic";
const SESSION_DOMAIN = "session";

export const SESSION_COOKIE_NAME = "jbp_session";

const DEFAULT_SESSION_TTL_DAYS = 30;

/** Injectable clock, so tests can sit on either side of an expiry. */
export interface ClockOptions {
  now?: () => number;
  /** Overrides `AUTH_SECRET`. Only tests pass this. */
  secret?: string;
}

/**
 * Read fresh from the environment on every call (not memoized) so a test can
 * set it in `beforeAll` and the web/worker processes pick up a rotated key on
 * restart without a build step.
 */
function authSecret(override?: string): string {
  return override ?? requireEnv("AUTH_SECRET");
}

function mac(domain: string, body: string, secret: string): string {
  return createHmac("sha256", secret).update(`${domain}:${body}`).digest("base64url");
}

/**
 * Constant-time comparison of two base64url MACs. Compares lengths first
 * (`timingSafeEqual` throws on a length mismatch), which leaks only the length
 * of a value the attacker already knows the shape of.
 */
function macEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Emails are matched case-insensitively everywhere; this is the one normalizer. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** A shape check, not a deliverability check -- the mail either arrives or it doesn't. */
export function isEmailish(email: string): boolean {
  return /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(email.trim());
}

function randomNonce(): string {
  // 16 CSPRNG bytes: enough that two tokens issued in the same second for the
  // same email are still distinct values (and distinct `used_tokens` rows),
  // and unguessable even to someone who knows exactly when a link was minted.
  return randomBytes(16).toString("base64url");
}

/**
 * Splits a signed body from the right: the last three fields are always exp,
 * nonce and MAC, so an email containing a `|` (legal, if rare) still parses.
 * The MAC covers the whole string either way, so this is a parse convenience,
 * not a security boundary.
 */
function splitSigned(
  raw: string,
): { email: string; exp: number; signature: string; body: string } | null {
  const parts = raw.split("|");
  if (parts.length < 4) return null;
  const signature = parts.pop() as string;
  const body = parts.join("|");
  parts.pop(); // nonce -- carried only to keep two same-second tokens distinct
  const expRaw = parts.pop() as string;
  const email = parts.join("|");
  if (!email || !/^\d+$/.test(expRaw)) return null;
  return { email, exp: Number(expRaw), signature, body };
}

/**
 * Mints a magic-link token for `email`, valid for `ttlMinutes`. The token is
 * the whole credential -- it is mailed, so it must be short-lived, and it is
 * spent on first use (see `verifyToken`).
 */
export function signToken(email: string, ttlMinutes: number, options: ClockOptions = {}): string {
  const now = options.now?.() ?? Date.now();
  const normalized = normalizeEmail(email);
  const exp = Math.floor(now / 1000) + ttlMinutes * 60;
  const body = `${normalized}|${exp}|${randomNonce()}`;
  const signature = mac(MAGIC_DOMAIN, body, authSecret(options.secret));
  return Buffer.from(`${body}|${signature}`, "utf8").toString("base64url");
}

/**
 * Verifies a magic-link token and spends it, returning the email or null.
 *
 * Order matters: the MAC and the expiry are checked before the database is
 * touched at all, so an attacker spraying forged tokens writes nothing; and
 * the `used_tokens` insert is last, so a token that failed verification isn't
 * burned (and a valid one is burned exactly once -- the primary key is the
 * arbiter, not a read-then-write, so two simultaneous clicks on the same link
 * still produce one login).
 *
 * Only the token's sha256 is stored. The table is a spent-token ledger, not a
 * credential store.
 */
export async function verifyToken(
  db: Queryable,
  token: string,
  options: ClockOptions = {},
): Promise<string | null> {
  const now = options.now?.() ?? Date.now();
  if (!token) return null;

  let decoded: string;
  try {
    decoded = Buffer.from(token, "base64url").toString("utf8");
  } catch {
    return null;
  }

  const parsed = splitSigned(decoded);
  if (!parsed) return null;

  const expected = mac(MAGIC_DOMAIN, parsed.body, authSecret(options.secret));
  if (!macEquals(parsed.signature, expected)) return null;
  if (parsed.exp * 1000 <= now) return null;

  // Hash the DECODED payload, never the string that arrived. base64url is
  // malleable -- `token`, `token=`, `token==` and a token with a stray newline
  // all decode to the same bytes -- so hashing the raw string would file each
  // variant under its own `used_tokens` row and let a spent link be replayed
  // by appending a character.
  const hash = createHash("sha256").update(decoded, "utf8").digest("hex");
  const result = await db.query(
    "INSERT INTO used_tokens (hash) VALUES ($1) ON CONFLICT (hash) DO NOTHING",
    [hash],
  );
  if (result.rowCount !== 1) return null;

  return parsed.email;
}

export interface SessionOptions extends ClockOptions {
  ttlDays?: number;
}

/**
 * Builds the signed cookie *value* (`email|exp|nonce|mac`). Building the
 * `Set-Cookie` header itself is the caller's job -- see `sessionCookieAttributes`.
 */
export function makeSessionCookie(email: string, options: SessionOptions = {}): string {
  const now = options.now?.() ?? Date.now();
  const ttlDays = options.ttlDays ?? DEFAULT_SESSION_TTL_DAYS;
  const normalized = normalizeEmail(email);
  const exp = Math.floor(now / 1000) + ttlDays * 24 * 60 * 60;
  const body = `${normalized}|${exp}|${randomNonce()}`;
  return `${body}|${mac(SESSION_DOMAIN, body, authSecret(options.secret))}`;
}

/**
 * The cookie value is percent-encoded on the way out (it contains `|` and the
 * payer's `@`, and only a subset of octets is legal in a cookie), so it has to
 * be decoded on the way back in. Nothing here decodes the value itself --
 * `next/headers` and a raw `Cookie` header both hand back exactly what the
 * browser sent -- and a value that isn't valid percent-encoding is used as-is
 * rather than throwing, so an old unencoded cookie still verifies.
 */
function decodeCookieValue(raw: string): string {
  if (!raw.includes("%")) return raw;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Returns the session's email, or null when the cookie is missing, forged or expired. */
export function readSession(
  cookieValue: string | null | undefined,
  options: ClockOptions = {},
): string | null {
  const now = options.now?.() ?? Date.now();
  if (!cookieValue) return null;

  const parsed = splitSigned(decodeCookieValue(cookieValue));
  if (!parsed) return null;

  const expected = mac(SESSION_DOMAIN, parsed.body, authSecret(options.secret));
  if (!macEquals(parsed.signature, expected)) return null;
  if (parsed.exp * 1000 <= now) return null;

  return parsed.email;
}

/**
 * Cookie attributes for the session. `Secure` is on unless `COOKIE_SECURE` is
 * explicitly "false" -- a local http dev server can't set a Secure cookie, but
 * the default has to be the safe one, since forgetting the variable in
 * production would ship the session over plaintext.
 *
 * `SameSite=Lax` (not Strict) because the magic link arrives from a mail
 * client: a Strict cookie set on that navigation would not be sent on the
 * follow-up request to /account.
 */
export function sessionCookieAttributes(maxAgeSeconds: number): string {
  const secure = process.env.COOKIE_SECURE !== "false";
  return [
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    secure ? "Secure" : null,
    `Max-Age=${maxAgeSeconds}`,
  ]
    .filter(Boolean)
    .join("; ");
}

/** The full `Set-Cookie` header value that logs `email` in. */
export function sessionSetCookie(email: string, options: SessionOptions = {}): string {
  const ttlDays = options.ttlDays ?? DEFAULT_SESSION_TTL_DAYS;
  const value = encodeURIComponent(makeSessionCookie(email, options));
  return `${SESSION_COOKIE_NAME}=${value}; ${sessionCookieAttributes(ttlDays * 24 * 60 * 60)}`;
}

/** Reads the session cookie out of a raw `Cookie` header. */
export function sessionFromCookieHeader(
  header: string | null | undefined,
  options: ClockOptions = {},
): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== SESSION_COOKIE_NAME) continue;
    return readSession(part.slice(index + 1).trim(), options);
  }
  return null;
}
