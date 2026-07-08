// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/brief/eval_metrics_report.ts
//
// P-EVAL.3 Part B (ADR-0187): the PURE cross-run aggregator + renderer for the persisted eval metrics
// (eval_metrics table, read via readEvalMetricsRows). Where renderEvalMarkdown (P-EVAL.1) reports ONE run,
// this rolls MANY runs per model into means + coverage and renders the deterministic ASCII markdown whose
// xychart-beta blocks the P-REPORT.4 viewer bar-ifies. The honesty rule is preserved: a metric is averaged
// ONLY over the runs that actually had that signal (null values are excluded, never counted as 0); the
// "signal" column shows the coverage (runs-with-signal / total), and a metric with zero coverage reads
// "no signal" rather than a fake number.
//
// PURE by construction: no I/O, no Date.now() (the caller passes `now`/`when`). Deterministic + ASCII-only.

import type { EvalMetricsSample } from "../memory/eval_metrics_ingest.ts";

const round1 = (n: number): number => Math.round(n * 10) / 10;
const ktok = (n: number): string => (n >= 1000 ? `${round1(n / 1000)}k` : String(n));

// The metric columns, in report order: key on EvalMetricsSample, label, and how to display a mean.
type MetricKey =
  | "tokensPerNetLoc" | "tokensPerCleanLoc" | "contextEfficiency" | "toolFailRate" | "wastedTokensEst"
  | "churnPct" | "testPassRate" | "specConformance" | "predictedAcceptance" | "tokensPerQualityFeat";

interface MetricDef { key: MetricKey; label: string; fmt: (v: number) => string }
const METRICS: MetricDef[] = [
  { key: "tokensPerNetLoc", label: "Tokens per net line", fmt: (v) => `${round1(v)} gen/line` },
  { key: "tokensPerCleanLoc", label: "Tokens per clean line", fmt: (v) => `${round1(v)} gen/line` },
  { key: "contextEfficiency", label: "Context efficiency", fmt: (v) => `${round1(v)}x` },
  { key: "toolFailRate", label: "Tool-call failure rate", fmt: (v) => `${round1(v)}%` },
  { key: "wastedTokensEst", label: "Wasted tokens (avg)", fmt: (v) => `~${ktok(Math.round(v))}` },
  { key: "churnPct", label: "Churn", fmt: (v) => `${round1(v)}%` },
  { key: "testPassRate", label: "Test pass rate", fmt: (v) => `${round1(v)}%` },
  { key: "specConformance", label: "Spec conformance", fmt: (v) => `${round1(v)}%` },
  { key: "predictedAcceptance", label: "Predicted acceptance", fmt: (v) => `${round1(v)}/100` },
  { key: "tokensPerQualityFeat", label: "Tokens per quality feature", fmt: (v) => `${ktok(Math.round(v))}/feature` },
];

/** One metric aggregated across a model's runs: the mean over runs that HAD the signal, the coverage
 *  count `n`, and the evidence tier (from the contributing runs, else the honest needs_signal). */
export interface MetricAgg { mean: number | null; n: number; tier: string }

export interface ModelEvalRollup {
  model: string;
  runs: number;
  totalNetLoc: number;
  metrics: Record<MetricKey, MetricAgg>;
}

function aggOne(rows: readonly EvalMetricsSample[], key: MetricKey): MetricAgg {
  const vals: number[] = [];
  let tier = "needs_signal";
  for (const r of rows) {
    const v = r[key];
    const t = r.tiers?.[key];
    if (typeof v === "number") { vals.push(v); if (t) tier = t; }
  }
  if (vals.length === 0) {
    // no run carried this signal — surface the honest tier if the rows agree on one
    const t = rows.find((r) => r.tiers?.[key])?.tiers?.[key];
    return { mean: null, n: 0, tier: t ?? "needs_signal" };
  }
  return { mean: round1(vals.reduce((s, x) => s + x, 0) / vals.length), n: vals.length, tier };
}

/** Roll the per-run rows up per model: run count, total net LOC, and each metric's mean over the runs that
 *  had the signal. Sorted by run volume (most-active model first). PURE. */
export function aggregateEvalMetrics(rows: readonly EvalMetricsSample[]): ModelEvalRollup[] {
  const byModel = new Map<string, EvalMetricsSample[]>();
  for (const r of rows) (byModel.get(r.model) ?? byModel.set(r.model, []).get(r.model)!).push(r);
  const out: ModelEvalRollup[] = [];
  for (const [model, rs] of byModel) {
    const metrics = {} as Record<MetricKey, MetricAgg>;
    for (const d of METRICS) metrics[d.key] = aggOne(rs, d.key);
    out.push({ model, runs: rs.length, totalNetLoc: rs.reduce((s, r) => s + r.netLoc, 0), metrics });
  }
  return out.sort((a, b) => b.runs - a.runs);
}

const xychart = (title: string, labels: string[], vals: number[]): string[] => [
  "```mermaid", "xychart-beta", `  title "${title}"`,
  `  x-axis [${labels.map((l) => `"${l}"`).join(", ")}]`, `  bar [${vals.join(", ")}]`, "```", "",
];
const trow = (cells: (string | number)[]): string => `| ${cells.join(" | ")} |`;

/** Render the cross-run eval rollup as deterministic ASCII markdown (a net-LOC-by-model chart + a per-model
 *  metrics table). ASCII-only so the security gate never homoglyph-flags it. PURE. */
export function renderEvalMetricsRollupMarkdown(rows: readonly EvalMetricsSample[], opts: { when?: string } = {}): string {
  const models = aggregateEvalMetrics(rows);
  const L: string[] = [];
  L.push("# Model Evaluation Rollup", "");
  L.push(`_${rows.length} run${rows.length === 1 ? "" : "s"} across ${models.length} model${models.length === 1 ? "" : "s"}${opts.when ? ` - ${opts.when}` : ""}_`, "");
  if (models.length === 0) { L.push("_No runs recorded yet. Generate a run report to start the ledger._", ""); return L.join("\n"); }

  L.push("## Net lines kept by model", "");
  L.push(...xychart("Net LOC by model", models.map((m) => m.model), models.map((m) => m.totalNetLoc)));

  for (const m of models) {
    L.push(`## ${m.model} (${m.runs} run${m.runs === 1 ? "" : "s"} - ${m.totalNetLoc} net LOC)`, "");
    L.push(trow(["Metric", "Mean", "Signal", "Basis"]), trow(["---", "---", "---", "---"]));
    for (const d of METRICS) {
      const a = m.metrics[d.key];
      const value = a.mean == null ? "no signal" : d.fmt(a.mean);
      const coverage = `${a.n}/${m.runs}`;
      L.push(trow([d.label, value, coverage, a.tier]));
    }
    L.push("");
  }
  return L.join("\n");
}
