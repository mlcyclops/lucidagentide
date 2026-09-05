// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_pchatc.ts
//
// P-CHAT.C (ADR-0190): the settled-turn "Generate engineering report" keystone. The DOM wiring (the run
// footer's CTA on a settled tool-using turn -> POST /api/eval/report -> "Open in Reports" link) is
// live-renderer behavior that needs in-app QA; and the route is a thin server seam. This demo proves the
// PURE logic they both depend on - mapping a turn's OBSERVED telemetry (tool calls + diffstats + tokens)
// into evals.ts's RunRecord, and rendering the reused Model-Evaluation markdown.
//
// Run with: bun run harness/scripts/demo_pchatc.ts

import { buildRunRecord, evalMetricsForTurn, renderTurnEvalReport, type ObservedTurn } from "../brief/eval_report.ts";

function fail(m: string): never { console.error(`FAIL: ${m}`); process.exit(1); }
function ok(m: string): void { console.log(`  PASS  ${m}`); }

console.log("P-CHAT.C demo - settled-turn engineering report (pure keystone)\n");

// A realistic settled turn: it searched + read (no diffstat), edited app.ts twice, wrote a new file, ran bash.
const turn: ObservedTurn = {
  runId: "run-42", model: "claude-opus-4-8",
  ctxTokens: 200_000, outputTokens: 8_000, totalTokens: 210_000, costUsd: 0.42,
  subagents: 1,
  tools: [
    { name: "search", path: undefined },
    { name: "read", path: "desktop/renderer/app.ts" },
    { name: "edit", path: "desktop/renderer/app.ts", add: 63, del: 4 },
    { name: "write", path: "desktop/trivia_seed.ts", add: 140, del: 0 },
    { name: "edit", path: "desktop/renderer/app.ts", add: 10, del: 2 },
    { name: "bash" },
  ],
  failures: [],
  when: "2026-07-07",
};

// [1] mapping: only diffstat-bearing writes are files; repeated edits merge; the surplus is a re-edit.
const run = buildRunRecord(turn);
if (run.files.length !== 2) fail(`expected 2 files, got ${run.files.length}`);
const app = run.files.find((f) => f.path === "desktop/renderer/app.ts");
if (!app || app.add !== 73 || app.del !== 6) fail(`app.ts not merged: ${JSON.stringify(app)}`);
if (run.reEdits !== 1) fail(`expected reEdits=1 (2 edits of app.ts over 2 files), got ${run.reEdits}`);
if (run.toolCalls !== 6) fail(`toolCalls should count ALL tools (6), got ${run.toolCalls}`);
ok("observed tools -> RunRecord: reads/searches/bash are not files, repeated edits merge, surplus = 1 re-edit, 6 tool calls");

// [2] render reuses evals.ts: titled ASCII markdown, a provenance xychart, direct context-efficiency.
const { title, markdown } = renderTurnEvalReport(turn);
if (title !== "Model Evaluation - claude-opus-4-8") fail(`bad title: ${title}`);
if (!markdown.startsWith("# Model Evaluation - claude-opus-4-8")) fail("markdown missing its # heading");
if (!markdown.includes("Context efficiency | 25x | direct")) fail("context efficiency (200k/8k = 25x) missing/wrong");
if (!markdown.includes("```mermaid")) fail("provenance xychart missing");
ok("renderTurnEvalReport -> titled Model-Evaluation markdown with a provenance chart + direct 25x context efficiency");

// [3] honesty: no AC / tests are knowable at the chat seam, so those MEASURED metrics stay null +
// needs_signal and that is what gets persisted. P-EVAL.4 (ADR-0187) changed only the RENDERING: the rows
// used to read "Spec conformance | needs AC | needs_signal", which made 40% of every report read as broken,
// and now show a clearly-labelled derived PROXY with the provenance in the Source column. The honesty rule
// is unmoved, so assert it on both axes: derived in the markdown, still null + needs_signal in EvalMetrics.
if (!markdown.includes("| Spec conformance | 75% | proxy | derived |")) fail("spec conformance should render as a labelled derived proxy");
if (!markdown.includes("| Predicted acceptance | 68/100 | proxy | derived |")) fail("predicted acceptance should render as a labelled derived proxy");
if (!markdown.includes("| Test pass rate | not measured this run | needs_signal | not measured |")) fail("an underivable metric must state that it was not measured");
const em = evalMetricsForTurn(turn);
if (em.specConformance.value !== null || em.specConformance.tier !== "needs_signal") fail("the PERSISTED spec conformance must stay null + needs_signal, never a proxy");
if (em.predictedAcceptance.value !== null) fail("the PERSISTED predicted acceptance must stay null");
ok("no invented signals: spec + acceptance render as labelled derived proxies while the persisted metrics stay null + needs_signal (ADR-A016 honesty rule)");

// [4] robustness: a lossy / hostile payload never yields a negative LOC or a NaN; an empty turn still renders.
const dirty = buildRunRecord({ ...turn, ctxTokens: -1, outputTokens: Number.NaN, costUsd: -3, tools: [{ name: "write", path: "x.ts", add: -9, del: 2 }] });
if (dirty.tokens.ctx !== 0 || dirty.tokens.output !== 0 || dirty.costUsd !== 0 || dirty.files[0]!.add !== 0) fail(`sanitation failed: ${JSON.stringify(dirty)}`);
const empty = renderTurnEvalReport({ ...turn, tools: [], outputTokens: 0 });
if (!empty.markdown.includes("## Efficiency") || empty.markdown.includes("net lines kept")) fail("empty turn should render Efficiency but no provenance section");
ok("hostile/lossy payload sanitized (no negative LOC / NaN); a no-tool turn still renders");

console.log("\nP-CHAT.C demo complete - pure observed-turn->report verified. The run-footer CTA + /api/eval/report route are typechecked and await in-app QA.");
