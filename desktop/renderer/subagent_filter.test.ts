// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-TASK.5a: delegation cards must scope /api/subagents runs (the whole session's union) to their
// own batch - by task id, by assignment prefix, or the sole-card fallback.

import { describe, expect, test } from "bun:test";
import { filterRunsForBatch, type BatchRun } from "./subagent_filter.ts";

const run = (name: string, assignment: string): BatchRun => ({ name, assignment });

describe("filterRunsForBatch", () => {
  test("two batches of 3 with names: each card keeps only its own 3 runs", () => {
    const union = [
      run("AuthLoader", "Wire the auth loader"),
      run("AuthTester", "Test the auth loader"),
      run("AuthDocs", "Document the auth loader"),
      run("UiPolish", "Polish the settings UI"),
      run("UiTests", "Test the settings UI"),
      run("UiDocs", "Document the settings UI"),
    ];
    const batchA = { names: ["AuthLoader", "AuthTester", "AuthDocs"], assignments: ["a1", "a2", "a3"], soleCard: false };
    const batchB = { names: ["UiPolish", "UiTests", "UiDocs"], assignments: ["b1", "b2", "b3"], soleCard: false };
    expect(filterRunsForBatch(union, batchA).map((r) => r.name)).toEqual(["AuthLoader", "AuthTester", "AuthDocs"]);
    expect(filterRunsForBatch(union, batchB).map((r) => r.name)).toEqual(["UiPolish", "UiTests", "UiDocs"]);
  });

  test("names set: a run outside the name list is dropped even if its assignment matches", () => {
    const union = [run("Mine", "Fix the parser"), run("Other-1", "Fix the parser")];
    const out = filterRunsForBatch(union, { names: ["Mine"], assignments: ["Fix the parser"], soleCard: false });
    expect(out.map((r) => r.name)).toEqual(["Mine"]);
  });

  test("assignment-prefix fallback: capped batch text matches the run's longer assignment", () => {
    const long = "Refactor the session store so every lane persists its approval scope " + "x".repeat(300);
    const union = [
      run("agent-1", long), // run carries the FULL assignment
      run("agent-2", "Something entirely unrelated"),
    ];
    // The backend caps batch assignments at 200 chars - prefix matching must still pair them.
    const out = filterRunsForBatch(union, { assignments: [long.slice(0, 200)], soleCard: false });
    expect(out.map((r) => r.name)).toEqual(["agent-1"]);
  });

  test("assignment matching normalizes whitespace on both sides", () => {
    const union = [run("agent-1", "  Fix   the\n  parser edge cases  ")];
    const out = filterRunsForBatch(union, { assignments: ["Fix the parser edge cases"], soleCard: false });
    expect(out.map((r) => r.name)).toEqual(["agent-1"]);
  });

  test("assignment matching works in both prefix directions", () => {
    // Run assignment shorter than the batch text (e.g. a truncated tail on the activity side).
    const union = [run("agent-1", "Build the fleet grid")];
    const out = filterRunsForBatch(union, { assignments: ["Build the fleet grid with approval chips"], soleCard: false });
    expect(out.map((r) => r.name)).toEqual(["agent-1"]);
  });

  test("single-card fallback: no match on the turn's only card shows all runs", () => {
    const union = [run("a", "one thing"), run("b", "another thing")];
    const out = filterRunsForBatch(union, { assignments: ["totally different text"], soleCard: true });
    expect(out.map((r) => r.name)).toEqual(["a", "b"]);
  });

  test("no match on a multi-card turn yields an empty list (never the union)", () => {
    const union = [run("a", "one thing"), run("b", "another thing")];
    const out = filterRunsForBatch(union, { assignments: ["totally different text"], soleCard: false });
    expect(out).toEqual([]);
  });

  test("matched rows are capped at the batch size", () => {
    const union = [
      run("agent-1", "Migrate module A to the new API"),
      run("agent-2", "Migrate module B to the new API"),
      run("agent-3", "Migrate module C to the new API"),
    ];
    // Two batch assignments, but all three runs prefix-match one of them via short batch text.
    const out = filterRunsForBatch(union, { assignments: ["Migrate module", "Migrate module"], soleCard: false });
    expect(out.length).toBe(2);
  });

  test("empty runs stay empty", () => {
    expect(filterRunsForBatch([], { assignments: ["x"], soleCard: true })).toEqual([]);
  });
});
