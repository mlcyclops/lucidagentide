// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/agent/trace.ts — P-AGENT.13 (ADR-0139): per-run execution traces for built agents.
//
// DELTA vs the ADR's first sketch: the DESKTOP engine opens agent_obs.duckdb READ-ONLY (omp's gate child is
// the single writer — see file_store.ts), so v1 traces are workspace JSON files under
// `<root>/.omp/agent-runs/traces/<run_id>.json`, exactly like authored specs live as files. DuckDB ingestion
// becomes a gate-child concern later; the file shape here is the contract either way.
//
// Recording is best-effort PROVENANCE layered on top of the run (same posture as loc_ledger): a failed
// trace write NEVER fails or blocks the run itself. Reading is fail-soft too: a corrupted trace file is
// skipped, never fatal. run_id is minted once per run and reused everywhere (invariant #9) — it is also
// the approval-resume handle for parked runs.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type RunStepKind = "segment" | "subagent" | "approval" | "branch";
export type RunTraceStatus = "running" | "awaiting-approval" | "completed" | "denied" | "blocked" | "error";

export interface RunStepRecord {
  kind: RunStepKind;
  index: number; // sequence within the run
  node_ids: string[]; // the canvas nodes this step covers (a segment's steps, or the boundary node)
  label: string; // human summary ("steps 1–2", the approval label, the child agent name)
  started_at: number;
  finished_at: number;
  ok: boolean;
  detail: string; // truncated output snippet, deny reason, or error text — never full transcripts
}

export interface AgentRunTrace {
  run_id: string; // stable per run (invariant #9); also the approval-resume handle
  spec_id: string;
  name: string; // agent name at run time (specs rename; traces keep what ran)
  model: string;
  prompt: string; // truncated task
  lineage: string[]; // spec_id chain for sub-agent runs (root run => [spec_id])
  started_at: number;
  finished_at?: number;
  status: RunTraceStatus;
  steps: RunStepRecord[];
  final_output?: string; // truncated
}

const SNIPPET_MAX = 2000;

export function snippet(text: string): string {
  const t = text.trim();
  return t.length > SNIPPET_MAX ? `${t.slice(0, SNIPPET_MAX)}…` : t;
}

const tracesDir = (root: string): string => join(root, ".omp", "agent-runs", "traces");

/** Only the minted id charset (`run_<uuid>` / `segrun_<uuid>`) — never a path separator or traversal. */
function safeRunId(id: unknown): string | null {
  return typeof id === "string" && /^[A-Za-z0-9_-]+$/.test(id) ? id : null;
}

/** Collects a run's steps and persists after every transition, so a parked (awaiting-approval) run's
 *  trace is already on disk while the human decides. All writes are fail-soft by contract. */
export class TraceRecorder {
  readonly trace: AgentRunTrace;
  readonly #root: string;

  constructor(root: string, init: { run_id: string; spec_id: string; name: string; model: string; prompt: string; lineage: string[] }) {
    this.#root = root;
    this.trace = {
      run_id: init.run_id,
      spec_id: init.spec_id,
      name: init.name,
      model: init.model,
      prompt: snippet(init.prompt),
      lineage: init.lineage,
      started_at: Date.now(),
      status: "running",
      steps: [],
    };
  }

  /** Append a finished step and persist. */
  step(rec: Omit<RunStepRecord, "index">): void {
    this.trace.steps.push({ ...rec, detail: snippet(rec.detail), index: this.trace.steps.length });
    this.save();
  }

  /** Move the run to a (possibly terminal) status and persist. Terminal statuses stamp finished_at. */
  status(status: RunTraceStatus, finalOutput?: string): void {
    this.trace.status = status;
    if (finalOutput !== undefined) this.trace.final_output = snippet(finalOutput);
    if (status !== "running" && status !== "awaiting-approval") this.trace.finished_at = Date.now();
    this.save();
  }

  /** Best-effort persistence — a trace write failure never breaks the run it describes. */
  save(): void {
    try {
      mkdirSync(tracesDir(this.#root), { recursive: true });
      writeFileSync(join(tracesDir(this.#root), `${this.trace.run_id}.json`), JSON.stringify(this.trace, null, 2));
    } catch {
      /* provenance only — never fatal */
    }
  }
}

export interface TraceSummary {
  run_id: string;
  spec_id: string;
  name: string;
  status: RunTraceStatus;
  started_at: number;
  finished_at?: number;
  steps: number;
}

/** Minimal structural check — enough to trust the fields the UI reads. Corrupted files are skipped. */
function readTraceFile(path: string): AgentRunTrace | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const t = parsed as Record<string, unknown>;
  if (typeof t.run_id !== "string" || typeof t.spec_id !== "string" || typeof t.status !== "string" || !Array.isArray(t.steps)) return null;
  if (typeof t.started_at !== "number" || typeof t.name !== "string") return null;
  return parsed as AgentRunTrace;
}

/** List trace summaries (newest first), optionally scoped to one spec. */
export function listTraces(root: string, specId?: string, limit = 50): TraceSummary[] {
  let files: string[];
  try {
    files = readdirSync(tracesDir(root)).filter((f) => f.endsWith(".json"));
  } catch {
    return []; // no traces yet
  }
  const out: TraceSummary[] = [];
  for (const f of files) {
    const t = readTraceFile(join(tracesDir(root), f));
    if (!t) continue;
    if (specId && t.spec_id !== specId) continue;
    out.push({
      run_id: t.run_id,
      spec_id: t.spec_id,
      name: t.name,
      status: t.status,
      started_at: t.started_at,
      ...(t.finished_at !== undefined ? { finished_at: t.finished_at } : {}),
      steps: t.steps.length,
    });
  }
  return out.sort((a, b) => b.started_at - a.started_at).slice(0, limit);
}

/** Load one full trace by run id. Null for unknown/corrupted/unsafe ids — never a bogus trace. */
export function loadTrace(root: string, runId: string): AgentRunTrace | null {
  const id = safeRunId(runId);
  if (!id) return null;
  return readTraceFile(join(tracesDir(root), `${id}.json`));
}
