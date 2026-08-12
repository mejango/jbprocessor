import type { Pool } from "pg";
import { basescanTx, formatTokens, formatUsdCents } from "../account/format.js";
import type { JobRow } from "../db/jobs.js";
import type { PaymentState } from "../db/payments.js";
import { sendAlert, sendEmail, type EmailDeps } from "../email/send.js";
import { requireEnv } from "../env.js";

export interface EmailJobDeps extends EmailDeps {
  pool: Pool;
}

/** Everything any of the payer-facing templates renders. */
interface PaymentEmailRow {
  id: string;
  email: string;
  state: PaymentState;
  amount_usd_cents: string;
  premium_usd_cents: string;
  tokens_held: string | null;
  claim_address: string | null;
  unlock_at: Date | null;
  release_tx: string | null;
  project_name: string;
}

/** The service's own origin, with any trailing slash removed. */
function baseUrl(): string {
  return requireEnv("BASE_URL").replace(/\/+$/, "");
}

/**
 * `2026-12-01`. Deliberately ISO rather than a locale format: the payer's
 * locale is unknown, and `01/12/2026` means two different days depending on
 * who reads it.
 */
function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function payloadString(job: JobRow, field: string): string {
  const payload = job.payload as Record<string, unknown> | null;
  const value = payload?.[field];
  if (typeof value !== "string" || value === "") {
    throw new Error(`job ${job.id}: payload has no ${field}`);
  }
  return value;
}

/**
 * Loads the payment behind an email job, or null when it's gone.
 *
 * A missing payment completes the job rather than retrying it: nothing about
 * a deleted row becomes true again on the third attempt, and a mail job is
 * not worth eight retries and a FATAL entry over it.
 */
async function loadPayment(deps: EmailJobDeps, id: string): Promise<PaymentEmailRow | null> {
  const { rows } = await deps.pool.query<PaymentEmailRow>(
    `SELECT p.id, p.email, p.state, p.amount_usd_cents, p.premium_usd_cents,
            p.tokens_held, p.claim_address, p.unlock_at, p.release_tx,
            pr.name AS project_name
       FROM payments p
       JOIN projects pr ON pr.project_id = p.project_id
      WHERE p.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/** Common footer. One place, so every mail points at the same account page. */
function footer(): string {
  return `See all your payments: ${baseUrl()}/account\n\n-- JBProcessor`;
}

/**
 * Mails a sign-in link. The token is in the URL and nowhere else -- not in
 * the log line, not in the subject -- and the copy says out loud that the
 * link is single-use and short-lived so an unexpected one reads as something
 * to ignore rather than something to click.
 */
export async function handleMagicLinkEmail(deps: EmailJobDeps, job: JobRow): Promise<void> {
  const email = payloadString(job, "email");
  const token = payloadString(job, "token");
  const link = `${baseUrl()}/api/auth/callback?token=${encodeURIComponent(token)}`;

  await sendEmail(deps, {
    to: email,
    subject: "Your sign-in link",
    text: [
      "Here is your sign-in link.",
      "",
      link,
      "",
      "It works once and expires in 15 minutes.",
      "If you did not ask to sign in, you can ignore this email -- nobody can",
      "reach your payments without a link from your own inbox.",
      "",
      "-- JBProcessor",
    ].join("\n"),
  });
}

/**
 * Mails an alert that was composed somewhere that must not send mail itself.
 *
 * The Stripe webhook is the caller that needs this: it runs in the web
 * process, inside the transaction that consumes the event id, and a mail
 * provider that times out there would roll the event back and replay the whole
 * handler. So the webhook writes the alert it wants sent and this delivers it,
 * with the queue's retries behind it.
 *
 * Deliberately not a template: the subject and body arrive whole. Anything
 * that needs the payment's own numbers already has them at the point it
 * decided to alert.
 */
export async function handleOpsAlert(deps: EmailJobDeps, job: JobRow): Promise<void> {
  await sendAlert(deps, payloadString(job, "subject"), payloadString(job, "text"));
}

/** Confirms the donation and explains the hold. Sent once the tokens are escrowed. */
export async function handleReceiptEmail(deps: EmailJobDeps, job: JobRow): Promise<void> {
  const paymentId = payloadString(job, "paymentId");
  const payment = await loadPayment(deps, paymentId);
  if (!payment) {
    console.warn(`receipt email: payment ${paymentId} not found -- dropping`);
    return;
  }

  const lines = [
    `Thanks for supporting ${payment.project_name}.`,
    "",
    `Donation: ${formatUsdCents(payment.amount_usd_cents)}`,
  ];
  if (BigInt(payment.premium_usd_cents) > 0n) {
    lines.push(`Service fee: ${formatUsdCents(payment.premium_usd_cents)}`);
  }
  lines.push(`Tokens bought: ${formatTokens(payment.tokens_held)}`);
  if (payment.claim_address) lines.push(`Delivery address: ${payment.claim_address}`);
  if (payment.unlock_at) lines.push(`Hold ends: ${formatDate(payment.unlock_at)}`);
  lines.push(
    "",
    "Your tokens are already bought and held onchain in escrow. When the hold",
    "ends we deliver them to your address automatically -- there is nothing for",
    "you to do, and nothing to claim.",
    "",
    footer(),
  );

  await sendEmail(deps, {
    to: payment.email,
    subject: `Your donation to ${payment.project_name}`,
    text: lines.join("\n"),
  });
}

/** The hold has ended; delivery is the keeper's job, not the payer's. */
export async function handleUnlockEmail(deps: EmailJobDeps, job: JobRow): Promise<void> {
  const paymentId = payloadString(job, "paymentId");
  const payment = await loadPayment(deps, paymentId);
  if (!payment) {
    console.warn(`unlock email: payment ${paymentId} not found -- dropping`);
    return;
  }

  const lines = [
    `The hold on your ${payment.project_name} donation has ended.`,
    "",
    `Tokens: ${formatTokens(payment.tokens_held)}`,
  ];
  if (payment.claim_address) lines.push(`Delivery address: ${payment.claim_address}`);
  lines.push(
    "",
    "We are sending them onchain now -- automatically, with nothing for you to",
    "do. You will get one more email when they land.",
    "",
    footer(),
  );

  await sendEmail(deps, {
    to: payment.email,
    subject: `Your ${payment.project_name} tokens are unlocking`,
    text: lines.join("\n"),
  });
}

/**
 * Tells the payer their delivery address is moving.
 *
 * This is the security mail of the set: the escrow enforces a 48 hour delay
 * before a redirect takes effect precisely so this email can arrive first,
 * and the copy's job is to make an unrequested change something the payer
 * knows to report while there is still time to stop it.
 */
export async function handleRedirectEmail(deps: EmailJobDeps, job: JobRow): Promise<void> {
  const paymentId = payloadString(job, "paymentId");
  const toAddress = payloadString(job, "toAddress");
  const payment = await loadPayment(deps, paymentId);
  if (!payment) {
    console.warn(`redirect email: payment ${paymentId} not found -- dropping`);
    return;
  }

  await sendEmail(deps, {
    to: payment.email,
    subject: "Your delivery address is changing",
    text: [
      `We received a request to change where your ${payment.project_name} tokens go.`,
      "",
      `New address: ${toAddress}`,
      "Takes effect: 48 hours from now",
      "",
      "The change is queued onchain and does not take effect until that delay",
      "has passed. If you did not ask for this, reply to this email right away",
      "and we will stop it.",
      "",
      footer(),
    ].join("\n"),
  });
}

/** The tokens are with the payer. Final mail of a payment's life. */
export async function handleReleaseEmail(deps: EmailJobDeps, job: JobRow): Promise<void> {
  const paymentId = payloadString(job, "paymentId");
  const payment = await loadPayment(deps, paymentId);
  if (!payment) {
    console.warn(`release email: payment ${paymentId} not found -- dropping`);
    return;
  }

  const lines = [
    `Your ${payment.project_name} tokens have been delivered.`,
    "",
    `Tokens: ${formatTokens(payment.tokens_held)}`,
  ];
  if (payment.claim_address) lines.push(`Delivered to: ${payment.claim_address}`);
  if (payment.release_tx) lines.push(`Transaction: ${basescanTx(payment.release_tx)}`);
  lines.push(
    "",
    "They are yours onchain now. Thanks for supporting the project.",
    "",
    footer(),
  );

  await sendEmail(deps, {
    to: payment.email,
    subject: `Your ${payment.project_name} tokens have been delivered`,
    text: lines.join("\n"),
  });
}
