import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/db/index.js";
import { claimNext, complete, enqueue, fail, reapStale } from "../src/db/jobs.js";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/jbprocessor_test";

const SCHEMA_NAME = `test_jobs_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

let pool: Pool;

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
});

afterAll(async () => {
  await pool.end();
  const adminPool = new Pool({ connectionString: TEST_DATABASE_URL });
  await adminPool.query(`DROP SCHEMA "${SCHEMA_NAME}" CASCADE`);
  await adminPool.end();
});

describe("enqueue + claimNext", () => {
  it("claims a freshly enqueued job", async () => {
    const job = await enqueue(pool, "send_email", { to: "a@example.com" });
    expect(job.id).toBeTruthy();
    expect(job.kind).toBe("send_email");
    expect(job.payload).toEqual({ to: "a@example.com" });
    expect(job.attempts).toBe(0);
    expect(job.locked_at).toBeNull();

    const claimed = await claimNext(pool);
    expect(claimed).not.toBeNull();
    expect(claimed?.id).toBe(job.id);
    expect(claimed?.attempts).toBe(1);
    expect(claimed?.locked_at).not.toBeNull();
  });

  it("of two truly concurrent claims for one ready job, exactly one wins and the other sees null (FOR UPDATE SKIP LOCKED)", async () => {
    const job = await enqueue(pool, "skip_locked_probe", {});

    // Fire both claims at once from the pool -- each pool.query checks out
    // its own connection, so these race at the Postgres level, not just in
    // JS. If SKIP LOCKED weren't doing its job, the second racer would
    // either block until the first commits and then re-claim the same row
    // (attempts=2), or throw a lock-wait error; instead it must see the
    // row's FOR UPDATE lock, skip it, match zero rows, and return null.
    const [a, b] = await Promise.all([claimNext(pool), claimNext(pool)]);
    const results = [a, b];

    const winners = results.filter((r) => r !== null);
    const losers = results.filter((r) => r === null);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(winners[0]?.id).toBe(job.id);
    expect(winners[0]?.attempts).toBe(1);

    // And a subsequent claim (lock still held, job not completed) also
    // finds nothing -- the win was not a fluke of timing.
    const third = await claimNext(pool);
    expect(third).toBeNull();
  });

  it("returns null when there is nothing ready to claim", async () => {
    const future = new Date(Date.now() + 60_000);
    await enqueue(pool, "not_yet", {}, { runAt: future });

    const claimed = await claimNext(pool);
    expect(claimed).toBeNull();
  });
});

describe("fail", () => {
  it("schedules exponential backoff and a later claim picks the job back up", async () => {
    const job = await enqueue(pool, "flaky", {});
    const claimed = await claimNext(pool);
    expect(claimed?.attempts).toBe(1);

    await fail(pool, job.id, new Error("boom"));

    // Backoff for attempts=1 is 30s * 2^1 = 60s in the future -- not ready yet.
    const tooSoon = await claimNext(pool);
    expect(tooSoon).toBeNull();

    // Directly inject run_at into the past to simulate time passing, rather
    // than sleeping in the test.
    await pool.query("UPDATE jobs SET run_at = now() - interval '1 second' WHERE id = $1", [
      job.id,
    ]);

    const reclaimed = await claimNext(pool);
    expect(reclaimed?.id).toBe(job.id);
    expect(reclaimed?.attempts).toBe(2);
    expect(reclaimed?.last_error).toBe("boom");
    expect(reclaimed?.locked_at).not.toBeNull();
  });

  it("marks the job done with a FATAL-prefixed error once attempts reach max_attempts", async () => {
    const job = await enqueue(pool, "always_fails", {});

    // Drive attempts up to max_attempts (default 8) via repeated claim+fail,
    // injecting run_at back into the past between rounds instead of sleeping.
    for (let i = 0; i < 8; i++) {
      const claimed = await claimNext(pool);
      expect(claimed?.id).toBe(job.id);
      await fail(pool, job.id, new Error(`attempt ${i + 1}`));
      await pool.query(
        "UPDATE jobs SET run_at = now() - interval '1 second' WHERE id = $1",
        [job.id],
      );
    }

    const { rows } = await pool.query<{
      done_at: Date | null;
      last_error: string | null;
      attempts: number;
      locked_at: Date | null;
    }>("SELECT done_at, last_error, attempts, locked_at FROM jobs WHERE id = $1", [job.id]);

    expect(rows[0]?.attempts).toBe(8);
    expect(rows[0]?.done_at).not.toBeNull();
    expect(rows[0]?.locked_at).toBeNull();
    expect(rows[0]?.last_error).toBe("FATAL: attempt 8");

    // Done jobs are never claimable again.
    const claimed = await claimNext(pool);
    expect(claimed).toBeNull();
  });

  it("releases the dedupe key when it goes FATAL, so the work can be queued again", async () => {
    const job = await enqueue(pool, "gives_up", { paymentId: "p1" }, {
      dedupeKey: "pay:p1",
    });

    for (let i = 0; i < 8; i++) {
      await claimNext(pool);
      await fail(pool, job.id, new Error("nope"));
      await pool.query(
        "UPDATE jobs SET run_at = now() - interval '1 second' WHERE id = $1",
        [job.id],
      );
    }

    const { rows } = await pool.query<{ dedupe_key: string | null }>(
      "SELECT dedupe_key FROM jobs WHERE id = $1",
      [job.id],
    );
    expect(rows[0]?.dedupe_key).toBeNull();

    // A fixed handler (or an operator) can now re-queue the same logical work.
    const requeued = await enqueue(pool, "gives_up", { paymentId: "p1" }, {
      dedupeKey: "pay:p1",
    });
    expect(requeued.id).not.toBe(job.id);
    expect(requeued.done_at).toBeNull();
  });

  it("keeps the dedupe key while the job is still retryable", async () => {
    const job = await enqueue(pool, "still_trying", {}, { dedupeKey: "pay:p2" });
    await claimNext(pool);
    await fail(pool, job.id, new Error("transient"));

    const second = await enqueue(pool, "still_trying", {}, { dedupeKey: "pay:p2" });
    expect(second.id).toBe(job.id);
  });
});

describe("complete", () => {
  it("marks the job done and it is no longer claimable", async () => {
    const job = await enqueue(pool, "one_shot", {});
    await claimNext(pool);
    await complete(pool, job.id);

    const { rows } = await pool.query<{ done_at: Date | null }>(
      "SELECT done_at FROM jobs WHERE id = $1",
      [job.id],
    );
    expect(rows[0]?.done_at).not.toBeNull();
  });
});

describe("enqueue dedupe", () => {
  it("a conflicting dedupe_key is a silent no-op, not an error", async () => {
    const first = await enqueue(pool, "welcome_email", { to: "dup@example.com" }, {
      dedupeKey: "welcome:dup@example.com",
    });

    const second = await enqueue(
      pool,
      "welcome_email",
      { to: "dup@example.com", different: true },
      { dedupeKey: "welcome:dup@example.com" },
    );

    // No throw, and no second row was inserted -- second returns the
    // pre-existing row rather than creating a duplicate.
    expect(second.id).toBe(first.id);

    const { rows } = await pool.query(
      "SELECT count(*)::int AS count FROM jobs WHERE dedupe_key = $1",
      ["welcome:dup@example.com"],
    );
    expect(rows[0]?.count).toBe(1);
  });
});

describe("reapStale", () => {
  it("clears locks older than 10 minutes so the job becomes claimable again", async () => {
    const job = await enqueue(pool, "stuck", {});
    await claimNext(pool);

    // Simulate a worker that claimed the job 11 minutes ago and died.
    await pool.query(
      "UPDATE jobs SET locked_at = now() - interval '11 minutes' WHERE id = $1",
      [job.id],
    );

    await reapStale(pool);

    const { rows } = await pool.query<{ locked_at: Date | null }>(
      "SELECT locked_at FROM jobs WHERE id = $1",
      [job.id],
    );
    expect(rows[0]?.locked_at).toBeNull();

    const reclaimed = await claimNext(pool);
    expect(reclaimed?.id).toBe(job.id);
  });

  it("leaves locks younger than 10 minutes untouched", async () => {
    const job = await enqueue(pool, "fresh_lock", {});
    await claimNext(pool);

    await reapStale(pool);

    const { rows } = await pool.query<{ locked_at: Date | null }>(
      "SELECT locked_at FROM jobs WHERE id = $1",
      [job.id],
    );
    expect(rows[0]?.locked_at).not.toBeNull();
  });
});
