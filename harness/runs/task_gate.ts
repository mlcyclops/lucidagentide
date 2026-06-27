// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/runs/task_gate.ts
//
// P-TASK.3 (ADR-0028): bind an omp `task` subagent dispatch to the run lineage and record its
// pre-dispatch sandbox disposition. A clean assignment mints a child subagent run with a
// trust-appropriate profile (auto-downgraded by chooseProfile when the scan found suspicious
// content); a blocked (suspicious/quarantined) assignment is instead routed to a read-only
// security-review child run — the work is NOT dispatched.
//
// This is provenance/policy lineage, layered on top of the gate's existing fail-closed scan. It
// never makes the security decision (the gate already did, in-process, fail-closed) — it records
// what happened and what sandbox SHOULD apply, so a task dispatch is a first-class lineage node.

import type { Db } from "../memory/db.ts";
import type { ExecutionProfile, TrustLabel } from "../contracts.ts";
import type { Telemetry } from "../telemetry/events.ts";
import type { ScannerClient } from "../security/scanner_client.ts";
import { spawnSubagent } from "./lineage.ts";
import { spawnSecurityReview } from "./security_review.ts";
import { chooseProfile } from "./profiles.ts";
import { ingestArtifact } from "../memory/ingest.ts";
import { promoteFactGated } from "../memory/promotion_gate.ts";

export interface TaskDispatchDecision {
  /** The gate's fail-closed block decision for the assignment + shared context. */
  block: boolean;
  /** Worst trust label found scanning the assignment + context. */
  trustLabel: TrustLabel;
}

export interface TaskGateResult {
  action: "dispatched" | "routed-to-review";
  /** The child run minted for this dispatch (subagent run, or the security-review run). */
  runId: string;
  profile: ExecutionProfile;
  downgraded: boolean;
  reason: string;
}

/**
 * Record the lineage + sandbox disposition for one task dispatch under `parentRunId`.
 * - blocked  → a read-only security-review child run; the assignment is not dispatched.
 * - allowed  → a subagent child run with a profile auto-downgraded for the assignment's trust.
 */
export async function gateTaskDispatch(
  db: Db,
  parentRunId: string,
  decision: TaskDispatchDecision,
  tel?: Telemetry,
): Promise<TaskGateResult> {
  if (decision.block) {
    const runId = await spawnSecurityReview(db, parentRunId, {}, tel);
    return {
      action: "routed-to-review",
      runId,
      profile: "read-only-audit",
      downgraded: true,
      reason: "blocked assignment routed to read-only security-review (not dispatched)",
    };
  }
  const p = chooseProfile({ trustLabel: decision.trustLabel });
  const runId = await spawnSubagent(db, parentRunId, { kind: "subagent", mode: "subagent", sandboxProfile: p.profile }, tel);
  tel?.emit("subagent_dispatched", { run_id: runId, parent_run_id: parentRunId, sandbox_profile: p.profile, downgraded: p.downgraded });
  return { action: "dispatched", runId, profile: p.profile, downgraded: p.downgraded, reason: p.reason };
}

export interface ResultGateOutcome {
  /** Promoted into semantic memory. */
  promoted: boolean;
  /** Blocked from promotion by keystone #2 (suspicious/quarantined source, unreviewed). */
  blocked: boolean;
  trustLabel: TrustLabel;
  artifactId: string;
  reason: string;
}

/**
 * P-TASK.4 (ADR-0028): gate a subagent's RETURNED text before it can become durable memory.
 * The result is ingested (scanned → trust-labelled, raw preserved) and then run through the
 * keystone-#2 promotion gate — so a suspicious/quarantined subagent result NEVER auto-promotes into
 * semantic memory. Returns the disposition; the raw artifact is always recorded for provenance.
 */
export async function gateSubagentResult(
  db: Db,
  scanner: ScannerClient,
  input: { runId: string; agent: string; resultText: string },
  tel?: Telemetry,
): Promise<ResultGateOutcome> {
  const art = await ingestArtifact(db, scanner, { runId: input.runId, sourceType: `subagent:${input.agent}`, rawContent: input.resultText }, {});
  const statement = input.resultText.replace(/\s+/g, " ").trim().slice(0, 160);
  const promo = statement.length >= 12
    ? await promoteFactGated(db, { entityName: `subagent:${input.agent}`, statement, trustLabel: art.trustLabel, sourceArtifactId: art.artifactId }, { telemetry: tel })
    : { promoted: false, blocked: false, reason: "result too short to promote" };
  tel?.emit("subagent_result_gated", { run_id: input.runId, agent: input.agent, trust_label: art.trustLabel, promoted: promo.promoted, artifact_id: art.artifactId });
  return { promoted: promo.promoted, blocked: ("blocked" in promo ? promo.blocked : false), trustLabel: art.trustLabel, artifactId: art.artifactId, reason: promo.reason };
}
