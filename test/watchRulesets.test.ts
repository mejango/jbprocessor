import { Pool } from "pg";
import type { Address } from "viem";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../src/db/index.js";
import type { JobRow } from "../src/db/jobs.js";
import type { EmailSendPayload, EmailSendResult, EmailSender } from "../src/email/send.js";
import {
  handleRulesetWatch,
  rulesetFingerprint,
  scheduleRulesetWatch,
  type RulesetReads,
  type RulesetSnapshot,
  type RulesetWatchDeps,
} from "../src/worker/watchRulesets.js";
import { handlers } from "../src/worker/index.js";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/jbprocessor_test";

const SCHEMA_NAME = `test_watch_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

function addr(tail: string): Address {
  return `0x${tail.padStart(40, "0")}` as Address;
}

const PROJECT_A = 101;
const PROJECT_B = 102;

let pool: Pool;

function snapshot(overrides: Partial<RulesetSnapshot["metadata"]> = {}, id = 1_700_000_000): RulesetSnapshot {
  return {
    ruleset: {
      id,
      duration: 604_800,
      weight: 1_000_000_000_000_000_000n,
      weightCutPercent: 0,
      approvalHook: addr("0"),
    },
    metadata: {
      reservedPercent: 2_000,
      cashOutTaxRate: 0,
      baseCurrency: 1,
      pausePay: false,
      allowOwnerMinting: false,
      allowSetCustomToken: false,
      allowTerminalMigration: false,
      allowSetController: false,
      useDataHookForPay: false,
      useDataHookForCashOut: false,
      dataHook: addr("0"),
      ...overrides,
    },
  };
}

class FakeController implements RulesetReads {
  current = new Map<string, RulesetSnapshot>();
  upcoming = new Map<string, RulesetSnapshot>();
  throwFor = new Set<string>();

  set(projectId: number, current: RulesetSnapshot, upcoming = current): void {
    this.current.set(String(projectId), current);
    this.upcoming.set(String(projectId), upcoming);
  }

  async currentRulesetOf(projectId: bigint): Promise<RulesetSnapshot> {
    if (this.throwFor.has(String(projectId))) throw new Error("rpc timeout");
    const found = this.current.get(String(projectId));
    if (!found) throw new Error(`no current ruleset for ${projectId}`);
    return found;
  }

  async upcomingRulesetOf(projectId: bigint): Promise<RulesetSnapshot> {
    if (this.throwFor.has(String(projectId))) throw new Error("rpc timeout");
    const found = this.upcoming.get(String(projectId));
    if (!found) throw new Error(`no upcoming ruleset for ${projectId}`);
    return found;
  }
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

let controller: FakeController;
let resend: FakeSender;

function deps(): RulesetWatchDeps {
  return { pool, controller, resend };
}

const WATCH_JOB: JobRow = {
  id: "0",
  kind: "ruleset-watch",
  payload: {},
  run_at: new Date(),
  attempts: 1,
  max_attempts: 8,
  locked_at: null,
  done_at: null,
  last_error: null,
  dedupe_key: null,
};

async function projectRow(projectId: number): Promise<{ status: string; ruleset_fingerprint: string | null }> {
  const { rows } = await pool.query<{ status: string; ruleset_fingerprint: string | null }>(
    "SELECT status, ruleset_fingerprint FROM projects WHERE project_id = $1",
    [projectId],
  );
  return rows[0]!;
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
});

afterAll(async () => {
  await pool.end();
  const adminPool = new Pool({ connectionString: TEST_DATABASE_URL });
  await adminPool.query(`DROP SCHEMA "${SCHEMA_NAME}" CASCADE`);
  await adminPool.end();
});

beforeEach(async () => {
  controller = new FakeController();
  resend = new FakeSender();
  process.env.EMAIL_FROM = "JBProcessor <mail@jbprocessor.test>";
  process.env.ALERT_EMAIL = "ops@jbprocessor.test";

  await pool.query("DELETE FROM jobs");
  await pool.query("DELETE FROM payments");
  await pool.query("DELETE FROM projects");
  await pool.query(
    `INSERT INTO projects (project_id, name, token_address, terminal_address)
     VALUES ($1, 'Alpha', $3, $4), ($2, 'Beta', $3, $4)`,
    [PROJECT_A, PROJECT_B, addr("70ce4"), addr("7e21")],
  );
});

afterEach(() => {
  delete process.env.EMAIL_FROM;
  delete process.env.ALERT_EMAIL;
});

describe("rulesetFingerprint", () => {
  it("is stable for the same configuration", () => {
    expect(rulesetFingerprint(snapshot(), snapshot())).toBe(
      rulesetFingerprint(snapshot(), snapshot()),
    );
  });

  it("changes when a money field changes", () => {
    const before = rulesetFingerprint(snapshot(), snapshot());
    expect(rulesetFingerprint(snapshot({ reservedPercent: 9_000 }), snapshot())).not.toBe(before);
    expect(rulesetFingerprint(snapshot(), snapshot({ pausePay: true }))).not.toBe(before);
    expect(rulesetFingerprint(snapshot({}, 1_700_000_001), snapshot())).not.toBe(before);
  });

  it("ignores the decayed weight, which auto-cycles without any config change", () => {
    const decayed = snapshot();
    decayed.ruleset.weight = 1n;
    expect(rulesetFingerprint(decayed, snapshot())).toBe(rulesetFingerprint(snapshot(), snapshot()));
  });
});

describe("handleRulesetWatch", () => {
  it("stores the fingerprint on the first scan without alerting", async () => {
    controller.set(PROJECT_A, snapshot());
    controller.set(PROJECT_B, snapshot());

    await handleRulesetWatch(deps(), WATCH_JOB);

    const row = await projectRow(PROJECT_A);
    expect(row.ruleset_fingerprint).toBeTruthy();
    expect(row.status).toBe("active");
    expect(resend.sent).toHaveLength(0);
  });

  it("stays silent when the configuration has not moved", async () => {
    controller.set(PROJECT_A, snapshot());
    controller.set(PROJECT_B, snapshot());
    await handleRulesetWatch(deps(), WATCH_JOB);
    const first = (await projectRow(PROJECT_A)).ruleset_fingerprint;

    await handleRulesetWatch(deps(), WATCH_JOB);

    expect((await projectRow(PROJECT_A)).ruleset_fingerprint).toBe(first);
    expect((await projectRow(PROJECT_A)).status).toBe("active");
    expect(resend.sent).toHaveLength(0);
  });

  it("suspends the project and alerts when the configuration changes", async () => {
    controller.set(PROJECT_A, snapshot());
    controller.set(PROJECT_B, snapshot());
    await handleRulesetWatch(deps(), WATCH_JOB);
    const before = (await projectRow(PROJECT_A)).ruleset_fingerprint;

    controller.set(PROJECT_A, snapshot({ cashOutTaxRate: 5_000 }));
    await handleRulesetWatch(deps(), WATCH_JOB);

    const after = await projectRow(PROJECT_A);
    expect(after.status).toBe("suspended");
    expect(after.ruleset_fingerprint).not.toBe(before);
    expect(resend.sent).toHaveLength(1);
    expect(resend.sent[0]!.text).toContain(String(PROJECT_A));
    expect(resend.sent[0]!.text).toContain("Alpha");
    // The other project is untouched.
    expect((await projectRow(PROJECT_B)).status).toBe("active");
  });

  it("skips suspended projects entirely", async () => {
    controller.set(PROJECT_B, snapshot());
    await pool.query("UPDATE projects SET status = 'suspended' WHERE project_id = $1", [PROJECT_A]);

    await handleRulesetWatch(deps(), WATCH_JOB);

    expect((await projectRow(PROJECT_A)).ruleset_fingerprint).toBeNull();
    expect((await projectRow(PROJECT_B)).ruleset_fingerprint).toBeTruthy();
  });

  it("keeps scanning when one project's reads fail", async () => {
    controller.throwFor.add(String(PROJECT_A));
    controller.set(PROJECT_B, snapshot());

    await expect(handleRulesetWatch(deps(), WATCH_JOB)).resolves.toBeUndefined();

    expect((await projectRow(PROJECT_A)).ruleset_fingerprint).toBeNull();
    expect((await projectRow(PROJECT_B)).ruleset_fingerprint).toBeTruthy();
  });

  it("schedules its successor before doing any work", async () => {
    controller.throwFor.add(String(PROJECT_A));
    controller.throwFor.add(String(PROJECT_B));

    await handleRulesetWatch(deps(), WATCH_JOB);

    const { rows } = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM jobs WHERE kind = 'ruleset-watch'",
    );
    expect(rows[0]!.n).toBe(1);
  });
});

describe("scheduleRulesetWatch", () => {
  it("collapses two schedulers aiming at the same hour into one job", async () => {
    const at = new Date("2026-08-11T10:05:00Z");
    await scheduleRulesetWatch(pool, at);
    await scheduleRulesetWatch(pool, new Date("2026-08-11T10:55:00Z"));

    const { rows } = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM jobs WHERE kind = 'ruleset-watch'",
    );
    expect(rows[0]!.n).toBe(1);
  });

  it("is registered in the worker handler table", () => {
    expect(handlers["ruleset-watch"]).toBeTypeOf("function");
  });
});
