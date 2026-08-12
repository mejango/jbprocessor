import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Address } from "viem";
import { migrate } from "../src/db/index.js";
import type { JobRow } from "../src/db/jobs.js";
import { createPayment, type PaymentState } from "../src/db/payments.js";
import {
  maskEmail,
  sendAlert,
  sendEmail,
  type EmailSendPayload,
  type EmailSendResult,
  type EmailSender,
} from "../src/email/send.js";
import {
  handleMagicLinkEmail,
  handleOpsAlert,
  handleReceiptEmail,
  handleRedirectEmail,
  handleReleaseEmail,
  handleUnlockEmail,
  type EmailJobDeps,
} from "../src/worker/emails.js";
import { handlers } from "../src/worker/index.js";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/jbprocessor_test";

const SCHEMA_NAME = `test_emails_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

const PROJECT_ID = 41;
const PROJECT_NAME = "Rain Forest Fund";

function addr(tail: string): Address {
  return `0x${tail.padStart(40, "0")}` as Address;
}

const BENEFICIARY = addr("b0b1");

let pool: Pool;

/** Captures what would have been mailed. */
class FakeSender implements EmailSender {
  sent: EmailSendPayload[] = [];
  error: string | null = null;

  emails = {
    send: async (payload: EmailSendPayload): Promise<EmailSendResult> => {
      if (this.error) return { data: null, error: { message: this.error } };
      this.sent.push(payload);
      return { data: { id: `email_${this.sent.length}` }, error: null };
    },
  };
}

let resend: FakeSender;

function deps(): EmailJobDeps {
  return { pool, resend };
}

const BASE_JOB: JobRow = {
  id: "0",
  kind: "receipt-email",
  payload: {},
  run_at: new Date(),
  attempts: 1,
  max_attempts: 8,
  locked_at: null,
  done_at: null,
  last_error: null,
  dedupe_key: null,
};

function jobFor(kind: string, payload: unknown): JobRow {
  return { ...BASE_JOB, kind, payload };
}

interface SeedOptions {
  state?: PaymentState;
  premiumUsdCents?: bigint;
  releaseTx?: string;
}

async function seedPayment(options: SeedOptions = {}): Promise<string> {
  const payment = await createPayment(pool, {
    projectId: PROJECT_ID,
    email: "Alice@Example.com",
    amountUsdCents: 2_500n,
    instant: options.premiumUsdCents !== undefined,
    premiumUsdCents: options.premiumUsdCents ?? 0n,
    claimAddress: BENEFICIARY,
    quoteTokens: 1_000n,
  });
  await pool.query(
    `UPDATE payments SET state = $2, tokens_held = '1234500000000000000000',
       unlock_at = '2026-12-01T00:00:00Z', pay_tx = $3, release_tx = $4
     WHERE id = $1`,
    [
      payment.id,
      options.state ?? "held",
      `0x${"a".repeat(64)}`,
      options.releaseTx ?? null,
    ],
  );
  return payment.id;
}

beforeAll(async () => {
  const adminPool = new Pool({ connectionString: TEST_DATABASE_URL });
  await adminPool.query(`CREATE SCHEMA "${SCHEMA_NAME}"`);
  await adminPool.end();

  pool = new Pool({
    connectionString: TEST_DATABASE_URL,
    options: `-c search_path=${SCHEMA_NAME}`,
  });
  await migrate(pool);
  await pool.query(
    `INSERT INTO projects (project_id, name, token_address, terminal_address)
     VALUES ($1, $2, $3, $4)`,
    [PROJECT_ID, PROJECT_NAME, addr("70ce4"), addr("7e21")],
  );
});

afterAll(async () => {
  await pool.end();
  const adminPool = new Pool({ connectionString: TEST_DATABASE_URL });
  await adminPool.query(`DROP SCHEMA "${SCHEMA_NAME}" CASCADE`);
  await adminPool.end();
});

beforeEach(() => {
  resend = new FakeSender();
  process.env.EMAIL_FROM = "JBProcessor <mail@jbprocessor.test>";
  process.env.ALERT_EMAIL = "ops@jbprocessor.test";
  process.env.BASE_URL = "https://pay.example.com/";
});

afterEach(() => {
  delete process.env.EMAIL_FROM;
  delete process.env.ALERT_EMAIL;
  delete process.env.BASE_URL;
});

describe("maskEmail", () => {
  it("keeps two characters of the local part and one of the domain", () => {
    expect(maskEmail("alice@example.com")).toBe("al***@e***");
  });

  it("does not leak a one-character local part", () => {
    expect(maskEmail("a@example.com")).toBe("a***@e***");
  });

  it("passes through anything that isn't an address shape", () => {
    expect(maskEmail("not-an-address")).toBe("***");
  });
});

describe("sendEmail", () => {
  it("sends from EMAIL_FROM with a text part", async () => {
    await sendEmail({ resend }, {
      to: "alice@example.com",
      subject: "Hello",
      text: "Body",
    });

    expect(resend.sent).toHaveLength(1);
    expect(resend.sent[0]).toMatchObject({
      from: "JBProcessor <mail@jbprocessor.test>",
      to: "alice@example.com",
      subject: "Hello",
      text: "Body",
    });
  });

  it("throws when the provider reports an error, so the job retries", async () => {
    resend.error = "rate limited";
    await expect(
      sendEmail({ resend }, { to: "alice@example.com", subject: "Hello", text: "Body" }),
    ).rejects.toThrow(/rate limited/);
  });

  it("never puts the recipient in the error message", async () => {
    resend.error = "rate limited";
    await expect(
      sendEmail({ resend }, { to: "alice@example.com", subject: "Hello", text: "Body" }),
    ).rejects.toThrow(/al\*\*\*@e\*\*\*/);
  });
});

describe("sendAlert", () => {
  it("goes to ALERT_EMAIL with a recognisable subject prefix", async () => {
    await sendAlert({ resend }, "Reconciliation", "three discrepancies");

    expect(resend.sent[0]?.to).toBe("ops@jbprocessor.test");
    expect(resend.sent[0]?.subject).toContain("Reconciliation");
    expect(resend.sent[0]?.text).toContain("three discrepancies");
  });
});

describe("handleMagicLinkEmail", () => {
  it("mails a callback link carrying the token", async () => {
    await handleMagicLinkEmail(deps(), jobFor("magic-link-email", {
      email: "alice@example.com",
      token: "tok.en.value",
    }));

    const sent = resend.sent[0]!;
    expect(sent.to).toBe("alice@example.com");
    expect(sent.text).toContain("https://pay.example.com/api/auth/callback?token=tok.en.value");
  });

  it("throws on a payload with no token", async () => {
    await expect(
      handleMagicLinkEmail(deps(), jobFor("magic-link-email", { email: "a@b.co" })),
    ).rejects.toThrow(/token/);
  });
});

describe("handleOpsAlert", () => {
  it("mails the operator the alert it was handed, whole", async () => {
    await handleOpsAlert(
      deps(),
      jobFor("ops-alert", { subject: "Refund on escrowed tokens", text: "payment 1234" }),
    );

    const sent = resend.sent[0]!;
    expect(sent.to).toBe("ops@jbprocessor.test");
    expect(sent.subject).toBe("[JBProcessor] Refund on escrowed tokens");
    expect(sent.text).toBe("payment 1234");
  });

  it("throws on a payload with no body, rather than mailing an empty alert", async () => {
    await expect(
      handleOpsAlert(deps(), jobFor("ops-alert", { subject: "Something happened" })),
    ).rejects.toThrow(/text/);
  });
});

describe("handleReceiptEmail", () => {
  it("renders the amount, tokens, destination and project name", async () => {
    const id = await seedPayment();
    await handleReceiptEmail(deps(), jobFor("receipt-email", { paymentId: id }));

    const sent = resend.sent[0]!;
    expect(sent.to).toBe("Alice@Example.com");
    expect(sent.subject).toContain(PROJECT_NAME);
    expect(sent.text).toContain("$25.00");
    expect(sent.text).toContain("1,234.5");
    expect(sent.text).toContain(BENEFICIARY);
    expect(sent.text).toContain("onchain");
  });

  it("shows the service fee only when one was charged", async () => {
    const withFee = await seedPayment({ premiumUsdCents: 50n });
    await handleReceiptEmail(deps(), jobFor("receipt-email", { paymentId: withFee }));
    expect(resend.sent[0]!.text).toContain("$0.50");

    resend.sent = [];
    const withoutFee = await seedPayment();
    await handleReceiptEmail(deps(), jobFor("receipt-email", { paymentId: withoutFee }));
    expect(resend.sent[0]!.text).not.toMatch(/service fee/i);
  });

  it("completes quietly when the payment is gone", async () => {
    await expect(
      handleReceiptEmail(
        deps(),
        jobFor("receipt-email", { paymentId: "00000000-0000-4000-8000-000000000000" }),
      ),
    ).resolves.toBeUndefined();
    expect(resend.sent).toHaveLength(0);
  });
});

describe("handleUnlockEmail", () => {
  it("tells the payer delivery is automatic", async () => {
    const id = await seedPayment({ state: "unlocked" });
    await handleUnlockEmail(deps(), jobFor("unlock-email", { paymentId: id }));

    const sent = resend.sent[0]!;
    expect(sent.subject).toContain(PROJECT_NAME);
    expect(sent.text).toMatch(/nothing (for you )?to do|automatically/i);
  });
});

describe("handleRedirectEmail", () => {
  it("names the new address and the delay before it takes effect", async () => {
    const id = await seedPayment();
    const to = addr("caf3");
    await handleRedirectEmail(
      deps(),
      jobFor("redirect-email", { paymentId: id, toAddress: to }),
    );

    const sent = resend.sent[0]!;
    expect(sent.text).toContain(to);
    expect(sent.text).toContain("48 hours");
    expect(sent.text).toMatch(/did not|didn't/i);
  });
});

describe("handleReleaseEmail", () => {
  it("links the release transaction", async () => {
    const releaseTx = `0x${"b".repeat(64)}`;
    const id = await seedPayment({ state: "claimed", releaseTx });
    await handleReleaseEmail(deps(), jobFor("release-email", { paymentId: id }));

    const sent = resend.sent[0]!;
    expect(sent.text).toContain(`https://basescan.org/tx/${releaseTx}`);
    expect(sent.text).toContain("1,234.5");
  });
});

describe("registry", () => {
  it("registers a handler for every email kind the service enqueues", () => {
    for (const kind of [
      "magic-link-email",
      "receipt-email",
      "unlock-email",
      "redirect-email",
      "release-email",
      "ops-alert",
    ]) {
      expect(handlers[kind], `no handler for ${kind}`).toBeTypeOf("function");
    }
  });
});
