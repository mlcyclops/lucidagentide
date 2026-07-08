// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_peval3b.ts
//
// P-EVAL.3 Part B (ADR-0187): the cross-run Model-Evaluation ROLLUP report, end to end - exactly the path
// the /api/eval/rollup route takes. Proves, offline:
//   [1] the two GUI-owned JSONL ledgers (eval-metrics from P-EVAL.3a, latency from P-EVAL.2) ingest into a
//       THROWAWAY DuckDB the GUI owns (no write-lock contention with agent_obs.duckdb),
//   [2] readEvalMetricsRows -> aggregateEvalMetrics rolls per model (means over runs-with-signal; a metric
//       with no signal stays "no signal", never a fake 0),
//   [3] readLatencyCalls -> rollupLatency adds the per-model p50/p95 latency section,
//   [4] the combined markdown is ASCII-only (gate-safe) with the xychart-beta blocks the viewer bar-ifies,
//   [5] an EMPTY ledger still yields a friendly report, never an error.
//
// Run with: bun run harness/scripts/demo_peval3b.ts

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../memory/db.ts";
import { ingestEvalMetrics, evalMetricsToSample } from "../memory/eval_metrics_ingest.ts";
import { ingestLatency, type LatencySample } from "../memory/latency_ingest.ts";
import { readEvalMetricsRows } from "../memory/eval_metrics_ingest.ts";
import { readLatencyCalls } from "../memory/latency_ingest.ts";
import { renderEvalMetricsRollupMarkdown, aggregateEvalMetrics } from "../brief/eval_metrics_report.ts";
import { rollupLatency, renderLatencyRollupMarkdown, computeEvalMetrics, type RunRecord } from "../brief/evals.ts";

function fail(m: string): never { console.error(`FAIL: ${m}`); process.exit(1); }
function ok(m: string): void { console.log(`  PASS  ${m}`); }

console.log("P-EVAL.3 Part B demo - cross-run Model-Evaluation rollup\n");

const dir = mkdtempSync(join(tmpdir(), "peval3b-"));
const evalJsonl = join(dir, "lucid-eval-metrics.jsonl");
const latJsonl = join(dir, "lucid-latency.jsonl");
const T = Date.UTC(2026, 6, 15, 14);

// Two runs on the same model: A has NO tests/AC (honest nulls), B HAS tests (real testPassRate).
const runA: RunRecord = { runId: "a", model: "claude-opus-4-8", tokens: { ctx: 16000, output: 2400, total: 18400 }, costUsd: 0.42, toolCalls: 10, toolFailures: [{ tool: "bash", reason: "exit 1" }], files: [{ path: "a.ts", add: 60, del: 5 }] };
const runB: RunRecord = { runId: "b", model: "claude-opus-4-8", tokens: { ctx: 12000, output: 1500, total: 13500 }, costUsd: 0.3, toolCalls: 6, toolFailures: [], files: [{ path: "b.ts", add: 30, del: 0 }], tests: { pass: 40, fail: 0 }, ac: { total: 5, met: 5 } };
writeFileSync(evalJsonl, [evalMetricsToSample(computeEvalMetrics(runA), T), evalMetricsToSample(computeEvalMetrics(runB), T + 1000)].map((s) => JSON.stringify(s)).join("\n") + "\n");

const latSample = (i: number, ok = true): LatencySample => ({ id: `l${i}`, model: "claude-opus-4-8", ts: T + i * 60_000, ttftMs: 400 + i * 20, totalMs: 3000 + i * 100, ok });
writeFileSync(latJsonl, [latSample(0), latSample(1), latSample(2)].map((s) => JSON.stringify(s)).join("\n") + "\n");

try {
  // [5] empty ledger first (no ingest) -> friendly report
  const empty = renderEvalMetricsRollupMarkdown([]);
  if (!empty.includes("No runs recorded yet") || empty.includes("xychart")) fail("empty ledger should be a friendly note with no chart");
  ok("empty ledger: a friendly 'no runs recorded yet' report, never an error");

  // [1] ingest both JSONL ledgers into a throwaway DB (the route's path)
  const db = await Db.open(join(dir, "rollup.duckdb"));
  await ingestEvalMetrics(db, evalJsonl);
  await ingestLatency(db, latJsonl);
  ok("ingest: the eval-metrics + latency JSONL ledgers loaded into a throwaway GUI-owned DuckDB");

  // [2] rows -> aggregate
  const rows = await readEvalMetricsRows(db);
  if (rows.length !== 2) fail("readback count off");
  const agg = aggregateEvalMetrics(rows)[0]!;
  if (agg.runs !== 2 || agg.totalNetLoc !== 85) fail(`aggregate off: runs=${agg.runs} netLoc=${agg.totalNetLoc}`); // 55 + 30
  if (agg.metrics.testPassRate.n !== 1 || agg.metrics.testPassRate.mean !== 100) fail("testPassRate should average over the ONE run that had tests");
  if (agg.metrics.specConformance.mean !== 100) fail("specConformance mean off");
  ok("aggregate: 2 runs -> per-model means (netLoc 85; testPassRate averaged over the 1 run with tests, null-run excluded)");

  // [3][4] render combined
  let markdown = renderEvalMetricsRollupMarkdown(rows);
  const calls = await readLatencyCalls(db);
  const roll = rollupLatency(calls, { period: "weekly", periodStart: T, metric: "ttft" });
  markdown += "\n\n" + renderLatencyRollupMarkdown(roll);
  if (!markdown.includes("# Model Evaluation Rollup") || !markdown.includes("# Model Latency Rollup")) fail("combined report missing a section");
  if ((markdown.match(/xychart-beta/g) ?? []).length < 2) fail("expected an eval chart + a latency chart");
  if (/[^\x00-\x7F]/.test(markdown)) fail("combined markdown must be ASCII-only (gate-safe)");
  ok("render: eval rollup + latency rollup combined, per-model xychart-beta blocks, ASCII-only (viewer bar-ifies)");

  db.close();
  console.log("\n--- sample cross-run rollup ---\n");
  console.log(markdown);
  console.log("\nP-EVAL.3 Part B demo complete - the JSONL ledgers roll into a combined, honest, gate-safe Model-Evaluation report.");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
