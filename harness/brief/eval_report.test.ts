// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-CHAT.C (ADR-0181): the pure observed-turn -> RunRecord adapter behind the settled turn's
// "Generate engineering report" button + the /api/eval/report route. Over-tests the load-bearing
// mapping: which tools are file changes, per-file aggregation, the re-edit (rework) count, sanitation of
// a hostile/lossy payload, and that the rendered markdown reuses evals.ts (title + needs_signal honesty).

import { expect, test } from "bun:test";
import { buildRunRecord, renderTurnEvalReport, type ObservedTurn } from "./eval_report.ts";

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

test("renderTurnEvalReport reuses evals.ts: titled markdown, provenance chart, honest needs_signal tiers", () => {
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
  // No AC / tests observed at the chat seam -> spec + acceptance stay needs_signal, never faked.
  expect(markdown).toContain("Spec conformance | needs AC | needs_signal");
  expect(markdown).toContain("Predicted acceptance | needs AC + tests | needs_signal");
});

test("a no-tool turn renders without throwing (no files, no provenance chart)", () => {
  const { markdown } = renderTurnEvalReport(base({ tools: [], outputTokens: 0 }));
  expect(markdown).toContain("## Efficiency");
  expect(markdown).not.toContain("net lines kept"); // no provenance section when there are no files
});
