// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-CHAT.C (ADR-0190): the pure observed-turn -> RunRecord adapter behind the settled turn's
// "Generate engineering report" button + the /api/eval/report route. Over-tests the load-bearing
// mapping: which tools are file changes, per-file aggregation, the re-edit (rework) count, sanitation of
// a hostile/lossy payload, and that the rendered markdown reuses evals.ts (title + needs_signal honesty).
//
// P-EVAL.4 (ADR-0187) extends ObservedTool with optional kind / detail / ok / durationMs and maps every
// call into a RunRecord.tools ToolRecord, so the report can group a turn by REAL tool name. The tests below
// pin both directions: a caller with the richer telemetry gets the rich breakdown, and a caller still
// posting the pre-P-EVAL.4 shape gets a valid RunRecord and a complete report with nothing invented.

import { expect, test } from "bun:test";
import { buildRunRecord, evalMetricsForTurn, renderTurnEvalReport, type ObservedTurn } from "./eval_report.ts";

const base = (over: Partial<ObservedTurn> = {}): ObservedTurn => ({
  runId: "run-1", model: "claude-opus-4-8",
  ctxTokens: 200_000, outputTokens: 8_000, totalTokens: 210_000, costUsd: 0.42,
  tools: [], failures: [], subagents: 0, ...over,
});

test("only tools with a path AND a diffstat become files; reads/searches/bash do not", () => {
  const t = base({
    tools: [
      { name: "search" },                                  // no path/diffstat
      { name: "read", path: "app.ts" },                     // path but no diffstat -> not a file
      { name: "edit", path: "app.ts", add: 63, del: 4 },
      { name: "write", path: "trivia_seed.ts", add: 140, del: 0 },
      { name: "bash", add: 0 },                             // diffstat-ish but no path -> not a file
    ],
  });
  const r = buildRunRecord(t);
  expect(r.files.map((f) => f.path).sort()).toEqual(["app.ts", "trivia_seed.ts"]);
  expect(r.toolCalls).toBe(5); // ALL tool calls count, not just file writes
  expect(r.files.find((f) => f.path === "app.ts")).toMatchObject({ add: 63, del: 4, aiAdd: 63, aiDel: 4 });
});

test("repeated writes to the same file merge, and the surplus is counted as re-edits (rework proxy)", () => {
  const r = buildRunRecord(base({
    tools: [
      { name: "edit", path: "app.ts", add: 63, del: 4 },
      { name: "write", path: "trivia_seed.ts", add: 140, del: 0 },
      { name: "edit", path: "app.ts", add: 10, del: 2 }, // second touch of app.ts
    ],
  }));
  expect(r.files).toHaveLength(2);
  expect(r.files.find((f) => f.path === "app.ts")).toMatchObject({ add: 73, del: 6, aiAdd: 73, aiDel: 6 });
  expect(r.reEdits).toBe(1); // 3 write-ops over 2 distinct files -> 1 re-edit
});

test("failures pass through; tokens/cost are sanitized (negative/NaN -> 0), never a negative LOC", () => {
  const r = buildRunRecord(base({
    ctxTokens: -5, outputTokens: Number.NaN, totalTokens: 210_000, costUsd: -1,
    tools: [{ name: "write", path: "x.ts", add: -10, del: 3 }],
    failures: [{ tool: "bash", reason: "exit 1", cmd: "bun test" }],
  }));
  expect(r.tokens).toEqual({ ctx: 0, output: 0, total: 210_000 });
  expect(r.costUsd).toBe(0);
  expect(r.toolFailures).toEqual([{ tool: "bash", reason: "exit 1", cmd: "bun test" }]);
  expect(r.files[0]).toMatchObject({ path: "x.ts", add: 0, del: 3 }); // negative add clamped to 0
});

test("renderTurnEvalReport reuses evals.ts: titled markdown, provenance chart, honest provenance labels", () => {
  const { title, markdown } = renderTurnEvalReport(base({
    tools: [
      { name: "edit", path: "app.ts", add: 63, del: 4 },
      { name: "write", path: "trivia_seed.ts", add: 140, del: 0 },
    ],
    when: "2026-07-07",
  }));
  expect(title).toBe("Model Evaluation - claude-opus-4-8");
  expect(markdown.startsWith("# Model Evaluation - claude-opus-4-8")).toBe(true);
  expect(markdown).toContain("## Efficiency");
  expect(markdown).toContain("Context efficiency | 25x | direct"); // 200000/8000
  expect(markdown).toContain("```mermaid"); // provenance xychart (files present)
  // P-EVAL.4: still no AC / tests at the chat seam, so those MEASURED metrics stay null + needs_signal and
  // that is what gets persisted. This test previously asserted the rendered rows read
  // "Spec conformance | needs AC | needs_signal" / "Predicted acceptance | needs AC + tests | needs_signal";
  // those rows now show a labelled derived proxy instead, because a report where 40% of the table says
  // "no signal" reads as broken. The honesty moved to the Source column, so assert it there.
  const m = evalMetricsForTurn(base({ tools: [{ name: "edit", path: "app.ts", add: 63, del: 4 }] }));
  expect(m.specConformance.value).toBeNull();
  expect(m.specConformance.tier).toBe("needs_signal");
  expect(m.predictedAcceptance.value).toBeNull();
  expect(markdown).toContain("| Spec conformance | 75% | proxy | derived |");   // no failures, unverified
  expect(markdown).toContain("| Predicted acceptance | 75/100 | proxy | derived |");
  expect(markdown).toContain("| Test pass rate | not measured this run | needs_signal | not measured |");
  expect(/[^\x00-\x7F]/.test(markdown)).toBe(false);
});

test("P-EVAL.4: richer per-tool telemetry maps into ToolRecords and drives the real-name breakdown", () => {
  const t = base({
    tools: [
      { name: "read", kind: "read", detail: "app.ts", ok: true, durationMs: 12 },
      { name: "read", kind: "read", detail: "bridge.ts", ok: true, durationMs: 18 },
      { name: "edit", kind: "edit", path: "app.ts", add: 63, del: 4, ok: true, durationMs: 40 },
      { name: "bash", kind: "other", detail: "bun test harness/brief/", ok: false, durationMs: 3000 },
    ],
    failures: [{ tool: "bash", reason: "1 test failed", cmd: "bun test harness/brief/" }],
  });
  const r = buildRunRecord(t);
  expect(r.tools).toHaveLength(4);
  expect(r.tools?.[0]).toEqual({ name: "read", kind: "read", detail: "app.ts", ok: true, durationMs: 12 });
  // No `detail` supplied for an edit -> the path IS the detail a reader wants.
  expect(r.tools?.[2]).toEqual({ name: "edit", kind: "edit", detail: "app.ts", ok: true, durationMs: 40 });

  const { markdown } = renderTurnEvalReport(t);
  expect(markdown).toContain("_read x2, bash x1 (1 failed), edit x1_"); // grouped by REAL name, not "other x4"
  expect(markdown).toContain("| read | read | 2 | 0 | 15ms | app.ts |");
  expect(markdown).toContain("| bash | other | 1 | 1 | 3s | bun test harness/brief/ |");
  expect(markdown).toContain("| Total | - | 4 | 1 | - | - |");
  expect(markdown).not.toContain("| unattributed |");
  // A failed `bun test` is a test run, so the previously-dead test pass rate now has a derived value.
  expect(evalMetricsForTurn(t).derived?.testPassRate?.display).toBe("0% of 1 test run");
});

test("P-EVAL.4: an older client's payload (no kind/detail/ok/durationMs) still produces a full report", () => {
  const t = base({ tools: [{ name: "edit", path: "app.ts", add: 10, del: 2 }, { name: "search" }] });
  const r = buildRunRecord(t);
  // Absent richer fields are DROPPED, never defaulted: a missing `ok` means "status unknown", not "succeeded".
  expect(r.tools).toEqual([
    { name: "edit", kind: undefined, detail: "app.ts", ok: undefined, durationMs: undefined },
    { name: "search", kind: undefined, detail: undefined, ok: undefined, durationMs: undefined },
  ]);
  const { markdown } = renderTurnEvalReport(t);
  expect(markdown).toContain("_edit x1, search x1_");
  expect(markdown).toContain("| edit | - | 1 | 0 | - | app.ts |"); // no kind, no duration -> honest dashes
  expect(markdown).toContain("## Files touched");
  expect(markdown).not.toContain("undefined");
  expect(markdown).not.toContain("NaN");
});

test("P-EVAL.4: a hostile / lossy richer payload cannot poison a duration or the ASCII guarantee", () => {
  const r = buildRunRecord(base({
    tools: [{ name: " edit ", kind: "  ", detail: "   ", path: "x.ts", add: 3, del: 0, durationMs: Number.NaN }],
  }));
  expect(r.tools?.[0]).toEqual({ name: "edit", kind: undefined, detail: "x.ts", ok: undefined, durationMs: undefined });
  const { markdown } = renderTurnEvalReport(base({
    tools: [{ name: "ed\u2014it", kind: "edit", path: "s\u00d7rc/a.ts", add: 1, del: 0, durationMs: -5 }],
  }));
  expect(/[^\x00-\x7F]/.test(markdown)).toBe(false); // also enforces the project-wide no-em-dash rule
  expect(markdown).toContain("| ed?it | edit | 1 | 0 | - |");
});

test("a no-tool turn renders without throwing (no files, no provenance chart)", () => {
  const { markdown } = renderTurnEvalReport(base({ tools: [], outputTokens: 0 }));
  expect(markdown).toContain("## Efficiency");
  expect(markdown).not.toContain("net lines kept"); // no provenance section when there are no files
});
