// desktop/loop_runlog.ts
//
// P-GOAL.10 (ADR-0055): the cross-run EVALUATION surface for /goal loops. ADR-0054's After-Action
// Report measures ONE run; loop-engineering's rubric (§9 Observability) also wants the team to read
// trends across runs — "success metrics established", an "append-only run history". This is that
// ledger: one compact JSON line per completed loop (append-only, under `.omp/loops/run-log.jsonl`,
// the same durable home as goal-memory), plus a PURE aggregator that turns the history into stats a
// user can act on — success rate, average iterations-to-success, failure breakdown by recurring blocker.
//
// Deliberately a flat JSONL file, NOT DuckDB: the desktop /goal loop persists to `.omp/loops/` markdown
// (goal_memory) — this stays in that lightweight, air-gap-clean lane and never touches the frozen DuckDB
// schema (invariant #10). PURE module: no I/O, no Date.now(); the backend stamps `ts`/`id` and writes.

import { type LoopMetrics, type LoopOutcome, stallSignature } from "./loop_report.ts";

/** One completed loop, compacted for the ledger. A superset of what the aggregator needs, so the raw
 *  history stays inspectable (and a future richer view doesn't need a migration). */
export interface LoopRunRecord {
  ts: number;            // completion time (ms epoch), stamped by the backend
  id: string;            // the loop id (shared with its memory + report files)
  goal: string;
  outcome: LoopOutcome;
  outcomeReason: string;
  iterations: number;
  maxIters: number;
  durationMs: number;
  tools: number;                       // total tool calls
  toolsByType: Record<string, number>;
  added: number;                       // LOC added (0 when not a git repo)
  removed: number;
  hasLoc: boolean;                     // false ⇒ added/removed are "unknown", not "zero"
  errors: number;
  websites: number;
  spendUsd: number;                    // P-GOAL.11: actual dollars spent (0 when unknown)
  hasSpend: boolean;                   // false ⇒ spendUsd is "unknown", not "$0"
  command?: string;
}

/** Project a P-GOAL.9 `LoopMetrics` into a ledger record. `id`/`ts` come from the backend (the same
 *  loop id used for the memory + report files; `ts` because pure modules can't read the clock). */
export function toRunRecord(m: LoopMetrics, meta: { id: string; ts: number }): LoopRunRecord {
  const tools = Object.values(m.toolCalls).reduce((a, b) => a + b, 0);
  return {
    ts: meta.ts,
    id: meta.id,
    goal: m.goal,
    outcome: m.outcome,
    outcomeReason: m.outcomeReason,
    iterations: m.iterations,
    maxIters: m.maxIters,
    durationMs: m.durationMs,
    tools,
    toolsByType: { ...m.toolCalls },
    added: m.loc?.added ?? 0,
    removed: m.loc?.removed ?? 0,
    hasLoc: m.loc != null,
    errors: m.errors.length,
    websites: m.websites.length,
    spendUsd: m.spendUsd ?? 0,
    hasSpend: m.spendUsd != null,
    command: m.command,
  };
}

/** Serialize a record to one JSONL line (no trailing newline — the writer adds it). */
export function runRecordLine(r: LoopRunRecord): string {
  return JSON.stringify(r);
}

/** Parse a run-log's JSONL content into records, skipping any malformed / non-record line (the ledger
 *  is append-only and best-effort; one bad line must never poison the whole history). */
export function parseRunLog(content: string): LoopRunRecord[] {
  const out: LoopRunRecord[] = [];
  for (const line of (content ?? "").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t) as Partial<LoopRunRecord>;
      if (typeof o?.id !== "string" || typeof o?.goal !== "string" || typeof o?.outcome !== "string") continue;
      out.push({
        ts: Number(o.ts) || 0,
        id: o.id,
        goal: o.goal,
        outcome: o.outcome as LoopOutcome,
        outcomeReason: String(o.outcomeReason ?? ""),
        iterations: Number(o.iterations) || 0,
        maxIters: Number(o.maxIters) || 0,
        durationMs: Number(o.durationMs) || 0,
        tools: Number(o.tools) || 0,
        toolsByType: (o.toolsByType && typeof o.toolsByType === "object") ? o.toolsByType as Record<string, number> : {},
        added: Number(o.added) || 0,
        removed: Number(o.removed) || 0,
        hasLoc: o.hasLoc === true,
        errors: Number(o.errors) || 0,
        websites: Number(o.websites) || 0,
        spendUsd: Number(o.spendUsd) || 0,
        hasSpend: o.hasSpend === true,
        command: typeof o.command === "string" ? o.command : undefined,
      });
    } catch { /* skip a malformed line */ }
  }
  return out;
}

export interface RunStats {
  runs: number;
  succeeded: number;        // outcome === "met"
  successRate: number;      // succeeded / runs (0 when no runs)
  avgItersToSucceed: number; // mean iterations over SUCCEEDED runs (0 when none)
  avgDurationMs: number;
  totalTools: number;
  toolsByType: Record<string, number>;
  totalAdded: number;
  totalRemoved: number;
  totalErrors: number;
  totalSpendUsd: number;   // P-GOAL.11: summed actual spend over runs that reported it
  /** non-success runs grouped by recurring blocker (normalized reason), most-common first. */
  topBlockers: { reason: string; count: number }[];
}

/** Aggregate a run history into the evaluation stats. Pure + deterministic. Blocker grouping reuses
 *  `stallSignature` so "3 of 5 tests fail" and "2 of 5 tests fail" collapse to ONE recurring blocker;
 *  the displayed `reason` is the first full reason seen for that signature. */
export function aggregateRuns(records: LoopRunRecord[]): RunStats {
  const runs = records.length;
  const met = records.filter((r) => r.outcome === "met");
  const toolsByType: Record<string, number> = {};
  let totalTools = 0, totalAdded = 0, totalRemoved = 0, totalErrors = 0, totalDuration = 0, totalSpendUsd = 0;
  for (const r of records) {
    totalTools += r.tools;
    totalAdded += r.added;
    totalRemoved += r.removed;
    totalErrors += r.errors;
    totalDuration += r.durationMs;
    if (r.hasSpend) totalSpendUsd += r.spendUsd;
    for (const [k, v] of Object.entries(r.toolsByType)) toolsByType[k] = (toolsByType[k] ?? 0) + (Number(v) || 0);
  }
  // failure breakdown: group the non-met runs by normalized blocker signature
  const blockers = new Map<string, { reason: string; count: number }>();
  for (const r of records) {
    if (r.outcome === "met") continue;
    const sig = stallSignature(r.outcomeReason) || "(unspecified)";
    const cur = blockers.get(sig);
    if (cur) cur.count++;
    else blockers.set(sig, { reason: r.outcomeReason || "(unspecified)", count: 1 });
  }
  const topBlockers = [...blockers.values()].sort((a, b) => b.count - a.count);
  return {
    runs,
    succeeded: met.length,
    successRate: runs ? met.length / runs : 0,
    avgItersToSucceed: met.length ? met.reduce((a, r) => a + r.iterations, 0) / met.length : 0,
    avgDurationMs: runs ? totalDuration / runs : 0,
    totalTools,
    toolsByType,
    totalAdded,
    totalRemoved,
    totalErrors,
    totalSpendUsd,
    topBlockers,
  };
}

/** A compact one-line eval summary for a chip/header, e.g. "12 runs · 75% met · ~3.2 iters to win". */
export function summarizeRunStats(s: RunStats): string {
  if (!s.runs) return "no loop runs yet";
  const pct = Math.round(s.successRate * 100);
  const iters = s.avgItersToSucceed ? ` · ~${s.avgItersToSucceed.toFixed(1)} iters to win` : "";
  return `${s.runs} run${s.runs === 1 ? "" : "s"} · ${pct}% met${iters}`;
}
