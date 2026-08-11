import type { Pool } from "pg";
import type { Queryable } from "./payments.js";

export interface JobRow {
  id: string;
  kind: string;
  payload: unknown;
  run_at: Date;
  attempts: number;
  max_attempts: number;
  locked_at: Date | null;
  done_at: Date | null;
  last_error: string | null;
  dedupe_key: string | null;
}

export interface EnqueueOptions {
  runAt?: Date;
  dedupeKey?: string;
}

/**
 * Inserts a new job. If `dedupeKey` collides with an existing row's
 * `dedupe_key`, this is a silent no-op that returns the pre-existing row
 * rather than throwing or inserting a duplicate -- callers that enqueue the
 * same logical work twice (e.g. a retried webhook) don't need to special-case
 * the conflict.
 */
export async function enqueue(
  pool: Queryable,
  kind: string,
  payload: unknown,
  options: EnqueueOptions = {},
): Promise<JobRow> {
  const { runAt, dedupeKey } = options;

  const result = await pool.query<JobRow>(
    `INSERT INTO jobs (kind, payload, run_at, dedupe_key)
     VALUES ($1, $2, COALESCE($3, now()), $4)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING *`,
    [kind, payload, runAt ?? null, dedupeKey ?? null],
  );

  const row = result.rows[0];
  if (row) {
    return row;
  }

  // ON CONFLICT DO NOTHING returns no row when it hit the unique constraint.
  // dedupeKey is guaranteed non-null here: without it there's nothing to
  // conflict on, so the insert above always succeeds.
  const existing = await pool.query<JobRow>(
    "SELECT * FROM jobs WHERE dedupe_key = $1",
    [dedupeKey],
  );
  const existingRow = existing.rows[0];
  if (!existingRow) {
    throw new Error("enqueue: dedupe conflict but no existing row found");
  }
  return existingRow;
}

/**
 * Takes a `Pool`, not a `Queryable`: the `FOR UPDATE SKIP LOCKED` row lock
 * this acquires lives until the surrounding transaction ends, so claiming
 * inside someone else's transaction would hold the lock past the intended
 * hand-off and change what "claimed" means for every other worker. Only
 * `enqueue` (which the webhook calls inside its own transaction) is widened.
 *
 * Atomically claims the next ready job: not done, not currently locked, due
 * to run. `FOR UPDATE SKIP LOCKED` lets concurrent workers race this query
 * without blocking on each other -- a worker that loses the race sees the
 * row as locked and skips straight to the next candidate (or, with only one
 * ready job, finds none and returns null) instead of waiting.
 */
export async function claimNext(pool: Pool): Promise<JobRow | null> {
  const result = await pool.query<JobRow>(
    `UPDATE jobs SET locked_at = now(), attempts = attempts + 1
     WHERE id = (
       SELECT id FROM jobs
       WHERE done_at IS NULL AND locked_at IS NULL AND run_at <= now()
       ORDER BY id LIMIT 1
       FOR UPDATE SKIP LOCKED)
     RETURNING *`,
  );
  return result.rows[0] ?? null;
}

/** Marks a claimed job done. */
export async function complete(pool: Pool, id: string): Promise<void> {
  await pool.query("UPDATE jobs SET done_at = now() WHERE id = $1", [id]);
}

/**
 * Records a failed attempt. Clears the lock and schedules exponential
 * backoff (30s * 2^attempts) so the job becomes claimable again later --
 * unless attempts have reached max_attempts, in which case the job is
 * marked done with `last_error` prefixed "FATAL:" so it's never retried
 * again but is still visible as a terminal failure.
 */
export async function fail(pool: Pool, id: string, err: Error): Promise<void> {
  const message = err.message;

  await pool.query(
    `UPDATE jobs SET
       locked_at = NULL,
       last_error = CASE
         WHEN attempts >= max_attempts THEN 'FATAL: ' || $2::text
         ELSE $2::text
       END,
       run_at = now() + interval '30 seconds' * 2 ^ attempts,
       done_at = CASE WHEN attempts >= max_attempts THEN now() ELSE done_at END
     WHERE id = $1`,
    [id, message],
  );
}

/**
 * Clears locks left behind by workers that claimed a job and then died
 * before calling complete/fail, so the job becomes claimable again. A lock
 * older than 10 minutes is assumed abandoned.
 */
export async function reapStale(pool: Pool): Promise<void> {
  await pool.query(
    `UPDATE jobs SET locked_at = NULL
     WHERE locked_at IS NOT NULL AND locked_at < now() - interval '10 minutes'`,
  );
}
