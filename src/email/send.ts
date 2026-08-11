import { Resend } from "resend";
import { requireEnv } from "../env.js";

/** What the provider is handed. Mirrors Resend's send payload, narrowed. */
export interface EmailSendPayload {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * Resend answers with `{ data, error }` rather than throwing, so the result
 * type carries both arms and `sendEmail` is the one place that turns a
 * provider error into an exception.
 */
export interface EmailSendResult {
  data: { id: string } | null;
  error: { message: string } | null;
}

/**
 * The slice of the mail provider this service uses. A real `Resend` instance
 * is adapted to it by `liveResend`; tests pass a capture object instead of a
 * network client.
 */
export interface EmailSender {
  emails: {
    send(payload: EmailSendPayload): Promise<EmailSendResult>;
  };
}

/** Everything a mail send needs, so handlers can take one dependency bag. */
export interface EmailDeps {
  resend: EmailSender;
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * `alice@example.com` -> `al***@e***`.
 *
 * Every log line and error message about mail goes through this. A worker log
 * is read by more people (and retained in more places) than the payments
 * table, and a payer's address is the one field that links a donation to a
 * person -- so it never appears in one. Anything that isn't address-shaped
 * collapses to `***` rather than being echoed on the assumption it's harmless.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return "***";
  return `${email.slice(0, Math.min(2, at))}***@${email[at + 1]}***`;
}

/**
 * Sends one email through the configured provider.
 *
 * A provider error is thrown, not swallowed: every caller is a job handler,
 * and a throw is exactly the "retry with backoff" the queue already knows how
 * to do. The thrown message carries the masked recipient so a failure is
 * traceable without the log holding the address.
 */
export async function sendEmail(deps: EmailDeps, message: EmailMessage): Promise<void> {
  const from = requireEnv("EMAIL_FROM");
  const payload: EmailSendPayload = {
    from,
    to: message.to,
    subject: message.subject,
    text: message.text,
  };
  if (message.html !== undefined) payload.html = message.html;

  const result = await deps.resend.emails.send(payload);
  if (result.error) {
    throw new Error(
      `email '${message.subject}' to ${maskEmail(message.to)} failed: ${result.error.message}`,
    );
  }
  console.log(`sent '${message.subject}' to ${maskEmail(message.to)}`);
}

/**
 * Mails the operator. Every automated alarm in this service -- reconciliation
 * discrepancies, a project whose ruleset moved, a forfeit that needs a manual
 * cash-out -- lands in one inbox with one recognisable prefix, so an operator
 * can filter on it without knowing which subsystem raised it.
 */
export async function sendAlert(
  deps: EmailDeps,
  subject: string,
  text: string,
): Promise<void> {
  await sendEmail(deps, {
    to: requireEnv("ALERT_EMAIL"),
    subject: `[JBProcessor] ${subject}`,
    text,
  });
}

/**
 * The live sender, bound to `RESEND_API_KEY`.
 *
 * An explicit adapter rather than handing the `Resend` instance over as-is:
 * `EmailSender` is a two-field structural type, and going through a lambda
 * keeps this service's payload shape (single recipient, text required) fixed
 * regardless of how the SDK's own overloads move.
 */
export function liveResend(): EmailSender {
  const client = new Resend(requireEnv("RESEND_API_KEY"));
  return {
    emails: {
      send: async (payload) => {
        const result = await client.emails.send(payload);
        return { data: result.data, error: result.error };
      },
    },
  };
}
