import Stripe from "stripe";
import { publicClient, walletClient } from "../chain/client.js";
import { getPool } from "../db/index.js";
import { claimNext, complete, fail, reapStale, type JobRow } from "../db/jobs.js";
import { requireEnv } from "../env.js";
import { handlePay, liveChain, type PayDeps } from "./pay.js";

/** Everything any handler needs. Later tasks widen this as they add handlers. */
export type WorkerDeps = PayDeps;

export type JobHandler = (deps: WorkerDeps, job: JobRow) => Promise<void>;

/**
 * Job kind -> handler. `unlock-note`, `receipt-email`, `forfeit`, `release`
 * and the recurring cranks register here as they land. A kind with no handler
 * fails (and eventually goes FATAL) rather than being silently completed --
 * an unregistered kind should be loud, not a quietly dropped payment.
 */
export const handlers: Record<string, JobHandler> = {
  pay: handlePay,
};

const IDLE_SLEEP_MS = 2_000;

/**
 * Reaps abandoned locks, claims at most one job, and runs it. Returns whether
 * a job was claimed, so the caller knows whether to sleep.
 *
 * The handler is the only thing allowed to throw here: a throw means "retry
 * with backoff" and is recorded by `fail`, while a clean return means the job
 * is done -- including the cases where the handler decided there was nothing
 * left to do. Exported for tests, which drive the loop one turn at a time.
 */
export async function runWorkerOnce(
  deps: WorkerDeps,
  registry: Record<string, JobHandler> = handlers,
): Promise<boolean> {
  await reapStale(deps.pool);

  const job = await claimNext(deps.pool);
  if (!job) return false;

  try {
    const handler = registry[job.kind];
    if (!handler) throw new Error(`no handler registered for job kind '${job.kind}'`);
    await handler(deps, job);
    await complete(deps.pool, job.id);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(`job ${job.id} (${job.kind}) failed: ${error.message}`);
    await fail(deps.pool, job.id, error);
  }

  return true;
}

function depsFromEnv(): WorkerDeps {
  return {
    pool: getPool(),
    stripe: new Stripe(requireEnv("STRIPE_SECRET_KEY")),
    chain: liveChain({ publicClient: publicClient(), walletClient: walletClient() }),
  };
}

/**
 * Runs the poll loop until SIGTERM/SIGINT, then stops claiming and resolves
 * once the in-flight job finishes -- a job is never abandoned mid-send, which
 * for the payer is the difference between a resumable crash and a clean stop.
 *
 * Nothing runs at import time: the process entry point calls this explicitly.
 */
export async function startWorker(deps: WorkerDeps = depsFromEnv()): Promise<void> {
  let stopping = false;
  let wake: (() => void) | null = null;

  const stop = () => {
    stopping = true;
    wake?.();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  try {
    while (!stopping) {
      const worked = await runWorkerOnce(deps);
      if (worked || stopping) continue;

      // Interruptible idle: a signal during the sleep exits immediately
      // instead of waiting out the full poll interval.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, IDLE_SLEEP_MS);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = null;
    }
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
}
