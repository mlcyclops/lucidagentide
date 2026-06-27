// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/loop_runlog.test.ts — P-GOAL.10 (ADR-0055): the cross-run evaluation ledger's pure core.

import { describe, expect, test } from "bun:test";
import { type LoopMetrics } from "./loop_report.ts";
import {
  aggregateRuns,
  type LoopRunRecord,
  parseRunLog,
  runRecordLine,
  summarizeRunStats,
  toRunRecord,
} from "./loop_runlog.ts";

function metrics(over: Partial<LoopMetrics> = {}): LoopMetrics {
  return {
    goal: "make tests pass", condition: "npm test exits 0", command: "npm test",
    outcome: "met", outcomeReason: "all pass", iterations: 3, maxIters: 6, durationMs: 120_000,
    toolCalls: { shell: 5, edit: 3 }, loc: { added: 40, removed: 9, files: 2 },
    errors: [{ iter: 1, detail: "x" }], websites: ["https://a.io"],
    perIteration: [], ...over,
  };
}

function rec(over: Partial<LoopRunRecord> = {}): LoopRunRecord {
  return {
    ts: 1000, id: "r", goal: "g", outcome: "met", outcomeReason: "ok", iterations: 2, maxIters: 6,
    durationMs: 1000, tools: 4, toolsByType: { shell: 4 }, added: 0, removed: 0, hasLoc: false,
    errors: 0, websites: 0, spendUsd: 0, hasSpend: false, ...over,
  };
}

describe("toRunRecord", () => {
  test("projects LoopMetrics into a compact ledger record", () => {
    const r = toRunRecord(metrics(), { id: "abc", ts: 42 });
    expect(r).toMatchObject({
      id: "abc", ts: 42, goal: "make tests pass", outcome: "met", iterations: 3,
      tools: 8, toolsByType: { shell: 5, edit: 3 }, added: 40, removed: 9, hasLoc: true,
      errors: 1, websites: 1, command: "npm test",
    });
  });
  test("no git ⇒ hasLoc false, added/removed default to 0 (unknown, not zero)", () => {
    const r = toRunRecord(metrics({ loc: null }), { id: "x", ts: 1 });
    expect(r.hasLoc).toBe(false);
    expect(r.added).toBe(0);
  });
  test("carries spend when observed; marks it unknown when absent (P-GOAL.11)", () => {
    expect(toRunRecord(metrics({ spendUsd: 0.42 }), { id: "a", ts: 1 })).toMatchObject({ spendUsd: 0.42, hasSpend: true });
    const noSpend = toRunRecord(metrics({ spendUsd: null }), { id: "b", ts: 1 });
    expect(noSpend).toMatchObject({ spendUsd: 0, hasSpend: false });
  });
});

describe("runRecordLine / parseRunLog round-trip", () => {
  test("a written line parses back to an equal record", () => {
    const r = toRunRecord(metrics(), { id: "abc", ts: 42 });
    const parsed = parseRunLog(runRecordLine(r) + "\n");
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual(r);
  });
  test("skips blank and malformed lines, keeps the valid ones", () => {
    const good = runRecordLine(rec({ id: "ok" }));
    const log = `\n${good}\nnot json\n{"partial": true}\n${runRecordLine(rec({ id: "ok2" }))}\n`;
    const parsed = parseRunLog(log);
    expect(parsed.map((r) => r.id)).toEqual(["ok", "ok2"]);
  });
  test("empty content ⇒ no records", () => {
    expect(parseRunLog("")).toEqual([]);
  });
});

describe("aggregateRuns", () => {
  test("success rate + avg iterations over only the succeeded runs", () => {
    const s = aggregateRuns([
      rec({ outcome: "met", iterations: 2 }),
      rec({ outcome: "met", iterations: 4 }),
      rec({ outcome: "stopped", iterations: 6, outcomeReason: "hit the cap" }),
      rec({ outcome: "error", iterations: 1, outcomeReason: "loop error: boom" }),
    ]);
    expect(s.runs).toBe(4);
    expect(s.succeeded).toBe(2);
    expect(s.successRate).toBe(0.5);
    expect(s.avgItersToSucceed).toBe(3); // (2+4)/2 — the stopped/error runs are excluded
  });

  test("sums tools/LOC/errors and merges tool-type tallies", () => {
    const s = aggregateRuns([
      rec({ tools: 4, toolsByType: { shell: 4 }, added: 10, removed: 2, errors: 1 }),
      rec({ tools: 3, toolsByType: { shell: 1, edit: 2 }, added: 5, removed: 0, errors: 2 }),
    ]);
    expect(s.totalTools).toBe(7);
    expect(s.toolsByType).toEqual({ shell: 5, edit: 2 });
    expect(s.totalAdded).toBe(15);
    expect(s.totalRemoved).toBe(2);
    expect(s.totalErrors).toBe(3);
  });

  test("sums spend only over runs that reported it (P-GOAL.11)", () => {
    const s = aggregateRuns([
      rec({ spendUsd: 0.10, hasSpend: true }),
      rec({ spendUsd: 0.25, hasSpend: true }),
      rec({ spendUsd: 0, hasSpend: false }), // unknown spend — excluded, not counted as $0
    ]);
    expect(s.totalSpendUsd).toBeCloseTo(0.35, 10);
  });

  test("failure breakdown groups recurring blockers (digits collapsed), most-common first", () => {
    const s = aggregateRuns([
      rec({ outcome: "stopped", outcomeReason: "stopped: 3 of 5 tests fail" }),
      rec({ outcome: "stopped", outcomeReason: "stopped: 1 of 5 tests fail" }),
      rec({ outcome: "error", outcomeReason: "loop error: timeout" }),
      rec({ outcome: "met", outcomeReason: "all pass" }), // excluded from blockers
    ]);
    expect(s.topBlockers[0]!.count).toBe(2);       // the two "N of 5 tests fail" collapse
    expect(s.topBlockers[0]!.reason).toContain("tests fail");
    expect(s.topBlockers).toHaveLength(2);          // tests-fail + timeout
  });

  test("empty history is all-zero, never divides by zero", () => {
    const s = aggregateRuns([]);
    expect(s).toMatchObject({ runs: 0, succeeded: 0, successRate: 0, avgItersToSucceed: 0, avgDurationMs: 0 });
    expect(s.topBlockers).toEqual([]);
  });
});

describe("summarizeRunStats", () => {
  test("compact chip text", () => {
    const s = aggregateRuns([rec({ outcome: "met", iterations: 3 }), rec({ outcome: "stopped", outcomeReason: "cap" })]);
    expect(summarizeRunStats(s)).toBe("2 runs · 50% met · ~3.0 iters to win");
  });
  test("no runs", () => {
    expect(summarizeRunStats(aggregateRuns([]))).toBe("no loop runs yet");
  });
});
