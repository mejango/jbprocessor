import { getPool, migrate } from "./index.js";

/**
 * `npm run migrate` -- applies every pending migration and exits.
 *
 * A separate entry point rather than something the worker does on boot: a
 * schema change is a deploy step an operator watches, and folding it into the
 * worker's start would make two processes (web and worker) race to apply it on
 * the first boot after a deploy.
 */
async function main(): Promise<void> {
  const pool = getPool();
  try {
    await migrate(pool);
    console.log("migrations applied");
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  // The whole error when there's no message to quote: a connection failure
  // arrives as an AggregateError whose own message is empty, and "migrate
  // failed:" on its own tells an operator nothing.
  console.error("migrate failed:", err instanceof Error && err.message ? err.message : err);
  process.exit(1);
});
