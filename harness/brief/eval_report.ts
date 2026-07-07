// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/brief/eval_report.ts
//
// P-CHAT.C (ADR-0181): the PURE adapter that turns a chat turn's OBSERVED telemetry (the tool calls the
// renderer saw fire, their per-file diffstats, the turn's tokens/cost/failures) into the RunRecord that
// P-EVAL.1's evals.ts already knows how to score + render. It is the load-bearing seam behind the settled
// turn's "Generate engineering report" button and the `/api/eval/report` route: the renderer/route pass
// only what they genuinely observed, this maps it into a RunRecord (merging repeated edits per file,
// counting re-edits as a rework/churn proxy, never inventing tests/AC/lint signals), and evals.ts does the
// metric math + the ASCII-only mermaid markdown the P-REPORT.4 viewer bar-ifies.
//
// PURE by construction: no I/O, no Date.now() (the caller passes `when`). Mirrors the P-CHAT.A/B keystone
// pattern - the DOM/route wiring is thin and QA-gated; the load-bearing mapping is tested here.

import { computeEvalMetrics, renderEvalMarkdown, type FileChange, type RunRecord } from "./evals.ts";

/** One tool call the chat turn made, as the renderer observed it. A write/edit carries a file `path` and a
 *  +/- diffstat (the P-CHAT.1 code the chip already sized); a read/search/bash carries neither. */
export interface ObservedTool { name: string; path?: string; add?: number; del?: number }

/** A settled chat turn's observed telemetry - everything the report needs that is actually knowable at the
 *  chat seam. The AC / lint / test signals (and P-EVAL.2's DuckDB capture) are deferred, so the metrics that
 *  depend on them stay `needs_signal` rather than being faked - the ADR-A016 honesty rule. */
export interface ObservedTurn {
  runId: string;
  model: string;
  ctxTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  tools: ObservedTool[];
  failures?: { tool: string; reason: string; cmd?: string }[];
  subagents?: number;
  when?: string;
}

/** Clamp a possibly-missing / negative / NaN count to a non-negative integer (a hostile or lossy client
 *  payload must never produce a negative LOC or a NaN metric). */
const nn = (n: number | undefined): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

/** Map an observed turn into evals.ts's RunRecord. A tool is a FILE change iff it has a `path` AND a diffstat
 *  (add or del) - reads/searches/bash have no diffstat and are NOT files. Repeated writes to the same path
 *  merge (adds/dels summed); the surplus writes beyond the distinct files are counted as re-edits (a
 *  churn/rework proxy that feeds `wastedTokensEst`). All lines are AI-authored at this seam, so the
 *  provenance aiAdd/aiDel equal add/del. PURE. */
export function buildRunRecord(t: ObservedTurn): RunRecord {
  const byPath = new Map<string, FileChange>();
  let writeOps = 0;
  for (const x of t.tools) {
    if (!x.path || (x.add == null && x.del == null)) continue; // not a file change (read/search/bash)
    writeOps++;
    const add = nn(x.add), del = nn(x.del);
    const cur = byPath.get(x.path);
    if (cur) { cur.add += add; cur.del += del; cur.aiAdd = (cur.aiAdd ?? 0) + add; cur.aiDel = (cur.aiDel ?? 0) + del; }
    else byPath.set(x.path, { path: x.path, add, del, aiAdd: add, aiDel: del });
  }
  const files = [...byPath.values()];
  return {
    runId: t.runId,
    model: t.model,
    tokens: { ctx: nn(t.ctxTokens), output: nn(t.outputTokens), total: nn(t.totalTokens) },
    costUsd: typeof t.costUsd === "number" && Number.isFinite(t.costUsd) && t.costUsd > 0 ? t.costUsd : 0,
    toolCalls: t.tools.length,
    toolFailures: (t.failures ?? []).map((f) => ({ tool: f.tool, reason: f.reason, cmd: f.cmd })),
    subagents: t.subagents,
    reEdits: Math.max(0, writeOps - files.length),
    files,
  };
}

/** Compute + render the turn's Model-Evaluation report markdown (reusing evals.ts). Returns the report-store
 *  title (matching the markdown's own `# ` heading) + the ASCII-only mermaid markdown the P-REPORT.4 viewer
 *  bar-ifies. PURE. */
export function renderTurnEvalReport(t: ObservedTurn): { title: string; markdown: string } {
  const run = buildRunRecord(t);
  const metrics = computeEvalMetrics(run);
  const markdown = renderEvalMarkdown(metrics, { costUsd: run.costUsd, totalTokens: run.tokens.total, when: t.when });
  return { title: `Model Evaluation - ${t.model}`, markdown };
}
