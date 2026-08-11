import { Pool } from "pg";
import { zeroAddress, type Address, type Hex } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { feePaymentId, paymentIdBytes32, type EscrowEntry } from "../src/chain/escrow.js";
import { migrate } from "../src/db/index.js";
import { claimNext, type JobRow } from "../src/db/jobs.js";
import { createPayment, type PaymentState } from "../src/db/payments.js";
import {
  handleReleaseScan,
  handleUnlockNote,
  scheduleReleaseScan,
  type ReleaseChain,
  type ReleaseDeps,
} from "../src/worker/release.js";
import { handlers } from "../src/worker/index.js";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/jbprocessor_test";

const SCHEMA_NAME = `test_release_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

const PROJECT_ID = 88;

function addr(tail: string): Address {
  return `0x${tail.padStart(40, "0")}` as Address;
}

const BENEFICIARY = addr("b0b1");

let pool: Pool;

/** Fake of the escrow reads and writes the keeper makes. */
class FakeEscrow implements ReleaseChain {
  entries = new Map<string, EscrowEntry>();
  released: string[] = [];
  failFor: string | null = null;
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

  async release(paymentId: Hex): Promise<Hex> {
    if (this.failFor === paymentId) throw new Error("StillLocked");
    const entry = this.entries.get(paymentId);
    if (!entry) throw new Error(`NoEntry: ${paymentId}`);
    if (entry.settled) throw new Error(`AlreadySettled: ${paymentId}`);
    entry.settled = true;
    this.released.push(paymentId);
    this.counter += 1;
    return `0x${this.counter.toString(16).padStart(64, "0")}` as Hex;
  }
}

let escrow: FakeEscrow;

function deps(): ReleaseDeps {
  return { pool, escrow };
}

const SCAN_JOB: JobRow = {
  id: "0",
  kind: "release-scan",
  payload: {},
  run_at: new Date(),
  attempts: 1,
  max_attempts: 8,
  locked_at: null,
  done_at: null,
  last_error: null,
  dedupe_key: null,
};

function jobFor(kind: string, paymentId: string): JobRow {
  return { ...SCAN_JOB, kind, payload: { paymentId } };
}

async function seedPayment(state: PaymentState, patch: { release_tx?: string } = {}): Promise<string> {
  const payment = await createPayment(pool, {
    projectId: PROJECT_ID,
    email: "payer@example.com",
    amountUsdCents: 1_000n,
    instant: false,
    claimAddress: BENEFICIARY,
    quoteTokens: 1_000n,
  });
  await pool.query(
    "UPDATE payments SET state = $2, tokens_held = '1000', unlock_at = now() - interval '1 hour', release_tx = $3 WHERE id = $1",
    [payment.id, state, patch.release_tx ?? null],
  );
  return payment.id;
}

async function stateOf(id: string): Promise<{ state: PaymentState; release_tx: string | null }> {
  const { rows } = await pool.query<{ state: PaymentState; release_tx: string | null }>(
    "SELECT state, release_tx FROM payments WHERE id = $1",
    [id],
  );
  return rows[0]!;
}

async function jobCount(kind: string, paymentId?: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    paymentId
      ? "SELECT count(*)::int AS n FROM jobs WHERE kind = $1 AND payload->>'paymentId' = $2"
      : "SELECT count(*)::int AS n FROM jobs WHERE kind = $1",
    paymentId ? [kind, paymentId] : [kind],
  );
  return rows[0]!.n;
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
    [PROJECT_ID, "Keeper Project", addr("70ce4"), addr("7e21")],
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
});

describe("handleUnlockNote", () => {
  it("moves held -> unlocked and enqueues the unlock email", async () => {
    const id = await seedPayment("held");
    await handleUnlockNote(deps(), jobFor("unlock-note", id));

    expect((await stateOf(id)).state).toBe("unlocked");
    expect(await jobCount("unlock-email", id)).toBe(1);
  });

  it("completes quietly when the payment is no longer held", async () => {
    const id = await seedPayment("forfeited");
    await expect(handleUnlockNote(deps(), jobFor("unlock-note", id))).resolves.toBeUndefined();

    expect((await stateOf(id)).state).toBe("forfeited");
    expect(await jobCount("unlock-email", id)).toBe(0);
  });

  it("completes quietly when the payment is gone", async () => {
    await expect(
      handleUnlockNote(deps(), jobFor("unlock-note", "00000000-0000-4000-8000-000000000000")),
    ).resolves.toBeUndefined();
  });

  it("throws on a payload with no paymentId, so the job retries visibly", async () => {
    await expect(
      handleUnlockNote(deps(), { ...SCAN_JOB, kind: "unlock-note", payload: {} }),
    ).rejects.toThrow(/paymentId/);
  });
});

describe("handleReleaseScan", () => {
  it("releases a due payment, records the tx, and enqueues the delivery email", async () => {
    const id = await seedPayment("unlocked");
    escrow.seed(paymentIdBytes32(id));

    await handleReleaseScan(deps(), SCAN_JOB);

    const row = await stateOf(id);
    expect(row.state).toBe("claimed");
    expect(row.release_tx).toBeTruthy();
    expect(escrow.released).toEqual([paymentIdBytes32(id)]);
    expect(await jobCount("release-email", id)).toBe(1);
  });

  it("releases the fee leg too, after the main leg", async () => {
    const id = await seedPayment("unlocked");
    const main = paymentIdBytes32(id);
    const fee = feePaymentId(main);
    escrow.seed(main);
    escrow.seed(fee);

    await handleReleaseScan(deps(), SCAN_JOB);

    expect(escrow.released).toEqual([main, fee]);
    expect((await stateOf(id)).state).toBe("claimed");
  });

  it("still claims the payment when the fee leg reverts", async () => {
    const id = await seedPayment("unlocked");
    const main = paymentIdBytes32(id);
    const fee = feePaymentId(main);
    escrow.seed(main);
    escrow.seed(fee);
    escrow.failFor = fee;

    await handleReleaseScan(deps(), SCAN_JOB);

    expect(escrow.released).toEqual([main]);
    expect((await stateOf(id)).state).toBe("claimed");
  });

  it("skips an entry whose redirect hasn't taken effect yet -- the contract would revert", async () => {
    const id = await seedPayment("unlocked");
    escrow.seed(paymentIdBytes32(id), {
      pendingBeneficiary: addr("de571"),
      redirectEffectiveAt: Math.floor(Date.now() / 1000) + 3_600,
    });

    await handleReleaseScan(deps(), SCAN_JOB);

    expect(escrow.released).toEqual([]);
    expect((await stateOf(id)).state).toBe("unlocked");
    expect(await jobCount("release-email", id)).toBe(0);
  });

  it("releases once a pending redirect's delay has passed", async () => {
    const id = await seedPayment("unlocked");
    escrow.seed(paymentIdBytes32(id), {
      pendingBeneficiary: addr("de571"),
      redirectEffectiveAt: Math.floor(Date.now() / 1000) - 60,
    });

    await handleReleaseScan(deps(), SCAN_JOB);

    expect(escrow.released).toEqual([paymentIdBytes32(id)]);
  });

  it("claims a payment the escrow already settled, without sending again", async () => {
    const id = await seedPayment("unlocked");
    escrow.seed(paymentIdBytes32(id), { settled: true });

    await handleReleaseScan(deps(), SCAN_JOB);

    expect(escrow.released).toEqual([]);
    expect((await stateOf(id)).state).toBe("claimed");
  });

  it("leaves a payment alone when the escrow has no entry for it", async () => {
    const id = await seedPayment("unlocked");

    await handleReleaseScan(deps(), SCAN_JOB);

    expect((await stateOf(id)).state).toBe("unlocked");
  });

  it("ignores payments that aren't unlocked, and ones already released", async () => {
    const held = await seedPayment("held");
    const claimed = await seedPayment("claimed", { release_tx: `0x${"44".repeat(32)}` });
    escrow.seed(paymentIdBytes32(held));
    escrow.seed(paymentIdBytes32(claimed));

    await handleReleaseScan(deps(), SCAN_JOB);

    expect(escrow.released).toEqual([]);
  });

  it("keeps going when one payment fails: the rest of the scan still releases", async () => {
    const bad = await seedPayment("unlocked");
    const good = await seedPayment("unlocked");
    escrow.seed(paymentIdBytes32(bad));
    escrow.seed(paymentIdBytes32(good));
    escrow.failFor = paymentIdBytes32(bad);

    await handleReleaseScan(deps(), SCAN_JOB);

    expect(escrow.released).toEqual([paymentIdBytes32(good)]);
    expect((await stateOf(bad)).state).toBe("unlocked");
    expect((await stateOf(good)).state).toBe("claimed");
  });

  it("schedules the next scan even when the scan body fails", async () => {
    const id = await seedPayment("unlocked");
    escrow.seed(paymentIdBytes32(id));
    const exploding: ReleaseChain = {
      getEntry: async () => {
        throw new Error("rpc down");
      },
      release: async () => {
        throw new Error("rpc down");
      },
    };

    await pool.query("DELETE FROM jobs WHERE kind = 'release-scan'");
    await handleReleaseScan({ pool, escrow: exploding }, SCAN_JOB);

    expect(await jobCount("release-scan")).toBe(1);
  });

  it("schedules the next scan about ten minutes out, once per bucket", async () => {
    await handleReleaseScan(deps(), SCAN_JOB);
    const after = await jobCount("release-scan");
    await handleReleaseScan(deps(), SCAN_JOB);
    expect(await jobCount("release-scan")).toBe(after);

    const { rows } = await pool.query<{ run_at: Date }>(
      "SELECT run_at FROM jobs WHERE kind = 'release-scan' ORDER BY id DESC LIMIT 1",
    );
    const delayMs = rows[0]!.run_at.getTime() - Date.now();
    expect(delayMs).toBeGreaterThan(8 * 60_000);
    expect(delayMs).toBeLessThan(12 * 60_000);
  });
});

describe("scheduleReleaseScan", () => {
  it("is idempotent within a bucket, so a restart doesn't pile up scans", async () => {
    await scheduleReleaseScan(pool, new Date(Date.UTC(2030, 0, 1, 0, 0, 0)));
    await scheduleReleaseScan(pool, new Date(Date.UTC(2030, 0, 1, 0, 5, 0)));
    const { rows } = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM jobs WHERE kind = 'release-scan' AND run_at >= $1",
      [new Date(Date.UTC(2029, 11, 31))],
    );
    expect(rows[0]!.n).toBe(1);
  });

  it("enqueues a claimable job", async () => {
    await pool.query("DELETE FROM jobs");
    await scheduleReleaseScan(pool, new Date());
    const job = await claimNext(pool);
    expect(job?.kind).toBe("release-scan");
  });
});

describe("worker registry", () => {
  it("registers the keeper handlers", () => {
    expect(handlers["unlock-note"]).toBe(handleUnlockNote);
    expect(handlers["release-scan"]).toBe(handleReleaseScan);
  });
});
