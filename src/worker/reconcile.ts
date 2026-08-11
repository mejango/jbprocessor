import type { Pool } from "pg";
import { zeroAddress, type Hex } from "viem";
import { getEntry, paymentIdBytes32, type EscrowClients, type EscrowEntry } from "../chain/escrow.js";
import { enqueue, type JobRow } from "../db/jobs.js";
import type { PaymentState } from "../db/payments.js";
import { sendAlert, type EmailDeps } from "../email/send.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** A payment mid-send for this long is not mid-send any more. */
const STUCK_PAYING_MS = HOUR_MS;

/** How long an abandoned checkout keeps pinning instant-pool headroom. */
const STALE_CREATED_MS = 24 * HOUR_MS;

/** Grace after an unlock (or a release) before silence counts as stuck. */
const DELIVERY_GRACE_MS = HOUR_MS;

/**
 * How far back to look for FATAL jobs. Slightly wider than the daily interval
 * so a run that starts a few minutes late can't leave a gap no run ever
 * covers; the cost is that a FATAL job near the boundary is reported twice,
 * which is the right way round for an alarm.
 */
const FATAL_LOOKBACK_MS = 25 * HOUR_MS;

/** Ceiling on the escrow cross-check, so one scan can't make thousands of RPC reads. */
const ESCROW_CHECK_LIMIT = 500;

/**
 * How long a delivered payment stays in the escrow cross-check.
 *
 * `held` and `unlocked` payments are money still at risk and are checked for
 * as long as they exist. `claimed` ones are checked for a week and then let
 * go: the only thing left to verify about them is that their entry settled,
 * `settled` never goes back to false, and keeping every payment ever made in
 * the daily read would eventually mean the oldest 500 rows are the only rows
 * this check ever looks at.
 */
const CLAIMED_RECHECK_MS = 7 * DAY_MS;

/** The escrow read the reconciler makes. */
export interface ReconcileChain {
  getEntry(paymentId: Hex): Promise<EscrowEntry | null>;
}

/** One charge, as much of it as the day's totals need. */
export interface StripeCharge {
  id: string;
  amount: number;
  status: string;
}

/** The slice of the Stripe SDK the daily cross-check reads. */
export interface ReconcileStripe {
  charges: {
    list(params: {
      created?: { gte?: number; lt?: number };
      limit?: number;
      starting_after?: string;
    }): Promise<{ data: StripeCharge[]; has_more: boolean }>;
  };
}

export interface ReconcileDeps extends EmailDeps {
  pool: Pool;
  escrow: ReconcileChain;
  stripe: ReconcileStripe;
  /** Injectable clock, so every window a check computes is testable. */
  now?: () => number;
}

/** The live escrow slice, bound to a viem client pair. */
export function liveReconcileChain(clients: Pick<EscrowClients, "publicClient">): ReconcileChain {
  return { getEntry: (paymentId) => getEntry(clients, paymentId) };
}

/** `2026-08-11`, in UTC. The reconciler has exactly one timezone. */
function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * Enqueues a reconciliation for `at`, at most once per UTC day. Keyed by the
 * target day rather than the enqueueing time, for the same reason the release
 * scan is: a run scheduling tomorrow's can't dedupe against its own key, while
 * a redeploy and a running chain aiming at the same day collapse into one job.
 */
export async function scheduleReconcile(pool: Pool, at: Date): Promise<void> {
  await enqueue(pool, "reconcile", {}, { runAt: at, dedupeKey: `reconcile:${utcDay(at)}` });
}

/**
 * Runs one check, turning a thrown error into a discrepancy line.
 *
 * A check that fails is itself a discrepancy: it means a question about the
 * books went unanswered today, which is exactly what an operator needs to
 * hear. Swallowing it would make a broken RPC look like a clean day.
 */
async function runCheck(name: string, check: () => Promise<string[]>): Promise<string[]> {
  try {
    return await check();
  } catch (err) {
    return [`check '${name}' failed: ${err instanceof Error ? err.message : String(err)}`];
  }
}

interface EscrowCheckRow {
  id: string;
  state: PaymentState;
  tokens_held: string | null;
  claim_address: string | null;
}

/**
 * (a) Every payment whose tokens should be in escrow has an entry that agrees
 * with the database, and points where the database says it points.
 *
 * The beneficiary comparison is the compromised-operator alarm. A redirect is
 * queued onchain 48 hours before it takes effect, and the database records the
 * new destination as soon as both legs are queued -- so `pendingBeneficiary`
 * (when set) is the address of record, and `beneficiary` otherwise. Anything
 * else means an entry was pointed somewhere this service never asked for.
 */
async function checkEscrowEntries(deps: ReconcileDeps, now: number): Promise<string[]> {
  const lines: string[] = [];
  const { rows } = await deps.pool.query<EscrowCheckRow>(
    `SELECT id, state, tokens_held, claim_address FROM payments
      WHERE state IN ('held', 'unlocked')
         OR (state = 'claimed' AND updated_at >= $1)
      ORDER BY created_at
      LIMIT ${ESCROW_CHECK_LIMIT + 1}`,
    [new Date(now - CLAIMED_RECHECK_MS)],
  );

  if (rows.length > ESCROW_CHECK_LIMIT) {
    lines.push(
      `escrow check: more than ${ESCROW_CHECK_LIMIT} live payments -- only the oldest ${ESCROW_CHECK_LIMIT} were checked`,
    );
    rows.length = ESCROW_CHECK_LIMIT;
  }

  for (const row of rows) {
    // Per payment, not just per check: one unreadable entry must not hide the
    // other 499.
    try {
      lines.push(...(await checkOneEntry(deps, row)));
    } catch (err) {
      lines.push(
        `payment ${row.id} (${row.state}): escrow read failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return lines;
}

async function checkOneEntry(deps: ReconcileDeps, row: EscrowCheckRow): Promise<string[]> {
  const lines: string[] = [];
  const entry = await deps.escrow.getEntry(paymentIdBytes32(row.id));

  if (!entry) {
    lines.push(`payment ${row.id} (${row.state}): no escrow entry onchain`);
    return lines;
  }

  if (row.tokens_held === null) {
    lines.push(
      `payment ${row.id} (${row.state}): no tokens_held recorded, but the escrow holds ${entry.amount}`,
    );
  } else if (entry.amount !== BigInt(row.tokens_held)) {
    lines.push(
      `payment ${row.id} (${row.state}): tokens_held is ${row.tokens_held} but the escrow entry amount is ${entry.amount}`,
    );
  }

  if (row.state === "claimed" && !entry.settled) {
    lines.push(
      `payment ${row.id}: recorded as claimed but the escrow entry is not settled onchain`,
    );
  }

  const onchainBeneficiary =
    entry.pendingBeneficiary !== zeroAddress ? entry.pendingBeneficiary : entry.beneficiary;
  const expected = row.claim_address;
  if (!expected) {
    lines.push(`payment ${row.id} (${row.state}): no claim_address recorded`);
  } else if (expected.toLowerCase() !== onchainBeneficiary.toLowerCase()) {
    lines.push(
      `payment ${row.id} (${row.state}): BENEFICIARY MISMATCH -- database says ${expected}, escrow says ${onchainBeneficiary}`,
    );
  }

  return lines;
}

/**
 * (b) Rows that have stopped moving.
 *
 * The stale-`created` sweep is the one mutation reconciliation is allowed to
 * make, and it is a cancellation of something that never happened: a checkout
 * nobody completed. It has to happen somewhere, because an abandoned instant
 * checkout pins instant-pool headroom that no other payment can then use.
 * Everything else here is reported and left alone.
 */
async function checkStuckRows(deps: ReconcileDeps, now: number): Promise<string[]> {
  const lines: string[] = [];

  const paying = await deps.pool.query<{ id: string; updated_at: Date }>(
    `SELECT id, updated_at FROM payments
      WHERE state = 'paying' AND updated_at < $1
      ORDER BY updated_at`,
    [new Date(now - STUCK_PAYING_MS)],
  );
  for (const row of paying.rows) {
    lines.push(
      `payment ${row.id}: stuck in 'paying' since ${row.updated_at.toISOString()} -- the payer worker may have died mid-send`,
    );
  }

  const stale = await deps.pool.query<{ id: string }>(
    `UPDATE payments SET state = 'canceled', updated_at = now()
      WHERE state = 'created' AND created_at < $1
      RETURNING id`,
    [new Date(now - STALE_CREATED_MS)],
  );
  for (const row of stale.rows) {
    lines.push(
      `payment ${row.id}: abandoned at checkout for over 24 hours -- canceled (this frees any instant-pool headroom it was holding)`,
    );
  }

  const overdue = await deps.pool.query<{ id: string; unlock_at: Date }>(
    `SELECT id, unlock_at FROM payments
      WHERE state = 'held' AND unlock_at IS NOT NULL AND unlock_at < $1
      ORDER BY unlock_at`,
    [new Date(now - DELIVERY_GRACE_MS)],
  );
  for (const row of overdue.rows) {
    lines.push(
      `payment ${row.id}: still 'held' though its unlock passed at ${row.unlock_at.toISOString()} -- its unlock-note job may have gone FATAL`,
    );
  }

  const undelivered = await deps.pool.query<{ id: string; updated_at: Date }>(
    `SELECT id, updated_at FROM payments
      WHERE state = 'unlocked' AND release_tx IS NULL AND updated_at < $1
      ORDER BY updated_at`,
    [new Date(now - DELIVERY_GRACE_MS)],
  );
  for (const row of undelivered.rows) {
    lines.push(
      `payment ${row.id}: unlocked at ${row.updated_at.toISOString()} but still has no release transaction`,
    );
  }

  return lines;
}

/** (c) Jobs that exhausted their retries. Each one is work that silently stopped. */
async function checkFatalJobs(deps: ReconcileDeps, now: number): Promise<string[]> {
  const { rows } = await deps.pool.query<{
    id: string;
    kind: string;
    payload: unknown;
    last_error: string;
  }>(
    `SELECT id, kind, payload, last_error FROM jobs
      WHERE last_error LIKE 'FATAL:%' AND done_at IS NOT NULL AND done_at > $1
      ORDER BY id`,
    [new Date(now - FATAL_LOOKBACK_MS)],
  );

  return rows.map(
    (row) =>
      `job ${row.id} (${row.kind}, ${JSON.stringify(row.payload)}) gave up: ${row.last_error}`,
  );
}

/**
 * (d) Yesterday's money, both sides.
 *
 * The database side is keyed on `created_at`, not on when a row last moved: a
 * payment's row is created minutes before Stripe's charge and never moves
 * again in that direction, whereas `updated_at` walks forward for months as
 * the payment unlocks and is delivered. Rows still sitting in `created` are
 * excluded -- nobody ever paid for those.
 *
 * The proxy is imperfect at the day boundary (a checkout started at 23:58 and
 * paid at 00:01 lands on either side), and it counts every succeeded charge on
 * the Stripe account, including any that another integration made. Both make
 * this a "look at the day" signal rather than a ledger equality.
 */
async function checkStripeDay(deps: ReconcileDeps, now: number): Promise<string[]> {
  const todayStart = Date.UTC(
    new Date(now).getUTCFullYear(),
    new Date(now).getUTCMonth(),
    new Date(now).getUTCDate(),
  );
  const dayStart = todayStart - DAY_MS;

  let stripeCount = 0;
  let stripeCents = 0n;
  let startingAfter: string | undefined;
  for (;;) {
    const page = await deps.stripe.charges.list({
      created: { gte: Math.floor(dayStart / 1000), lt: Math.floor(todayStart / 1000) },
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    for (const charge of page.data) {
      if (charge.status !== "succeeded" || charge.amount <= 0) continue;
      stripeCount += 1;
      stripeCents += BigInt(charge.amount);
    }
    const last = page.data.at(-1);
    if (!page.has_more || !last) break;
    startingAfter = last.id;
  }

  const { rows } = await deps.pool.query<{ n: string; total: string | null }>(
    `SELECT count(*) AS n, sum(amount_usd_cents + premium_usd_cents) AS total
       FROM payments
      WHERE state <> 'created' AND created_at >= $1 AND created_at < $2`,
    [new Date(dayStart), new Date(todayStart)],
  );
  const ledgerCount = Number(rows[0]?.n ?? "0");
  const ledgerCents = BigInt(rows[0]?.total ?? "0");

  if (stripeCount === ledgerCount && stripeCents === ledgerCents) return [];

  return [
    `Stripe cross-check for ${utcDay(new Date(dayStart))}: Stripe has ${stripeCount} succeeded charges totalling ${stripeCents} cents, the ledger has ${ledgerCount} paid payments totalling ${ledgerCents} cents`,
  ];
}

/**
 * The daily books-balance check.
 *
 * It never corrects anything (bar cancelling abandoned checkouts, which is a
 * cancellation of something that never happened): every disagreement between
 * this service's database, the chain and Stripe is a question for a human, and
 * an automated "fix" applied to a mismatch nobody has understood yet is how a
 * small bug becomes a lost payment.
 *
 * Everything lands in one email. Five separate alarms for one bad night is how
 * an operator learns to filter the alarm folder.
 */
export async function handleReconcile(deps: ReconcileDeps, _job: JobRow): Promise<void> {
  const now = deps.now?.() ?? Date.now();

  // Scheduled first, like every recurring crank here: nothing below may be
  // able to break the chain and silently end all future reconciliation.
  await scheduleReconcile(deps.pool, new Date(now + DAY_MS));

  const lines = [
    ...(await runCheck("escrow entries", () => checkEscrowEntries(deps, now))),
    ...(await runCheck("stuck rows", () => checkStuckRows(deps, now))),
    ...(await runCheck("fatal jobs", () => checkFatalJobs(deps, now))),
    ...(await runCheck("stripe day", () => checkStripeDay(deps, now))),
  ];

  if (lines.length === 0) {
    console.log(`reconciliation for ${utcDay(new Date(now))}: no discrepancies`);
    return;
  }

  await sendAlert(
    deps,
    `Reconciliation found ${lines.length} discrepanc${lines.length === 1 ? "y" : "ies"}`,
    [
      `Daily reconciliation for ${utcDay(new Date(now))} found ${lines.length} thing(s)`,
      "that do not add up. Nothing has been corrected automatically.",
      "",
      ...lines.map((line) => `  - ${line}`),
      "",
      "-- JBProcessor",
    ].join("\n"),
  );
}
