// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-EVAL.1 (ADR-0187): the pure eval-metrics + API-latency rollup core. Over-tests the load-bearing
// math: nearest-rank percentiles, DST-correct business-hours bucketing, the metric formulas + their
// direct/proxy/needs_signal tiers (never zero-as-truth), and the per-model x hour rollup + WoW deltas.
//
// P-EVAL.4 (ADR-0187) adds the second half: the four metrics nothing in the pipeline ever populated now
// carry a labelled DERIVED substitute, the per-tool breakdown groups by real tool name, and the report
// states its gaps out loud. The tests below pin BOTH axes, because the whole point is that the derived
// proxies improve the report without ever entering the measured values migration 0011 persists.

import { expect, test } from "bun:test";
import {
  compareRollup, computeEvalMetrics, filesTouched, hourEt, percentile, renderEvalMarkdown,
  renderLatencyRollupMarkdown, rollupLatency, toolBreakdown, toolSummaryLine,
  type ApiLatencyCall, type RunRecord, type ToolRecord,
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

// Deliberately UNCHANGED by P-EVAL.4. This test pins the MEASURED axis: the values + tiers that
// eval_metrics_log.ts flattens and migration 0011 stores. A derived proxy must never move any of them.
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
  // P-EVAL.4: baseRun has tests + AC, so nothing on its rendered table is unmeasurable any more. The old
  // assertion here was a bare `toContain("needs_signal")`, which only ever passed because tokens-per-clean-
  // line printed that jargon on EVERY report; it now shows a labelled derived proxy instead. What has to
  // stay honest is the provenance column, so assert that directly.
  expect(em).toContain("| Tokens per clean line | 12.3 gen/line | proxy | derived |");
  expect(em).toContain("| Test pass rate | 100% | direct | measured |");
  expect(/[^\x00-\x7F]/.test(em)).toBe(false);
});

// ── P-EVAL.4 (ADR-0187): derived metrics, provenance, and rich per-tool detail ─────────────────────────

/** The pre-P-EVAL.4 RunRecord: ONLY the fields P-EVAL.1 required. An older client still posts exactly this,
 *  and it must still compute + render a complete report. */
const oldShapeRun: RunRecord = {
  runId: "old-1", model: "claude-opus-5",
  tokens: { ctx: 16300, output: 2400, total: 18700 }, costUsd: 0.42,
  toolCalls: 12, toolFailures: [{ tool: "bash", reason: "not found" }],
  files: [{ path: "desktop/renderer/app.ts", add: 63, del: 4 }],
};

/** A run whose caller DID have the richer telemetry: real tool names, a coarse kind, per-call ok + duration.
 *  23 calls that the coarse ACP kind alone would have collapsed into "read"/"edit"/"other". */
const richRun: RunRecord = {
  runId: "rich-1", model: "claude-opus-5",
  tokens: { ctx: 200_000, output: 9_000, total: 209_000 }, costUsd: 1.5,
  toolCalls: 23,
  toolFailures: [{ tool: "bash", reason: "1 test failed", cmd: "bun test harness/brief/" }],
  files: [{ path: "harness/brief/evals.ts", add: 250, del: 40 }, { path: "harness/brief/evals.test.ts", add: 120, del: 0 }],
  tools: [
    ...Array.from({ length: 14 }, (): ToolRecord => ({ name: "read", kind: "read", detail: "harness/brief/evals.ts", ok: true, durationMs: 20 })),
    ...Array.from({ length: 6 }, (): ToolRecord => ({ name: "edit", kind: "edit", detail: "harness/brief/evals.ts", ok: true, durationMs: 80 })),
    { name: "bash", kind: "other", detail: "bun test harness/brief/", ok: false, durationMs: 4000 },
    { name: "bash", kind: "other", detail: "bun test harness/brief/", ok: true, durationMs: 3800 },
    { name: "bash", kind: "other", detail: "bun run typecheck", ok: true, durationMs: 9000 },
  ],
};

const render = (r: RunRecord): string =>
  renderEvalMarkdown(computeEvalMetrics(r), { costUsd: r.costUsd, totalTokens: r.tokens.total });
const rowFor = (md: string, label: string): string | undefined => md.split("\n").find((l) => l.startsWith(`| ${label} |`));

test("P-EVAL.4: an old-shape RunRecord renders a full report with the four dead metrics derived", () => {
  const m = computeEvalMetrics(oldShapeRun);
  for (const k of ["tokensPerCleanLoc", "specConformance", "dodCompletion", "predictedAcceptance"] as const) {
    expect(m.sources?.[k]).toBe("derived");
    expect(m.derived?.[k]?.value).toBeGreaterThan(0);
    expect(m.derived?.[k]?.tier).toBe("proxy"); // a substitute is a PROXY, never dressed up as direct
  }
  const md = render(oldShapeRun);
  expect(md).toContain("## Efficiency");
  expect(md).toContain("## Specification conformance and acceptance");
  expect(md).toContain("| Spec conformance | 55% | proxy | derived |");   // 0.6*(1-1/12), unverified, ended dirty
  expect(md).toContain("| Definition of done | 27% | proxy | derived |"); // 0.3*(1-1/12), nothing verified
  expect(md).toContain("| Tokens per clean line | 43.6 gen/line | proxy | derived |"); // 2400 / churn-discounted 55
  // No metric that IS derivable may still print the pre-P-EVAL.4 "no signal" jargon.
  for (const label of ["Spec conformance", "Definition of done", "Predicted acceptance", "Tokens per clean line"]) {
    expect(rowFor(md, label)).not.toContain("needs_signal");
    expect(rowFor(md, label)).not.toContain("needs AC");
  }
});

test("P-EVAL.4: derived proxies never leak into the measured axis the eval_metrics ledger persists", () => {
  // migration 0011 + eval_metrics_ingest.ts flatten ONLY `<metric>.value` and `.tier`. A derived proxy
  // landing there would make the cross-run rollup average one real AC check against one tool-failure guess,
  // which is exactly the fake precision ADR-A016 forbids.
  const m = computeEvalMetrics(oldShapeRun);
  for (const k of ["specConformance", "predictedAcceptance", "tokensPerQualityFeature"] as const) {
    expect(m.derived?.[k]).toBeDefined();
    expect(m[k].value).toBeNull();
    expect(m[k].tier).toBe("needs_signal");
  }
  expect(m.derived?.dodCompletion).toBeDefined();
  expect(m.dodCompletion?.value).toBeNull();
  // The one pre-existing exception: P-EVAL.1 already emitted an UNNAMED net-LOC substitute for tokens per
  // clean line (a value carrying a needs_signal tier). P-EVAL.4 leaves that persisted value byte-identical
  // and only names the substitute, so the ledger's history stays comparable across the increment.
  expect(m.tokensPerCleanLoc.value).toBe(40.7); // round1(2400/59), unchanged
  expect(m.tokensPerCleanLoc.tier).toBe("needs_signal");
});

test("P-EVAL.4: rich telemetry renders a breakdown by REAL tool name with per-tool failure counts", () => {
  const stats = toolBreakdown(richRun);
  expect(stats.map((s) => [s.label, s.calls, s.failures])).toEqual([["read", 14, 0], ["edit", 6, 0], ["bash", 3, 1]]);
  // The coarse ACP kind alone would have read "read x14, edit x6, other x3" - the real names are the point.
  expect(toolSummaryLine(stats)).toBe("read x14, edit x6, bash x3 (1 failed)");
  const md = render(richRun);
  expect(md).toContain("## Tool activity");
  expect(md).toContain("_read x14, edit x6, bash x3 (1 failed)_");
  expect(md).toContain("| bash | other | 3 | 1 | 5.6s | bun test harness/brief/ |"); // (4000+3800+9000)/3
  expect(md).toContain("| Total | - | 23 | 1 | - | - |");
  expect(md).not.toContain("| unattributed |"); // 23 named calls reconcile with toolCalls exactly
});

test("P-EVAL.4: unnamed calls become an explicit unattributed bucket; failures attribute without ok telemetry", () => {
  // The ACP-only case: omp's tool_call update carries no toolName, so with no self-report the only calls we
  // can name are the ones the failure ledger names. The other 11 are STATED as unattributed, never dropped
  // and never mislabeled as some tool they were not.
  const stats = toolBreakdown(oldShapeRun);
  expect(stats.map((s) => [s.label, s.calls, s.failures])).toEqual([["bash", 1, 1], ["unattributed", 11, 0]]);
  expect(stats.reduce((n, s) => n + s.calls, 0)).toBe(oldShapeRun.toolCalls); // the table always reconciles
  // A group WITH records but no `ok` field borrows its failure count from the ledger.
  const noOk = toolBreakdown({ ...oldShapeRun, toolCalls: 3, tools: [{ name: "bash" }, { name: "bash" }, { name: "read" }] });
  expect(noOk.find((s) => s.label === "bash")).toMatchObject({ calls: 2, failures: 1 });
  expect(noOk.find((s) => s.label === "unattributed")).toBeUndefined();
  // A record with no name at all falls back to the coarse kind rather than collapsing to "unknown".
  expect(toolBreakdown({ ...oldShapeRun, toolCalls: 2, toolFailures: [], tools: [{ kind: "read" }, { kind: "read" }] })[0])
    .toMatchObject({ label: "read", calls: 2 });
});

test("P-EVAL.4: the files-touched table shows path / added / removed / net and reconciles its total", () => {
  const md = render(richRun);
  expect(md).toContain("## Files touched");
  expect(md).toContain("| harness/brief/evals.ts | 250 | 40 | +210 |");
  expect(md).toContain("| harness/brief/evals.test.ts | 120 | 0 | +120 |");
  expect(md).toContain("| Total | 370 | 40 | +330 |");
  expect(filesTouched(richRun).map((f) => f.net)).toEqual([210, 120]);
  // A net DELETION renders signed, never as a bare positive number.
  expect(render({ ...richRun, files: [{ path: "dead.ts", add: 2, del: 40 }] })).toContain("| dead.ts | 2 | 40 | -38 |");
});

test("P-EVAL.4: test pass rate derives from test-runner invocations, and says so when none ran", () => {
  // Two `bun test` calls, one failed -> 50% of 2 test RUNS. The display names its denominator so nobody
  // reads a per-invocation rate as a per-assertion pass rate.
  const m = computeEvalMetrics(richRun);
  expect(m.sources?.testPassRate).toBe("derived");
  expect(m.derived?.testPassRate?.display).toBe("50% of 2 test runs");
  expect(m.testPassRate.value).toBeNull(); // the persisted measured axis stays honest-null

  // A real test report always wins over the derivation, and no substitute is even computed.
  const measured = computeEvalMetrics({ ...richRun, tests: { pass: 41, fail: 1 } });
  expect(measured.sources?.testPassRate).toBe("measured");
  expect(measured.testPassRate.value).toBe(97.6); // round1(100*41/42)
  expect(measured.derived?.testPassRate).toBeUndefined();

  // No test-shaped call anywhere -> stays null, and the report NAMES the gap rather than omitting the row.
  expect(computeEvalMetrics(oldShapeRun).sources?.testPassRate).toBe("none");
  const md = render(oldShapeRun);
  expect(md).toContain("| Test pass rate | not measured this run | needs_signal | not measured |");
  expect(md).toContain("## Not measured this run");
  expect(md).toContain("- Test pass rate: not measured this run, no test-runner invocation was observed");
  // Editing a test FILE is not running tests. The detector needs an explicit runner token.
  expect(computeEvalMetrics({ ...oldShapeRun, tools: [{ name: "edit", detail: "harness/brief/evals.test.ts" }] }).sources?.testPassRate).toBe("none");
  // A failure record naming the command counts, because a failed `bun test` proves a test run happened.
  const fromLedger = computeEvalMetrics({ ...oldShapeRun, toolFailures: [{ tool: "bash", reason: "exit 1", cmd: "bun test" }] });
  expect(fromLedger.derived?.testPassRate?.display).toBe("0% of 1 test run");
});

test("P-EVAL.4: a measured signal renders as measured; a full run has no gaps and no needs_signal", () => {
  const full: RunRecord = { ...richRun, tests: { pass: 42, fail: 0 }, ac: { total: 6, met: 6 }, cleanLoc: 300, dod: { total: 4, met: 3 } };
  const md = render(full);
  expect(md).toContain("| Tokens per clean line | 30 gen/line | direct | measured |"); // 9000/300
  expect(md).toContain("| Spec conformance | 100% | proxy | measured |");
  expect(md).toContain("| Definition of done | 75% | direct | measured |");            // dod 3/4, finally a row
  // P-EVAL.4 also surfaces churn, which P-EVAL.1 computed + persisted but never rendered anywhere.
  expect(md).toContain("| Code churn (deleted / added) | 10.8% | proxy | measured |"); // 40/370
  expect(md).not.toContain("## Not measured this run");
  expect(md).not.toContain("needs_signal");
  expect(computeEvalMetrics(full).derived).toEqual({}); // nothing to substitute when everything is measured
});

test("P-EVAL.4: a run with no tools and no files invents nothing and names every gap", () => {
  const idle: RunRecord = {
    runId: "e", model: "claude-opus-5", tokens: { ctx: 0, output: 0, total: 0 },
    costUsd: 0, toolCalls: 0, toolFailures: [], files: [],
  };
  const m = computeEvalMetrics(idle);
  expect(m.derived).toEqual({}); // nothing observable to derive FROM, so nothing is fabricated
  const md = render(idle);
  expect(md).toContain("## Not measured this run");
  for (const label of [
    "Tokens per net line", "Tokens per clean line", "Context efficiency", "Test pass rate",
    "Spec conformance", "Definition of done", "Predicted acceptance", "Tokens per quality feature",
  ]) {
    expect(rowFor(md, label)).toContain("| not measured this run |");
    expect(rowFor(md, label)?.endsWith("| not measured |")).toBe(true);
    expect(md).toContain(`- ${label}: not measured this run,`);
  }
  expect(md).not.toContain("## Tool activity");
  expect(md).not.toContain("## Files touched");
  expect(md).not.toContain("net lines kept");
});

test("P-EVAL.4: hostile telemetry cannot break the table or the ASCII-only guarantee", () => {
  // A homoglyph, a table-breaking pipe, an embedded newline and an oversized detail must all be neutralized:
  // the whole document has to stay ASCII for the security gate (U+00D7 in a chart label was the original
  // lesson) and a raw `|` would silently shatter a markdown row into extra columns.
  const md = render({
    ...richRun,
    files: [{ path: "src/\u00d7\u2014weird.ts", add: 1, del: 0 }],
    tools: [{ name: "ba|sh", kind: "other", detail: `x\u00d7y\nnext ${"z".repeat(200)}` }],
  });
  expect(/[^\x00-\x7F]/.test(md)).toBe(false); // also enforces the project-wide no-em-dash rule
  expect(md).toContain("| ba/sh |");           // the pipe became a slash, not a new column
  expect(md.split("\n").every((l) => !l.startsWith("|") || l.endsWith("|"))).toBe(true);
  expect(md.split("\n").every((l) => l.length < 200)).toBe(true); // the 200-char detail was truncated
});

test("P-EVAL.4: renderEvalMarkdown tolerates an EvalMetrics with none of the new optional fields", () => {
  // eval_metrics rows rehydrated from before this increment carry no sources / derived / toolStats. The
  // renderer must infer provenance from the tiers instead of throwing or printing "undefined".
  const { derived, sources, toolStats, filesTouched: ft, dodCompletion, ...legacy } = computeEvalMetrics(oldShapeRun);
  const md = renderEvalMarkdown(legacy, { costUsd: 0.42, totalTokens: 18700 });
  expect(md).toContain("| Tokens per net line | 40.7 gen/line | proxy | measured |");
  expect(md).toContain("| Spec conformance | not measured this run | needs_signal | not measured |");
  expect(md).toContain("| Definition of done | not measured this run | needs_signal | not measured |");
  expect(md).not.toContain("## Tool activity");
  expect(md).not.toContain("undefined");
  expect(/[^\x00-\x7F]/.test(md)).toBe(false);
});
