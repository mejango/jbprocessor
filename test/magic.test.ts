import { createHash } from "node:crypto";
import { Pool } from "pg";
import type { Address, Hex } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { feePaymentId, paymentIdBytes32 } from "../src/chain/escrow.js";
import { migrate } from "../src/db/index.js";
import { createPayment, type PaymentState } from "../src/db/payments.js";
import {
  makeSessionCookie,
  readSession,
  signToken,
  verifyToken,
  SESSION_COOKIE_NAME,
} from "../src/auth/magic.js";
import { getOrCreatePregenWallet, type ParaClient } from "../src/wallets/para.js";
import { requestMagicLink, completeLogin } from "../src/account/login.js";
import { requestRedirect, RedirectError, type RedirectEscrow } from "../src/account/redirect.js";
import { listAccountPayments, publicPaymentView } from "../src/account/payments.js";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/jbprocessor_test";

const SCHEMA_NAME = `test_magic_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

const PROJECT_ID = 42;
const SECRET = "test-auth-secret-do-not-use-in-production";

function addr(tail: string): Address {
  return `0x${tail.padStart(40, "0")}` as Address;
}

const DEST = addr("de571");
const OTHER_DEST = addr("de572");

let pool: Pool;

/** Fixed clock helper: tests pass explicit `now()`s rather than sleeping. */
function at(ms: number): () => number {
  return () => ms;
}

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);

beforeAll(async () => {
  process.env.AUTH_SECRET = SECRET;

  const adminPool = new Pool({ connectionString: TEST_DATABASE_URL });
  await adminPool.query(`CREATE SCHEMA "${SCHEMA_NAME}"`);
  await adminPool.end();

  pool = new Pool({
    connectionString: TEST_DATABASE_URL,
    options: `-c search_path=${SCHEMA_NAME}`,
  });
  await migrate(pool);
  await pool.query(
    `INSERT INTO projects (project_id, name, token_address, terminal_address)
     VALUES ($1, $2, $3, $4)`,
    [PROJECT_ID, "Test Project", addr("b0b1"), addr("7e21")],
  );
});

afterAll(async () => {
  await pool.end();
  const adminPool = new Pool({ connectionString: TEST_DATABASE_URL });
  await adminPool.query(`DROP SCHEMA "${SCHEMA_NAME}" CASCADE`);
  await adminPool.end();
});

describe("signToken / verifyToken", () => {
  it("round-trips the email", async () => {
    const token = signToken("payer@example.com", 15, { now: at(T0) });
    await expect(verifyToken(pool, token, { now: at(T0 + 60_000) })).resolves.toBe(
      "payer@example.com",
    );
  });

  it("rejects a token past its expiry", async () => {
    const token = signToken("late@example.com", 15, { now: at(T0) });
    await expect(
      verifyToken(pool, token, { now: at(T0 + 16 * 60_000) }),
    ).resolves.toBeNull();
  });

  it("is single-use: the second verification fails", async () => {
    const token = signToken("once@example.com", 15, { now: at(T0) });
    await expect(verifyToken(pool, token, { now: at(T0) })).resolves.toBe("once@example.com");
    await expect(verifyToken(pool, token, { now: at(T0) })).resolves.toBeNull();
  });

  it("stores only the token's hash, never the token itself", async () => {
    const token = signToken("hashed@example.com", 15, { now: at(T0) });
    await verifyToken(pool, token, { now: at(T0) });
    const { rows } = await pool.query<{ hash: string }>("SELECT hash FROM used_tokens");
    const hash = createHash("sha256").update(token).digest("hex");
    expect(rows.map((row) => row.hash)).toContain(hash);
    expect(rows.map((row) => row.hash)).not.toContain(token);
  });

  it("rejects a tampered payload", async () => {
    const token = signToken("victim@example.com", 15, { now: at(T0) });
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const forged = Buffer.from(
      decoded.replace("victim@example.com", "attacker@example.com"),
      "utf8",
    ).toString("base64url");
    await expect(verifyToken(pool, forged, { now: at(T0) })).resolves.toBeNull();
  });

  it("rejects a token signed with a different secret", async () => {
    const token = signToken("other@example.com", 15, { now: at(T0), secret: "some-other-secret" });
    await expect(verifyToken(pool, token, { now: at(T0) })).resolves.toBeNull();
  });

  it("rejects garbage without touching the used-token table", async () => {
    const before = await pool.query("SELECT count(*)::int AS n FROM used_tokens");
    await expect(verifyToken(pool, "not-a-token", { now: at(T0) })).resolves.toBeNull();
    await expect(verifyToken(pool, "", { now: at(T0) })).resolves.toBeNull();
    const after = await pool.query("SELECT count(*)::int AS n FROM used_tokens");
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("does not reuse a session cookie as a magic-link token", async () => {
    const cookie = makeSessionCookie("crossover@example.com", { now: at(T0) });
    await expect(verifyToken(pool, cookie, { now: at(T0) })).resolves.toBeNull();
  });
});

describe("session cookies", () => {
  it("round-trips the email", () => {
    const cookie = makeSessionCookie("payer@example.com", { now: at(T0) });
    expect(readSession(cookie, { now: at(T0 + 3_600_000) })).toBe("payer@example.com");
  });

  it("expires", () => {
    const cookie = makeSessionCookie("payer@example.com", { now: at(T0), ttlDays: 1 });
    expect(readSession(cookie, { now: at(T0 + 25 * 3_600_000) })).toBeNull();
  });

  it("rejects a tampered email", () => {
    const cookie = makeSessionCookie("payer@example.com", { now: at(T0) });
    const forged = cookie.replace("payer@example.com", "attacker@example.com");
    expect(readSession(forged, { now: at(T0) })).toBeNull();
  });

  it("rejects an empty or malformed value", () => {
    expect(readSession("", { now: at(T0) })).toBeNull();
    expect(readSession("payer@example.com|999999999999", { now: at(T0) })).toBeNull();
  });

  it("names the cookie", () => {
    expect(SESSION_COOKIE_NAME).toBeTruthy();
  });
});

describe("getOrCreatePregenWallet", () => {
  class FakePara implements ParaClient {
    calls: string[] = [];
    next = 1;
    async createPregenWallet(email: string): Promise<string> {
      this.calls.push(email);
      return addr(`a11ce${this.next++}`);
    }
  }

  it("memoizes: the same email always gets the same address, and Para is called once", async () => {
    const para = new FakePara();
    const first = await getOrCreatePregenWallet({ pool, para }, "pregen@example.com");
    const second = await getOrCreatePregenWallet({ pool, para }, "pregen@example.com");
    expect(second).toBe(first);
    expect(para.calls).toEqual(["pregen@example.com"]);
  });

  it("treats the email case-insensitively", async () => {
    const para = new FakePara();
    const lower = await getOrCreatePregenWallet({ pool, para }, "mixed@example.com");
    const upper = await getOrCreatePregenWallet({ pool, para }, "MiXeD@Example.com");
    expect(upper).toBe(lower);
    expect(para.calls).toHaveLength(1);
  });

  it("keeps one address when two callers race", async () => {
    const para = new FakePara();
    const [a, b] = await Promise.all([
      getOrCreatePregenWallet({ pool, para }, "race@example.com"),
      getOrCreatePregenWallet({ pool, para }, "race@example.com"),
    ]);
    expect(a).toBe(b);
    const { rows } = await pool.query("SELECT * FROM pregen_wallets WHERE email = $1", [
      "race@example.com",
    ]);
    expect(rows).toHaveLength(1);
  });

  it("rejects an address the provider didn't return as an address", async () => {
    const broken: ParaClient = { createPregenWallet: async () => "not-an-address" };
    await expect(
      getOrCreatePregenWallet({ pool, para: broken }, "broken@example.com"),
    ).rejects.toThrow(/address/i);
  });
});

describe("requestMagicLink / completeLogin", () => {
  it("enqueues an email job carrying a token that logs the payer in", async () => {
    await requestMagicLink({ pool }, "Login@Example.com", { now: at(T0) });

    const { rows } = await pool.query<{ kind: string; payload: { email: string; token: string } }>(
      "SELECT kind, payload FROM jobs WHERE kind = 'magic-link-email' ORDER BY id DESC LIMIT 1",
    );
    const job = rows[0]!;
    expect(job.payload.email).toBe("login@example.com");

    await expect(completeLogin({ pool }, job.payload.token, { now: at(T0) })).resolves.toBe(
      "login@example.com",
    );
  });

  it("returns null for a bad token rather than throwing", async () => {
    await expect(completeLogin({ pool }, "garbage", { now: at(T0) })).resolves.toBeNull();
  });

  it("does not enqueue anything for a malformed email", async () => {
    const before = await pool.query("SELECT count(*)::int AS n FROM jobs WHERE kind = 'magic-link-email'");
    await requestMagicLink({ pool }, "not-an-email", { now: at(T0) });
    const after = await pool.query("SELECT count(*)::int AS n FROM jobs WHERE kind = 'magic-link-email'");
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});

/** Fake of the two escrow operations a redirect makes. */
class FakeEscrow implements RedirectEscrow {
  entries = new Set<string>();
  calls: Array<{ paymentId: Hex; to: Address }> = [];
  failFor: string | null = null;
  private counter = 0;

  async hasEntry(paymentId: Hex): Promise<boolean> {
    return this.entries.has(paymentId);
  }

  async setBeneficiary(paymentId: Hex, to: Address): Promise<Hex> {
    if (this.failFor === paymentId) throw new Error("rpc exploded");
    this.calls.push({ paymentId, to });
    this.counter += 1;
    return `0x${this.counter.toString(16).padStart(64, "0")}` as Hex;
  }
}

async function seedPayment(
  email: string,
  state: PaymentState,
  patch: { release_tx?: string } = {},
): Promise<string> {
  const payment = await createPayment(pool, {
    projectId: PROJECT_ID,
    email,
    amountUsdCents: 2_500n,
    instant: false,
    claimAddress: addr("00a1"),
    quoteTokens: 1_000n,
  });
  await pool.query(
    "UPDATE payments SET state = $2, tokens_held = $3, unlock_at = $4, pay_tx = $5, release_tx = $6 WHERE id = $1",
    [
      payment.id,
      state,
      "1000",
      new Date(T0 + 7 * 86_400_000),
      `0x${"11".repeat(32)}`,
      patch.release_tx ?? null,
    ],
  );
  return payment.id;
}

describe("requestRedirect", () => {
  let escrow: FakeEscrow;

  beforeEach(() => {
    escrow = new FakeEscrow();
  });

  it("sets the beneficiary, records the destination, and enqueues a confirmation", async () => {
    const id = await seedPayment("owner@example.com", "held");
    const result = await requestRedirect(
      { pool, escrow },
      { paymentId: id, address: DEST, sessionEmail: "owner@example.com" },
    );

    expect(result.txHash).toBeTruthy();
    expect(escrow.calls).toEqual([{ paymentId: paymentIdBytes32(id), to: DEST }]);

    const { rows } = await pool.query<{ claim_address: string }>(
      "SELECT claim_address FROM payments WHERE id = $1",
      [id],
    );
    expect(rows[0]!.claim_address.toLowerCase()).toBe(DEST.toLowerCase());

    const audit = await pool.query("SELECT * FROM redirects WHERE payment_id = $1", [id]);
    expect(audit.rowCount).toBe(1);

    const jobs = await pool.query(
      "SELECT count(*)::int AS n FROM jobs WHERE kind = 'redirect-email' AND payload->>'paymentId' = $1",
      [id],
    );
    expect(jobs.rows[0].n).toBe(1);
  });

  it("redirects the fee leg too when the escrow holds one", async () => {
    const id = await seedPayment("fee@example.com", "held");
    escrow.entries.add(feePaymentId(paymentIdBytes32(id)));

    const result = await requestRedirect(
      { pool, escrow },
      { paymentId: id, address: DEST, sessionEmail: "fee@example.com" },
    );

    expect(result.feeTxHash).toBeTruthy();
    expect(escrow.calls.map((call) => call.paymentId)).toEqual([
      paymentIdBytes32(id),
      feePaymentId(paymentIdBytes32(id)),
    ]);
  });

  it("reports a fee-leg failure but keeps the main redirect on record", async () => {
    const id = await seedPayment("feefail@example.com", "held");
    const feeId = feePaymentId(paymentIdBytes32(id));
    escrow.entries.add(feeId);
    escrow.failFor = feeId;

    await expect(
      requestRedirect(
        { pool, escrow },
        { paymentId: id, address: DEST, sessionEmail: "feefail@example.com" },
      ),
    ).rejects.toMatchObject({ code: "fee_leg_failed", status: 502 });

    const { rows } = await pool.query<{ claim_address: string }>(
      "SELECT claim_address FROM payments WHERE id = $1",
      [id],
    );
    expect(rows[0]!.claim_address.toLowerCase()).toBe(DEST.toLowerCase());
  });

  it("rejects a session email that isn't the payment's", async () => {
    const id = await seedPayment("owner@example.com", "held");
    await expect(
      requestRedirect(
        { pool, escrow },
        { paymentId: id, address: DEST, sessionEmail: "someone-else@example.com" },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(escrow.calls).toHaveLength(0);
  });

  it("accepts the payment's email in a different case", async () => {
    const id = await seedPayment("Case@Example.com", "unlocked");
    await expect(
      requestRedirect(
        { pool, escrow },
        { paymentId: id, address: DEST, sessionEmail: "case@example.com" },
      ),
    ).resolves.toBeTruthy();
  });

  it("rejects a malformed address", async () => {
    const id = await seedPayment("badaddr@example.com", "held");
    await expect(
      requestRedirect(
        { pool, escrow },
        { paymentId: id, address: "0xnope", sessionEmail: "badaddr@example.com" },
      ),
    ).rejects.toMatchObject({ code: "invalid_address" });
    expect(escrow.calls).toHaveLength(0);
  });

  it("rejects an unknown payment", async () => {
    await expect(
      requestRedirect(
        { pool, escrow },
        {
          paymentId: "00000000-0000-4000-8000-000000000000",
          address: DEST,
          sessionEmail: "nobody@example.com",
        },
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("rejects a payment that has already been released", async () => {
    const id = await seedPayment("released@example.com", "claimed", {
      release_tx: `0x${"22".repeat(32)}`,
    });
    await expect(
      requestRedirect(
        { pool, escrow },
        { paymentId: id, address: DEST, sessionEmail: "released@example.com" },
      ),
    ).rejects.toMatchObject({ code: "not_redirectable" });
    expect(escrow.calls).toHaveLength(0);
  });

  it("rejects a payment that hasn't been escrowed yet", async () => {
    const id = await seedPayment("early@example.com", "paid");
    await expect(
      requestRedirect(
        { pool, escrow },
        { paymentId: id, address: DEST, sessionEmail: "early@example.com" },
      ),
    ).rejects.toMatchObject({ code: "not_redirectable" });
  });

  it("allows three redirects a day and refuses the fourth", async () => {
    const id = await seedPayment("busy@example.com", "held");
    for (const destination of [DEST, OTHER_DEST, DEST]) {
      await requestRedirect(
        { pool, escrow },
        { paymentId: id, address: destination, sessionEmail: "busy@example.com" },
      );
    }
    await expect(
      requestRedirect(
        { pool, escrow },
        { paymentId: id, address: OTHER_DEST, sessionEmail: "busy@example.com" },
      ),
    ).rejects.toMatchObject({ code: "rate_limited", status: 429 });
    expect(escrow.calls).toHaveLength(3);
  });

  it("ignores redirects older than a day when counting", async () => {
    const id = await seedPayment("yesterday@example.com", "held");
    for (let i = 0; i < 3; i += 1) {
      await pool.query(
        "INSERT INTO redirects (payment_id, to_address, created_at) VALUES ($1, $2, now() - interval '2 days')",
        [id, DEST],
      );
    }
    await expect(
      requestRedirect(
        { pool, escrow },
        { paymentId: id, address: DEST, sessionEmail: "yesterday@example.com" },
      ),
    ).resolves.toBeTruthy();
  });

  it("is a RedirectError, so routes can map code -> status", async () => {
    const error = new RedirectError("not_found", "nope");
    expect(error.status).toBe(404);
  });
});

describe("publicPaymentView", () => {
  it("returns the integrator surface without the payer's email", async () => {
    const id = await seedPayment("private@example.com", "held");
    const view = await publicPaymentView(pool, id);
    expect(view).toMatchObject({
      state: "held",
      amountUsdCents: "2500",
      premiumUsdCents: "0",
      quoteTokens: "1000",
      tokensHeld: "1000",
      beneficiary: addr("00a1"),
      releaseTx: null,
    });
    expect(view?.unlockAt).toBeTruthy();
    expect(JSON.stringify(view)).not.toContain("private@example.com");
  });

  it("returns null for an unknown id, and for a malformed one", async () => {
    await expect(
      publicPaymentView(pool, "00000000-0000-4000-8000-000000000001"),
    ).resolves.toBeNull();
    await expect(publicPaymentView(pool, "not-a-uuid")).resolves.toBeNull();
  });
});

describe("listAccountPayments", () => {
  it("lists a payer's payments with the project name and an unlock countdown", async () => {
    const id = await seedPayment("account@example.com", "held");
    const rows = await listAccountPayments(pool, "Account@Example.com", { now: at(T0) });

    const row = rows.find((candidate) => candidate.id === id);
    expect(row).toBeDefined();
    expect(row!.projectName).toBe("Test Project");
    expect(row!.unlockInDays).toBe(7);
    expect(row!.canRedirect).toBe(true);
    expect(row!.stateLabel).toBeTruthy();
  });

  it("shows no countdown once the tokens are released", async () => {
    const id = await seedPayment("done@example.com", "claimed", {
      release_tx: `0x${"33".repeat(32)}`,
    });
    const rows = await listAccountPayments(pool, "done@example.com", { now: at(T0) });
    const row = rows.find((candidate) => candidate.id === id)!;
    expect(row.unlockInDays).toBeNull();
    expect(row.canRedirect).toBe(false);
    expect(row.releaseTx).toBeTruthy();
  });

  it("returns nothing for an email with no payments", async () => {
    await expect(
      listAccountPayments(pool, "stranger@example.com", { now: at(T0) }),
    ).resolves.toEqual([]);
  });
});
