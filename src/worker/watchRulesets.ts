import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { Address } from "viem";
import { controllerAbi } from "../chain/abi/controller.js";
import type { AppPublicClient } from "../chain/client.js";
import { enqueue, type JobRow } from "../db/jobs.js";
import { envAddress } from "../env.js";
import { sendAlert, type EmailDeps } from "../email/send.js";

/** How often the watcher re-reads every active project's terms. */
const WATCH_INTERVAL_MS = 60 * 60 * 1000;

/** The `JBRuleset` fields the fingerprint covers. */
export interface RulesetFields {
  id: number;
  duration: number;
  weight: bigint;
  weightCutPercent: number;
  approvalHook: Address;
}

/** The `JBRulesetMetadata` fields the fingerprint covers. */
export interface RulesetMetadataFields {
  reservedPercent: number;
  cashOutTaxRate: number;
  baseCurrency: number;
  pausePay: boolean;
  allowOwnerMinting: boolean;
  allowSetCustomToken: boolean;
  allowTerminalMigration: boolean;
  allowSetController: boolean;
  useDataHookForPay: boolean;
  useDataHookForCashOut: boolean;
  dataHook: Address;
}

export interface RulesetSnapshot {
  ruleset: RulesetFields;
  metadata: RulesetMetadataFields;
}

/** The two controller reads the watcher makes, behind an injectable surface. */
export interface RulesetReads {
  currentRulesetOf(projectId: bigint): Promise<RulesetSnapshot>;
  upcomingRulesetOf(projectId: bigint): Promise<RulesetSnapshot>;
}

export interface RulesetWatchDeps extends EmailDeps {
  pool: Pool;
  controller: RulesetReads;
}

/** The live implementation, reading `JB_CONTROLLER_ADDRESS` on Base. */
export function liveRulesetReads(publicClient: AppPublicClient): RulesetReads {
  const read = async (
    functionName: "currentRulesetOf" | "upcomingRulesetOf",
    projectId: bigint,
  ): Promise<RulesetSnapshot> => {
    const [ruleset, metadata] = await publicClient.readContract({
      address: envAddress("JB_CONTROLLER_ADDRESS"),
      abi: controllerAbi,
      functionName,
      args: [projectId],
    });
    return {
      ruleset: {
        id: ruleset.id,
        duration: ruleset.duration,
        weight: ruleset.weight,
        weightCutPercent: ruleset.weightCutPercent,
        approvalHook: ruleset.approvalHook,
      },
      metadata: {
        reservedPercent: metadata.reservedPercent,
        cashOutTaxRate: metadata.cashOutTaxRate,
        baseCurrency: metadata.baseCurrency,
        pausePay: metadata.pausePay,
        allowOwnerMinting: metadata.allowOwnerMinting,
        allowSetCustomToken: metadata.allowSetCustomToken,
        allowTerminalMigration: metadata.allowTerminalMigration,
        allowSetController: metadata.allowSetController,
        useDataHookForPay: metadata.useDataHookForPay,
        useDataHookForCashOut: metadata.useDataHookForCashOut,
        dataHook: metadata.dataHook,
      },
    };
  };

  return {
    currentRulesetOf: (projectId) => read("currentRulesetOf", projectId),
    upcomingRulesetOf: (projectId) => read("upcomingRulesetOf", projectId),
  };
}

/**
 * The fields that go into one ruleset's half of the fingerprint, in a fixed
 * order so the JSON is stable regardless of how the reads were assembled.
 *
 * What's in, and why:
 *   id                     a new stored ruleset always gets a new id, so this
 *                          alone catches "the owner queued different terms"
 *   duration               how long those terms hold before the next cycle
 *   weightCutPercent       the declared issuance decay per cycle
 *   approvalHook           who is allowed to gate future changes
 *   reservedPercent        how much of a donor's issuance is skimmed away
 *   cashOutTaxRate         what the tokens are worth on the way out
 *   baseCurrency           what the issuance rate is even denominated in
 *   pausePay               whether a donation can be made at all
 *   allowOwnerMinting      whether the owner can dilute a donor at will
 *   allowSetCustomToken    whether the token the escrow holds can be swapped
 *   allowTerminalMigration whether the money can be pointed somewhere else
 *   allowSetController     whether all of the above can be replaced wholesale
 *   useDataHookForPay      whether a contract gets to rewrite issuance
 *   useDataHookForCashOut  whether a contract gets to rewrite cash-out value
 *   dataHook               which contract that is
 *
 * What's deliberately out:
 *   cycleNumber, start, basedOnId -- these move on every auto-cycle with no
 *     change of terms whatsoever, so fingerprinting them would suspend every
 *     project on its own schedule.
 *   weight -- likewise. A ruleset with a non-zero `weightCutPercent` reports a
 *     freshly decayed weight every cycle while its `id` stays put, so including
 *     it would raise a false alarm every cycle for every decaying revnet. It
 *     costs nothing to omit: weight only changes outside the declared decay
 *     when a new ruleset is stored, and that always shows up as a new `id`.
 *   the packed `metadata` uint256 -- it is exactly the decoded fields above
 *     plus the flags below, so hashing it too would only add noise.
 *   the permission flags with no bearing on a donor's tokens
 *     (allowSetTerminals, allowAddAccountingContext, allowAddPriceFeed,
 *     ownerMustSendPayouts, holdFees, pauseCreditTransfers,
 *     scopeCashOutsToLocalBalances) -- suspending a live project is
 *     expensive, so the trigger is limited to terms that change what a
 *     donation buys or where it can go.
 */
function stableFields(snapshot: RulesetSnapshot): unknown[] {
  const { ruleset, metadata } = snapshot;
  return [
    ruleset.id,
    ruleset.duration,
    ruleset.weightCutPercent,
    ruleset.approvalHook.toLowerCase(),
    metadata.reservedPercent,
    metadata.cashOutTaxRate,
    metadata.baseCurrency,
    metadata.pausePay,
    metadata.allowOwnerMinting,
    metadata.allowSetCustomToken,
    metadata.allowTerminalMigration,
    metadata.allowSetController,
    metadata.useDataHookForPay,
    metadata.useDataHookForCashOut,
    metadata.dataHook.toLowerCase(),
  ];
}

/**
 * A project's terms, as one comparable string. Covers the current ruleset and
 * the upcoming one, so terms that are merely *queued* trip the alarm before
 * they start taking donors' money -- which is the only window in which a
 * suspension actually protects anyone.
 */
export function rulesetFingerprint(
  current: RulesetSnapshot,
  upcoming: RulesetSnapshot,
): string {
  const json = JSON.stringify([stableFields(current), stableFields(upcoming)]);
  return createHash("sha256").update(json).digest("hex");
}

/**
 * A snapshot as one readable line for the alert. `weight` is a bigint, which
 * plain `JSON.stringify` refuses outright, so every bigint becomes its decimal
 * string.
 */
function describe(snapshot: RulesetSnapshot): string {
  return JSON.stringify(snapshot, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
}

/**
 * Enqueues a watch scan for `at`, at most once per hour bucket. Same shape as
 * the release scan's scheduler: the key comes from the target time, so a scan
 * scheduling its successor can't dedupe against itself, while a fresh boot and
 * a running chain aiming at the same hour collapse into one job.
 */
export async function scheduleRulesetWatch(pool: Pool, at: Date): Promise<void> {
  const bucket = Math.floor(at.getTime() / WATCH_INTERVAL_MS);
  await enqueue(pool, "ruleset-watch", {}, { runAt: at, dedupeKey: `ruleset-watch:${bucket}` });
}

interface WatchedProject {
  project_id: string;
  name: string;
  ruleset_fingerprint: string | null;
}

/**
 * Re-reads every active project's onchain terms and suspends any project whose
 * terms have moved.
 *
 * This is the service's one defence against a project changing the deal after
 * we started selling it: a donor is quoted tokens under one set of rules, and
 * their money doesn't reach the chain for up to a few days. Onchain reads are
 * the source of truth here on purpose -- an indexer's latency is exactly the
 * window this check exists to close.
 *
 * Suspension is one-way by design. Re-activating a project is a manual SQL
 * statement in the runbook, taken after a human has read the new terms, so a
 * suspended project is skipped entirely rather than re-fingerprinted (which
 * would quietly bless whatever it changed to).
 *
 * Same two safety rules as the release scan: the successor is scheduled first,
 * so nothing below can break the chain, and each project is read inside its
 * own try/catch, so one unreachable RPC costs one project rather than the scan.
 */
export async function handleRulesetWatch(
  deps: RulesetWatchDeps,
  _job: JobRow,
): Promise<void> {
  await scheduleRulesetWatch(deps.pool, new Date(Date.now() + WATCH_INTERVAL_MS));

  const { rows } = await deps.pool.query<WatchedProject>(
    `SELECT project_id, name, ruleset_fingerprint FROM projects
      WHERE status = 'active'
      ORDER BY project_id`,
  );

  for (const project of rows) {
    try {
      await watchOne(deps, project);
    } catch (err) {
      console.error(
        `ruleset watch: project ${project.project_id} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

async function watchOne(deps: RulesetWatchDeps, project: WatchedProject): Promise<void> {
  const projectId = BigInt(project.project_id);
  const [current, upcoming] = await Promise.all([
    deps.controller.currentRulesetOf(projectId),
    deps.controller.upcomingRulesetOf(projectId),
  ]);
  const fingerprint = rulesetFingerprint(current, upcoming);

  if (project.ruleset_fingerprint === null) {
    // Enrollment, not a change: the terms this project is being sold under are
    // whatever they are right now, and there is nothing to compare against.
    await deps.pool.query(
      "UPDATE projects SET ruleset_fingerprint = $2 WHERE project_id = $1",
      [project.project_id, fingerprint],
    );
    console.log(`ruleset watch: recorded first fingerprint for project ${project.project_id}`);
    return;
  }

  if (project.ruleset_fingerprint === fingerprint) return;

  // The new fingerprint is stored alongside the suspension so that a re-read
  // doesn't re-alert on the same change; the `status` is what actually stops
  // new checkouts, and only a human clears it.
  await deps.pool.query(
    "UPDATE projects SET status = 'suspended', ruleset_fingerprint = $2 WHERE project_id = $1",
    [project.project_id, fingerprint],
  );

  await sendAlert(
    deps,
    `Project suspended: ${project.name} changed its onchain terms`,
    [
      `${project.name} (#${project.project_id}) has a different ruleset configuration`,
      "than when we last checked, so it has been suspended and will not accept",
      "new payments.",
      "",
      `Previous fingerprint: ${project.ruleset_fingerprint}`,
      `Current fingerprint:  ${fingerprint}`,
      "",
      "Current ruleset:",
      `  ${describe(current)}`,
      "Upcoming ruleset:",
      `  ${describe(upcoming)}`,
      "",
      "Payments already in flight are unaffected -- they were quoted and bought",
      "under the old terms. Review the new terms and re-activate the project",
      "manually if they are still acceptable.",
      "",
      "-- JBProcessor",
    ].join("\n"),
  );
}
