import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/db/index.js";
import {
  createPayment,
  transition,
  TransitionError,
} from "../src/db/payments.js";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/jbprocessor_test";

const SCHEMA_NAME = `test_payments_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

let pool: Pool;
const PROJECT_ID = 1;

beforeAll(async () => {
  const adminPool = new Pool({ connectionString: TEST_DATABASE_URL });
  await adminPool.query(`CREATE SCHEMA "${SCHEMA_NAME}"`);
  await adminPool.end();

  // Every connection this pool opens gets the scratch schema first on its
  // search_path, so migrate() and all queries below are isolated from any
  // other test file running concurrently against the same database.
  pool = new Pool({
    connectionString: TEST_DATABASE_URL,
    options: `-c search_path=${SCHEMA_NAME}`,
  });

  await migrate(pool);

  await pool.query(
    `INSERT INTO projects (project_id, name, token_address, terminal_address)
     VALUES ($1, $2, $3, $4)`,
    [PROJECT_ID, "Test Project", "0x0000000000000000000000000000000000dEaD", "0x0000000000000000000000000000000000bEEF"],
  );
});

afterAll(async () => {
  await pool.end();
  const adminPool = new Pool({ connectionString: TEST_DATABASE_URL });
  await adminPool.query(`DROP SCHEMA "${SCHEMA_NAME}" CASCADE`);
  await adminPool.end();
});

describe("migrate", () => {
  it("is idempotent -- re-running does not error or duplicate objects", async () => {
    await expect(migrate(pool)).resolves.toBeUndefined();
    const { rows } = await pool.query(
      "SELECT filename FROM schema_migrations ORDER BY filename",
    );
    expect(rows.map((row) => row.filename)).toEqual([
      "001_init.sql",
      "002_premium.sql",
      "003_pool_draw.sql",
    ]);
  });
});

describe("createPayment", () => {
  it("returns a row in the created state", async () => {
    const payment = await createPayment(pool, {
      projectId: PROJECT_ID,
      email: "buyer@example.com",
      amountUsdCents: 5000n,
      instant: false,
    });

    expect(payment.id).toBeTruthy();
    expect(payment.state).toBe("created");
    expect(payment.project_id).toBe(String(PROJECT_ID));
    expect(payment.email).toBe("buyer@example.com");
    expect(payment.amount_usd_cents).toBe("5000");
    expect(payment.instant).toBe(false);
  });
});

describe("transition", () => {
  it("moves created -> paid exactly once; a second identical call throws TransitionError", async () => {
    const payment = await createPayment(pool, {
      projectId: PROJECT_ID,
      email: "once@example.com",
      amountUsdCents: 1000n,
      instant: false,
    });

    const paid = await transition(pool, payment.id, ["created"], "paid");
    expect(paid.state).toBe("paid");
    expect(paid.id).toBe(payment.id);

    // The row is now in 'paid', not 'created' -- an identical second call
    // must find zero matching rows and throw, proving at-most-once.
    await expect(
      transition(pool, payment.id, ["created"], "paid"),
    ).rejects.toBeInstanceOf(TransitionError);

    // And the row was not mutated by the failed second attempt.
    const { rows } = await pool.query<{ state: string }>(
      "SELECT state FROM payments WHERE id = $1",
      [payment.id],
    );
    expect(rows[0]?.state).toBe("paid");
  });

  it("throws TransitionError when the row is not in one of the given from-states", async () => {
    const payment = await createPayment(pool, {
      projectId: PROJECT_ID,
      email: "wrong-state@example.com",
      amountUsdCents: 2000n,
      instant: false,
    });

    // payment is 'created', not 'paid' -- this must not match.
    await expect(
      transition(pool, payment.id, ["paid"], "settled"),
    ).rejects.toBeInstanceOf(TransitionError);

    const { rows } = await pool.query<{ state: string }>(
      "SELECT state FROM payments WHERE id = $1",
      [payment.id],
    );
    expect(rows[0]?.state).toBe("created");
  });

  it("throws TransitionError for an id that does not exist", async () => {
    await expect(
      transition(
        pool,
        "00000000-0000-0000-0000-000000000000",
        ["created"],
        "paid",
      ),
    ).rejects.toBeInstanceOf(TransitionError);
  });

  it("applies allowlisted patch fields alongside the state change", async () => {
    const payment = await createPayment(pool, {
      projectId: PROJECT_ID,
      email: "patch@example.com",
      amountUsdCents: 3000n,
      instant: true,
    });

    const unlockAt = new Date(Date.now() + 60_000);
    const held = await transition(pool, payment.id, ["created"], "held", {
      pay_tx: "0xdeadbeef",
      unlock_at: unlockAt,
      tokens_held: "123.456",
    });

    expect(held.state).toBe("held");
    expect(held.pay_tx).toBe("0xdeadbeef");
    expect(held.tokens_held).toBe("123.456");
    expect(new Date(held.unlock_at as unknown as string).getTime()).toBe(
      unlockAt.getTime(),
    );

    // updated_at must have moved forward from created_at.
    expect(held.updated_at.getTime()).toBeGreaterThanOrEqual(
      held.created_at.getTime(),
    );
  });

  it("rejects a patch key that is not in the allowlist", async () => {
    const payment = await createPayment(pool, {
      projectId: PROJECT_ID,
      email: "badpatch@example.com",
      amountUsdCents: 1500n,
      instant: false,
    });

    await expect(
      transition(pool, payment.id, ["created"], "paid", {
        // @ts-expect-error -- deliberately not a patchable column
        id: "attacker-controlled",
      }),
    ).rejects.toThrow(/not a patchable column/);
  });
});
