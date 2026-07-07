// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/brief/evals.ts
//
// P-EVAL.1 (ADR-0187): the PURE core of the Model-Evaluation (Evals) report + the per-model API-latency
// rollup. Sits beside engineering_update.ts / change_graph.ts (the other report generators).
//
// PURE by construction: no I/O, no network, no Date.now() inside these functions (the caller passes every
// timestamp). Deterministic. It computes the run's eval metrics (each tagged direct | proxy | needs_signal
// per ADR-A016's honesty rule - a missing signal is `null` + `needs_signal`, NEVER zero-as-truth), rolls
// per-call API latency into per-model x business-hour p50/p95 buckets (Eastern time, DST-correct), and
// renders deterministic report markdown whose per-model charts are mermaid `xychart-beta` blocks - which
// the EXISTING report viewer (P-REPORT.4 parseChartRows + buildScoreChart) already turns into `.rchart`
// bars while keeping the mermaid copyable. Generated markdown is ASCII-only so the security gate never
// homoglyph-flags it (a lesson from the design pass: `x` U+00D7 gets quarantined).

// ── metric tiers ──────────────────────────────────────────────────────────────
export type MetricTier = "direct" | "proxy" | "needs_signal";
export interface Metric { value: number | null; display: string; tier: MetricTier }
const metric = (value: number | null, display: string, tier: MetricTier): Metric => ({ value, display, tier });

const round1 = (n: number): number => Math.round(n * 10) / 10;
const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);
const ktok = (n: number): string => (n >= 1000 ? `${round1(n / 1000)}k` : String(n));
const pad2 = (n: number): string => String(n).padStart(2, "0");
const fmtMs = (ms: number): string => (ms >= 1000 ? `${round1(ms / 1000)}s` : `${ms}ms`);

// ── per-run eval metrics ────────────────────────────────────────────────────────
export interface FileChange { path: string; add: number; del: number; aiAdd?: number; aiDel?: number }
export interface RunRecord {
  runId: string;
  model: string;
  tokens: { ctx: number; output: number; total: number };
  costUsd: number;
  toolCalls: number;
  toolFailures: { tool: string; reason: string; cmd?: string }[];
  subagents?: number;
  reEdits?: number; // re-edits of already-touched files (action-level rework/churn proxy)
  files: FileChange[];
  tests?: { pass: number; fail: number };
  ac?: { total: number; met: number }; // acceptance criteria (absent => spec metrics are needs_signal)
  cleanLoc?: number; // lint/test-clean surviving LOC (absent => tokens-per-clean-line is needs_signal)
  dod?: { total: number; met: number }; // definition-of-done checklist
}

export interface Provenance { path: string; aiAdd: number; aiDel: number; netKept: number }
export interface EvalMetrics {
  runId: string; model: string;
  grossAdd: number; grossDel: number; netLoc: number;
  churnPct: Metric;
  tokensPerNetLoc: Metric; tokensPerCleanLoc: Metric; contextEfficiency: Metric;
  toolFailRate: Metric; wastedTokensEst: Metric;
  testPassRate: Metric; specConformance: Metric; predictedAcceptance: Metric; tokensPerQualityFeature: Metric;
  provenance: Provenance[];
}

/** Compute the run's eval metrics. PURE. Every metric carries its evidence tier; a metric whose signal is
 *  absent is `null` + `needs_signal` (never faked). */
export function computeEvalMetrics(run: RunRecord): EvalMetrics {
  const grossAdd = run.files.reduce((s, f) => s + f.add, 0);
  const grossDel = run.files.reduce((s, f) => s + f.del, 0);
  const netLoc = grossAdd - grossDel;
  const { ctx, output: out, total: tot } = run.tokens;
  const calls = run.toolCalls;
  const failRate = calls > 0 ? run.toolFailures.length / calls : 0;
  const churn = grossAdd > 0 ? grossDel / grossAdd : 0;

  // tokens per net line (proxy; unstable near 0 -> fall back to per-gross-line)
  const tpnlDenom = netLoc > 0 ? netLoc : grossAdd;
  const tokensPerNetLoc = tpnlDenom > 0 ? metric(round1(out / tpnlDenom), `${round1(out / tpnlDenom)} gen/line`, "proxy") : metric(null, "n/a", "proxy");

  // tokens per CLEAN line: DIRECT with a lint signal; else "surviving net LOC" (needs_signal)
  const cleanBase = run.cleanLoc ?? (netLoc > 0 ? netLoc : 0);
  const tokensPerCleanLoc = cleanBase > 0
    ? metric(round1(out / cleanBase), `${round1(out / cleanBase)} gen/line`, run.cleanLoc != null ? "direct" : "needs_signal")
    : metric(null, "n/a", "needs_signal");

  const contextEfficiency = out > 0 ? metric(round1(ctx / out), `${round1(ctx / out)}x`, "direct") : metric(null, "n/a", "direct");

  // estimated wasted tokens (proxy): failed-call share of total + churn share of output
  const churnRatio = run.reEdits != null && run.files.length > 0 ? clamp01(run.reEdits / run.files.length) : clamp01(churn);
  const wasted = Math.round(failRate * tot + churnRatio * out);

  const testTotal = run.tests ? run.tests.pass + run.tests.fail : 0;
  const testPass = testTotal > 0 && run.tests ? run.tests.pass / testTotal : null;
  const testPassRate = testPass != null ? metric(round1(100 * testPass), `${Math.round(100 * testPass)}%`, "direct") : metric(null, "no tests", "needs_signal");

  const hasAc = run.ac != null && run.ac.total > 0;
  const specVal = hasAc && run.ac ? run.ac.met / run.ac.total : null;
  const specConformance = specVal != null ? metric(round1(100 * specVal), `${Math.round(100 * specVal)}%`, "proxy") : metric(null, "needs AC", "needs_signal");

  const dodVal = run.dod && run.dod.total > 0 ? run.dod.met / run.dod.total : testPass;
  let predictedAcceptance: Metric;
  if (specVal != null && testPass != null) {
    const pa = 100 * (0.35 * specVal + 0.25 * testPass + 0.15 * (1 - clamp01(churnRatio)) + 0.1 * (1 - failRate) + 0.15 * (dodVal ?? testPass));
    predictedAcceptance = metric(Math.round(pa), `${Math.round(pa)}/100`, "proxy");
  } else {
    predictedAcceptance = metric(null, "needs AC + tests", "needs_signal");
  }

  const tokensPerQualityFeature = hasAc && run.ac && run.ac.met > 0
    ? metric(Math.round(tot / run.ac.met), `${ktok(Math.round(tot / run.ac.met))}/feature`, "proxy")
    : metric(null, "needs AC", "needs_signal");

  const provenance: Provenance[] = run.files.map((f) => {
    const aiAdd = f.aiAdd ?? f.add, aiDel = f.aiDel ?? f.del;
    return { path: f.path, aiAdd, aiDel, netKept: Math.max(0, aiAdd - aiDel) };
  });

  return {
    runId: run.runId, model: run.model, grossAdd, grossDel, netLoc,
    churnPct: metric(round1(100 * churn), `${round1(100 * churn)}%`, "proxy"),
    tokensPerNetLoc, tokensPerCleanLoc, contextEfficiency,
    toolFailRate: metric(round1(100 * failRate), `${Math.round(100 * failRate)}%`, "direct"),
    wastedTokensEst: metric(wasted, `~${ktok(wasted)}`, "proxy"),
    testPassRate, specConformance, predictedAcceptance, tokensPerQualityFeature, provenance,
  };
}

// ── API-latency rollup (per model x business hour, Eastern time) ──────────────────
export interface ApiLatencyCall { model: string; ts: number; ttftMs: number; totalMs: number; ok: boolean }
export interface LatencyBucket { hourEt: number; calls: number; avg: number; p50: number; p95: number }
export interface ModelLatency { model: string; calls: number; p50: number; p95: number; byHour: LatencyBucket[] }
export type RollupPeriod = "weekly" | "monthly";
export interface LatencyRollup { period: RollupPeriod; periodStart: number; tz: string; businessHours: [number, number]; metric: "ttft" | "total"; models: ModelLatency[] }

const ET_TZ = "America/New_York";
const BUSINESS: [number, number] = [8, 17]; // [08:00 inclusive, 17:00 exclusive) = the 08:00-17:00 window

/** Bucket a timestamp into its Eastern hour + a business-hours flag. Uses Intl so EST/EDT DST is exact. */
export function hourEt(ts: number, tz: string = ET_TZ): { hour: number; business: boolean } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ts));
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  return { hour, business: hour >= BUSINESS[0] && hour < BUSINESS[1] };
}

/** Deterministic nearest-rank (ceil) percentile. `percentile([], p) === 0`. */
export function percentile(nums: readonly number[], p: number): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? 0;
}

/** Roll per-call latency into per-model x business-hour p50/p95 buckets. Off-hours calls are excluded
 *  unless `businessOnly:false`. `metric` selects TTFT (default) vs total round-trip. PURE. */
export function rollupLatency(
  calls: readonly ApiLatencyCall[],
  opts: { period: RollupPeriod; periodStart: number; tz?: string; metric?: "ttft" | "total"; businessOnly?: boolean },
): LatencyRollup {
  const tz = opts.tz ?? ET_TZ;
  const useTotal = opts.metric === "total";
  const businessOnly = opts.businessOnly !== false;
  const byModel = new Map<string, Map<number, number[]>>();
  const modelAll = new Map<string, number[]>();
  for (const c of calls) {
    const { hour, business } = hourEt(c.ts, tz);
    if (businessOnly && !business) continue;
    const v = useTotal ? c.totalMs : c.ttftMs;
    let hours = byModel.get(c.model);
    if (!hours) { hours = new Map(); byModel.set(c.model, hours); }
    (hours.get(hour) ?? hours.set(hour, []).get(hour)!).push(v);
    (modelAll.get(c.model) ?? modelAll.set(c.model, []).get(c.model)!).push(v);
  }
  const models: ModelLatency[] = [...byModel.entries()].map(([model, hours]) => {
    const byHour: LatencyBucket[] = [...hours.entries()].sort((a, b) => a[0] - b[0]).map(([h, vs]) => ({
      hourEt: h, calls: vs.length,
      avg: Math.round(vs.reduce((s, x) => s + x, 0) / vs.length),
      p50: Math.round(percentile(vs, 50)), p95: Math.round(percentile(vs, 95)),
    }));
    const all = modelAll.get(model) ?? [];
    return { model, calls: all.length, p50: Math.round(percentile(all, 50)), p95: Math.round(percentile(all, 95)), byHour };
  }).sort((a, b) => b.calls - a.calls);
  return { period: opts.period, periodStart: opts.periodStart, tz, businessHours: BUSINESS, metric: useTotal ? "total" : "ttft", models };
}

export interface LatencyDelta { model: string; p50: number; p95: number; prevP50: number | null; prevP95: number | null; deltaP50Pct: number | null; deltaP95Pct: number | null }
const pctChange = (a: number, b: number): number => (b > 0 ? Math.round(((a - b) / b) * 100) : 0);

/** Week-over-week / month-over-month deltas per model (null prev fields when a model is new this period). */
export function compareRollup(cur: LatencyRollup, prev?: LatencyRollup): LatencyDelta[] {
  const prevBy = new Map((prev?.models ?? []).map((m) => [m.model, m]));
  return cur.models.map((m) => {
    const p = prevBy.get(m.model);
    return {
      model: m.model, p50: m.p50, p95: m.p95,
      prevP50: p ? p.p50 : null, prevP95: p ? p.p95 : null,
      deltaP50Pct: p ? pctChange(m.p50, p.p50) : null, deltaP95Pct: p ? pctChange(m.p95, p.p95) : null,
    };
  });
}

// ── deterministic report markdown (ASCII-only; charts as mermaid xychart-beta) ────
const xychart = (title: string, labels: string[], vals: number[]): string[] => [
  "```mermaid", "xychart-beta", `  title "${title}"`,
  `  x-axis [${labels.map((l) => `"${l}"`).join(", ")}]`, `  bar [${vals.join(", ")}]`, "```", "",
];
const row = (cells: (string | number)[]): string => `| ${cells.join(" | ")} |`;

/** Render the per-run Evals section as deterministic ASCII markdown (tables + xychart-beta charts). */
export function renderEvalMarkdown(m: EvalMetrics, meta: { costUsd: number; totalTokens: number; when?: string }): string {
  const L: string[] = [];
  L.push(`# Model Evaluation - ${m.model}`, "");
  L.push(`_run ${m.runId}${meta.when ? ` - ${meta.when}` : ""} - $${meta.costUsd.toFixed(2)} - ${ktok(meta.totalTokens)} tokens_`, "");

  L.push("## Efficiency", "");
  L.push(row(["Metric", "Value", "Basis"]), row(["---", "---", "---"]));
  L.push(row(["Tokens per net line", m.tokensPerNetLoc.display, m.tokensPerNetLoc.tier]));
  L.push(row(["Tokens per clean line", m.tokensPerCleanLoc.display, m.tokensPerCleanLoc.tier]));
  L.push(row(["Context efficiency", m.contextEfficiency.display, m.contextEfficiency.tier]));
  L.push(row(["Tool-call failure rate", m.toolFailRate.display, m.toolFailRate.tier]));
  L.push(row(["Estimated wasted tokens", m.wastedTokensEst.display, m.wastedTokensEst.tier]), "");

  if (m.provenance.length > 0) {
    L.push("## Code provenance (net lines kept, by file)", "");
    L.push(...xychart(`${m.model} net lines kept`, m.provenance.map((p) => (p.path.split("/").pop() ?? p.path)), m.provenance.map((p) => p.netKept)));
  }

  L.push("## Specification conformance and acceptance", "");
  L.push(row(["Metric", "Value", "Basis"]), row(["---", "---", "---"]));
  L.push(row(["Spec conformance", m.specConformance.display, m.specConformance.tier]));
  L.push(row(["Test pass rate", m.testPassRate.display, m.testPassRate.tier]));
  L.push(row(["Predicted acceptance", m.predictedAcceptance.display, m.predictedAcceptance.tier]));
  L.push(row(["Tokens per quality feature", m.tokensPerQualityFeature.display, m.tokensPerQualityFeature.tier]), "");
  return L.join("\n");
}

/** Render the weekly/monthly latency rollup as deterministic ASCII markdown: a per-model xychart of
 *  TTFT p50 by business hour + a WoW/MoM comparison table. */
export function renderLatencyRollupMarkdown(r: LatencyRollup, prev?: LatencyRollup): string {
  const L: string[] = [];
  const periodLabel = r.period === "weekly" ? "Weekly" : "Monthly";
  const kind = r.metric === "total" ? "total" : "TTFT";
  L.push(`# Model Latency Rollup - ${periodLabel}`, "");
  L.push(`_business hours ${pad2(r.businessHours[0])}:00-${pad2(r.businessHours[1])}:00 ${r.tz} - ${kind} p50 by hour_`, "");
  for (const m of r.models) {
    L.push(`## ${m.model} - ${kind} p50 by hour (${m.calls} calls - p50 ${fmtMs(m.p50)} - p95 ${fmtMs(m.p95)})`, "");
    L.push(...xychart(`${m.model} ${kind} p50 (ms) by hour ET`, m.byHour.map((b) => `${pad2(b.hourEt)}:00`), m.byHour.map((b) => b.p50)));
  }
  const deltas = compareRollup(r, prev);
  if (prev) {
    L.push(`## ${r.period === "weekly" ? "Week-over-week" : "Month-over-month"} comparison`, "");
    L.push(row(["Model", "p50", "prev p50", "change", "p95 change"]), row(["---", "---", "---", "---", "---"]));
    for (const d of deltas) {
      const sign = (n: number | null): string => (n == null ? "-" : `${n > 0 ? "+" : ""}${n}%`);
      L.push(row([d.model, fmtMs(d.p50), d.prevP50 == null ? "-" : fmtMs(d.prevP50), sign(d.deltaP50Pct), sign(d.deltaP95Pct)]));
    }
    L.push("");
  }
  return L.join("\n");
}
