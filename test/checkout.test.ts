import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type Stripe from "stripe";
import { migrate } from "../src/db/index.js";
import { createCheckoutSession, CheckoutError } from "../src/stripe/checkout.js";
import type { CheckoutDeps } from "../src/stripe/checkout.js";
import type { QuoteTokensParams } from "../src/chain/quote.js";
import type { WalletProvider } from "../src/wallets/types.js";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/jbprocessor_test";

const SCHEMA_NAME = `test_checkout_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

const PROJECT_ID = 7;
const SUSPENDED_PROJECT_ID = 8;
const TERMINAL = "0x0000000000000000000000000000000000feed01" as `0x${string}`;
const TOKEN = "0x0000000000000000000000000000000000000abc" as `0x${string}`;
const POOL_ADDRESS = "0x1111111111111111111111111111111111111111";
const WORKER = "0x2222222222222222222222222222222222222222";
const PREGEN_WALLET = "0x3333333333333333333333333333333333333333" as `0x${string}`;

let pool: Pool;

/** Records every session.create call so assertions can inspect the params. */
class StripeStub {
  calls: Stripe.Checkout.SessionCreateParams[] = [];
  nextUrl = "https://checkout.stripe.com/c/pay/cs_test_1";
  /** Session ids are unique in `payments`, so each call gets its own. */
  nextId: string | null = null;
  checkout = {
    sessions: {
      create: async (params: Stripe.Checkout.SessionCreateParams) => {
        this.calls.push(params);
        return {
          id: this.nextId ?? `cs_test_${this.calls.length}`,
          url: this.nextUrl,
        };
      },
    },
  };
  get lastCall(): Stripe.Checkout.SessionCreateParams {
    const call = this.calls[this.calls.length - 1];
    if (!call) throw new Error("no session.create call recorded");
    return call;
  }
}

class WalletStub implements WalletProvider {
  calls: string[] = [];
  async getOrCreatePregenWallet(email: string): Promise<`0x${string}`> {
    this.calls.push(email);
    return PREGEN_WALLET;
  }
}

const QUOTE_TOKENS = 4242n * 10n ** 18n;

/** Captures the params checkout hands the quote. */
function quoteReadsStub(beneficiaryTokenCount = QUOTE_TOKENS) {
  const calls: QuoteTokensParams[] = [];
  return {
    calls,
    previewPayFor: async (params: QuoteTokensParams) => {
      calls.push(params);
      return {
        weight: 0n,
        rulesetMetadata: 0n,
        beneficiaryTokenCount,
        hookAmounts: [] as bigint[],
      };
    },
    pricePerUnit: async () => 1_000_000n,
  };
}

interface TestDeps extends CheckoutDeps {
  stripe: StripeStub;
  wallets: WalletStub;
  /** `payment_method_types` of the most recent session.create call. */
  lastCallMethods(): string[] | undefined;
  /** The single line item's `unit_amount`, in cents. */
  lastCallUnitAmount(): number | undefined;
}

function deps(overrides: Partial<CheckoutDeps> = {}): TestDeps {
  const stripe = new StripeStub();
  const wallets = new WalletStub();
  const base = {
    pool,
    stripe,
    wallets,
    quoteReads: quoteReadsStub() as unknown as CheckoutDeps["quoteReads"],
    readAllowance: async () => 1_000_000_000n,
    ...overrides,
  } as unknown as CheckoutDeps & { stripe: StripeStub; wallets: WalletStub };

  return {
    ...base,
    lastCallMethods: () => base.stripe.lastCall.payment_method_types,
    lastCallUnitAmount: () =>
      base.stripe.lastCall.line_items?.[0]?.price_data?.unit_amount,
  };
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
     VALUES ($1, 'Active Project', $2, $3, 'active'),
            ($4, 'Suspended Project', $2, $3, 'suspended')`,
    [PROJECT_ID, TOKEN, TERMINAL, SUSPENDED_PROJECT_ID],
  );
});

afterAll(async () => {
  await pool.end();
  const adminPool = new Pool({ connectionString: TEST_DATABASE_URL });
  await adminPool.query(`DROP SCHEMA "${SCHEMA_NAME}" CASCADE`);
  await adminPool.end();
});

beforeEach(async () => {
  process.env.BASE_URL = "https://processor.test";
  process.env.CARD_CEILING_USD_CENTS = "50000";
  process.env.PREMIUM_BPS = "150";
  process.env.INSTANT_POOL_ADDRESS = POOL_ADDRESS;
  process.env.WORKER_ADDRESS = WORKER;
  await pool.query("DELETE FROM payments");
});

afterEach(() => {
  delete process.env.BASE_URL;
  delete process.env.CARD_CEILING_USD_CENTS;
  delete process.env.PREMIUM_BPS;
  delete process.env.INSTANT_POOL_ADDRESS;
  delete process.env.WORKER_ADDRESS;
});

describe("createCheckoutSession -- rejections", () => {
  it("rejects an unknown project without creating a payment row", async () => {
    const d = deps();
    await expect(
      createCheckoutSession(d, {
        projectId: 999,
        amountUsdCents: 1000n,
        email: "a@example.com",
        instant: false,
      }),
    ).rejects.toMatchObject({ code: "unknown_project" });

    expect(d.stripe.calls).toHaveLength(0);
    const { rows } = await pool.query("SELECT * FROM payments");
    expect(rows).toHaveLength(0);
  });

  it("rejects a suspended project", async () => {
    const d = deps();
    await expect(
      createCheckoutSession(d, {
        projectId: SUSPENDED_PROJECT_ID,
        amountUsdCents: 1000n,
        email: "a@example.com",
        instant: false,
      }),
    ).rejects.toBeInstanceOf(CheckoutError);
    await expect(
      createCheckoutSession(d, {
        projectId: SUSPENDED_PROJECT_ID,
        amountUsdCents: 1000n,
        email: "a@example.com",
        instant: false,
      }),
    ).rejects.toMatchObject({ code: "project_suspended" });
    expect(d.stripe.calls).toHaveLength(0);
  });

  it("rejects a malformed wallet address", async () => {
    const d = deps();
    await expect(
      createCheckoutSession(d, {
        projectId: PROJECT_ID,
        amountUsdCents: 1000n,
        email: "a@example.com",
        instant: false,
        walletAddress: "0xnot-an-address",
      }),
    ).rejects.toMatchObject({ code: "invalid_wallet_address" });
  });

  it("leaves no orphan payment row when BASE_URL is missing", async () => {
    delete process.env.BASE_URL;
    const d = deps();
    await expect(
      createCheckoutSession(d, {
        projectId: PROJECT_ID,
        amountUsdCents: 5000n,
        email: "noenv@example.com",
        instant: false,
      }),
    ).rejects.toThrow(/BASE_URL/);

    // Every throw site sits before the insert, so a rejected request leaves
    // nothing behind for reconciliation to puzzle over.
    const { rows } = await pool.query("SELECT * FROM payments");
    expect(rows).toHaveLength(0);
    expect(d.stripe.calls).toHaveLength(0);
  });

  it("rejects a non-positive amount", async () => {
    const d = deps();
    await expect(
      createCheckoutSession(d, {
        projectId: PROJECT_ID,
        amountUsdCents: 0n,
        email: "a@example.com",
        instant: false,
      }),
    ).rejects.toMatchObject({ code: "invalid_amount" });
  });
});

describe("createCheckoutSession -- card ceiling", () => {
  it("offers card + bank under the ceiling, with 3DS forced on the card path", async () => {
    const d = deps();
    await createCheckoutSession(d, {
      projectId: PROJECT_ID,
      amountUsdCents: 50_000n,
      email: "under@example.com",
      instant: false,
    });

    expect(d.lastCallMethods()).toEqual(["card", "us_bank_account"]);
    expect(d.stripe.lastCall.payment_method_options?.card?.request_three_d_secure).toBe(
      "any",
    );
    expect(d.stripe.lastCall.mode).toBe("payment");
  });

  it("rejects the card path above the ceiling -- the session is bank-only", async () => {
    const d = deps();
    await createCheckoutSession(d, {
      projectId: PROJECT_ID,
      amountUsdCents: 50_001n,
      email: "over@example.com",
      instant: false,
    });

    expect(d.lastCallMethods()).toEqual(["us_bank_account"]);
    // No card in the session, so no card-specific options either.
    expect(d.stripe.lastCall.payment_method_options?.card).toBeUndefined();
  });

  it("honours a CARD_CEILING_USD_CENTS override", async () => {
    process.env.CARD_CEILING_USD_CENTS = "2000";
    const d = deps();
    await createCheckoutSession(d, {
      projectId: PROJECT_ID,
      amountUsdCents: 2001n,
      email: "custom@example.com",
      instant: false,
    });
    expect(d.lastCallMethods()).toEqual(["us_bank_account"]);
  });
});

describe("createCheckoutSession -- instant pool headroom", () => {
  it("rejects instant when the allowance minus in-flight instant payments is short", async () => {
    // 60 USDC of allowance, 50 USDC already in flight -> 10 USDC of headroom.
    await pool.query(
      `INSERT INTO payments (project_id, email, amount_usd_cents, instant, state)
       VALUES ($1, 'inflight@example.com', 5000, true, 'paid')`,
      [PROJECT_ID],
    );

    const d = deps({ readAllowance: async () => 60_000_000n });
    await expect(
      createCheckoutSession(d, {
        projectId: PROJECT_ID,
        amountUsdCents: 5000n,
        email: "instant@example.com",
        instant: true,
      }),
    ).rejects.toMatchObject({ code: "insufficient_pool_headroom" });
    expect(d.stripe.calls).toHaveLength(0);
  });

  it("allows instant when headroom exactly covers the amount", async () => {
    const d = deps({ readAllowance: async () => 50_000_000n });
    const result = await createCheckoutSession(d, {
      projectId: PROJECT_ID,
      amountUsdCents: 5000n,
      email: "exact@example.com",
      instant: true,
    });
    expect(result.url).toContain("checkout.stripe.com");
  });

  it("reserves the premium as well as the donation for in-flight instant payments", async () => {
    // The worker draws amount + premium out of the pool, so headroom has to
    // reserve both: 50.00 donation + 0.75 premium = 50.75 committed.
    await pool.query(
      `INSERT INTO payments (project_id, email, amount_usd_cents, premium_usd_cents, instant, state)
       VALUES ($1, 'premium-inflight@example.com', 5000, 75, true, 'paid')`,
      [PROJECT_ID],
    );

    // Exactly enough for the donation alone -- but not for what will be drawn.
    const d = deps({ readAllowance: async () => 100_750_000n - 1n });
    await expect(
      createCheckoutSession(d, {
        projectId: PROJECT_ID,
        amountUsdCents: 5000n,
        email: "second-instant@example.com",
        instant: true,
      }),
    ).rejects.toMatchObject({ code: "insufficient_pool_headroom" });
  });

  it("ignores terminal-state payments when summing in-flight instant volume", async () => {
    await pool.query(
      `INSERT INTO payments (project_id, email, amount_usd_cents, instant, state)
       VALUES ($1, 'done@example.com', 5000, true, 'claimed'),
              ($1, 'refund@example.com', 5000, true, 'refunded')`,
      [PROJECT_ID],
    );
    const d = deps({ readAllowance: async () => 50_000_000n });
    await expect(
      createCheckoutSession(d, {
        projectId: PROJECT_ID,
        amountUsdCents: 5000n,
        email: "fresh@example.com",
        instant: true,
      }),
    ).resolves.toMatchObject({ paymentId: expect.any(String) });
  });

  it("does not read the allowance at all for a default (non-instant) payment", async () => {
    let reads = 0;
    const d = deps({
      readAllowance: async () => {
        reads += 1;
        return 0n;
      },
    });
    await createCheckoutSession(d, {
      projectId: PROJECT_ID,
      amountUsdCents: 5000n,
      email: "default@example.com",
      instant: false,
    });
    expect(reads).toBe(0);
  });
});

describe("createCheckoutSession -- happy path", () => {
  it("stores the quote, session id and pregen claim address", async () => {
    const d = deps();
    const result = await createCheckoutSession(d, {
      projectId: PROJECT_ID,
      amountUsdCents: 5000n,
      email: "happy@example.com",
      instant: false,
    });

    expect(result.url).toBe("https://checkout.stripe.com/c/pay/cs_test_1");

    const { rows } = await pool.query<{
      id: string;
      quote_tokens: string;
      stripe_session_id: string;
      claim_address: string;
      state: string;
      instant: boolean;
      amount_usd_cents: string;
    }>("SELECT * FROM payments WHERE id = $1", [result.paymentId]);
    const row = rows[0];
    expect(row).toBeDefined();
    expect(row?.state).toBe("created");
    expect(row?.quote_tokens).toBe(QUOTE_TOKENS.toString());
    expect(row?.stripe_session_id).toBe("cs_test_1");
    expect(row?.claim_address).toBe(PREGEN_WALLET);
    expect(row?.amount_usd_cents).toBe("5000");

    // The pregen wallet is only minted for the payer's own email.
    expect(d.wallets.calls).toEqual(["happy@example.com"]);

    // metadata.payment_id is the only link Stripe carries back to us.
    expect(d.stripe.lastCall.metadata?.payment_id).toBe(result.paymentId);
    // Stripe sends the payer to the status page built on the public payment view.
    expect(d.stripe.lastCall.success_url).toBe(
      `https://processor.test/done?payment_id=${result.paymentId}`,
    );
    expect(d.stripe.lastCall.cancel_url).toContain("https://processor.test");
  });

  it("uses a supplied wallet address instead of minting a pregen wallet", async () => {
    const d = deps();
    const supplied = "0x4444444444444444444444444444444444444444";
    const result = await createCheckoutSession(d, {
      projectId: PROJECT_ID,
      amountUsdCents: 5000n,
      email: "byo@example.com",
      instant: false,
      walletAddress: supplied,
    });

    expect(d.wallets.calls).toEqual([]);
    const { rows } = await pool.query<{ claim_address: string }>(
      "SELECT claim_address FROM payments WHERE id = $1",
      [result.paymentId],
    );
    expect(rows[0]?.claim_address?.toLowerCase()).toBe(supplied.toLowerCase());
  });

  it("quotes against the project's terminal with cents converted to 6-decimal USDC wei", async () => {
    const quote = quoteReadsStub();
    const d = deps({ quoteReads: quote as unknown as CheckoutDeps["quoteReads"] });
    await createCheckoutSession(d, {
      projectId: PROJECT_ID,
      amountUsdCents: 5000n,
      email: "quote@example.com",
      instant: false,
    });

    // $50.00 -> 50_000000 (USDC is 6-decimal), never 50e18.
    expect(quote.calls).toHaveLength(1);
    expect(quote.calls[0]?.projectId).toBe(BigInt(PROJECT_ID));
    expect(quote.calls[0]?.usdcAmountWei).toBe(50_000_000n);
  });

  it("refuses a project that previews zero tokens", async () => {
    // Neither the terminal's preview nor the mint-path floor could say what
    // the donation buys. Selling it would mean quoting the payer nothing, a
    // drift gate comparing zero against zero, and a send with no slippage
    // floor -- so it is refused before any row is written.
    const d = deps({
      quoteReads: quoteReadsStub(0n) as unknown as CheckoutDeps["quoteReads"],
    });

    await expect(
      createCheckoutSession(d, {
        projectId: PROJECT_ID,
        amountUsdCents: 5000n,
        email: "unquotable@example.com",
        instant: false,
      }),
    ).rejects.toMatchObject({ code: "project_unquotable" });

    expect(d.stripe.calls).toHaveLength(0);
    const { rows } = await pool.query("SELECT 1 FROM payments WHERE email = $1", [
      "unquotable@example.com",
    ]);
    expect(rows).toHaveLength(0);
  });

  it("charges the donation only for a default payment", async () => {
    const d = deps();
    await createCheckoutSession(d, {
      projectId: PROJECT_ID,
      amountUsdCents: 5000n,
      email: "nopremium@example.com",
      instant: false,
    });
    expect(d.lastCallUnitAmount()).toBe(5000);
  });

  it("adds the instant premium to the charged amount but not to the quoted donation", async () => {
    const quote = quoteReadsStub();
    const d = deps({
      quoteReads: quote as unknown as CheckoutDeps["quoteReads"],
      readAllowance: async () => 1_000_000_000n,
    });
    await createCheckoutSession(d, {
      projectId: PROJECT_ID,
      amountUsdCents: 5000n,
      email: "premium@example.com",
      instant: true,
    });

    // 5000 cents * 150bps = 75 cents of premium.
    expect(d.lastCallUnitAmount()).toBe(5075);
    // The premium is a service fee -- the donation quoted (and later paid
    // on-chain) is still the donation amount.
    expect(quote.calls[0]?.usdcAmountWei).toBe(50_000_000n);
  });

  it("persists the premium so reconciliation never re-derives it from PREMIUM_BPS", async () => {
    const d = deps();
    const instantResult = await createCheckoutSession(d, {
      projectId: PROJECT_ID,
      amountUsdCents: 5000n,
      email: "stored-premium@example.com",
      instant: true,
    });
    const defaultResult = await createCheckoutSession(d, {
      projectId: PROJECT_ID,
      amountUsdCents: 5000n,
      email: "stored-nopremium@example.com",
      instant: false,
    });

    const { rows } = await pool.query<{ id: string; premium_usd_cents: string }>(
      "SELECT id, premium_usd_cents FROM payments WHERE id = ANY($1)",
      [[instantResult.paymentId, defaultResult.paymentId]],
    );
    const byId = new Map(rows.map((row) => [row.id, row.premium_usd_cents]));
    expect(byId.get(instantResult.paymentId)).toBe("75");
    expect(byId.get(defaultResult.paymentId)).toBe("0");
  });

  it("does not store a session id for a session Stripe returned without a URL", async () => {
    const d = deps();
    d.stripe.nextUrl = null as unknown as string;

    await expect(
      createCheckoutSession(d, {
        projectId: PROJECT_ID,
        amountUsdCents: 5000n,
        email: "nourl@example.com",
        instant: false,
      }),
    ).rejects.toMatchObject({ code: "stripe_session_missing_url" });

    const { rows } = await pool.query<{ stripe_session_id: string | null }>(
      "SELECT stripe_session_id FROM payments WHERE email = 'nourl@example.com'",
    );
    expect(rows[0]?.stripe_session_id).toBeNull();
  });

  it("rounds the premium down (integer cents, never float math)", async () => {
    process.env.PREMIUM_BPS = "150";
    const d = deps();
    // 333 cents * 150 / 10000 = 4.995 -> 4 cents.
    await createCheckoutSession(d, {
      projectId: PROJECT_ID,
      amountUsdCents: 333n,
      email: "round@example.com",
      instant: true,
    });
    expect(d.lastCallUnitAmount()).toBe(337);
  });
});
