import type { Pool } from "pg";
import type Stripe from "stripe";
import { isAddress, type Address, type Hex } from "viem";
import type { ChainClients } from "../chain/client.js";
import { balanceOf, transferFrom } from "../chain/erc20.js";
import {
  escrowAddress,
  feePaymentId,
  getEntry,
  paymentIdBytes32,
  processPayment,
  type ProcessPaymentParams,
  type ProcessPaymentResult,
} from "../chain/escrow.js";
import {
  driftExceeded,
  liveQuoteReads,
  minTokensForQuote,
  quoteTokens,
  USDC_ON_BASE,
  USDC_WEI_PER_CENT,
  type QuoteTokensParams,
} from "../chain/quote.js";
import { withTransaction } from "../db/index.js";
import { enqueue, type JobRow } from "../db/jobs.js";
import {
  transition,
  TransitionError,
  type PaymentRow,
  type PaymentPatch,
  type PaymentState,
  type Queryable,
} from "../db/payments.js";
import { envAddress } from "../env.js";
import type { StripePaymentIntentReader } from "../stripe/webhook.js";

/** Enqueued by the Stripe webhook (`src/stripe/webhook.ts`). */
export interface PayJobPayload {
  paymentId: string;
}

/** Enqueued by this handler once the tokens are escrowed. */
export interface UnlockNoteJobPayload {
  paymentId: string;
}
export interface ReceiptEmailJobPayload {
  paymentId: string;
}

/**
 * Every on-chain operation the payer makes, behind one injectable surface so
 * tests can drive the whole state machine (including crash resumption) without
 * an RPC. `liveChain` is the production implementation.
 */
export interface PayChain {
  /**
   * Resolves everything this payment will need from the environment, throwing
   * on anything missing or malformed. Called before the `paid -> paying` gate
   * so a misconfigured deployment fails while the payment is still untouched,
   * rather than stranding it in `paying`.
   */
  assertConfigured(options: { instant: boolean }): void;
  quoteTokens(params: QuoteTokensParams): Promise<bigint>;
  /**
   * Tokens the escrow already holds for this payment id, or null when it has
   * no entry at all. This is the at-most-once pivot: an entry means a previous
   * attempt's `processPayment` landed, whatever this process managed to record
   * before dying.
   */
  entryTokensHeld(paymentId: Hex): Promise<bigint | null>;
  processPayment(params: ProcessPaymentParams): Promise<ProcessPaymentResult>;
  /** Draws USDC from the instant pool Safe to the worker, against its allowance. */
  drawFromInstantPool(amountWei: bigint): Promise<Hex>;
  /** The worker wallet's own USDC balance -- the belt on a lost draw record. */
  workerUsdcBalance(): Promise<bigint>;
}

/** The slice of the Stripe SDK the payer reads and writes refunds through. */
export interface StripeRefunds {
  refunds: {
    create(
      params: Stripe.RefundCreateParams,
      options?: Stripe.RequestOptions,
    ): Promise<{ id: string }>;
    list(params: Stripe.RefundListParams): Promise<{ data: Array<{ id: string }> }>;
  };
}

export type PayStripe = StripePaymentIntentReader & StripeRefunds;

export interface PayDeps {
  pool: Pool;
  stripe: PayStripe;
  chain: PayChain;
}

function requireWorkerAccount(clients: ChainClients) {
  const account = clients.walletClient.account;
  if (!account) {
    throw new Error("liveChain: walletClient has no account configured");
  }
  return account;
}

/** The live `PayChain`, bound to a viem client pair. */
export function liveChain(clients: ChainClients): PayChain {
  // Built once per chain instance, not per quote: it memoizes the JBPrices
  // address it resolves off the controller, and a fresh one per call would
  // re-read that on every payment.
  const quoteReads = liveQuoteReads(clients.publicClient);

  return {
    assertConfigured: ({ instant }) => {
      requireWorkerAccount(clients);
      escrowAddress();
      if (instant) envAddress("INSTANT_POOL_ADDRESS");
    },
    quoteTokens: (params) => quoteTokens(quoteReads, params),
    entryTokensHeld: async (paymentId) => (await getEntry(clients, paymentId))?.amount ?? null,
    processPayment: (params) => processPayment(clients, params),
    drawFromInstantPool: async (amountWei) =>
      transferFrom(clients, {
        token: USDC_ON_BASE,
        from: envAddress("INSTANT_POOL_ADDRESS"),
        // The spender is whoever signs, so the draw must land on the signer's
        // own address -- that's the address the pool granted the allowance to.
        to: requireWorkerAccount(clients).address,
        amount: amountWei,
      }),
    workerUsdcBalance: () =>
      balanceOf(clients, USDC_ON_BASE, requireWorkerAccount(clients).address),
  };
}

interface ProjectRow {
  project_id: string;
  token_address: string;
  terminal_address: string;
}

/** The processor's own revnet, paid the instant premium. All three or none. */
interface ProcessorProject {
  projectId: bigint;
  token: Address;
  terminal: Address;
}

/**
 * Reads the processor project config, or null when it isn't configured --
 * pre-revnet, the premium simply accrues in the settlement wallet, which is a
 * supported deployment, not an error.
 */
function processorProject(): ProcessorProject | null {
  const projectId = process.env.PROCESSOR_PROJECT_ID;
  const token = process.env.PROCESSOR_TOKEN_ADDRESS;
  const terminal = process.env.PROCESSOR_TERMINAL_ADDRESS;
  if (!projectId || !token || !terminal) return null;

  if (!/^\d+$/.test(projectId)) {
    throw new Error(`PROCESSOR_PROJECT_ID must be a non-negative integer, got: ${projectId}`);
  }
  if (!isAddress(token) || !isAddress(terminal)) {
    throw new Error(
      "PROCESSOR_TOKEN_ADDRESS and PROCESSOR_TERMINAL_ADDRESS must be 0x-prefixed 20-byte hex addresses",
    );
  }
  return { projectId: BigInt(projectId), token, terminal };
}

function payloadPaymentId(job: JobRow): string {
  const payload = job.payload as { paymentId?: unknown } | null;
  const paymentId = payload?.paymentId;
  if (typeof paymentId !== "string" || paymentId === "") {
    throw new Error(`job ${job.id}: payload has no paymentId`);
  }
  return paymentId;
}

async function loadPayment(db: Queryable, id: string): Promise<PaymentRow | null> {
  const { rows } = await db.query<PaymentRow>("SELECT * FROM payments WHERE id = $1", [id]);
  return rows[0] ?? null;
}

async function loadProject(db: Queryable, projectId: string): Promise<ProjectRow> {
  const { rows } = await db.query<ProjectRow>(
    "SELECT project_id, token_address, terminal_address FROM projects WHERE project_id = $1",
    [projectId],
  );
  const project = rows[0];
  if (!project) throw new Error(`project ${projectId} not found`);
  return project;
}

function requireAddress(value: string | null, label: string): Address {
  if (!value || !isAddress(value)) {
    throw new Error(`${label} is not a valid address: ${value}`);
  }
  return value;
}

/** Returns the expanded object behind a Stripe reference, or null when it's a bare id. */
function expandedRef<T extends object>(ref: string | T | null | undefined): T | null {
  return ref && typeof ref !== "string" ? ref : null;
}

/**
 * Belt for the default (non-instant) rail: refuse to spend the settlement
 * wallet's USDC until Stripe's money is actually in it. The job is already
 * scheduled for the charge's `available_on`, so this is normally a formality
 * -- but schedules drift, and paying against money that hasn't landed turns a
 * timing bug into an unfunded on-chain send.
 *
 * Throwing (rather than completing) is deliberate: the money will land, so the
 * job's backoff is exactly the right response.
 */
async function requireStripeMoneyAvailable(
  deps: PayDeps,
  payment: PaymentRow,
): Promise<void> {
  const intentId = payment.stripe_payment_intent;
  if (!intentId) {
    throw new Error(
      `payment ${payment.id}: no stripe_payment_intent to verify settlement against`,
    );
  }

  const intent = await deps.stripe.paymentIntents.retrieve(intentId, {
    expand: ["latest_charge.balance_transaction"],
  });
  const charge = expandedRef(intent.latest_charge);
  const balanceTransaction = expandedRef(charge?.balance_transaction);

  if (!balanceTransaction) {
    throw new Error(
      `payment ${payment.id}: charge has no balance transaction yet, so its funds are not available`,
    );
  }
  if (balanceTransaction.status !== "available") {
    throw new Error(
      `payment ${payment.id}: balance transaction ${balanceTransaction.id} is '${balanceTransaction.status}', not yet 'available'`,
    );
  }
}

/**
 * Full Stripe refund, then `paying -> refunded`. The idempotency key makes the
 * refund itself replay-safe: an attempt that crashed between the refund and
 * the transition retries into the same key and Stripe returns the original
 * refund instead of issuing a second one.
 */
async function refundForDrift(
  deps: PayDeps,
  payment: PaymentRow,
  quoteAtCheckout: bigint,
  quoteNow: bigint,
): Promise<void> {
  const intentId = payment.stripe_payment_intent;
  if (!intentId) {
    throw new Error(`payment ${payment.id}: cannot refund -- no stripe_payment_intent recorded`);
  }

  console.warn(
    `payment ${payment.id}: quote drifted from ${quoteAtCheckout} to ${quoteNow} -- refunding`,
  );
  await deps.stripe.refunds.create(
    { payment_intent: intentId },
    { idempotencyKey: `refund:${payment.id}` },
  );
  await transition(deps.pool, payment.id, ["paying"], "refunded");
}

/**
 * Draws this payment's USDC (donation + premium) out of the instant pool,
 * at most once across every attempt.
 *
 * Three layers, because a draw is real money moving between two durable
 * states: `pool_draw_tx` records a completed draw (checked first, written
 * immediately after the transfer and before anything else can fail, so a
 * reverting `processPayment` retried to exhaustion draws once, not once per
 * attempt); and on a resumed attempt the worker's own USDC balance is checked
 * too, which covers the one window `pool_draw_tx` can't -- a crash between the
 * transfer landing and the row being written.
 *
 * The balance check is deliberately resume-only. The draw happens after the
 * `paying` gate, so no first attempt can have drawn anything, and on a first
 * attempt a healthy resting balance (default-rail USDC awaiting its own sends)
 * would otherwise silently pay a pool-funded payment out of settlement funds.
 *
 * Reserving the same `amount + premium` in checkout's headroom is what keeps
 * the pool from being over-committed -- see `instantPoolHeadroomWei` in
 * `src/stripe/checkout.ts`; the two must always move together.
 */
async function drawFromInstantPool(
  deps: PayDeps,
  payment: PaymentRow,
  totalWei: bigint,
  resuming: boolean,
): Promise<void> {
  if (payment.pool_draw_tx) return;

  if (resuming && (await deps.chain.workerUsdcBalance()) >= totalWei) {
    console.warn(
      `payment ${payment.id}: worker already holds ${totalWei} USDC base units, skipping the pool draw`,
    );
    return;
  }

  const txHash = await deps.chain.drawFromInstantPool(totalWei);
  await deps.pool.query(
    "UPDATE payments SET pool_draw_tx = $2, updated_at = now() WHERE id = $1",
    [payment.id, txHash],
  );
}

/**
 * True when Stripe has already refunded this payment.
 *
 * Probed before a resumed attempt re-quotes: an attempt that crashed between
 * issuing a drift refund and recording it leaves a payment in `paying` whose
 * money is already back with the payer, and a fresh quote that has since
 * recovered would otherwise pay for it on-chain anyway.
 */
async function alreadyRefunded(deps: PayDeps, payment: PaymentRow): Promise<boolean> {
  const intentId = payment.stripe_payment_intent;
  if (!intentId) return false;
  const refunds = await deps.stripe.refunds.list({ payment_intent: intentId, limit: 1 });
  return refunds.data.length > 0;
}

/**
 * The one commit that ends a successful pay: record what the escrow holds and
 * schedule everything that follows from it, in a single transaction. Split
 * across transactions, a crash in the middle would leave a `held` payment with
 * no unlock ever scheduled -- and the state machine would never route back
 * here to fix it.
 */
async function commitHeld(
  deps: PayDeps,
  payment: PaymentRow,
  tokensHeld: bigint,
  payTx: Hex | undefined,
): Promise<void> {
  const patch: PaymentPatch = { tokens_held: tokensHeld.toString() };
  // Absent only when resuming a crashed attempt: the entry proves the send
  // landed, but its tx hash died with the process.
  if (payTx) patch.pay_tx = payTx;

  await withTransaction(deps.pool, async (db) => {
    await transition(db, payment.id, ["paying"], "held", patch);

    const payload: UnlockNoteJobPayload = { paymentId: payment.id };
    await enqueue(db, "unlock-note", payload, {
      runAt: payment.unlock_at ?? undefined,
      dedupeKey: `unlock:${payment.id}`,
    });

    const receipt: ReceiptEmailJobPayload = { paymentId: payment.id };
    await enqueue(db, "receipt-email", receipt, { dedupeKey: `receipt:${payment.id}` });
  });
}

/**
 * Turns one settled Stripe payment into one on-chain `pay()` through the
 * escrow -- at most once, ever.
 *
 * The guarantee is two-layered. The `paid -> paying` transition is a
 * single-row compare-and-set, so only one runner may ever start a send; and
 * anything that resumes an interrupted `paying` consults the escrow's own
 * `entries` mapping before sending, so a process that died between the
 * transaction and the bookkeeping resumes into the bookkeeping rather than
 * paying twice. The contract's `EntryExists` check backstops both.
 */
export async function handlePay(deps: PayDeps, job: JobRow): Promise<void> {
  const paymentId = payloadPaymentId(job);
  const payment = await loadPayment(deps.pool, paymentId);

  if (!payment) {
    // Nothing to pay and nothing a retry could fix.
    console.warn(`pay job ${job.id}: payment ${paymentId} not found -- dropping`);
    return;
  }

  // 'settled' is the same pre-pay position as 'paid' (Stripe's money has
  // landed) and must be payable from here: treating it as terminal would
  // complete the job, burn the `pay:<id>` dedupe key, and leave the payment
  // with nothing scheduled to ever pay it.
  //
  // Anything else is finished or retired: a dispute canceled it, a refund
  // landed, or another attempt already escrowed it. Retrying would never
  // change that, so the job is done.
  const payable: PaymentState[] = ["paid", "settled"];
  if (!payable.includes(payment.state) && payment.state !== "paying") {
    console.warn(`payment ${payment.id}: state is '${payment.state}', nothing to pay`);
    return;
  }

  const project = await loadProject(deps.pool, payment.project_id);
  const terminal = requireAddress(project.terminal_address, `project ${project.project_id} terminal`);
  const projectToken = requireAddress(project.token_address, `project ${project.project_id} token`);
  const beneficiary = requireAddress(payment.claim_address, `payment ${payment.id} claim_address`);
  if (!payment.unlock_at) {
    throw new Error(`payment ${payment.id}: no unlock_at recorded, refusing to escrow`);
  }
  const unlockAt = Math.floor(payment.unlock_at.getTime() / 1000);

  const escrowPaymentId = paymentIdBytes32(payment.id);
  const amountWei = BigInt(payment.amount_usd_cents) * USDC_WEI_PER_CENT;
  const premiumWei = BigInt(payment.premium_usd_cents) * USDC_WEI_PER_CENT;

  // Resolved up front, before anything moves: a bad environment must fail
  // while the payment is still untouched, not after the donation leg has
  // landed and a misconfigured fee leg is all that stands between the payer
  // and their escrowed tokens.
  deps.chain.assertConfigured({ instant: payment.instant });
  const processor = payment.instant && premiumWei > 0n ? processorProject() : null;

  let resuming = payment.state === "paying";

  if (!resuming) {
    // Instant is fronted by the pool, so there's nothing of Stripe's to wait for.
    if (!payment.instant) await requireStripeMoneyAvailable(deps, payment);

    try {
      await transition(deps.pool, payment.id, payable, "paying");
    } catch (err) {
      if (!(err instanceof TransitionError)) throw err;
      // The row moved under us between the load and the gate -- a dispute or a
      // failed async debit canceling it is the expected cause, and the job is
      // done. The one state worth continuing from is 'paying'.
      const current = await loadPayment(deps.pool, payment.id);
      if (current?.state !== "paying") {
        console.warn(
          `payment ${payment.id}: state changed to '${current?.state}' before the pay gate -- not paying`,
        );
        return;
      }
      resuming = true;
    }
  }

  // Only a resumed attempt can have an entry: a fresh one just won the gate.
  const alreadyHeld = resuming ? await deps.chain.entryTokensHeld(escrowPaymentId) : null;

  let tokensHeld: bigint;
  let payTx: Hex | undefined;

  if (alreadyHeld === null) {
    // Nothing is on-chain, so a resumed attempt might be resuming a refund
    // rather than a send. Ask Stripe before quoting anything.
    if (resuming && (await alreadyRefunded(deps, payment))) {
      console.warn(`payment ${payment.id}: already refunded at Stripe -- recording, not paying`);
      await transition(deps.pool, payment.id, ["paying"], "refunded");
      return;
    }

    const quoteNow = await deps.chain.quoteTokens({
      terminal,
      projectId: BigInt(payment.project_id),
      usdcAmountWei: amountWei,
    });

    // The payer was quoted a number of tokens at checkout; if the project's
    // issuance has moved against them by more than the tolerance, they get
    // their money back rather than a materially different deal.
    if (payment.quote_tokens !== null) {
      const quoteAtCheckout = BigInt(payment.quote_tokens);
      if (driftExceeded(quoteAtCheckout, quoteNow)) {
        await refundForDrift(deps, payment, quoteAtCheckout, quoteNow);
        return;
      }
    }

    // After the drift gate, never before it: drawing and then refunding would
    // strand pool USDC in the worker wallet with no payment left to spend it
    // on. Nothing between here and the send needs the funds.
    if (payment.instant) {
      await drawFromInstantPool(deps, payment, amountWei + premiumWei, resuming);
    }

    const result = await deps.chain.processPayment({
      paymentId: escrowPaymentId,
      terminal,
      projectId: BigInt(payment.project_id),
      usdcAmountWei: amountWei,
      // The floor rides the *fresh* quote, so the tolerance covers only the
      // drift still possible between this simulation and inclusion.
      minReturnedTokens: minTokensForQuote(quoteNow),
      projectToken,
      beneficiary,
      unlockAt,
      memo: payment.id,
    });
    tokensHeld = result.tokensHeld;
    payTx = result.txHash;
  } else {
    tokensHeld = alreadyHeld;
  }

  // Fee leg last, so a failure here retries into the branch above finding the
  // donation entry already on-chain and skipping it.
  if (processor) {
    await payPremiumLeg(deps, processor, {
      escrowPaymentId,
      premiumWei,
      beneficiary,
      unlockAt,
      memo: payment.id,
      // Only a resumed attempt that skipped the donation leg can already have
      // sent the fee leg -- the ordering above rules out every other case.
      checkExisting: alreadyHeld !== null,
    });
  }

  await commitHeld(deps, payment, tokensHeld, payTx);
}

interface PremiumLegParams {
  escrowPaymentId: Hex;
  premiumWei: bigint;
  beneficiary: Address;
  unlockAt: number;
  memo: string;
  checkExisting: boolean;
}

/**
 * Pays the instant premium into the processor's own project as a second escrow
 * entry, keyed by `feePaymentId` so it never collides with the donation's.
 *
 * `minReturnedTokens` is 0: this leg buys the processor its own tokens with
 * its own fee, so there's no payer to protect from slippage, and a revert here
 * would strand a donation that already succeeded.
 */
async function payPremiumLeg(
  deps: PayDeps,
  processor: ProcessorProject,
  params: PremiumLegParams,
): Promise<void> {
  const feeId = feePaymentId(params.escrowPaymentId);
  if (params.checkExisting && (await deps.chain.entryTokensHeld(feeId)) !== null) return;

  await deps.chain.processPayment({
    paymentId: feeId,
    terminal: processor.terminal,
    projectId: processor.projectId,
    usdcAmountWei: params.premiumWei,
    minReturnedTokens: 0n,
    projectToken: processor.token,
    beneficiary: params.beneficiary,
    unlockAt: params.unlockAt,
    memo: `${params.memo} premium`,
  });
}
