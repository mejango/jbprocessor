import { startWorker } from "./index.js";

/**
 * The worker process entry point.
 *
 * `startWorker` resolves only after SIGTERM/SIGINT has been handled and the
 * in-flight job has finished, so reaching the success arm means a clean,
 * deliberate stop -- exit 0, and let the platform leave it stopped.
 *
 * Everything that can go wrong before the loop starts is a misconfigured
 * environment (`depsFromEnv` resolves every required variable eagerly). Those
 * throw here with the variable's name in the message and exit non-zero, which
 * is what a deploy needs: a container that dies loudly on boot rather than one
 * that reports healthy while quietly paying nothing.
 */
startWorker().then(
  () => {
    console.log("worker stopped");
    process.exit(0);
  },
  (err: unknown) => {
    console.error(
      "worker failed to start:",
      err instanceof Error && err.message ? err.message : err,
    );
    process.exit(1);
  },
);
