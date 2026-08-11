import { Pool } from "pg";
import { zeroAddress, type Address, type Hex } from "viem";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { feePaymentId, paymentIdBytes32, type EscrowEntry } from "../src/chain/escrow.js";
import { migrate } from "../src/db/index.js";
import type { JobRow } from "../src/db/jobs.js";
import { createPayment, type PaymentState } from "../src/db/payments.js";
import type { EmailSendPayload, EmailSendResult, EmailSender } from "../src/email/send.js";
import { handleForfeit, type ForfeitChain, type ForfeitDeps } from "../src/worker/forfeit.js";
import { handlers } from "../src/worker/index.js";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/jbprocessor_test";

const SCHEMA_NAME = `test_forfeit_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

const PROJECT_ID = 55;

function addr(tail: string): Address {
  return `0x${tail.padStart(40, "0")}` as Address;
}

const BENEFICIARY = addr("b0b1");

let pool: Pool;

class FakeEscrow implements ForfeitChain {
  entries = new Map<string, EscrowEntry>();
  forfeited: string[] = [];
  private counter = 0;

  seed(paymentId: Hex, overrides: Partial<EscrowEntry> = {}): void {
    this.entries.set(paymentId, {
      token: addr("70ce4"),
      amount: 1_000n,
      unlockAt: 1_700_000_000,
      settled: false,
      beneficiary: BENEFICIARY,
      pendingBeneficiary: zeroAddress,
      redirectEffectiveAt: 0,
      ...overrides,
    });
  }

  async getEntry(paymentId: Hex): Promise<EscrowEntry | null> {
    return this.entries.get(paymentId) ?? null;
  }

  async forfeit(paymentId: Hex): Promise<Hex> {
    const entry = this.entries.get(paymentId);
    if (!entry) throw new Error(`NoEntry: ${paymentId}`);
    if (entry.settled) throw new Error(`AlreadySettled: ${paymentId}`);
    entry.settled = true;
    this.forfeited.push(paymentId);
    this.counter += 1;
    return `0x${this.counter.toString(16).padStart(64, "0")}` as Hex;
  }
}

class FakeSender implements EmailSender {
  sent: EmailSendPayload[] = [];
  emails = {
    send: async (payload: EmailSendPayload): Promise<EmailSendResult> => {
      this.sent.push(payload);
      return { data: { id: "e1" }, error: null };
    },
  };
}

let escrow: FakeEscrow;
let resend: FakeSender;

function deps(): ForfeitDeps {
  return { pool, escrow, resend };
}

const BASE_JOB: JobRow = {
  id: "0",
  kind: "forfeit",
  payload: {},
  run_at: new Date(),
  attempts: 1,
  max_attempts: 8,
  locked_at: null,
  done_at: null,
  last_error: null,
  dedupe_key: null,
};

function jobFor(paymentId: string): JobRow {
  return { ...BASE_JOB, payload: { paymentId } };
}

async function seedPayment(state: PaymentState = "forfeited"): Promise<string> {
  const payment = await createPayment(pool, {
    projectId: PROJECT_ID,
    email: "payer@example.com",
    amountUsdCents: 4_200n,
    instant: false,
    claimAddress: BENEFICIARY,
  });
  await pool.query(
    "UPDATE payments SET state = $2, tokens_held = '1000' WHERE id = $1",
    [payment.id, state],
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
    [PROJECT_ID, "Disputed Project", addr("70ce4"), addr("7e21")],
  );
});

afterAll(async () => {
  await pool.end();
  const adminPool = new Pool({ connectionString: TEST_DATABASE_URL });
  await adminPool.query(`DROP SCHEMA "${SCHEMA_NAME}" CASCADE`);
  await adminPool.end();
});

beforeEach(() => {
  escrow = new FakeEscrow();
  resend = new FakeSender();
  process.env.EMAIL_FROM = "JBProcessor <mail@jbprocessor.test>";
  process.env.ALERT_EMAIL = "ops@jbprocessor.test";
});

afterEach(() => {
  delete process.env.EMAIL_FROM;
  delete process.env.ALERT_EMAIL;
});

describe("handleForfeit", () => {
  it("forfeits both legs and alerts with the payment details", async () => {
    const id = await seedPayment();
    const main = paymentIdBytes32(id);
    const fee = feePaymentId(main);
    escrow.seed(main);
    escrow.seed(fee, { amount: 10n });

    await handleForfeit(deps(), jobFor(id));

    expect(escrow.forfeited).toEqual([main, fee]);
    expect(resend.sent).toHaveLength(1);
    expect(resend.sent[0]!.to).toBe("ops@jbprocessor.test");
    expect(resend.sent[0]!.text).toContain(id);
    expect(resend.sent[0]!.text).toContain("$42.00");
  });

  it("forfeits the main leg alone when there is no fee entry", async () => {
    const id = await seedPayment();
    const main = paymentIdBytes32(id);
    escrow.seed(main);

    await handleForfeit(deps(), jobFor(id));

    expect(escrow.forfeited).toEqual([main]);
    expect(resend.sent).toHaveLength(1);
  });

  it("does not fail the job when the release scan already settled the entry", async () => {
    const id = await seedPayment();
    const main = paymentIdBytes32(id);
    escrow.seed(main, { settled: true });

    await expect(handleForfeit(deps(), jobFor(id))).resolves.toBeUndefined();

    expect(escrow.forfeited).toEqual([]);
    expect(resend.sent[0]!.text).toMatch(/already/i);
  });

  it("does not fail the job when the escrow has no entry at all", async () => {
    const id = await seedPayment();

    await expect(handleForfeit(deps(), jobFor(id))).resolves.toBeUndefined();
    expect(resend.sent[0]!.text).toMatch(/no escrow entry|no entry/i);
  });

  it("completes without touching the chain when the payment is not forfeited", async () => {
    const id = await seedPayment("held");
    escrow.seed(paymentIdBytes32(id));

    await expect(handleForfeit(deps(), jobFor(id))).resolves.toBeUndefined();

    expect(escrow.forfeited).toEqual([]);
    expect(resend.sent).toHaveLength(0);
  });

  it("completes quietly when the payment is gone", async () => {
    await expect(
      handleForfeit(deps(), jobFor("00000000-0000-4000-8000-000000000000")),
    ).resolves.toBeUndefined();
    expect(resend.sent).toHaveLength(0);
  });

  it("is registered in the worker handler table", () => {
    expect(handlers["forfeit"]).toBeTypeOf("function");
  });
});
