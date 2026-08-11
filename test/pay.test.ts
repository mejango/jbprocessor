import { Pool } from "pg";
import type { Address, Hex } from "viem";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { feePaymentId, paymentIdBytes32 } from "../src/chain/escrow.js";
import type { ProcessPaymentParams, ProcessPaymentResult } from "../src/chain/escrow.js";
import type { QuoteTokensParams } from "../src/chain/quote.js";
import { enqueue, claimNext, type JobRow } from "../src/db/jobs.js";
import { migrate } from "../src/db/index.js";
import { createPayment, type PaymentState } from "../src/db/payments.js";
import { handlePay, type PayChain } from "../src/worker/pay.js";
import { runWorkerOnce, startWorker, type WorkerDeps } from "../src/worker/index.js";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/jbprocessor_test";

const SCHEMA_NAME = `test_pay_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

const PROJECT_ID = 77;

function addr(tail: string): Address {
  return `0x${tail.padStart(40, "0")}` as Address;
}

const TERMINAL = addr("7e2a1");
const PROJECT_TOKEN = addr("beef01");
const CLAIM_ADDRESS = addr("c1a1a0");
const PROCESSOR_TERMINAL = addr("fee7e1");
const PROCESSOR_TOKEN = addr("fee70c");

const USDC_WEI_PER_CENT = 10_000n;

let pool: Pool;

/** Fake of every on-chain operation the payer worker makes. */
class FakeChain implements PayChain {
  quote = 1_000_000n;
  /** What the worker wallet holds; the draw belt reads this on a resume. */
  workerBalance = 0n;
  configErrors: Error | null = null;
  /** paymentId (bytes32) -> tokens held, i.e. the escrow's `entries` mapping. */
  entries = new Map<string, bigint>();
  processed: ProcessPaymentParams[] = [];
  quoteCalls: QuoteTokensParams[] = [];
  draws: bigint[] = [];
  /** Set to a bytes32 paymentId to make the next processPayment for it throw. */
  failProcessFor: string | null = null;
  /** When true, every processPayment reverts -- a permanently failing send. */
  alwaysFailProcess = false;
  private txCounter = 0;

  assertConfigured(_options: { instant: boolean }): void {
    if (this.configErrors) throw this.configErrors;
  }

  async workerUsdcBalance(): Promise<bigint> {
    return this.workerBalance;
  }

  async quoteTokens(params: QuoteTokensParams): Promise<bigint> {
    this.quoteCalls.push(params);
    return this.quote;
  }

  async entryTokensHeld(paymentId: Hex): Promise<bigint | null> {
    return this.entries.get(paymentId) ?? null;
  }

  async processPayment(params: ProcessPaymentParams): Promise<ProcessPaymentResult> {
    if (this.alwaysFailProcess) {
      throw new Error("terminal reverted");
    }
    if (this.failProcessFor === params.paymentId) {
      this.failProcessFor = null;
      throw new Error("rpc exploded mid-send");
    }
    if (this.entries.has(params.paymentId)) {
      throw new Error(`EntryExists: ${params.paymentId}`);
    }
    this.processed.push(params);
    const tokensHeld = this.quote;
    this.entries.set(params.paymentId, tokensHeld);
    this.txCounter += 1;
    return {
      txHash: `0x${this.txCounter.toString(16).padStart(64, "0")}` as Hex,
      tokensHeld,
    };
  }

  async drawFromInstantPool(amountWei: bigint): Promise<Hex> {
    this.draws.push(amountWei);
    return `0x${"d0".repeat(32)}` as Hex;
  }
}

/** Fake of the Stripe slice the worker reads (settlement belt) and writes (refunds). */
class FakeStripe {
  balanceTransactionStatus: string | null = "available";
  retrieved: string[] = [];
  refundCalls: Array<{ params: unknown; options: unknown }> = [];
  /** Refunds Stripe already knows about, as `refunds.list` would report them. */
  existingRefunds: Array<{ id: string }> = [];
  listCalls: unknown[] = [];
  /** Runs inside `paymentIntents.retrieve`, to simulate a concurrent state change. */
  onRetrieve: (() => Promise<void>) | null = null;

  paymentIntents = {
    retrieve: async (id: string, _params?: { expand?: string[] }) => {
      this.retrieved.push(id);
      if (this.onRetrieve) await this.onRetrieve();
      return {
        id,
        object: "payment_intent",
        latest_charge: {
          id: "ch_test",
          object: "charge",
          balance_transaction:
            this.balanceTransactionStatus === null
              ? null
              : {
                  id: "txn_test",
                  object: "balance_transaction",
                  status: this.balanceTransactionStatus,
                },
        },
      } as never;
    },
  };

  refunds = {
    create: async (params: unknown, options?: unknown) => {
      this.refundCalls.push({ params, options });
      const refund = { id: `re_test_${this.refundCalls.length}` };
      this.existingRefunds.push(refund);
      return refund;
    },
    list: async (params: unknown) => {
      this.listCalls.push(params);
      return { data: this.existingRefunds.slice(0, 1) };
    },
  };
}

function deps(chain: FakeChain, stripe: FakeStripe): WorkerDeps {
  // The keeper's escrow reads are never exercised here (no payment in these
  // tests reaches `unlocked`), but the worker registry now carries the release
  // handlers, so the deps have to satisfy their slice too.
  const escrow = {
    getEntry: async () => null,
    release: async () => {
      throw new Error("release: not expected in the payer tests");
    },
  };
  return { pool, stripe, chain, escrow } as unknown as WorkerDeps;
}

interface SeedOptions {
  state?: PaymentState;
  instant?: boolean;
  amountUsdCents?: bigint;
  premiumUsdCents?: bigint;
  quoteTokens?: bigint;
  unlockAt?: Date;
  claimAddress?: Address | null;
  paymentIntent?: string | null;
}

let seedCounter = 0;

async function seedPayment(options: SeedOptions = {}) {
  seedCounter += 1;
  const payment = await createPayment(pool, {
    projectId: PROJECT_ID,
    email: `payer${seedCounter}@example.com`,
    amountUsdCents: options.amountUsdCents ?? 5000n,
    premiumUsdCents: options.premiumUsdCents ?? 0n,
    instant: options.instant ?? false,
    claimAddress: options.claimAddress === null ? undefined : options.claimAddress ?? CLAIM_ADDRESS,
    quoteTokens: options.quoteTokens ?? 1_000_000n,
  });

  const unlockAt = options.unlockAt ?? new Date(Date.now() + 120 * 24 * 60 * 60 * 1000);
  await pool.query(
    `UPDATE payments SET state = $2, unlock_at = $3, method = 'card', stripe_payment_intent = $4
     WHERE id = $1`,
    [
      payment.id,
      options.state ?? "paid",
      unlockAt,
      options.paymentIntent === null ? null : options.paymentIntent ?? `pi_${payment.id}`,
    ],
  );

  return { ...payment, unlock_at: unlockAt };
}

async function readPayment(id: string) {
  const { rows } = await pool.query<{
    state: PaymentState;
    tokens_held: string | null;
    pay_tx: string | null;
    pool_draw_tx: string | null;
  }>("SELECT state, tokens_held, pay_tx, pool_draw_tx FROM payments WHERE id = $1", [id]);
  const row = rows[0];
  if (!row) throw new Error(`payment ${id} not found`);
  return row;
}

async function readJob(dedupeKey: string) {
  const { rows } = await pool.query<{ kind: string; run_at: Date; payload: unknown }>(
    "SELECT kind, run_at, payload FROM jobs WHERE dedupe_key = $1",
    [dedupeKey],
  );
  return rows[0] ?? null;
}

function payJob(paymentId: string): JobRow {
  return {
    id: "1",
    kind: "pay",
    payload: { paymentId },
    run_at: new Date(),
    attempts: 1,
    max_attempts: 8,
    locked_at: new Date(),
    done_at: null,
    last_error: null,
    dedupe_key: `pay:${paymentId}`,
  };
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
     VALUES ($1, 'Pay Project', $2, $3)`,
    [PROJECT_ID, PROJECT_TOKEN, TERMINAL],
  );
});

afterAll(async () => {
  await pool.end();
  const adminPool = new Pool({ connectionString: TEST_DATABASE_URL });
  await adminPool.query(`DROP SCHEMA "${SCHEMA_NAME}" CASCADE`);
  await adminPool.end();
});

beforeEach(async () => {
  await pool.query("DELETE FROM jobs");
  await pool.query("DELETE FROM payments");
});

afterEach(() => {
  delete process.env.PROCESSOR_PROJECT_ID;
  delete process.env.PROCESSOR_TOKEN_ADDRESS;
  delete process.env.PROCESSOR_TERMINAL_ADDRESS;
  delete process.env.DRIFT_TOLERANCE_BPS;
});

describe("handlePay -- default (non-instant) happy path", () => {
  it("walks paid -> paying -> held and pays the escrow with the right args", async () => {
    const payment = await seedPayment({ amountUsdCents: 5000n });
    const chain = new FakeChain();
    const stripe = new FakeStripe();

    await handlePay(deps(chain, stripe), payJob(payment.id));

    const row = await readPayment(payment.id);
    expect(row.state).toBe("held");
    expect(row.tokens_held).toBe("1000000");
    expect(row.pay_tx).not.toBeNull();

    expect(chain.processed).toHaveLength(1);
    const sent = chain.processed[0];
    expect(sent?.paymentId).toBe(paymentIdBytes32(payment.id));
    expect(sent?.terminal).toBe(TERMINAL);
    expect(sent?.projectId).toBe(BigInt(PROJECT_ID));
    expect(sent?.usdcAmountWei).toBe(5000n * USDC_WEI_PER_CENT);
    // Default tolerance is 200bps: 1_000_000 * 9800 / 10000.
    expect(sent?.minReturnedTokens).toBe(980_000n);
    expect(sent?.projectToken).toBe(PROJECT_TOKEN);
    expect(sent?.beneficiary).toBe(CLAIM_ADDRESS);
    expect(sent?.unlockAt).toBe(Math.floor(payment.unlock_at.getTime() / 1000));
    expect(sent?.memo).toContain(payment.id);

    // Default payments never touch the instant pool.
    expect(chain.draws).toHaveLength(0);
  });

  it("enqueues the unlock note at unlock_at and a receipt email", async () => {
    const payment = await seedPayment();
    await handlePay(deps(new FakeChain(), new FakeStripe()), payJob(payment.id));

    const unlock = await readJob(`unlock:${payment.id}`);
    expect(unlock?.kind).toBe("unlock-note");
    expect(unlock?.payload).toMatchObject({ paymentId: payment.id });
    expect(new Date(unlock?.run_at as unknown as string).getTime()).toBe(
      payment.unlock_at.getTime(),
    );

    const receipt = await readJob(`receipt:${payment.id}`);
    expect(receipt?.kind).toBe("receipt-email");
    expect(receipt?.payload).toMatchObject({ paymentId: payment.id });
  });

  it("refuses to pay before the Stripe money is available, leaving the payment in 'paid'", async () => {
    const payment = await seedPayment();
    const chain = new FakeChain();
    const stripe = new FakeStripe();
    stripe.balanceTransactionStatus = "pending";

    await expect(handlePay(deps(chain, stripe), payJob(payment.id))).rejects.toThrow(
      /pending|not.*available/i,
    );

    expect(chain.processed).toHaveLength(0);
    expect((await readPayment(payment.id)).state).toBe("paid");
  });
});

describe("handlePay -- drift", () => {
  it("refunds the payer and marks the payment refunded when the quote has fallen too far", async () => {
    const payment = await seedPayment({ quoteTokens: 1_000_000n });
    const chain = new FakeChain();
    chain.quote = 900_000n; // 10% below the checkout quote, tolerance is 2%.
    const stripe = new FakeStripe();

    await handlePay(deps(chain, stripe), payJob(payment.id));

    expect(chain.processed).toHaveLength(0);
    expect(stripe.refundCalls).toHaveLength(1);
    expect(stripe.refundCalls[0]?.params).toMatchObject({
      payment_intent: `pi_${payment.id}`,
    });
    expect((await readPayment(payment.id)).state).toBe("refunded");
  });

  it("pays normally when the quote drifted within tolerance", async () => {
    const payment = await seedPayment({ quoteTokens: 1_000_000n });
    const chain = new FakeChain();
    chain.quote = 990_000n; // 1% below -- inside the 2% tolerance.
    const stripe = new FakeStripe();

    await handlePay(deps(chain, stripe), payJob(payment.id));

    expect(stripe.refundCalls).toHaveLength(0);
    expect(chain.processed).toHaveLength(1);
    expect(chain.processed[0]?.minReturnedTokens).toBe((990_000n * 9800n) / 10_000n);
    expect((await readPayment(payment.id)).state).toBe("held");
  });

  it("does not re-refund a retry that crashed between the refund and the transition", async () => {
    const payment = await seedPayment({ state: "paying", quoteTokens: 1_000_000n });
    const chain = new FakeChain();
    chain.quote = 500_000n;
    const stripe = new FakeStripe();

    await handlePay(deps(chain, stripe), payJob(payment.id));

    // Same idempotency key as the crashed attempt would have used, so Stripe
    // itself collapses the duplicate.
    expect(stripe.refundCalls[0]?.options).toMatchObject({
      idempotencyKey: `refund:${payment.id}`,
    });
    expect((await readPayment(payment.id)).state).toBe("refunded");
  });
});

describe("handlePay -- at-most-once", () => {
  it("resumes a crash-after-paying attempt without re-sending, using the on-chain entry", async () => {
    const payment = await seedPayment({ state: "paying" });
    const chain = new FakeChain();
    chain.entries.set(paymentIdBytes32(payment.id), 777n);
    const stripe = new FakeStripe();

    await handlePay(deps(chain, stripe), payJob(payment.id));

    expect(chain.processed).toHaveLength(0);
    const row = await readPayment(payment.id);
    expect(row.state).toBe("held");
    expect(row.tokens_held).toBe("777");
    // The tx hash of the crashed attempt is unrecoverable; the entry is the record.
    expect(row.pay_tx).toBeNull();
    expect(await readJob(`unlock:${payment.id}`)).not.toBeNull();
  });

  it("re-sends nothing and completes silently for a payment canceled before the job ran", async () => {
    const payment = await seedPayment({ state: "canceled" });
    const chain = new FakeChain();
    const stripe = new FakeStripe();

    await expect(handlePay(deps(chain, stripe), payJob(payment.id))).resolves.toBeUndefined();

    expect(chain.processed).toHaveLength(0);
    expect(chain.quoteCalls).toHaveLength(0);
    expect(stripe.retrieved).toHaveLength(0);
    expect((await readPayment(payment.id)).state).toBe("canceled");
  });

  it("completes silently when the payment is canceled between the load and the gate", async () => {
    const payment = await seedPayment();
    const chain = new FakeChain();
    const stripe = new FakeStripe();
    // A dispute lands while the settlement belt is talking to Stripe.
    stripe.onRetrieve = async () => {
      await pool.query("UPDATE payments SET state = 'canceled' WHERE id = $1", [payment.id]);
    };

    await expect(handlePay(deps(chain, stripe), payJob(payment.id))).resolves.toBeUndefined();

    expect(chain.processed).toHaveLength(0);
    expect((await readPayment(payment.id)).state).toBe("canceled");
  });

  it("is a no-op for a payment already held", async () => {
    const payment = await seedPayment({ state: "held" });
    const chain = new FakeChain();
    await expect(
      handlePay(deps(chain, new FakeStripe()), payJob(payment.id)),
    ).resolves.toBeUndefined();
    expect(chain.processed).toHaveLength(0);
    expect((await readPayment(payment.id)).state).toBe("held");
  });
});

describe("handlePay -- instant", () => {
  it("draws amount + premium from the pool and pays both legs", async () => {
    process.env.PROCESSOR_PROJECT_ID = "9";
    process.env.PROCESSOR_TOKEN_ADDRESS = PROCESSOR_TOKEN;
    process.env.PROCESSOR_TERMINAL_ADDRESS = PROCESSOR_TERMINAL;

    const payment = await seedPayment({
      instant: true,
      amountUsdCents: 10_000n,
      premiumUsdCents: 150n,
    });
    const chain = new FakeChain();
    const stripe = new FakeStripe();

    await handlePay(deps(chain, stripe), payJob(payment.id));

    // Instant skips the settlement belt entirely -- the pool fronts the money.
    expect(stripe.retrieved).toHaveLength(0);
    expect(chain.draws).toEqual([10_150n * USDC_WEI_PER_CENT]);

    expect(chain.processed).toHaveLength(2);
    const main = chain.processed[0];
    const fee = chain.processed[1];
    expect(main?.paymentId).toBe(paymentIdBytes32(payment.id));
    expect(main?.usdcAmountWei).toBe(10_000n * USDC_WEI_PER_CENT);
    expect(fee?.paymentId).toBe(feePaymentId(paymentIdBytes32(payment.id)));
    expect(fee?.projectId).toBe(9n);
    expect(fee?.terminal).toBe(PROCESSOR_TERMINAL);
    expect(fee?.projectToken).toBe(PROCESSOR_TOKEN);
    expect(fee?.usdcAmountWei).toBe(150n * USDC_WEI_PER_CENT);
    expect(fee?.beneficiary).toBe(CLAIM_ADDRESS);
    expect(fee?.unlockAt).toBe(main?.unlockAt);

    const row = await readPayment(payment.id);
    expect(row.state).toBe("held");
    // tokens_held records the donation leg only.
    expect(row.tokens_held).toBe("1000000");
  });

  it("skips the fee leg silently when the processor project env is unset", async () => {
    const payment = await seedPayment({
      instant: true,
      amountUsdCents: 10_000n,
      premiumUsdCents: 150n,
    });
    const chain = new FakeChain();

    await handlePay(deps(chain, new FakeStripe()), payJob(payment.id));

    expect(chain.draws).toEqual([10_150n * USDC_WEI_PER_CENT]);
    expect(chain.processed).toHaveLength(1);
    expect((await readPayment(payment.id)).state).toBe("held");
  });

  it("a retry after a fee-leg failure does not re-send the donation leg", async () => {
    process.env.PROCESSOR_PROJECT_ID = "9";
    process.env.PROCESSOR_TOKEN_ADDRESS = PROCESSOR_TOKEN;
    process.env.PROCESSOR_TERMINAL_ADDRESS = PROCESSOR_TERMINAL;

    const payment = await seedPayment({
      instant: true,
      amountUsdCents: 10_000n,
      premiumUsdCents: 150n,
    });
    const chain = new FakeChain();
    const stripe = new FakeStripe();
    chain.failProcessFor = feePaymentId(paymentIdBytes32(payment.id));

    await expect(handlePay(deps(chain, stripe), payJob(payment.id))).rejects.toThrow(
      /rpc exploded/,
    );
    expect(chain.processed).toHaveLength(1);
    expect((await readPayment(payment.id)).state).toBe("paying");

    // The retry sees the donation entry on-chain and sends only the fee leg.
    await handlePay(deps(chain, stripe), payJob(payment.id));

    expect(chain.processed).toHaveLength(2);
    expect(chain.processed[1]?.paymentId).toBe(feePaymentId(paymentIdBytes32(payment.id)));
    expect(chain.draws).toHaveLength(1); // no second pool draw either
    expect((await readPayment(payment.id)).state).toBe("held");
  });
});

describe("handlePay -- the pool draw happens at most once", () => {
  it("draws once no matter how many times a permanently reverting send is retried", async () => {
    const payment = await seedPayment({
      instant: true,
      amountUsdCents: 10_000n,
      premiumUsdCents: 150n,
    });
    const chain = new FakeChain();
    chain.alwaysFailProcess = true;
    const stripe = new FakeStripe();

    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(handlePay(deps(chain, stripe), payJob(payment.id))).rejects.toThrow(
        /terminal reverted/,
      );
    }

    // Without a recorded draw, each retry would pull another 10_150 USDC out of
    // the pool -- up to max_attempts times -- and checkout would never see it.
    expect(chain.draws).toHaveLength(1);
    const row = await readPayment(payment.id);
    expect(row.pool_draw_tx).not.toBeNull();
    expect(row.state).toBe("paying");
  });

  it("does not draw again when the payment already has a recorded draw", async () => {
    const payment = await seedPayment({
      state: "paying",
      instant: true,
      amountUsdCents: 10_000n,
      premiumUsdCents: 150n,
    });
    await pool.query("UPDATE payments SET pool_draw_tx = '0xdrawn' WHERE id = $1", [
      payment.id,
    ]);
    const chain = new FakeChain();

    await handlePay(deps(chain, new FakeStripe()), payJob(payment.id));

    expect(chain.draws).toHaveLength(0);
    expect(chain.processed).toHaveLength(1);
    expect((await readPayment(payment.id)).state).toBe("held");
  });

  it("skips a resumed draw when the worker already holds the USDC (lost draw record)", async () => {
    const payment = await seedPayment({
      state: "paying",
      instant: true,
      amountUsdCents: 10_000n,
      premiumUsdCents: 150n,
    });
    const chain = new FakeChain();
    chain.workerBalance = 10_150n * USDC_WEI_PER_CENT;

    await handlePay(deps(chain, new FakeStripe()), payJob(payment.id));

    expect(chain.draws).toHaveLength(0);
    expect(chain.processed).toHaveLength(1);
  });

  it("still draws on a first attempt even when the worker is holding other funds", async () => {
    const payment = await seedPayment({
      instant: true,
      amountUsdCents: 10_000n,
      premiumUsdCents: 150n,
    });
    const chain = new FakeChain();
    // Default-rail USDC resting in the settlement wallet is not this payment's
    // money: a first attempt has never drawn, so it must still draw.
    chain.workerBalance = 1_000_000n * USDC_WEI_PER_CENT;

    await handlePay(deps(chain, new FakeStripe()), payJob(payment.id));

    expect(chain.draws).toEqual([10_150n * USDC_WEI_PER_CENT]);
  });
});

describe("handlePay -- resuming after a refund", () => {
  it("records the refund instead of paying when Stripe has already refunded", async () => {
    const payment = await seedPayment({ state: "paying" });
    const chain = new FakeChain();
    const stripe = new FakeStripe();
    stripe.existingRefunds = [{ id: "re_earlier" }];

    await handlePay(deps(chain, stripe), payJob(payment.id));

    // The quote may well have recovered by now; paying anyway would send USDC
    // on-chain for money already back with the payer.
    expect(chain.quoteCalls).toHaveLength(0);
    expect(chain.processed).toHaveLength(0);
    expect(stripe.refundCalls).toHaveLength(0);
    expect((await readPayment(payment.id)).state).toBe("refunded");
  });

  it("does not probe for refunds on a fresh attempt", async () => {
    const payment = await seedPayment();
    const stripe = new FakeStripe();

    await handlePay(deps(new FakeChain(), stripe), payJob(payment.id));

    expect(stripe.listCalls).toHaveLength(0);
    expect((await readPayment(payment.id)).state).toBe("held");
  });
});

describe("handlePay -- pre-pay states and config", () => {
  it("pays a payment in 'settled' just like one in 'paid'", async () => {
    const payment = await seedPayment({ state: "settled" });
    const chain = new FakeChain();

    await handlePay(deps(chain, new FakeStripe()), payJob(payment.id));

    expect(chain.processed).toHaveLength(1);
    expect((await readPayment(payment.id)).state).toBe("held");
  });

  it("fails before the gate on a bad environment, leaving the payment payable", async () => {
    const payment = await seedPayment();
    const chain = new FakeChain();
    chain.configErrors = new Error("ESCROW_ADDRESS environment variable is not set");

    await expect(
      handlePay(deps(chain, new FakeStripe()), payJob(payment.id)),
    ).rejects.toThrow(/ESCROW_ADDRESS/);

    expect((await readPayment(payment.id)).state).toBe("paid");
  });
});

describe("handlePay -- bad input", () => {
  it("completes silently for a payment id that does not exist", async () => {
    const chain = new FakeChain();
    await expect(
      handlePay(deps(chain, new FakeStripe()), payJob("00000000-0000-4000-8000-000000000000")),
    ).resolves.toBeUndefined();
    expect(chain.processed).toHaveLength(0);
  });

  it("throws when the payment has no beneficiary to escrow for", async () => {
    const payment = await seedPayment({ claimAddress: null });
    await expect(
      handlePay(deps(new FakeChain(), new FakeStripe()), payJob(payment.id)),
    ).rejects.toThrow(/claim_address|beneficiary/i);
  });
});

describe("runWorkerOnce", () => {
  it("claims a pay job, runs its handler, and marks it done", async () => {
    const payment = await seedPayment();
    const job = await enqueue(pool, "pay", { paymentId: payment.id }, {
      dedupeKey: `pay:${payment.id}`,
    });
    const chain = new FakeChain();

    const worked = await runWorkerOnce(deps(chain, new FakeStripe()));
    expect(worked).toBe(true);

    const { rows } = await pool.query<{ done_at: Date | null; last_error: string | null }>(
      "SELECT done_at, last_error FROM jobs WHERE id = $1",
      [job.id],
    );
    expect(rows[0]?.done_at).not.toBeNull();
    expect(rows[0]?.last_error).toBeNull();
    expect((await readPayment(payment.id)).state).toBe("held");
  });

  it("returns false when there is nothing to claim", async () => {
    expect(await runWorkerOnce(deps(new FakeChain(), new FakeStripe()))).toBe(false);
  });

  it("fails a job whose kind has no handler instead of completing it", async () => {
    const job = await enqueue(pool, "not-a-kind", {});

    expect(await runWorkerOnce(deps(new FakeChain(), new FakeStripe()))).toBe(true);

    const { rows } = await pool.query<{ done_at: Date | null; last_error: string | null }>(
      "SELECT done_at, last_error FROM jobs WHERE id = $1",
      [job.id],
    );
    expect(rows[0]?.done_at).toBeNull();
    expect(rows[0]?.last_error).toMatch(/not-a-kind/);
  });

  it("fails the job (for retry) when the handler throws", async () => {
    const payment = await seedPayment();
    const job = await enqueue(pool, "pay", { paymentId: payment.id });
    const stripe = new FakeStripe();
    stripe.balanceTransactionStatus = "pending";

    expect(await runWorkerOnce(deps(new FakeChain(), stripe))).toBe(true);

    const { rows } = await pool.query<{
      done_at: Date | null;
      last_error: string | null;
      locked_at: Date | null;
    }>("SELECT done_at, last_error, locked_at FROM jobs WHERE id = $1", [job.id]);
    expect(rows[0]?.done_at).toBeNull();
    expect(rows[0]?.locked_at).toBeNull();
    expect(rows[0]?.last_error).toBeTruthy();
    expect((await readPayment(payment.id)).state).toBe("paid");
  });

  it("survives a queue error instead of exiting, and stops on SIGTERM", async () => {
    const payment = await seedPayment();
    await enqueue(pool, "pay", { paymentId: payment.id });

    // A pool whose first call fails: the loop must log and keep going, not
    // take the whole worker process down with it.
    let calls = 0;
    const flakyPool = {
      query: async (...args: unknown[]) => {
        calls += 1;
        if (calls === 1) throw new Error("connection terminated unexpectedly");
        return (pool.query as (...a: unknown[]) => unknown)(...args);
      },
      connect: () => pool.connect(),
    } as unknown as Pool;

    const running = startWorker({
      ...deps(new FakeChain(), new FakeStripe()),
      pool: flakyPool,
    });

    // Give the loop time to eat the error, sleep, and come back for the job.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if ((await readPayment(payment.id)).state === "held") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect((await readPayment(payment.id)).state).toBe("held");

    process.emit("SIGTERM");
    await expect(running).resolves.toBeUndefined();
  }, 20_000);

  it("reaps a stale lock so an abandoned job is claimable again", async () => {
    const payment = await seedPayment();
    const job = await enqueue(pool, "pay", { paymentId: payment.id });
    await claimNext(pool);
    await pool.query(
      "UPDATE jobs SET locked_at = now() - interval '11 minutes' WHERE id = $1",
      [job.id],
    );

    expect(await runWorkerOnce(deps(new FakeChain(), new FakeStripe()))).toBe(true);
    expect((await readPayment(payment.id)).state).toBe("held");
  });
});
