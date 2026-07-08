// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/memory/eval_metrics_ingest.ts
//
// P-EVAL.3 (ADR-0187): persist the per-run Model-Evaluation metrics (evals.ts computeEvalMetrics) into the
// eval_metrics table (migration 0011). Same read-only-DB constraint as P-EVAL.2's api_latency: the GUI can't
// co-write agent_obs.duckdb, so desktop/eval_metrics_log.ts appends a flat sample per settled turn to
// lucid-eval-metrics.jsonl and the single writer ingests it here. Idempotent: run_id is the PK, so
// re-ingesting inserts zero new rows. Malformed / incomplete lines are COUNTED (skipped), never dropped.
//
// The honesty rule (ADR-A016) survives the round-trip: a metric whose signal is absent is stored NULL
// (never 0), and its evidence tier (direct | proxy | needs_signal) is kept verbatim in `tiers` (JSON).

import { readFileSync } from "node:fs";
import type { Db } from "./db.ts";
import type { EvalMetrics } from "../brief/evals.ts";

/** A flat, self-contained per-run metrics row (JSONL line + eval_metrics columns). Metric VALUES are
 *  number|null (null = the signal was absent); the per-metric TIERS live in `tiers`. */
export interface EvalMetricsSample {
  runId: string;
  model: string;
  ts: number; // UNIX ms — when the run was recorded
  grossAdd: number;
  grossDel: number;
  netLoc: number;
  churnPct: number | null;
  tokensPerNetLoc: number | null;
  tokensPerCleanLoc: number | null;
  contextEfficiency: number | null;
  toolFailRate: number | null;
  wastedTokensEst: number | null;
  testPassRate: number | null;
  specConformance: number | null;
  predictedAcceptance: number | null;
  tokensPerQualityFeat: number | null;
  tiers: Record<string, string>; // metric name -> "direct" | "proxy" | "needs_signal"
}

export interface IngestStats {
  processed: number;
  inserted: number;
  duplicates: number;
  skipped: number;
}

/** Flatten evals.ts's EvalMetrics (Metric objects) into the stored sample: each metric's `.value` becomes a
 *  nullable column and its `.tier` is preserved in `tiers`. PURE. */
export function evalMetricsToSample(m: EvalMetrics, ts: number): EvalMetricsSample {
  return {
    runId: m.runId, model: m.model, ts,
    grossAdd: m.grossAdd, grossDel: m.grossDel, netLoc: m.netLoc,
    churnPct: m.churnPct.value,
    tokensPerNetLoc: m.tokensPerNetLoc.value,
    tokensPerCleanLoc: m.tokensPerCleanLoc.value,
    contextEfficiency: m.contextEfficiency.value,
    toolFailRate: m.toolFailRate.value,
    wastedTokensEst: m.wastedTokensEst.value,
    testPassRate: m.testPassRate.value,
    specConformance: m.specConformance.value,
    predictedAcceptance: m.predictedAcceptance.value,
    tokensPerQualityFeat: m.tokensPerQualityFeature.value,
    tiers: {
      churnPct: m.churnPct.tier,
      tokensPerNetLoc: m.tokensPerNetLoc.tier,
      tokensPerCleanLoc: m.tokensPerCleanLoc.tier,
      contextEfficiency: m.contextEfficiency.tier,
      toolFailRate: m.toolFailRate.tier,
      wastedTokensEst: m.wastedTokensEst.tier,
      testPassRate: m.testPassRate.tier,
      specConformance: m.specConformance.tier,
      predictedAcceptance: m.predictedAcceptance.tier,
      tokensPerQualityFeat: m.tokensPerQualityFeature.tier,
    },
  };
}

async function count(db: Db): Promise<number> {
  const r = await db.get("SELECT count(*)::INT AS n FROM eval_metrics");
  return Number(r?.n ?? 0);
}

function validSample(s: unknown): s is EvalMetricsSample {
  if (!s || typeof s !== "object") return false;
  const o = s as Record<string, unknown>;
  return typeof o.runId === "string" && o.runId.length > 0
    && typeof o.model === "string"
    && typeof o.ts === "number" && Number.isFinite(o.ts)
    && typeof o.grossAdd === "number" && typeof o.grossDel === "number" && typeof o.netLoc === "number"
    && !!o.tiers && typeof o.tiers === "object";
}

// A nullable numeric column: keep a real number, else NULL (never coerce a missing signal to 0).
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Ingest every metrics sample from `jsonlPath` into eval_metrics. Idempotent on run_id. */
export async function ingestEvalMetrics(db: Db, jsonlPath: string): Promise<IngestStats> {
  const text = readFileSync(jsonlPath, "utf8");
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const before = await count(db);
  let processed = 0;
  let skipped = 0;
  const ingestedAt = new Date().toISOString();

  for (const line of lines) {
    let s: EvalMetricsSample;
    try {
      const parsed = JSON.parse(line);
      if (!validSample(parsed)) { skipped++; continue; }
      s = parsed;
    } catch { skipped++; continue; }
    try {
      await db.run(
        `INSERT OR IGNORE INTO eval_metrics
           (run_id, model, ts, gross_add, gross_del, net_loc, churn_pct, tokens_per_net_loc,
            tokens_per_clean_loc, context_efficiency, tool_fail_rate, wasted_tokens_est, test_pass_rate,
            spec_conformance, predicted_acceptance, tokens_per_quality_feat, tiers, ingested_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,CAST($17 AS JSON),$18)`,
        [
          s.runId, s.model, new Date(s.ts).toISOString(),
          Math.trunc(s.grossAdd), Math.trunc(s.grossDel), Math.trunc(s.netLoc),
          numOrNull(s.churnPct), numOrNull(s.tokensPerNetLoc), numOrNull(s.tokensPerCleanLoc),
          numOrNull(s.contextEfficiency), numOrNull(s.toolFailRate),
          numOrNull(s.wastedTokensEst) != null ? Math.trunc(s.wastedTokensEst as number) : null,
          numOrNull(s.testPassRate), numOrNull(s.specConformance), numOrNull(s.predictedAcceptance),
          numOrNull(s.tokensPerQualityFeat),
          JSON.stringify(s.tiers ?? {}), ingestedAt,
        ],
      );
    } catch { skipped++; continue; }
    processed++;
  }

  const inserted = (await count(db)) - before;
  return { processed, inserted, duplicates: processed - inserted, skipped };
}

/** Read persisted metrics rows back into EvalMetricsSample (ts as UNIX ms), newest last. Optional
 *  [sinceMs, untilMs) window + model filter scope a report period. Feeds the P-EVAL.3 rollup (Part B). */
export async function readEvalMetricsRows(
  db: Db,
  opts: { sinceMs?: number; untilMs?: number; model?: string } = {},
): Promise<EvalMetricsSample[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.sinceMs != null) { params.push(new Date(opts.sinceMs).toISOString()); where.push(`ts >= $${params.length}`); }
  if (opts.untilMs != null) { params.push(new Date(opts.untilMs).toISOString()); where.push(`ts < $${params.length}`); }
  if (opts.model != null) { params.push(opts.model); where.push(`model = $${params.length}`); }
  const rows = await db.all(
    `SELECT run_id, model, epoch_ms(ts) AS ts_ms, gross_add, gross_del, net_loc, churn_pct,
            tokens_per_net_loc, tokens_per_clean_loc, context_efficiency, tool_fail_rate, wasted_tokens_est,
            test_pass_rate, spec_conformance, predicted_acceptance, tokens_per_quality_feat, tiers
       FROM eval_metrics ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY ts`,
    params,
  );
  return rows.map((r) => ({
    runId: String(r.run_id), model: String(r.model), ts: Number(r.ts_ms),
    grossAdd: Number(r.gross_add), grossDel: Number(r.gross_del), netLoc: Number(r.net_loc),
    churnPct: numOrNull(r.churn_pct), tokensPerNetLoc: numOrNull(r.tokens_per_net_loc),
    tokensPerCleanLoc: numOrNull(r.tokens_per_clean_loc), contextEfficiency: numOrNull(r.context_efficiency),
    toolFailRate: numOrNull(r.tool_fail_rate), wastedTokensEst: numOrNull(r.wasted_tokens_est),
    testPassRate: numOrNull(r.test_pass_rate), specConformance: numOrNull(r.spec_conformance),
    predictedAcceptance: numOrNull(r.predicted_acceptance), tokensPerQualityFeat: numOrNull(r.tokens_per_quality_feat),
    tiers: parseTiers(r.tiers),
  }));
}

function parseTiers(v: unknown): Record<string, string> {
  if (v && typeof v === "object") return v as Record<string, string>; // DuckDB may hand back a parsed JSON object
  if (typeof v === "string") { try { const o = JSON.parse(v); return o && typeof o === "object" ? o : {}; } catch { return {}; } }
  return {};
}
