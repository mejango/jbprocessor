import type { Pool } from "pg";
import { zeroAddress, type Hex } from "viem";
import { balanceOf } from "../chain/erc20.js";
import {
  feePaymentId,
  getEntry,
  paymentIdBytes32,
  type EscrowClients,
  type EscrowEntry,
} from "../chain/escrow.js";
import { USDC_ON_BASE, USDC_WEI_PER_CENT } from "../chain/quote.js";
import { enqueue, type JobRow } from "../db/jobs.js";
import type { PaymentState } from "../db/payments.js";
import { sendAlert, type EmailDeps } from "../email/send.js";
import { envAddress, envBigInt } from "../env.js";

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

/**
 * How much USDC may sit idle in the settlement wallet before it's worth
 * asking why. 100 USDC: high enough that a gas-money float or one rounding
 * remainder doesn't page anybody, low enough that a single stuck donation
 * (the smallest thing that leaves real money resting) is visible.
 */
const DEFAULT_RESTING_BALANCE_ALERT_USDC = 100_000_000n;

/** The onchain reads the reconciler makes. */
export interface ReconcileChain {
  getEntry(paymentId: Hex): Promise<EscrowEntry | null>;
  /** The settlement wallet's own USDC balance, in 6-decimal base units. */
  settlementUsdcBalance(): Promise<bigint>;
}

/** One charge, as much of it as the day's totals need. */
export interface StripeCharge {
  id: string;
  amount: number;
  status: string;
}

/** One dispute, as much of it as the daily chargeback sweep needs. */
export interface StripeDispute {
  id: string;
  /** A bare id, or an expanded intent. Stripe returns either. */
  payment_intent: string | { id: string } | null;
}

/** The window-and-page parameters both daily list calls take. */
export interface StripeListParams {
  created?: { gte?: number; lt?: number };
  limit?: number;
  starting_after?: string;
}

/** One page of a Stripe list, narrowed to what the reconciler reads. */
export interface StripePage<T> {
  data: T[];
  has_more: boolean;
}

/** The slice of the Stripe SDK the daily cross-checks read. */
export interface ReconcileStripe {
  charges: {
    list(params: StripeListParams): Promise<StripePage<StripeCharge>>;
  };
  disputes: {
    list(params: StripeListParams): Promise<StripePage<StripeDispute>>;
  };
}

export interface ReconcileDeps extends EmailDeps {
  pool: Pool;
  escrow: ReconcileChain;
  stripe: ReconcileStripe;
  /** Injectable clock, so every window a check computes is testable. */
  now?: () => number;
}

/**
 * The live onchain slice, bound to a viem client pair.
 *
 * The balance is read for `WORKER_ADDRESS`, not for the wallet client's own
 * account: the reconciler runs in the worker, but the address it audits is the
 * one configured as the settlement wallet, so a deployment whose key and
 * configured address have drifted apart reports on the address of record.
 */
export function liveReconcileChain(clients: Pick<EscrowClients, "publicClient">): ReconcileChain {
  return {
    getEntry: (paymentId) => getEntry(clients, paymentId),
    settlementUsdcBalance: () =>
      balanceOf(clients, USDC_ON_BASE, envAddress("WORKER_ADDRESS")),
  };
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
  instant: boolean;
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
    `SELECT id, state, tokens_held, claim_address, instant FROM payments
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

  lines.push(...(await checkFeeLeg(deps, row)));

  return lines;
}

/**
 * The fee leg of an instant payment, which the release keeper is allowed to
 * fail at.
 *
 * An instant payment buys two escrow entries: the donation, and the premium
 * paid into the processor's own project -- with the *payer* as beneficiary of
 * both. `releaseOne` releases the donation, then tries the fee leg and
 * tolerates a failure there, on the grounds that a stuck fee entry must not
 * make a delivered donation look undelivered. That is the right call for the
 * keeper, and on its own it is also a silent one: the payment reads `claimed`,
 * the donation entry is settled, nothing is scheduled to try again, and the
 * payer's $PROCESSOR tokens sit unsettled forever.
 *
 * So this is the alarm the keeper's tolerance depends on. `release` is
 * permissionless onchain, so the fix is a crank anyone can send -- the line
 * names the entry to send it for.
 *
 * Only instant payments have a fee leg (a zero premium never writes one), so a
 * default-rail payment does not spend an RPC read here, and only a `claimed`
 * payment is late: while the donation is held or unlocked, an unsettled fee
 * entry is simply one that has not been released yet.
 */
async function checkFeeLeg(deps: ReconcileDeps, row: EscrowCheckRow): Promise<string[]> {
  if (!row.instant || row.state !== "claimed") return [];

  const feeId = feePaymentId(paymentIdBytes32(row.id));
  const feeEntry = await deps.escrow.getEntry(feeId);
  if (!feeEntry || feeEntry.settled) return [];

  return [
    `payment ${row.id}: delivered, but its fee-leg entry ${feeId} is still unsettled onchain (${feeEntry.amount} tokens for ${feeEntry.beneficiary}) -- release is permissionless, crank it`,
  ];
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

/** Yesterday in UTC, as `[start, end)` epoch milliseconds. */
function yesterdayWindow(now: number): { start: number; end: number } {
  const at = new Date(now);
  const end = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  return { start: end - DAY_MS, end };
}

/**
 * Walks every page of a Stripe list within a window. Stripe caps a page at
 * 100, and a busy day is more than that -- reading only the first page would
 * make the daily totals quietly wrong in exactly the direction (Stripe looks
 * smaller than the ledger) that reads as a missing charge.
 */
async function listAllInWindow<T extends { id: string }>(
  list: (params: StripeListParams) => Promise<StripePage<T>>,
  window: { start: number; end: number },
): Promise<T[]> {
  const all: T[] = [];
  let startingAfter: string | undefined;
  for (;;) {
    const page = await list({
      created: { gte: Math.floor(window.start / 1000), lt: Math.floor(window.end / 1000) },
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    all.push(...page.data);
    const last = page.data.at(-1);
    if (!page.has_more || !last) break;
    startingAfter = last.id;
  }
  return all;
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
  const window = yesterdayWindow(now);
  const charges = await listAllInWindow((params) => deps.stripe.charges.list(params), window);

  let stripeCount = 0;
  let stripeCents = 0n;
  for (const charge of charges) {
    if (charge.status !== "succeeded" || charge.amount <= 0) continue;
    stripeCount += 1;
    stripeCents += BigInt(charge.amount);
  }

  // `stripe_payment_intent IS NOT NULL` is the "was actually charged" marker:
  // it is written by `checkout.session.completed` and nowhere else, so it is
  // set for exactly the payments Stripe took money for. Selecting on state
  // alone would count abandoned checkouts that this very run canceled -- rows
  // that left `created` without a charge behind them -- and report a
  // discrepancy for every one of them.
  const { rows } = await deps.pool.query<{ n: string; total: string | null }>(
    `SELECT count(*) AS n, sum(amount_usd_cents + premium_usd_cents) AS total
       FROM payments
      WHERE state <> 'created' AND stripe_payment_intent IS NOT NULL
        AND created_at >= $1 AND created_at < $2`,
    [new Date(window.start), new Date(window.end)],
  );
  const ledgerCount = Number(rows[0]?.n ?? "0");
  const ledgerCents = BigInt(rows[0]?.total ?? "0");

  if (stripeCount === ledgerCount && stripeCents === ledgerCents) return [];

  return [
    `Stripe cross-check for ${utcDay(new Date(window.start))}: Stripe has ${stripeCount} succeeded charges totalling ${stripeCents} cents, the ledger has ${ledgerCount} charged payments totalling ${ledgerCents} cents`,
  ];
}

/**
 * (e) USDC that has stopped moving.
 *
 * Money passes *through* the settlement wallet: a default-rail donation lands
 * there from Stripe and leaves in the same hour that its pay job runs, and an
 * instant one is drawn from the pool immediately before it is spent. So a
 * resting balance is not a float -- it is USDC that arrived for a payment
 * whose on-chain send never happened, or was drawn for one that then refunded.
 *
 * The other checks find those payments by name when the ledger knows about
 * them. This one is the backstop for when it doesn't: a lost draw record, a
 * manual transfer, a Stripe payout into the wallet with no row behind it at
 * all. It reports a number, not a payment, because the whole point is that
 * there may be no row to point at.
 */
async function checkRestingBalance(deps: ReconcileDeps): Promise<string[]> {
  const threshold = envBigInt("RESTING_BALANCE_ALERT_USDC", DEFAULT_RESTING_BALANCE_ALERT_USDC);
  const balance = await deps.escrow.settlementUsdcBalance();
  if (balance <= threshold) return [];

  return [
    `settlement wallet holds ${balance} USDC base units, above the ${threshold} alert threshold -- USDC resting here is money that arrived for a payment whose on-chain send did not happen`,
  ];
}

/**
 * (f) Instant-pool money that has been earned back but not yet returned.
 *
 * The instant rail spends the pool's USDC on a payment the moment it is
 * charged, and the payer's own money lands days later, in the settlement
 * wallet. Repaying the pool out of it is a manual transfer -- nothing in this
 * service moves USDC back to the pool Safe -- so the standing allowance only
 * ever depletes, and the rail fails closed (`insufficient_pool_headroom` at
 * checkout) when it runs out.
 *
 * That is a deliberate v1 deviation, and this line is what stops it being a
 * silent one: every draw whose payment has since settled (`held` onward, so
 * Stripe's money is in) and that no one has marked swept is money the pool is
 * owed. It reports the total rather than each payment, because the number is
 * the decision -- how much to move -- and the runbook's UPDATE is what clears
 * the line.
 */
async function checkPoolSweep(deps: ReconcileDeps): Promise<string[]> {
  const { rows } = await deps.pool.query<{ n: string; cents: string | null }>(
    `SELECT count(*) AS n, sum(amount_usd_cents + premium_usd_cents) AS cents
       FROM payments
      WHERE instant AND pool_draw_tx IS NOT NULL AND pool_swept_at IS NULL
        AND state IN ('held', 'unlocked', 'claimed')`,
  );
  const count = Number(rows[0]?.n ?? "0");
  if (count === 0) return [];

  const wei = BigInt(rows[0]?.cents ?? "0") * USDC_WEI_PER_CENT;
  return [
    `instant pool: ${count} settled instant payment(s) drew ${wei} USDC base units that has not been swept back to the pool -- see "Instant pool operations" in the README; the pool's allowance does not refill itself`,
  ];
}

/**
 * (g) Yesterday's chargebacks, against what the state machine did about them.
 *
 * The webhook's dispute router handles every state it safely can, but it
 * deliberately leaves one alone: a payment in `paying` is mid-send and owned
 * by the payer worker, so transitioning it there would race an on-chain
 * transaction. That payment goes on to become `held` -- disputed, but with the
 * tokens escrowed and the keeper scheduled to deliver them to someone who has
 * already taken their money back. `src/stripe/webhook.ts` names this check as
 * the thing that catches it, so this is that check.
 *
 * It never auto-forfeits. By the time this runs the tokens may be delivered,
 * the dispute may have been won, or the escrow entry may be gone -- and
 * clawing back a payer's tokens on a day-old inference is not a decision to
 * automate. The line tells an operator which payment to look at.
 */
async function checkDisputes(deps: ReconcileDeps, now: number): Promise<string[]> {
  const window = yesterdayWindow(now);
  const disputes = await listAllInWindow((params) => deps.stripe.disputes.list(params), window);

  const lines: string[] = [];
  for (const dispute of disputes) {
    const intentId =
      typeof dispute.payment_intent === "string"
        ? dispute.payment_intent
        : dispute.payment_intent?.id;
    if (!intentId) continue;

    const { rows } = await deps.pool.query<{ id: string; state: PaymentState }>(
      "SELECT id, state FROM payments WHERE stripe_payment_intent = $1",
      [intentId],
    );
    const payment = rows[0];
    // A dispute on a charge this service never made is another integration's.
    if (!payment) continue;

    if (payment.state === "forfeited" || payment.state === "canceled") continue;

    lines.push(
      `payment ${payment.id}: disputed (${dispute.id}) but still '${payment.state}' -- the dispute did not resolve to 'forfeited' or 'canceled', so the tokens need a manual decision`,
    );
  }

  return lines;
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
 * Everything lands in one email. Seven separate alarms for one bad night is
 * how an operator learns to filter the alarm folder.
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
    ...(await runCheck("resting balance", () => checkRestingBalance(deps))),
    ...(await runCheck("instant pool sweep", () => checkPoolSweep(deps))),
    ...(await runCheck("disputes", () => checkDisputes(deps, now))),
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
