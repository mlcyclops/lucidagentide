// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/memory/eval_metrics_ingest.test.ts — P-EVAL.3 (ADR-0187): eval_metrics ingest + readback.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "./db.ts";
import { evalMetricsToSample, ingestEvalMetrics, readEvalMetricsRows, type EvalMetricsSample } from "./eval_metrics_ingest.ts";
import { computeEvalMetrics, type RunRecord } from "../brief/evals.ts";

let dir: string;
let db: Db;
let jsonl: string;
const T0 = Date.parse("2026-07-07T14:00:00.000Z");

// A run WITHOUT tests/AC: testPassRate + specConformance are null + needs_signal (the honesty rule).
const runNoSignals: RunRecord = {
  runId: "run-a", model: "claude-opus-4-8",
  tokens: { ctx: 16000, output: 2400, total: 18400 }, costUsd: 0.42,
  toolCalls: 10, toolFailures: [{ tool: "bash", reason: "exit 1" }],
  files: [{ path: "app.ts", add: 60, del: 5 }],
};
// A run WITH tests + AC: those metrics become real (direct/proxy).
const runFull: RunRecord = {
  ...runNoSignals, runId: "run-b",
  tests: { pass: 40, fail: 0 }, ac: { total: 5, met: 5 }, cleanLoc: 55,
};

function writeJsonl(samples: EvalMetricsSample[]): void {
  writeFileSync(jsonl, samples.map((s) => JSON.stringify(s)).join("\n") + "\n");
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "evalm-"));
  db = await Db.open(join(dir, "t.duckdb"));
  jsonl = join(dir, "lucid-eval-metrics.jsonl");
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

test("evalMetricsToSample flattens values + preserves tiers; a missing signal is null (never 0)", () => {
  const s = evalMetricsToSample(computeEvalMetrics(runNoSignals), T0);
  expect(s.runId).toBe("run-a");
  expect(s.netLoc).toBe(55); // 60 - 5
  expect(s.toolFailRate).toBeCloseTo(10, 5); // 1/10 -> 10%
  expect(s.testPassRate).toBeNull();         // no tests -> null, NOT 0
  expect(s.specConformance).toBeNull();      // no AC -> null
  expect(s.tiers.toolFailRate).toBe("direct");
  expect(s.tiers.testPassRate).toBe("needs_signal");
  expect(s.tiers.specConformance).toBe("needs_signal");
});

test("ingests samples into eval_metrics, idempotent on run_id", async () => {
  writeJsonl([evalMetricsToSample(computeEvalMetrics(runNoSignals), T0), evalMetricsToSample(computeEvalMetrics(runFull), T0 + 1000)]);
  const first = await ingestEvalMetrics(db, jsonl);
  expect(first.inserted).toBe(2);
  expect(first.skipped).toBe(0);
  const again = await ingestEvalMetrics(db, jsonl);
  expect(again.inserted).toBe(0);
  expect(again.duplicates).toBe(2);
});

test("NULL-not-zero survives the DB round-trip; tiers restore", async () => {
  writeJsonl([evalMetricsToSample(computeEvalMetrics(runNoSignals), T0)]);
  await ingestEvalMetrics(db, jsonl);
  const rows = await readEvalMetricsRows(db);
  expect(rows.length).toBe(1);
  const r = rows[0]!;
  expect(r.ts).toBe(T0);                 // ts round-trips to UNIX ms
  expect(r.testPassRate).toBeNull();     // stored NULL, read back null
  expect(r.specConformance).toBeNull();
  expect(r.netLoc).toBe(55);
  expect(r.tiers.testPassRate).toBe("needs_signal");
  expect(r.tiers.toolFailRate).toBe("direct");
});

test("a run WITH signals stores real values + direct/proxy tiers", async () => {
  writeJsonl([evalMetricsToSample(computeEvalMetrics(runFull), T0)]);
  await ingestEvalMetrics(db, jsonl);
  const r = (await readEvalMetricsRows(db))[0]!;
  expect(r.testPassRate).toBe(100);      // 40/40
  expect(r.tiers.testPassRate).toBe("direct");
  expect(r.specConformance).toBe(100);   // 5/5
  expect(r.tiers.specConformance).toBe("proxy");
});

test("malformed / incomplete lines are skipped, not dropped", async () => {
  writeFileSync(jsonl, [
    "{ not json",
    JSON.stringify(evalMetricsToSample(computeEvalMetrics(runNoSignals), T0)),
    JSON.stringify({ runId: "x", model: "m" }),  // missing numeric fields + tiers
    "",
  ].join("\n"));
  const stats = await ingestEvalMetrics(db, jsonl);
  expect(stats.inserted).toBe(1);
  expect(stats.skipped).toBe(2);
});

test("readEvalMetricsRows scopes by model + window", async () => {
  writeJsonl([
    evalMetricsToSample(computeEvalMetrics(runNoSignals), T0),
    evalMetricsToSample(computeEvalMetrics({ ...runFull, model: "haiku-4-5" }), T0 + 60_000),
  ]);
  await ingestEvalMetrics(db, jsonl);
  const opus = await readEvalMetricsRows(db, { model: "claude-opus-4-8" });
  expect(opus.length).toBe(1);
  expect(opus[0]!.runId).toBe("run-a");
  const windowed = await readEvalMetricsRows(db, { sinceMs: T0 + 30_000 });
  expect(windowed.length).toBe(1);
  expect(windowed[0]!.model).toBe("haiku-4-5");
});
