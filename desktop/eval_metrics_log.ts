// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/eval_metrics_log.ts — P-EVAL.3 (ADR-0187): GUI-owned per-run eval-metrics capture.
//
// When a settled turn's Model-Evaluation report is generated (the /api/eval/report route), we also persist
// the computed EvalMetrics so they accrue for the cross-run rollup (P-EVAL.3 Part B). Same read-only-DB
// constraint as P-EVAL.2's latency capture: the GUI can't co-write agent_obs.duckdb, so we append a flat
// sample to an append-only JSONL (~/.omp/lucid-eval-metrics.jsonl) and the single writer ingests it
// (harness/memory/eval_metrics_ingest.ts). Metadata only — metric numbers, never prompt/reply text.
//
// Best-effort + fail-open: a capture failure NEVER breaks the report generation it rides alongside.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { EvalMetrics } from "../harness/brief/evals.ts";
import { evalMetricsToSample, type EvalMetricsSample } from "../harness/memory/eval_metrics_ingest.ts";

const LOG_PATH = join(homedir(), ".omp", "lucid-eval-metrics.jsonl");

/** Record one run's eval metrics. Fully guarded — any failure is swallowed. `ts` is the run time (UNIX ms);
 *  `logPath` is injectable for tests. Returns the written sample, or null if nothing was recorded. */
export function recordEvalMetrics(m: EvalMetrics, ts: number, opts: { logPath?: string } = {}): EvalMetricsSample | null {
  try {
    if (!m || !m.runId || !m.model || !Number.isFinite(ts)) return null;
    const sample = evalMetricsToSample(m, ts);
    const path = opts.logPath ?? LOG_PATH;
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(sample) + "\n");
    return sample;
  } catch {
    return null; // audit is best-effort; never break report generation on a capture failure
  }
}

export { LOG_PATH as EVAL_METRICS_LOG_PATH };
