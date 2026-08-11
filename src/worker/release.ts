import type { Pool } from "pg";
import type { Hex } from "viem";
import { zeroAddress } from "viem";
import {
  feePaymentId,
  getEntry,
  paymentIdBytes32,
  release,
  type EscrowClients,
  type EscrowEntry,
} from "../chain/escrow.js";
import { enqueue, type JobRow } from "../db/jobs.js";
import { transition, TransitionError } from "../db/payments.js";

/** How often the keeper looks for entries whose hold has expired. */
const SCAN_INTERVAL_MS = 10 * 60 * 1000;

/** Ceiling on one scan, so a backlog is worked through in bounded batches. */
const SCAN_BATCH = 200;

/** The escrow reads and writes the keeper makes. */
export interface ReleaseChain {
  getEntry(paymentId: Hex): Promise<EscrowEntry | null>;
  release(paymentId: Hex): Promise<Hex>;
}

export interface ReleaseDeps {
  pool: Pool;
  escrow: ReleaseChain;
}

/** The live implementation, bound to a viem client pair. */
export function liveReleaseChain(clients: EscrowClients): ReleaseChain {
  return {
    getEntry: (paymentId) => getEntry(clients, paymentId),
    release: async (paymentId) => (await release(clients, { paymentId })).txHash,
  };
}

export interface UnlockEmailJobPayload {
  paymentId: string;
}
export interface ReleaseEmailJobPayload {
  paymentId: string;
}

function payloadPaymentId(job: JobRow): string {
  const payload = job.payload as { paymentId?: unknown } | null;
  const paymentId = payload?.paymentId;
  if (typeof paymentId !== "string" || paymentId === "") {
    throw new Error(`job ${job.id}: payload has no paymentId`);
  }
  return paymentId;
}

/**
 * Marks a held payment unlocked once its hold expires. Scheduled by the payer
 * at `unlock_at`, so by the time this runs the wait is already over.
 *
 * A payment that is no longer `held` is not an error: a dispute may have
 * forfeited it, or an operator may have refunded it, in which case the right
 * answer is to complete quietly and let the terminal state stand. Nothing here
 * touches the chain -- the release itself is the scan's job, so a slow RPC
 * can't delay the unlock bookkeeping.
 */
export async function handleUnlockNote(deps: ReleaseDeps, job: JobRow): Promise<void> {
  const paymentId = payloadPaymentId(job);

  try {
    await transition(deps.pool, paymentId, ["held"], "unlocked");
  } catch (err) {
    if (!(err instanceof TransitionError)) throw err;
    console.warn(`payment ${paymentId}: not held at unlock time -- nothing to unlock`);
    return;
  }

  const payload: UnlockEmailJobPayload = { paymentId };
  await enqueue(deps.pool, "unlock-email", payload, { dedupeKey: `unlock-email:${paymentId}` });
}

/**
 * Enqueues a scan for `at`, at most once per ten-minute bucket.
 *
 * The dedupe key is derived from the target time rather than the enqueueing
 * time so that the recurring chain can't dedupe against itself: a scan
 * scheduling its successor ten minutes out always lands in a later bucket than
 * its own, while two schedulers aiming at the same slot (a scan and a fresh
 * boot, say) collapse into one job.
 */
export async function scheduleReleaseScan(pool: Pool, at: Date): Promise<void> {
  const bucket = Math.floor(at.getTime() / SCAN_INTERVAL_MS);
  await enqueue(pool, "release-scan", {}, { runAt: at, dedupeKey: `release-scan:${bucket}` });
}

/**
 * The keeper crank: releases every unlocked entry whose tokens are still in
 * escrow. No payer action is ever required -- this is the only thing that has
 * to run for tokens to arrive.
 *
 * Two rules make it safe to run forever unattended. The successor scan is
 * scheduled *first*, so nothing below -- an unreachable RPC, a poisoned row,
 * an exhausted retry budget -- can break the chain and silently stop every
 * future delivery. And each payment is handled inside its own try/catch, so
 * one entry that always reverts costs exactly itself and never the rest of
 * the batch.
 */
export async function handleReleaseScan(deps: ReleaseDeps, _job: JobRow): Promise<void> {
  await scheduleReleaseScan(deps.pool, new Date(Date.now() + SCAN_INTERVAL_MS));

  const { rows } = await deps.pool.query<{ id: string }>(
    `SELECT id FROM payments
      WHERE state = 'unlocked' AND release_tx IS NULL
      ORDER BY unlock_at
      LIMIT ${SCAN_BATCH}`,
  );

  for (const row of rows) {
    try {
      await releaseOne(deps, row.id);
    } catch (err) {
      console.error(
        `release scan: payment ${row.id} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

async function releaseOne(deps: ReleaseDeps, paymentId: string): Promise<void> {
  const escrowPaymentId = paymentIdBytes32(paymentId);
  const entry = await deps.escrow.getEntry(escrowPaymentId);

  if (!entry) {
    // The escrow has no record of this payment, so there is nothing to
    // release and no state change this job could justify. Left alone
    // deliberately: reconciliation (Task 9) owns the mismatch.
    console.warn(`release scan: payment ${paymentId} is unlocked but the escrow has no entry`);
    return;
  }

  // A queued redirect makes `release` revert until the contract's delay
  // elapses, so skipping is not a courtesy -- it's the difference between
  // waiting one crank and burning gas on a guaranteed revert.
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (entry.pendingBeneficiary !== zeroAddress && entry.redirectEffectiveAt > nowSeconds) {
    return;
  }

  let releaseTx: Hex | undefined;
  if (entry.settled) {
    // Already released onchain: an earlier crank sent it and died before
    // recording the hash. The tokens are with the payer either way, so the row
    // catches up rather than trying (and reverting) again.
    console.warn(
      `release scan: payment ${paymentId} was already settled onchain -- recording the state only`,
    );
  } else {
    releaseTx = await deps.escrow.release(escrowPaymentId);
  }

  // Fee leg after the donation leg, and never fatal: the payer's tokens are
  // already out, and a stuck fee entry is the processor's problem to crank
  // later, not a reason to leave the payment looking undelivered.
  const feeId = feePaymentId(escrowPaymentId);
  try {
    const feeEntry = await deps.escrow.getEntry(feeId);
    if (feeEntry && !feeEntry.settled) await deps.escrow.release(feeId);
  } catch (err) {
    console.error(
      `release scan: payment ${paymentId} fee leg failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  await transition(
    deps.pool,
    paymentId,
    ["unlocked"],
    "claimed",
    releaseTx ? { release_tx: releaseTx } : undefined,
  );

  const payload: ReleaseEmailJobPayload = { paymentId };
  await enqueue(deps.pool, "release-email", payload, { dedupeKey: `release-email:${paymentId}` });
}
