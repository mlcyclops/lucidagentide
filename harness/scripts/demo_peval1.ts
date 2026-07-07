// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_peval1.ts
//
// P-EVAL.1 (ADR-0187): the pure Model-Evaluation metrics + API-latency rollup core. Proves, offline:
//   [1] metric formulas + honesty tiers (direct/proxy/needs_signal; a missing signal is null, never 0),
//   [2] DST-correct business-hours bucketing (08:00-17:00 America/New_York) + nearest-rank p50/p95,
//   [3] the per-model x hour rollup excludes off-hours calls and sorts by volume,
//   [4] week-over-week deltas, and [5] the rendered markdown is ASCII-only mermaid xychart the report
//       viewer bar-ifies. Then prints a sample per-run report + weekly rollup.
//
// Run with: bun run harness/scripts/demo_peval1.ts

import {
  compareRollup, computeEvalMetrics, hourEt, percentile, renderEvalMarkdown, renderLatencyRollupMarkdown,
  rollupLatency, type ApiLatencyCall, type RunRecord,
} from "../brief/evals.ts";

function fail(m: string): never { console.error(`FAIL: ${m}`); process.exit(1); }
function ok(m: string): void { console.log(`  PASS  ${m}`); }

console.log("P-EVAL.1 demo - Model-Evaluation metrics + API-latency rollup\n");

// [1] metrics + tiers
const run: RunRecord = {
  runId: "01JZ", model: "claude-opus-4-8",
  tokens: { ctx: 16300, output: 2400, total: 18700 }, costUsd: 0.42,
  toolCalls: 12, toolFailures: [{ tool: "bash", reason: "not found" }, { tool: "search", reason: "no matches" }],
  files: [{ path: "desktop/renderer/app.ts", add: 63, del: 4 }, { path: "desktop/trivia_seed.ts", add: 140, del: 0 }],
  tests: { pass: 42, fail: 0 }, ac: { total: 6, met: 6 },
};
const m = computeEvalMetrics(run);
if (m.netLoc !== 199 || m.contextEfficiency.value !== 6.8 || m.predictedAcceptance.value !== 98) fail("metric formulas off");
if (m.toolFailRate.tier !== "direct" || m.tokensPerNetLoc.tier !== "proxy") fail("tiers off");
const noAc = computeEvalMetrics({ ...run, ac: undefined });
if (noAc.specConformance.value !== null || noAc.specConformance.tier !== "needs_signal") fail("missing AC must be null + needs_signal, never 0");
ok("metrics: formulas + direct/proxy/needs_signal tiers; a missing signal is null (never zero-as-truth)");

// [2] DST + percentiles
if (hourEt(Date.UTC(2026, 0, 15, 12)).hour !== 7 || hourEt(Date.UTC(2026, 6, 15, 12)).hour !== 8) fail("DST bucketing off");
if (percentile([10, 20, 30, 40], 95) !== 40 || percentile([], 50) !== 0) fail("percentile off");
ok("business-hours bucketing is DST-correct (EST 07:00 vs EDT 08:00 for the same 12:00 UTC); p50/p95 nearest-rank");

// [3][4] rollup + deltas
const jul = (h: number): number => Date.UTC(2026, 6, 15, h);
const calls: ApiLatencyCall[] = [
  { model: "claude-opus-4-8", ts: jul(13), ttftMs: 520, totalMs: 3100, ok: true },
  { model: "claude-opus-4-8", ts: jul(13), ttftMs: 640, totalMs: 3200, ok: true },
  { model: "claude-opus-4-8", ts: jul(19), ttftMs: 950, totalMs: 4100, ok: true }, // 15:00 ET
  { model: "claude-opus-4-8", ts: jul(2), ttftMs: 9999, totalMs: 9999, ok: true }, // off-hours -> excluded
  { model: "haiku-4-5", ts: jul(13), ttftMs: 180, totalMs: 800, ok: true },
  { model: "haiku-4-5", ts: jul(19), ttftMs: 290, totalMs: 950, ok: true },
];
const cur = rollupLatency(calls, { period: "weekly", periodStart: jul(0) });
if (cur.models[0]?.calls !== 3) fail("off-hours call not excluded");
if (cur.models.map((x) => x.model).join() !== "claude-opus-4-8,haiku-4-5") fail("not sorted by volume");
const opusHours = cur.models[0]!.byHour.map((b) => b.hourEt);
if (opusHours.join() !== "9,15") fail(`unexpected hour buckets: ${opusHours}`);
const prev = rollupLatency([{ model: "claude-opus-4-8", ts: jul(13), ttftMs: 600, totalMs: 3000, ok: true }], { period: "weekly", periodStart: jul(0) - 7 * 864e5 });
const d = compareRollup(cur, prev).find((x) => x.model === "claude-opus-4-8")!;
if (d.prevP50 !== 600 || d.deltaP50Pct == null) fail("WoW delta off");
ok("rollup: off-hours excluded, per-model-by-hour p50/p95, sorted by volume, WoW deltas computed");

// [5] render
const md = renderLatencyRollupMarkdown(cur, prev);
if (!md.includes("xychart-beta") || !md.includes("Week-over-week")) fail("rollup markdown missing chart/comparison");
if (/[^\x00-\x7F]/.test(md) || /[^\x00-\x7F]/.test(renderEvalMarkdown(m, { costUsd: 0.42, totalTokens: 18700 }))) fail("generated markdown must be ASCII-only (homoglyph-safe for the gate)");
ok("render: per-model mermaid xychart (viewer bar-ifies) + ASCII-only (gate-safe)");

console.log("\n--- sample per-run report ---\n");
console.log(renderEvalMarkdown(m, { costUsd: 0.42, totalTokens: 18700, when: "2026-07-07" }));
console.log("\n--- sample weekly latency rollup ---\n");
console.log(md);
console.log("\nP-EVAL.1 demo complete - metrics honest (tiered, null-not-zero), latency rolled per model by business hour, ASCII/gate-safe.");
