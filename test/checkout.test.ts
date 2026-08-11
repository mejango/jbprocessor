import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type Stripe from "stripe";
import { migrate } from "../src/db/index.js";
import { createCheckoutSession, CheckoutError } from "../src/stripe/checkout.js";
import type { CheckoutDeps } from "../src/stripe/checkout.js";
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
  nextId = "cs_test_1";
  checkout = {
    sessions: {
      create: async (params: Stripe.Checkout.SessionCreateParams) => {
        this.calls.push(params);
        return { id: this.nextId, url: this.nextUrl };
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

/** Captures the args quoteTokens forwards to previewPayFor. */
function quoteClientStub() {
  const calls: unknown[] = [];
  return {
    calls,
    readContract: async (args: { args: readonly unknown[] }) => {
      calls.push(args.args);
      return [{}, QUOTE_TOKENS, 0n, []] as const;
    },
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
    quoteClient: quoteClientStub() as unknown as CheckoutDeps["quoteClient"],
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
    expect(d.stripe.lastCall.success_url).toContain("https://processor.test");
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
    const quote = quoteClientStub();
    const d = deps({ quoteClient: quote as unknown as CheckoutDeps["quoteClient"] });
    await createCheckoutSession(d, {
      projectId: PROJECT_ID,
      amountUsdCents: 5000n,
      email: "quote@example.com",
      instant: false,
    });

    // $50.00 -> 50_000000 (USDC is 6-decimal), never 50e18.
    expect(quote.calls).toHaveLength(1);
    const args = quote.calls[0] as readonly unknown[];
    expect(args[0]).toBe(BigInt(PROJECT_ID));
    expect(args[2]).toBe(50_000_000n);
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
    const quote = quoteClientStub();
    const d = deps({
      quoteClient: quote as unknown as CheckoutDeps["quoteClient"],
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
    expect((quote.calls[0] as readonly unknown[])[2]).toBe(50_000_000n);
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
