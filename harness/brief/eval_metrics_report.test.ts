// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/brief/eval_metrics_report.test.ts — P-EVAL.3 Part B (ADR-0187): the cross-run rollup.

import { test, expect } from "bun:test";
import { aggregateEvalMetrics, renderEvalMetricsRollupMarkdown } from "./eval_metrics_report.ts";
import type { EvalMetricsSample } from "../memory/eval_metrics_ingest.ts";

function sample(over: Partial<EvalMetricsSample>): EvalMetricsSample {
  return {
    runId: "r", model: "claude-opus-4-8", ts: 0,
    grossAdd: 60, grossDel: 5, netLoc: 55,
    churnPct: 8, tokensPerNetLoc: 40, tokensPerCleanLoc: null, contextEfficiency: 6.8,
    toolFailRate: 10, wastedTokensEst: 300, testPassRate: null, specConformance: null,
    predictedAcceptance: null, tokensPerQualityFeat: null,
    tiers: {
      churnPct: "proxy", tokensPerNetLoc: "proxy", tokensPerCleanLoc: "needs_signal", contextEfficiency: "direct",
      toolFailRate: "direct", wastedTokensEst: "proxy", testPassRate: "needs_signal", specConformance: "needs_signal",
      predictedAcceptance: "needs_signal", tokensPerQualityFeat: "needs_signal",
    },
    ...over,
  };
}

test("aggregates per model: mean over runs, total net LOC, run count", () => {
  const rows = [
    sample({ runId: "a", toolFailRate: 10, netLoc: 50 }),
    sample({ runId: "b", toolFailRate: 20, netLoc: 30 }),
  ];
  const [m] = aggregateEvalMetrics(rows);
  expect(m!.runs).toBe(2);
  expect(m!.totalNetLoc).toBe(80);
  expect(m!.metrics.toolFailRate.mean).toBe(15); // (10+20)/2
  expect(m!.metrics.toolFailRate.n).toBe(2);
  expect(m!.metrics.toolFailRate.tier).toBe("direct");
});

test("a metric is averaged ONLY over runs that had the signal (null excluded, never 0)", () => {
  const rows = [
    sample({ runId: "a", testPassRate: null }),              // no tests
    sample({ runId: "b", testPassRate: 100, tiers: { ...sample({}).tiers, testPassRate: "direct" } }), // has tests
  ];
  const [m] = aggregateEvalMetrics(rows);
  // mean over the ONE run that had a value — not (0+100)/2
  expect(m!.metrics.testPassRate.mean).toBe(100);
  expect(m!.metrics.testPassRate.n).toBe(1);
  expect(m!.metrics.testPassRate.tier).toBe("direct");
});

test("a metric with zero coverage stays null (needs_signal), never a fake number", () => {
  const [m] = aggregateEvalMetrics([sample({ specConformance: null })]);
  expect(m!.metrics.specConformance.mean).toBeNull();
  expect(m!.metrics.specConformance.n).toBe(0);
  expect(m!.metrics.specConformance.tier).toBe("needs_signal");
});

test("models sort by run volume (most active first)", () => {
  const rows = [
    sample({ model: "haiku-4-5", runId: "h1" }),
    sample({ model: "claude-opus-4-8", runId: "o1" }),
    sample({ model: "claude-opus-4-8", runId: "o2" }),
  ];
  expect(aggregateEvalMetrics(rows).map((m) => m.model)).toEqual(["claude-opus-4-8", "haiku-4-5"]);
});

test("render: xychart + per-model table + 'no signal' for null metrics; ASCII-only", () => {
  const md = renderEvalMetricsRollupMarkdown([sample({ testPassRate: null })], { when: "2026-07-15" });
  expect(md).toContain("# Model Evaluation Rollup");
  expect(md).toContain("xychart-beta");
  expect(md).toContain("Net LOC by model");
  expect(md).toContain("no signal");                 // null metric renders honestly
  expect(md).toContain("| Tool-call failure rate |");
  expect(/[^\x00-\x7F]/.test(md)).toBe(false);       // gate-safe (ASCII-only)
});

test("render: empty ledger reads as a friendly note, no crash", () => {
  const md = renderEvalMetricsRollupMarkdown([]);
  expect(md).toContain("No runs recorded yet");
  expect(md).not.toContain("xychart");
});
