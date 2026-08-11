import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "migrations");

let sharedPool: Pool | undefined;

/**
 * Returns the process-wide connection pool, reading DATABASE_URL from the
 * environment on first use. Callers that need an isolated pool (e.g. tests
 * pointed at a scratch schema) should construct their own `pg.Pool` and pass
 * it to `migrate` / the payments functions instead of using this singleton.
 */
export function getPool(): Pool {
  if (!sharedPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL environment variable is not set");
    }
    sharedPool = new Pool({ connectionString });
  }
  return sharedPool;
}

/**
 * Runs `fn` against a single checked-out client inside one transaction,
 * committing on return and rolling back on throw.
 *
 * The point is all-or-nothing bookkeeping: the payer worker's "record the
 * held tokens AND schedule the unlock note AND schedule the receipt" must
 * either all land or none of them, or a crash between the state change and
 * the enqueues would leave a payment that is `held` forever with nothing
 * scheduled to unlock it.
 *
 * A `ROLLBACK` that itself fails means the connection is no longer
 * trustworthy, so it's destroyed rather than returned to the pool.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (db: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let suspect: Error | undefined;
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      suspect = rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr));
    }
    throw err;
  } finally {
    client.release(suspect);
  }
}

/**
 * Runs every numbered .sql file in src/db/migrations that hasn't been
 * applied yet, in filename order, each inside its own transaction. Applied
 * filenames are tracked in a `schema_migrations` table so re-running is a
 * no-op.
 */
export async function migrate(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const appliedResult = await pool.query<{ filename: string }>(
    "SELECT filename FROM schema_migrations",
  );
  const applied = new Set(appliedResult.rows.map((row) => row.filename));

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((file) => file.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (filename) VALUES ($1)",
        [file],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}
