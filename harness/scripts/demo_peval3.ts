// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_peval3.ts
//
// P-EVAL.3 Part A (ADR-0187): the per-run eval-metrics PERSISTENCE pipeline. Proves, offline, the path a
// settled turn takes when its Model-Evaluation report is generated:
//   [1] evalMetricsForTurn maps an observed turn -> RunRecord -> EvalMetrics (reusing P-CHAT.C + P-EVAL.1),
//   [2] the GUI-side sink (recordEvalMetrics) flattens it to a sample + appends to an append-only JSONL,
//       KEEPING the honesty rule: a metric with no signal (no tests/AC) is null (never 0) + needs_signal,
//   [3] the single-writer ingest loads the JSONL into eval_metrics IDEMPOTENTLY (re-ingest inserts 0),
//   [4] readEvalMetricsRows round-trips the rows back (ts as UNIX ms, NULLs + tiers intact) for the rollup.
//
// Run with: bun run harness/scripts/demo_peval3.ts

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../memory/db.ts";
import { ingestEvalMetrics, readEvalMetricsRows } from "../memory/eval_metrics_ingest.ts";
import { recordEvalMetrics } from "../../desktop/eval_metrics_log.ts";
import { evalMetricsForTurn, type ObservedTurn } from "../brief/eval_report.ts";

function fail(m: string): never { console.error(`FAIL: ${m}`); process.exit(1); }
function ok(m: string): void { console.log(`  PASS  ${m}`); }

console.log("P-EVAL.3 demo - per-run eval-metrics persistence pipeline\n");

const dir = mkdtempSync(join(tmpdir(), "peval3-"));
const jsonl = join(dir, "lucid-eval-metrics.jsonl");
const T = Date.UTC(2026, 6, 15, 14);

// Two settled turns, as the renderer/route observed them. Turn A has NO tests/AC (metrics stay honest-null);
// turn B is a different run on the same model.
const turnA: ObservedTurn = {
  runId: "run-a", model: "claude-opus-4-8", ctxTokens: 16000, outputTokens: 2400, totalTokens: 18400, costUsd: 0.42,
  tools: [{ name: "edit", path: "app.ts", add: 60, del: 5 }, { name: "read", path: "x.ts" }, { name: "bash" }],
  failures: [{ tool: "bash", reason: "exit 1" }], when: "2026-07-15",
};
const turnB: ObservedTurn = { ...turnA, runId: "run-b", tools: [{ name: "write", path: "b.ts", add: 30, del: 0 }] };

try {
  const db = await Db.open(join(dir, "obs.duckdb"));
  if (!(await db.appliedVersions()).includes(11)) fail("migration 0011 not applied");

  // [1][2] compute + sink
  const s = recordEvalMetrics(evalMetricsForTurn(turnA), T, { logPath: jsonl });
  recordEvalMetrics(evalMetricsForTurn(turnB), T + 1000, { logPath: jsonl });
  if (!s || s.netLoc !== 55) fail("sink netLoc wrong");
  if (s.testPassRate !== null || s.tiers.testPassRate !== "needs_signal") fail("no-test metric must be null + needs_signal, never 0");
  if (s.toolFailRate == null || s.tiers.toolFailRate !== "direct") fail("tool-fail-rate should be a direct signal");
  ok("compute + sink: observed turn -> EvalMetrics -> flat sample (netLoc 55; testPassRate null+needs_signal; toolFailRate direct) appended to JSONL");

  // [3] ingest -> eval_metrics, idempotent
  const first = await ingestEvalMetrics(db, jsonl);
  if (first.inserted !== 2 || first.skipped !== 0) fail(`ingest expected 2 inserted, got ${first.inserted}/${first.skipped}`);
  const again = await ingestEvalMetrics(db, jsonl);
  if (again.inserted !== 0 || again.duplicates !== 2) fail("re-ingest not idempotent");
  ok("ingest: 2 runs -> eval_metrics; re-ingesting the same file inserts 0 (run_id is the dedup key)");

  // [4] readback: NULLs + tiers survive
  const rows = await readEvalMetricsRows(db, { model: "claude-opus-4-8" });
  if (rows.length !== 2) fail("readback count off");
  const a = rows.find((r) => r.runId === "run-a")!;
  if (a.ts !== T) fail("ts did not round-trip to UNIX ms");
  if (a.testPassRate !== null || a.tiers.testPassRate !== "needs_signal") fail("null-not-zero + tier did not survive the DB round-trip");
  ok("readback: rows -> EvalMetricsSample (ts UNIX ms); NULL-not-zero + direct/proxy/needs_signal tiers intact");

  db.close();
  console.log("\nP-EVAL.3 demo complete - per-run metrics captured at report time, persisted via the single-writer ingest, read back honest (null-not-zero, tiers preserved). The cross-run rollup + report kind is Part B.");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
