// harness/runs/lineage.ts
//
// Parent/child run lineage for recursive execution (P5.1). A parent run spawns
// subagent runs; each carries its own trace (telemetry is run_id-scoped), sandbox
// profile, and scan lineage (ingested artifacts are run_id-scoped). The run tree
// is reconstructable for replay, with the flow of suspicious content per node.

import { Snowflake } from "@oh-my-pi/pi-utils";
import type { AgentMode, ExecutionProfile } from "../contracts.ts";
import type { Db } from "./../memory/db.ts";
import type { Telemetry } from "../telemetry/events.ts";

export type RunKind = "root" | "subagent" | "security-review";
export type RunStatus = "running" | "completed" | "failed" | "blocked" | "dispatched";

export interface StartRunInput {
  runId?: string;
  parentRunId?: string;
  sessionId?: string;
  kind: RunKind;
  mode?: AgentMode;
  sandboxProfile?: ExecutionProfile;
}

/** Begin a run; returns its run_id. */
export async function startRun(db: Db, input: StartRunInput, tel?: Telemetry): Promise<string> {
  const runId = input.runId ?? Snowflake.next();
  await db.run(
    `INSERT INTO runs (run_id, parent_run_id, session_id, kind, mode, sandbox_profile, status, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,'running',$7)`,
    [
      runId,
      input.parentRunId ?? null,
      input.sessionId ?? null,
      input.kind,
      input.mode ?? null,
      input.sandboxProfile ?? null,
      new Date().toISOString(),
    ],
  );
  tel?.emit("run_started", { kind: input.kind, parent_run_id: input.parentRunId, mode: input.mode });
  return runId;
}

export async function endRun(db: Db, runId: string, status: RunStatus, tel?: Telemetry): Promise<void> {
  await db.run("UPDATE runs SET status=$2, ended_at=$3 WHERE run_id=$1", [runId, status, new Date().toISOString()]);
  tel?.emit("run_finished", { status });
}

/** Update a run's status and/or sandbox profile in place (e.g. after a gate
 *  decision). Does not set ended_at. */
export async function setRunDisposition(
  db: Db,
  runId: string,
  d: { status?: RunStatus; sandboxProfile?: ExecutionProfile },
): Promise<void> {
  if (d.status !== undefined) await db.run("UPDATE runs SET status=$2 WHERE run_id=$1", [runId, d.status]);
  if (d.sandboxProfile !== undefined) await db.run("UPDATE runs SET sandbox_profile=$2 WHERE run_id=$1", [runId, d.sandboxProfile]);
}

export interface SpawnSubagentOptions {
  kind?: RunKind;
  mode?: AgentMode;
  sandboxProfile?: ExecutionProfile;
}

/** Spawn a child run under `parentRunId`, inheriting the parent's session. */
export async function spawnSubagent(db: Db, parentRunId: string, opts: SpawnSubagentOptions = {}, tel?: Telemetry): Promise<string> {
  const parent = await db.get("SELECT session_id FROM runs WHERE run_id=$1", [parentRunId]);
  return startRun(
    db,
    {
      parentRunId,
      sessionId: parent?.session_id ? String(parent.session_id) : undefined,
      kind: opts.kind ?? "subagent",
      mode: opts.mode ?? "subagent",
      sandboxProfile: opts.sandboxProfile,
    },
    tel,
  );
}

export interface RunNode {
  runId: string;
  parentRunId: string | null;
  kind: string;
  mode: string | null;
  sandboxProfile: string | null;
  status: string;
  /** Quarantined/suspicious artifacts ingested under this run (scan lineage). */
  suspiciousArtifacts: number;
  /** Security findings under this run (injection lineage for replay). */
  findingCount: number;
  /** Approval decisions under this run (approval lineage for replay). */
  approvalCount: number;
  children: RunNode[];
}

/** Reconstruct the run tree rooted at `rootRunId`, with per-node suspicious counts. */
export async function getRunTree(db: Db, rootRunId: string): Promise<RunNode | undefined> {
  const rows = await db.all(
    `WITH RECURSIVE tree AS (
       SELECT run_id, parent_run_id, kind, mode, sandbox_profile, status
       FROM runs WHERE run_id = $1
       UNION ALL
       SELECT r.run_id, r.parent_run_id, r.kind, r.mode, r.sandbox_profile, r.status
       FROM runs r JOIN tree t ON r.parent_run_id = t.run_id
     )
     SELECT t.*,
            (SELECT count(*)::INT FROM content_artifacts a
               WHERE a.run_id = t.run_id AND a.trust_label IN ('quarantined','suspicious')) AS suspicious_artifacts,
            (SELECT count(*)::INT FROM content_artifacts a
               JOIN content_scans sc ON sc.artifact_id = a.artifact_id
               JOIN security_findings f ON f.scan_id = sc.scan_id
               WHERE a.run_id = t.run_id) AS finding_count,
            (SELECT count(*)::INT FROM content_artifacts a
               JOIN approval_events e ON e.artifact_id = a.artifact_id
               WHERE a.run_id = t.run_id) AS approval_count
     FROM tree t`,
    [rootRunId],
  );
  if (rows.length === 0) return undefined;

  const byId = new Map<string, RunNode>();
  for (const r of rows) {
    byId.set(String(r.run_id), {
      runId: String(r.run_id),
      parentRunId: r.parent_run_id == null ? null : String(r.parent_run_id),
      kind: String(r.kind),
      mode: r.mode == null ? null : String(r.mode),
      sandboxProfile: r.sandbox_profile == null ? null : String(r.sandbox_profile),
      status: String(r.status),
      suspiciousArtifacts: Number(r.suspicious_artifacts ?? 0),
      findingCount: Number(r.finding_count ?? 0),
      approvalCount: Number(r.approval_count ?? 0),
      children: [],
    });
  }
  for (const node of byId.values()) {
    if (node.runId === rootRunId) continue;
    if (node.parentRunId && byId.has(node.parentRunId)) byId.get(node.parentRunId)!.children.push(node);
  }
  return byId.get(rootRunId);
}

/** The lineage chain from the root down to `runId` (inclusive). */
export async function getLineage(db: Db, runId: string): Promise<string[]> {
  const chain: string[] = [];
  let current: string | undefined = runId;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    chain.unshift(current);
    const row = await db.get("SELECT parent_run_id FROM runs WHERE run_id=$1", [current]);
    current = row?.parent_run_id == null ? undefined : String(row.parent_run_id);
  }
  return chain;
}
