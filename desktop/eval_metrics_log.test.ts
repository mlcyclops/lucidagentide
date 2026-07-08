// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/eval_metrics_log.test.ts — P-EVAL.3 (ADR-0187): the GUI-side eval-metrics sink.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordEvalMetrics } from "./eval_metrics_log.ts";
import type { EvalMetricsSample } from "../harness/memory/eval_metrics_ingest.ts";
import { computeEvalMetrics, type EvalMetrics, type RunRecord } from "../harness/brief/evals.ts";

let dir: string;
let logPath: string;

const run: RunRecord = {
  runId: "run-1", model: "claude-opus-4-8",
  tokens: { ctx: 16000, output: 2400, total: 18400 }, costUsd: 0.42,
  toolCalls: 10, toolFailures: [{ tool: "bash", reason: "exit 1" }],
  files: [{ path: "app.ts", add: 60, del: 5 }],
};
const metrics: EvalMetrics = computeEvalMetrics(run);

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "evalmlog-")); logPath = join(dir, "lucid-eval-metrics.jsonl"); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function readLines(): EvalMetricsSample[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as EvalMetricsSample);
}

test("records a flattened sample with the run's values + tiers", () => {
  const s = recordEvalMetrics(metrics, 1_000, { logPath });
  expect(s).not.toBeNull();
  expect(s!.runId).toBe("run-1");
  expect(s!.ts).toBe(1_000);
  expect(s!.netLoc).toBe(55);
  expect(s!.testPassRate).toBeNull();          // no tests -> null, never 0
  expect(s!.tiers.toolFailRate).toBe("direct");
});

test("appends one JSONL line per record", () => {
  recordEvalMetrics(metrics, 1_000, { logPath });
  recordEvalMetrics({ ...metrics, runId: "run-2" }, 2_000, { logPath });
  const lines = readLines();
  expect(lines.length).toBe(2);
  expect(lines.map((l) => l.runId)).toEqual(["run-1", "run-2"]);
});

test("guards a bad input (no runId / non-finite ts) and writes nothing", () => {
  expect(recordEvalMetrics({ ...metrics, runId: "" }, 1_000, { logPath })).toBeNull();
  expect(recordEvalMetrics(metrics, NaN, { logPath })).toBeNull();
  expect(readLines().length).toBe(0);
});
