import { Pool } from "pg";
import { zeroAddress, type Address, type Hex } from "viem";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { paymentIdBytes32, type EscrowEntry } from "../src/chain/escrow.js";
import { migrate } from "../src/db/index.js";
import type { JobRow } from "../src/db/jobs.js";
import { createPayment, type PaymentState } from "../src/db/payments.js";
import type { EmailSendPayload, EmailSendResult, EmailSender } from "../src/email/send.js";
import {
  handleReconcile,
  scheduleReconcile,
  type ReconcileChain,
  type ReconcileDeps,
  type ReconcileStripe,
  type StripeCharge,
} from "../src/worker/reconcile.js";
import { handlers } from "../src/worker/index.js";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/jbprocessor_test";

const SCHEMA_NAME = `test_reconcile_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

const PROJECT_ID = 77;

function addr(tail: string): Address {
  return `0x${tail.padStart(40, "0")}` as Address;
}

const BENEFICIARY = addr("b0b1");
const ATTACKER = addr("badd");

/** Fixed clock, so every window in the checks is deterministic. */
const NOW = new Date("2026-08-11T12:00:00Z");
const HOUR_MS = 3_600_000;

let pool: Pool;

class FakeEscrow implements ReconcileChain {
  entries = new Map<string, EscrowEntry>();
  throwFor = new Set<string>();

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
    if (this.throwFor.has(paymentId)) throw new Error("rpc timeout");
    return this.entries.get(paymentId) ?? null;
  }
}

class FakeStripe implements ReconcileStripe {
  charges: ReconcileStripe["charges"];
  pages: StripeCharge[][] = [[]];

  constructor() {
    this.charges = {
      list: async (params) => {
        const index = params.starting_after
          ? this.pages.findIndex((page) => page.at(-1)?.id === params.starting_after) + 1
          : 0;
        const data = this.pages[index] ?? [];
        return { data, has_more: index < this.pages.length - 1 };
      },
    };
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
let stripe: FakeStripe;
let resend: FakeSender;

function deps(): ReconcileDeps {
  return { pool, escrow, stripe, resend, now: () => NOW.getTime() };
}

const RECONCILE_JOB: JobRow = {
  id: "0",
  kind: "reconcile",
  payload: {},
  run_at: new Date(),
  attempts: 1,
  max_attempts: 8,
  locked_at: null,
  done_at: null,
  last_error: null,
  dedupe_key: null,
};

interface SeedOptions {
  state: PaymentState;
  tokensHeld?: string | null;
  claimAddress?: string;
  amountUsdCents?: bigint;
  premiumUsdCents?: bigint;
  releaseTx?: string | null;
  unlockAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

async function seedPayment(options: SeedOptions): Promise<string> {
  const payment = await createPayment(pool, {
    projectId: PROJECT_ID,
    email: "payer@example.com",
    amountUsdCents: options.amountUsdCents ?? 2_500n,
    instant: false,
    premiumUsdCents: options.premiumUsdCents ?? 0n,
    claimAddress: options.claimAddress ?? BENEFICIARY,
  });
  await pool.query(
    `UPDATE payments SET state = $2, tokens_held = $3, release_tx = $4, unlock_at = $5,
       created_at = $6, updated_at = $7
     WHERE id = $1`,
    [
      payment.id,
      options.state,
      options.tokensHeld === undefined ? "1000" : options.tokensHeld,
      options.releaseTx ?? null,
      options.unlockAt === undefined ? new Date(NOW.getTime() + 30 * 24 * HOUR_MS) : options.unlockAt,
      options.createdAt ?? NOW,
      options.updatedAt ?? NOW,
    ],
  );
  return payment.id;
}

/** The single alert body, or null when nothing was sent. */
function alertText(): string | null {
  return resend.sent[0]?.text ?? null;
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
    [PROJECT_ID, "Books Project", addr("70ce4"), addr("7e21")],
  );
});

afterAll(async () => {
  await pool.end();
  const adminPool = new Pool({ connectionString: TEST_DATABASE_URL });
  await adminPool.query(`DROP SCHEMA "${SCHEMA_NAME}" CASCADE`);
  await adminPool.end();
});

beforeEach(async () => {
  escrow = new FakeEscrow();
  stripe = new FakeStripe();
  resend = new FakeSender();
  process.env.EMAIL_FROM = "JBProcessor <mail@jbprocessor.test>";
  process.env.ALERT_EMAIL = "ops@jbprocessor.test";

  await pool.query("DELETE FROM jobs");
  await pool.query("DELETE FROM payments");
});

afterEach(() => {
  delete process.env.EMAIL_FROM;
  delete process.env.ALERT_EMAIL;
});

describe("handleReconcile", () => {
  it("says nothing when the books balance", async () => {
    const id = await seedPayment({ state: "held" });
    escrow.seed(paymentIdBytes32(id));

    await handleReconcile(deps(), RECONCILE_JOB);

    expect(resend.sent).toHaveLength(0);
  });

  it("schedules tomorrow's run before doing any work", async () => {
    await handleReconcile(deps(), RECONCILE_JOB);

    const { rows } = await pool.query<{ dedupe_key: string }>(
      "SELECT dedupe_key FROM jobs WHERE kind = 'reconcile'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.dedupe_key).toBe("reconcile:2026-08-12");
  });

  it("sends exactly one alert carrying every discrepancy", async () => {
    const missing = await seedPayment({ state: "held" });
    const stuck = await seedPayment({
      state: "paying",
      updatedAt: new Date(NOW.getTime() - 2 * HOUR_MS),
    });

    await handleReconcile(deps(), RECONCILE_JOB);

    expect(resend.sent).toHaveLength(1);
    expect(alertText()).toContain(missing);
    expect(alertText()).toContain(stuck);
  });

  it("flags a held payment with no escrow entry", async () => {
    const id = await seedPayment({ state: "held" });

    await handleReconcile(deps(), RECONCILE_JOB);

    expect(alertText()).toContain(id);
    expect(alertText()).toMatch(/no escrow entry/i);
  });

  it("flags an amount that disagrees with tokens_held", async () => {
    const id = await seedPayment({ state: "held", tokensHeld: "1000" });
    escrow.seed(paymentIdBytes32(id), { amount: 999n });

    await handleReconcile(deps(), RECONCILE_JOB);

    expect(alertText()).toMatch(/amount/i);
    expect(alertText()).toContain("999");
  });

  it("flags a claimed payment whose entry is not settled onchain", async () => {
    const id = await seedPayment({ state: "claimed", releaseTx: `0x${"b".repeat(64)}` });
    escrow.seed(paymentIdBytes32(id), { settled: false });

    await handleReconcile(deps(), RECONCILE_JOB);

    expect(alertText()).toMatch(/not settled/i);
  });

  it("stops re-reading payments delivered over a week ago", async () => {
    // No escrow entry seeded: an in-window row in this state would be flagged.
    await seedPayment({
      state: "claimed",
      releaseTx: `0x${"b".repeat(64)}`,
      updatedAt: new Date(NOW.getTime() - 30 * 24 * HOUR_MS),
      createdAt: new Date(NOW.getTime() - 40 * 24 * HOUR_MS),
    });

    await handleReconcile(deps(), RECONCILE_JOB);

    expect(resend.sent).toHaveLength(0);
  });

  it("flags a beneficiary the escrow does not agree with", async () => {
    const id = await seedPayment({ state: "held" });
    escrow.seed(paymentIdBytes32(id), { beneficiary: ATTACKER });

    await handleReconcile(deps(), RECONCILE_JOB);

    expect(alertText()).toMatch(/beneficiary/i);
    expect(alertText()).toContain(ATTACKER);
  });

  it("accepts a queued redirect as the beneficiary of record", async () => {
    const id = await seedPayment({ state: "held", claimAddress: ATTACKER });
    escrow.seed(paymentIdBytes32(id), {
      beneficiary: BENEFICIARY,
      pendingBeneficiary: ATTACKER,
      redirectEffectiveAt: Math.floor(NOW.getTime() / 1000) + 48 * 3600,
    });

    await handleReconcile(deps(), RECONCILE_JOB);

    expect(resend.sent).toHaveLength(0);
  });

  it("flags a payment stuck in paying", async () => {
    const id = await seedPayment({
      state: "paying",
      updatedAt: new Date(NOW.getTime() - 3 * HOUR_MS),
    });

    await handleReconcile(deps(), RECONCILE_JOB);

    expect(alertText()).toContain(id);
    expect(alertText()).toMatch(/paying/i);
  });

  it("cancels a stale created payment and says so", async () => {
    const id = await seedPayment({
      state: "created",
      createdAt: new Date(NOW.getTime() - 30 * HOUR_MS),
      updatedAt: new Date(NOW.getTime() - 30 * HOUR_MS),
    });

    await handleReconcile(deps(), RECONCILE_JOB);

    const { rows } = await pool.query<{ state: PaymentState }>(
      "SELECT state FROM payments WHERE id = $1",
      [id],
    );
    expect(rows[0]!.state).toBe("canceled");
    expect(alertText()).toMatch(/canceled/i);
    expect(alertText()).toContain(id);
  });

  it("leaves a fresh created payment alone", async () => {
    const id = await seedPayment({
      state: "created",
      createdAt: new Date(NOW.getTime() - 2 * HOUR_MS),
      updatedAt: new Date(NOW.getTime() - 2 * HOUR_MS),
    });

    await handleReconcile(deps(), RECONCILE_JOB);

    const { rows } = await pool.query<{ state: PaymentState }>(
      "SELECT state FROM payments WHERE id = $1",
      [id],
    );
    expect(rows[0]!.state).toBe("created");
  });

  it("flags a held payment whose unlock passed hours ago", async () => {
    const id = await seedPayment({
      state: "held",
      unlockAt: new Date(NOW.getTime() - 5 * HOUR_MS),
    });
    escrow.seed(paymentIdBytes32(id));

    await handleReconcile(deps(), RECONCILE_JOB);

    expect(alertText()).toContain(id);
    expect(alertText()).toMatch(/unlock/i);
  });

  it("flags an unlocked payment that never got a release tx", async () => {
    const id = await seedPayment({
      state: "unlocked",
      unlockAt: new Date(NOW.getTime() - 5 * HOUR_MS),
      updatedAt: new Date(NOW.getTime() - 4 * HOUR_MS),
    });
    escrow.seed(paymentIdBytes32(id));

    await handleReconcile(deps(), RECONCILE_JOB);

    expect(alertText()).toContain(id);
    expect(alertText()).toMatch(/release/i);
  });

  it("lists jobs that went FATAL", async () => {
    await pool.query(
      `INSERT INTO jobs (kind, payload, done_at, last_error)
       VALUES ('pay', '{}', $1, 'FATAL: revert')`,
      [new Date(NOW.getTime() - 2 * HOUR_MS)],
    );

    await handleReconcile(deps(), RECONCILE_JOB);

    expect(alertText()).toMatch(/FATAL/);
    expect(alertText()).toContain("revert");
  });

  it("compares yesterday's Stripe charges against the ledger", async () => {
    await seedPayment({
      state: "paid",
      amountUsdCents: 2_500n,
      premiumUsdCents: 50n,
      createdAt: new Date("2026-08-10T09:00:00Z"),
      updatedAt: new Date("2026-08-10T09:05:00Z"),
    });
    stripe.pages = [[{ id: "ch_1", amount: 9_900, status: "succeeded" }]];

    await handleReconcile(deps(), RECONCILE_JOB);

    expect(alertText()).toMatch(/stripe/i);
    expect(alertText()).toContain("9900");
    expect(alertText()).toContain("2550");
  });

  it("is quiet when Stripe and the ledger agree, across pages", async () => {
    await seedPayment({
      state: "paid",
      amountUsdCents: 2_500n,
      premiumUsdCents: 50n,
      createdAt: new Date("2026-08-10T09:00:00Z"),
      updatedAt: new Date("2026-08-10T09:05:00Z"),
    });
    await seedPayment({
      state: "held",
      amountUsdCents: 1_000n,
      createdAt: new Date("2026-08-10T18:00:00Z"),
      updatedAt: new Date("2026-08-10T18:05:00Z"),
      tokensHeld: null,
    });
    stripe.pages = [
      [{ id: "ch_1", amount: 2_550, status: "succeeded" }],
      [{ id: "ch_2", amount: 1_000, status: "succeeded" }],
    ];
    // The held payment above has no tokens_held, so check (a) would flag it --
    // give it an entry and a matching amount.
    await pool.query("UPDATE payments SET tokens_held = '1000' WHERE state = 'held'");
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM payments WHERE state = 'held'",
    );
    escrow.seed(paymentIdBytes32(rows[0]!.id));

    await handleReconcile(deps(), RECONCILE_JOB);

    expect(resend.sent).toHaveLength(0);
  });

  it("ignores charges that did not succeed", async () => {
    stripe.pages = [[{ id: "ch_1", amount: 5_000, status: "failed" }]];

    await handleReconcile(deps(), RECONCILE_JOB);

    expect(resend.sent).toHaveLength(0);
  });

  it("turns a check that throws into a line instead of losing the whole scan", async () => {
    const id = await seedPayment({ state: "held" });
    escrow.throwFor.add(paymentIdBytes32(id));
    const stuck = await seedPayment({
      state: "paying",
      updatedAt: new Date(NOW.getTime() - 3 * HOUR_MS),
    });

    await expect(handleReconcile(deps(), RECONCILE_JOB)).resolves.toBeUndefined();

    expect(alertText()).toMatch(/rpc timeout/);
    expect(alertText()).toContain(stuck);
  });
});

describe("scheduleReconcile", () => {
  it("collapses two schedulers aiming at the same day into one job", async () => {
    await scheduleReconcile(pool, new Date("2026-08-11T01:00:00Z"));
    await scheduleReconcile(pool, new Date("2026-08-11T23:00:00Z"));

    const { rows } = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM jobs WHERE kind = 'reconcile'",
    );
    expect(rows[0]!.n).toBe(1);
  });

  it("is registered in the worker handler table", () => {
    expect(handlers["reconcile"]).toBeTypeOf("function");
  });
});
