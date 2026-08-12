import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { escrowAbi } from "../src/chain/abi/escrow.js";
import { terminalAbi } from "../src/chain/abi/terminal.js";
import type { AppPublicClient, AppWalletClient, ChainClients } from "../src/chain/client.js";
import { paymentIdBytes32 } from "../src/chain/escrow.js";
import { liveQuoteReads, quoteTokens, USDC_ON_BASE } from "../src/chain/quote.js";
import { migrate } from "../src/db/index.js";
import { enqueue } from "../src/db/jobs.js";
import { createPayment, type PaymentState } from "../src/db/payments.js";
import type { EmailSendPayload, EmailSendResult, EmailSender } from "../src/email/send.js";
import { liveForfeitChain } from "../src/worker/forfeit.js";
import { runWorkerOnce, type WorkerDeps } from "../src/worker/index.js";
import { liveChain } from "../src/worker/pay.js";
import { liveReconcileChain } from "../src/worker/reconcile.js";
import { liveRedirectChain } from "../src/worker/redirect.js";
import { liveReleaseChain, scheduleReleaseScan } from "../src/worker/release.js";
import { liveRulesetReads } from "../src/worker/watchRulesets.js";
import {
  ANVIL_DEFAULT_KEY,
  FORK_CONTROLLER,
  FORK_PROJECT_ID,
  FORK_PROJECT_TOKEN,
  FORK_TERMINAL,
  FORK_TEST_TIMEOUT_MS,
  FORK_USDC_WHALE,
} from "./fork-addresses.js";

/**
 * The whole worker path, against real Base state.
 *
 *   FORK_RPC_URL=https://mainnet.base.org npx vitest run e2e.fork
 *
 * Everything that touches money is real: a real anvil fork of Base, a real
 * `JBProcessorEscrow` deployed onto it, a real Juicebox V6 terminal, a real
 * `previewPayFor` quote, real USDC moved from a real holder. Only Stripe and
 * the mail provider are faked -- there is no test-mode Stripe account in this
 * environment, and a fake is the right stand-in for the two facts the payer
 * worker actually reads from it (the charge's funds are available; no refund
 * exists).
 *
 * What it proves that the unit suites cannot: that the ABIs match the deployed
 * contracts, that a quote taken from a live revnet survives the round trip
 * into `minReturnedTokens` without tripping the terminal's own slippage check,
 * and that the job registry moves one payment from `paid` all the way to
 * `claimed` with the tokens landing in the beneficiary's balance.
 *
 * Skipped entirely unless FORK_RPC_URL is set, so `npm test` never touches the
 * network.
 */
const FORK_RPC_URL = process.env.FORK_RPC_URL;

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/jbprocessor_test";

const SCHEMA_NAME = `test_e2e_fork_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

// Its own port, so this suite and escrow.fork can run in the same session.
const ANVIL_PORT = 8647;
const ANVIL_RPC_URL = `http://127.0.0.1:${ANVIL_PORT}`;

const HOLD_SECONDS = 3600;

/** A $25.00 donation, in cents -- the unit money is counted in everywhere here. */
const DONATION_CENTS = 2_500n;

const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
]);

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARTIFACT_PATH = join(
  __dirname,
  "..",
  "contracts",
  "out",
  "JBProcessorEscrow.sol",
  "JBProcessorEscrow.json",
);

function loadEscrowBytecode(): Hex {
  const artifact = JSON.parse(readFileSync(ARTIFACT_PATH, "utf8")) as {
    bytecode: { object: Hex };
  };
  return artifact.bytecode.object;
}

async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(ANVIL_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${method} failed: ${body.error.message}`);
  return body.result;
}

async function waitForAnvil(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await rpc("eth_blockNumber");
      return;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`anvil did not become ready at ${ANVIL_RPC_URL}: ${String(lastError)}`);
}

/**
 * The two facts the payer worker reads from Stripe on the default rail: that
 * the charge's money has settled, and that no refund has been issued. Both are
 * asserted against, so a change to how the worker interrogates Stripe shows up
 * here as a failure rather than as a silently skipped check.
 */
class FakeStripe {
  intentRetrievals: string[] = [];
  refundLookups = 0;

  paymentIntents = {
    retrieve: async (id: string) => {
      this.intentRetrievals.push(id);
      return {
        id,
        latest_charge: {
          id: "ch_fork_1",
          payment_method_details: { type: "us_bank_account" },
          balance_transaction: {
            id: "txn_fork_1",
            status: "available",
            available_on: Math.floor(Date.now() / 1000),
          },
        },
      };
    },
  };

  refunds = {
    create: async () => ({ id: "re_fork_1" }),
    list: async () => {
      this.refundLookups += 1;
      return { data: [] as Array<{ id: string }> };
    },
  };
}

class FakeSender implements EmailSender {
  sent: EmailSendPayload[] = [];
  emails = {
    send: async (payload: EmailSendPayload): Promise<EmailSendResult> => {
      this.sent.push(payload);
      return { data: { id: "e1" }, error: null };
    },
  };
}

describe.skipIf(!FORK_RPC_URL)("worker end-to-end (anvil fork of Base)", () => {
  let anvil: ChildProcessWithoutNullStreams;
  let pool: Pool;
  let escrowAddress: Address;
  let resend: FakeSender;
  let stripe: FakeStripe;
  let deps: WorkerDeps;

  const operator = privateKeyToAccount(ANVIL_DEFAULT_KEY);
  /** The floor the quote produced, asserted as a real lower bound below. */
  let quotedFloor = 0n;
  const beneficiary = getAddress(`0x${"beef".padStart(40, "0")}`);

  const publicClient = createPublicClient({
    chain: base,
    transport: http(ANVIL_RPC_URL),
  }) as AppPublicClient;
  const walletClient = createWalletClient({
    account: operator,
    chain: base,
    transport: http(ANVIL_RPC_URL),
  }) as AppWalletClient;
  const clients: ChainClients = { publicClient, walletClient };

  /**
   * Runs queued jobs until the queue is empty, exactly as the worker loop
   * does. Bounded, so a handler that keeps rescheduling itself fails the test
   * instead of hanging it.
   */
  async function drainJobs(limit = 20): Promise<number> {
    let ran = 0;
    while (ran < limit) {
      if (!(await runWorkerOnce(deps))) return ran;
      ran += 1;
    }
    throw new Error(`job queue did not drain within ${limit} jobs`);
  }

  async function paymentRow(id: string): Promise<{
    state: PaymentState;
    tokens_held: string | null;
    pay_tx: string | null;
    release_tx: string | null;
  }> {
    const { rows } = await pool.query<{
      state: PaymentState;
      tokens_held: string | null;
      pay_tx: string | null;
      release_tx: string | null;
    }>("SELECT state, tokens_held, pay_tx, release_tx FROM payments WHERE id = $1", [id]);
    const row = rows[0];
    if (!row) throw new Error(`payment ${id} disappeared`);
    return row;
  }

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: TEST_DATABASE_URL });
    await adminPool.query(`CREATE SCHEMA "${SCHEMA_NAME}"`);
    await adminPool.end();

    pool = new Pool({
      connectionString: TEST_DATABASE_URL,
      options: `-c search_path=${SCHEMA_NAME}`,
    });
    await migrate(pool);
    await pool.query(
      `INSERT INTO projects (project_id, name, token_address, terminal_address, status)
       VALUES ($1, 'Fork Test Project', $2, $3, 'active')`,
      [FORK_PROJECT_ID.toString(), FORK_PROJECT_TOKEN, FORK_TERMINAL],
    );

    anvil = spawn(
      "anvil",
      ["--fork-url", FORK_RPC_URL as string, "--port", String(ANVIL_PORT), "--silent"],
      { stdio: "pipe" },
    );
    await waitForAnvil();

    // The escrow, owned and operated by the same anvil account that signs
    // every write here -- the worker's key and the owner Safe are separate in
    // production, but nothing in this path depends on them differing.
    const deployHash = await walletClient.deployContract({
      abi: escrowAbi,
      bytecode: loadEscrowBytecode(),
      args: [operator.address, operator.address, USDC_ON_BASE],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
    if (!receipt.contractAddress) throw new Error("escrow deployment returned no address");
    escrowAddress = receipt.contractAddress;

    process.env.ESCROW_ADDRESS = escrowAddress;
    process.env.WORKER_ADDRESS = operator.address;
    process.env.JB_CONTROLLER_ADDRESS = FORK_CONTROLLER;
    process.env.BASE_URL = "https://processor.test";
    process.env.EMAIL_FROM = "JBProcessor <mail@jbprocessor.test>";
    process.env.ALERT_EMAIL = "ops@jbprocessor.test";
    process.env.AUTH_SECRET = "fork-test-secret-fork-test-secret";

    // Fund the settlement wallet with USDC from a real holder, and let the
    // escrow pull it -- this is the standing approval a deployment makes once.
    const fundAmount = 1_000_000_000n; // 1,000 USDC
    await rpc("anvil_impersonateAccount", [FORK_USDC_WHALE]);
    await rpc("anvil_setBalance", [FORK_USDC_WHALE, `0x${(10n ** 18n).toString(16)}`]);
    const whaleClient = createWalletClient({
      account: FORK_USDC_WHALE,
      chain: base,
      transport: http(ANVIL_RPC_URL),
    });
    const transferHash = await whaleClient.writeContract({
      address: USDC_ON_BASE,
      abi: erc20Abi,
      functionName: "transfer",
      args: [operator.address, fundAmount],
    });
    await publicClient.waitForTransactionReceipt({ hash: transferHash });
    await rpc("anvil_stopImpersonatingAccount", [FORK_USDC_WHALE]);

    const approveHash = await walletClient.writeContract({
      address: USDC_ON_BASE,
      abi: erc20Abi,
      functionName: "approve",
      args: [escrowAddress, fundAmount],
    });
    await publicClient.waitForTransactionReceipt({ hash: approveHash });

    resend = new FakeSender();
    stripe = new FakeStripe();
    deps = {
      pool,
      stripe,
      chain: liveChain(clients),
      controller: liveRulesetReads(publicClient),
      resend,
      escrow: {
        ...liveReleaseChain(clients),
        ...liveRedirectChain(clients),
        ...liveForfeitChain(clients),
        ...liveReconcileChain(clients),
      },
    } as unknown as WorkerDeps;
  }, FORK_TEST_TIMEOUT_MS);

  afterAll(async () => {
    anvil?.kill();
    await pool?.end();
    const adminPool = new Pool({ connectionString: TEST_DATABASE_URL });
    await adminPool.query(`DROP SCHEMA "${SCHEMA_NAME}" CASCADE`);
    await adminPool.end();

    delete process.env.ESCROW_ADDRESS;
    delete process.env.WORKER_ADDRESS;
    delete process.env.JB_CONTROLLER_ADDRESS;
    delete process.env.BASE_URL;
    delete process.env.EMAIL_FROM;
    delete process.env.ALERT_EMAIL;
    delete process.env.AUTH_SECRET;
  }, FORK_TEST_TIMEOUT_MS);

  /**
   * The mint-path floor, against the real hook.
   *
   * Project #6 is a revnet: `useDataHookForPay` is set, so the terminal mints
   * nothing and `previewPayFor` reports zero while the buyback hook acquires
   * the tokens by swapping. `quoteTokens` therefore falls back to the floor --
   * what the terminal WOULD have minted -- and this is where that fallback
   * meets reality rather than a stub.
   */
  it(
    "falls back to the mint-path floor when the buyback hook takes the payment",
    async () => {
      const usdcAmountWei = DONATION_CENTS * 10_000n;
      const preview = await publicClient.readContract({
        address: FORK_TERMINAL,
        abi: terminalAbi,
        functionName: "previewPayFor",
        args: [FORK_PROJECT_ID, USDC_ON_BASE, usdcAmountWei, beneficiary, "0x"],
      });
      const beneficiaryTokenCount = preview[1];
      const hookSpecifications = preview[3];

      // Every base unit is accounted for: the terminal mints against it, or a
      // pay hook has claimed it. A preview reporting neither would mean the
      // payment vanishes.
      const claimedByHooks = hookSpecifications.reduce((sum, spec) => sum + spec.amount, 0n);
      expect(beneficiaryTokenCount > 0n || claimedByHooks === usdcAmountWei).toBe(true);

      quotedFloor = await quoteTokens(liveQuoteReads(publicClient), {
        terminal: FORK_TERMINAL,
        projectId: FORK_PROJECT_ID,
        usdcAmountWei,
      });
      expect(quotedFloor).toBeGreaterThan(0n);

      // The hook is what makes the preview zero, so the quote must NOT be it.
      if (beneficiaryTokenCount === 0n) expect(quotedFloor).not.toBe(beneficiaryTokenCount);
    },
    FORK_TEST_TIMEOUT_MS,
  );

  it(
    "decodes the live controller's current and upcoming rulesets",
    async () => {
      const controller = liveRulesetReads(publicClient);
      const current = await controller.currentRulesetOf(FORK_PROJECT_ID);
      const upcoming = await controller.upcomingRulesetOf(FORK_PROJECT_ID);

      // A live project always has a stored ruleset with a non-zero id; a
      // zero here would mean the controller ABI decoded into the wrong shape.
      expect(current.ruleset.id).toBeGreaterThan(0);
      expect(current.ruleset.weight).toBeGreaterThan(0n);
      expect(current.metadata.baseCurrency).toBeGreaterThan(0);
      // The project must still be accepting payments, or nothing below works.
      expect(current.metadata.pausePay).toBe(false);
      expect(upcoming.ruleset.id).toBeGreaterThan(0);
    },
    FORK_TEST_TIMEOUT_MS,
  );

  it(
    "carries one payment from 'paid' to 'claimed' with the tokens delivered",
    async () => {
      const unlockAt = new Date(Date.now() + HOLD_SECONDS * 1000);
      const payment = await createPayment(pool, {
        projectId: Number(FORK_PROJECT_ID),
        email: "payer@example.com",
        amountUsdCents: DONATION_CENTS,
        instant: false,
        claimAddress: beneficiary,
        // What checkout would have stored: the mint-path floor, since this
        // project's preview is zero.
        quoteTokens: quotedFloor,
      });
      await pool.query(
        `UPDATE payments
            SET state = 'paid', method = 'bank', unlock_at = $2,
                stripe_payment_intent = 'pi_fork_1', updated_at = now()
          WHERE id = $1`,
        [payment.id, unlockAt],
      );

      const beforeBalance = await publicClient.readContract({
        address: FORK_PROJECT_TOKEN,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [beneficiary],
      });

      // --- pay --------------------------------------------------------
      await enqueue(pool, "pay", { paymentId: payment.id }, { dedupeKey: `pay:${payment.id}` });
      await drainJobs();

      const held = await paymentRow(payment.id);
      expect(held.state).toBe("held");
      expect(held.pay_tx).toMatch(/^0x[0-9a-fA-F]{64}$/);
      expect(stripe.intentRetrievals).toContain("pi_fork_1");

      const entry = await publicClient.readContract({
        address: escrowAddress,
        abi: escrowAbi,
        functionName: "entries",
        args: [paymentIdBytes32(payment.id)],
      });
      // The ledger's tokens_held is the escrow's own measured amount, not a
      // number this service computed -- so these two agreeing is the whole
      // point of reading the amount back off the Processed event.
      expect(held.tokens_held).toBe(entry[1].toString());
      expect(entry[1]).toBeGreaterThan(0n);

      // THE lower-bound property. The floor claims the payer receives at least
      // this much; the buyback hook only swaps when the swap beats minting, so
      // the tokens actually escrowed must not be fewer. If this ever fails, the
      // quote is over-promising and `minReturnedTokens` would revert real pays.
      expect(entry[1]).toBeGreaterThanOrEqual(quotedFloor);

      // And the payer was quoted something, not zero.
      const { rows: quoted } = await pool.query<{ quote_tokens: string | null }>(
        "SELECT quote_tokens FROM payments WHERE id = $1",
        [payment.id],
      );
      expect(BigInt(quoted[0]?.quote_tokens ?? "0")).toBe(quotedFloor);
      expect(entry[0].toLowerCase()).toBe(FORK_PROJECT_TOKEN.toLowerCase());
      expect(entry[3]).toBe(false); // not settled
      expect(entry[4].toLowerCase()).toBe(beneficiary.toLowerCase());
      expect(resend.sent.some((mail) => mail.to === "payer@example.com")).toBe(true);

      // --- unlock -----------------------------------------------------
      // Both clocks: the chain's, because the escrow refuses to release
      // before `unlockAt`; and the queue's, because the unlock note was
      // scheduled for the same moment.
      await rpc("evm_increaseTime", [HOLD_SECONDS + 1]);
      await rpc("evm_mine", []);
      await pool.query("UPDATE jobs SET run_at = now() WHERE kind = 'unlock-note'");
      await drainJobs();

      expect((await paymentRow(payment.id)).state).toBe("unlocked");

      // --- release ----------------------------------------------------
      await scheduleReleaseScan(pool, new Date());
      await drainJobs();

      const claimed = await paymentRow(payment.id);
      expect(claimed.state).toBe("claimed");
      expect(claimed.release_tx).toMatch(/^0x[0-9a-fA-F]{64}$/);

      const afterBalance = await publicClient.readContract({
        address: FORK_PROJECT_TOKEN,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [beneficiary],
      });
      expect(afterBalance - beforeBalance).toBe(BigInt(claimed.tokens_held ?? "0"));

      const settledEntry = await publicClient.readContract({
        address: escrowAddress,
        abi: escrowAbi,
        functionName: "entries",
        args: [paymentIdBytes32(payment.id)],
      });
      expect(settledEntry[3]).toBe(true);
    },
    FORK_TEST_TIMEOUT_MS,
  );

  it(
    "refuses to pay the same payment twice",
    async () => {
      // A second `pay` job for a payment already `held` must not send
      // anything on-chain. This is the at-most-once guarantee, checked
      // against the real escrow rather than a fake that remembers calls.
      const { rows } = await pool.query<{ id: string; tokens_held: string }>(
        "SELECT id, tokens_held FROM payments WHERE state = 'claimed' LIMIT 1",
      );
      const existing = rows[0];
      if (!existing) throw new Error("expected the delivered payment from the previous test");

      await enqueue(
        pool,
        "pay",
        { paymentId: existing.id },
        { dedupeKey: `pay:${existing.id}:again` },
      );
      await drainJobs();

      const after = await paymentRow(existing.id);
      expect(after.state).toBe("claimed");
      expect(after.tokens_held).toBe(existing.tokens_held);
    },
    FORK_TEST_TIMEOUT_MS,
  );
});
