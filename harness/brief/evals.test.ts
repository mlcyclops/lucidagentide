// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-EVAL.1 (ADR-0178): the pure eval-metrics + API-latency rollup core. Over-tests the load-bearing
// math: nearest-rank percentiles, DST-correct business-hours bucketing, the metric formulas + their
// direct/proxy/needs_signal tiers (never zero-as-truth), and the per-model x hour rollup + WoW deltas.

import { expect, test } from "bun:test";
import {
  compareRollup, computeEvalMetrics, hourEt, percentile, renderEvalMarkdown, renderLatencyRollupMarkdown,
  rollupLatency, type ApiLatencyCall, type RunRecord,
} from "./evals.ts";

test("percentile is deterministic nearest-rank (ceil), empty -> 0", () => {
  expect(percentile([], 50)).toBe(0);
  expect(percentile([5], 95)).toBe(5);
  expect(percentile([10, 20, 30, 40], 50)).toBe(20); // ceil(.5*4)=2 -> idx1
  expect(percentile([10, 20, 30, 40], 95)).toBe(40); // ceil(.95*4)=4 -> idx3
  expect(percentile([30, 10, 20], 50)).toBe(20); // sorts first
});

test("hourEt buckets Eastern time and handles EST/EDT DST", () => {
  // same 12:00 UTC lands in different Eastern hours across DST
  const winter = hourEt(Date.UTC(2026, 0, 15, 12)); // Jan -> EST (UTC-5) -> 07:00
  expect(winter.hour).toBe(7);
  expect(winter.business).toBe(false); // 07:00 is before the 08:00 window
  const summer = hourEt(Date.UTC(2026, 6, 15, 12)); // Jul -> EDT (UTC-4) -> 08:00
  expect(summer.hour).toBe(8);
  expect(summer.business).toBe(true);
  const evening = hourEt(Date.UTC(2026, 6, 15, 23)); // EDT -> 19:00 -> off-hours
  expect(evening.business).toBe(false);
});

const baseRun: RunRecord = {
  runId: "01JZ", model: "claude-opus-4-8",
  tokens: { ctx: 16300, output: 2400, total: 18700 }, costUsd: 0.42,
  toolCalls: 12, toolFailures: [{ tool: "bash", reason: "not found" }, { tool: "search", reason: "no matches" }],
  files: [{ path: "desktop/renderer/app.ts", add: 63, del: 4 }, { path: "desktop/trivia_seed.ts", add: 140, del: 0 }],
  tests: { pass: 42, fail: 0 }, ac: { total: 6, met: 6 },
};

test("computeEvalMetrics: formulas + tiers on a full run", () => {
  const m = computeEvalMetrics(baseRun);
  expect([m.grossAdd, m.grossDel, m.netLoc]).toEqual([203, 4, 199]);
  expect(m.churnPct.value).toBe(2); // round1(100*4/203)
  expect(m.tokensPerNetLoc.value).toBe(12.1); // round1(2400/199)
  expect(m.tokensPerNetLoc.tier).toBe("proxy");
  expect(m.contextEfficiency.value).toBe(6.8); // round1(16300/2400)
  expect(m.toolFailRate.value).toBe(16.7);
  expect(m.toolFailRate.tier).toBe("direct");
  expect(m.wastedTokensEst.value).toBe(3164); // failRate*total + churn*output
  expect(m.testPassRate.value).toBe(100);
  expect(m.specConformance.value).toBe(100);
  expect(m.predictedAcceptance.value).toBe(98);
  expect(m.tokensPerQualityFeature.value).toBe(3117); // round(18700/6)
  expect(m.provenance.map((p) => p.netKept)).toEqual([59, 140]);
});

test("computeEvalMetrics: missing signals -> null + needs_signal, never zero", () => {
  const noAc = computeEvalMetrics({ ...baseRun, ac: undefined });
  expect(noAc.specConformance.value).toBeNull();
  expect(noAc.specConformance.tier).toBe("needs_signal");
  expect(noAc.predictedAcceptance.value).toBeNull();
  expect(noAc.predictedAcceptance.tier).toBe("needs_signal");
  expect(noAc.tokensPerQualityFeature.tier).toBe("needs_signal");

  const noClean = computeEvalMetrics(baseRun);
  expect(noClean.tokensPerCleanLoc.tier).toBe("needs_signal"); // falls back to surviving net LOC
  const withClean = computeEvalMetrics({ ...baseRun, cleanLoc: 150 });
  expect(withClean.tokensPerCleanLoc.tier).toBe("direct");
  expect(withClean.tokensPerCleanLoc.value).toBe(16); // round1(2400/150)

  const noTests = computeEvalMetrics({ ...baseRun, tests: undefined });
  expect(noTests.testPassRate.tier).toBe("needs_signal");
});

const jul = (h: number): number => Date.UTC(2026, 6, 15, h); // July -> EDT (UTC-4): ET hour = h-4
const calls: ApiLatencyCall[] = [
  // model A, 3 calls at 13:00Z = 09:00 ET (business)
  { model: "A", ts: jul(13), ttftMs: 100, totalMs: 900, ok: true },
  { model: "A", ts: jul(13), ttftMs: 200, totalMs: 1200, ok: true },
  { model: "A", ts: jul(13), ttftMs: 300, totalMs: 1500, ok: true },
  // model A, 1 call OFF-hours at 02:00Z = 22:00 ET prev day -> excluded
  { model: "A", ts: jul(2), ttftMs: 9999, totalMs: 9999, ok: true },
  // model B, 2 calls at 14:00Z = 10:00 ET (business)
  { model: "B", ts: jul(14), ttftMs: 50, totalMs: 400, ok: true },
  { model: "B", ts: jul(14), ttftMs: 150, totalMs: 600, ok: true },
];

test("rollupLatency: business-hours only, per model x hour p50/p95, sorted by volume", () => {
  const r = rollupLatency(calls, { period: "weekly", periodStart: jul(0) });
  expect(r.metric).toBe("ttft");
  expect(r.businessHours).toEqual([8, 17]);
  expect(r.models.map((m) => m.model)).toEqual(["A", "B"]); // A(3) before B(2)
  const a = r.models[0]!;
  expect(a.calls).toBe(3); // off-hours call excluded
  expect(a.byHour).toHaveLength(1);
  expect(a.byHour[0]!.hourEt).toBe(9);
  expect(a.byHour[0]!.p50).toBe(200); // [100,200,300] nearest-rank
  expect(a.byHour[0]!.p95).toBe(300);
  expect(a.p50).toBe(200);
  const b = r.models[1]!;
  expect(b.byHour[0]!.hourEt).toBe(10);
  expect(b.byHour[0]!.p50).toBe(50); // [50,150] p50 -> idx0
  expect(b.byHour[0]!.p95).toBe(150);
});

test("rollupLatency: total metric + businessOnly:false include everything", () => {
  const rt = rollupLatency(calls, { period: "weekly", periodStart: jul(0), metric: "total" });
  expect(rt.metric).toBe("total");
  expect(rt.models[0]!.byHour[0]!.p50).toBe(1200); // totals [900,1200,1500] p50
  const all = rollupLatency(calls, { period: "weekly", periodStart: jul(0), businessOnly: false });
  expect(all.models[0]!.calls).toBe(4); // off-hours call now counted
});

test("compareRollup: WoW deltas per model, null prev for a new model", () => {
  const cur = rollupLatency(calls, { period: "weekly", periodStart: jul(0) });
  const prev = rollupLatency(
    [{ model: "A", ts: jul(13), ttftMs: 100, totalMs: 900, ok: true }, { model: "A", ts: jul(13), ttftMs: 100, totalMs: 900, ok: true }],
    { period: "weekly", periodStart: jul(0) - 7 * 864e5 },
  );
  const d = compareRollup(cur, prev);
  const a = d.find((x) => x.model === "A")!;
  expect(a.prevP50).toBe(100);
  expect(a.deltaP50Pct).toBe(100); // 200 vs 100 = +100%
  const b = d.find((x) => x.model === "B")!;
  expect(b.prevP50).toBeNull(); // B is new this period
  expect(b.deltaP50Pct).toBeNull();
});

test("render: markdown emits mermaid xychart the viewer bar-ifies; ASCII-only", () => {
  const cur = rollupLatency(calls, { period: "weekly", periodStart: jul(0) });
  const md = renderLatencyRollupMarkdown(cur, cur);
  expect(md).toContain("xychart-beta");
  expect(md).toContain("Week-over-week comparison");
  expect(md).toContain("America/New_York");
  expect(/[^\x00-\x7F]/.test(md)).toBe(false); // no non-ASCII (homoglyph-safe for the gate)

  const em = renderEvalMarkdown(computeEvalMetrics(baseRun), { costUsd: 0.42, totalTokens: 18700, when: "2026-07-07" });
  expect(em).toContain("# Model Evaluation");
  expect(em).toContain("xychart-beta"); // provenance chart
  expect(em).toContain("needs_signal"); // tokens-per-clean-line tier shows honestly
  expect(/[^\x00-\x7F]/.test(em)).toBe(false);
});
