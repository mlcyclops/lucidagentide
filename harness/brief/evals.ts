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
//
// P-EVAL.4 (ADR-0187): the report got RICHER without getting less honest. Two things made a generated
// report read as broken. (a) Four metrics were permanently dead: nothing in the pipeline ever populates
// RunRecord.tests / .ac / .cleanLoc / .dod, so 40% of the table said `needs_signal` on EVERY report,
// forever. (b) Per-tool detail was coarse, because omp's ACP `tool_call` update transmits only
// toolCallId/title/kind/status/rawInput and NEVER the real toolName (see
// node_modules/@oh-my-pi/pi-coding-agent/src/modes/acp/acp-event-mapper.ts:410-417), so a turn's whole
// tool list collapsed into "other x23".
//
// The fix keeps the FROZEN axis frozen. `Metric.tier` (direct | proxy | needs_signal) is persisted verbatim
// into eval_metrics.tiers (migration 0011) and averaged across runs by eval_metrics_report.ts, so a
// report-time PROXY must never land in that ledger: blending one real AC check with one tool-failure guess
// is precisely the fake precision ADR-A016 exists to prevent. So the measured metrics are computed EXACTLY
// as P-EVAL.1 wrote them (null + `needs_signal` when the signal is absent, and that is what persists), and
// the substitutes live on a SECOND, render-only axis: `EvalMetrics.derived` (the substitute Metric per key)
// plus `EvalMetrics.sources` (measured | derived | none per key). That is the ONE provenance approach in
// this module; there is no parallel `derived: string[]` list. renderEvalMarkdown prefers the substitute over
// a signal-less measurement and labels every row with its provenance, so a reader always knows whether a
// number was measured, substituted, or genuinely absent, and an absent one gets an explicit "not measured
// this run" line instead of silently vanishing.

// ── metric tiers ──────────────────────────────────────────────────────────────
export type MetricTier = "direct" | "proxy" | "needs_signal";
export interface Metric { value: number | null; display: string; tier: MetricTier }
const metric = (value: number | null, display: string, tier: MetricTier): Metric => ({ value, display, tier });

/** P-EVAL.4: metric PROVENANCE, a second axis orthogonal to `MetricTier`. `tier` answers "how strong is the
 *  evidence class" and is frozen (it is persisted and cross-run averaged); `source` answers "where did this
 *  number come from": `measured` = computed from the signal it is meant to measure, `derived` = a documented
 *  substitute because that signal is absent, `none` = nothing derivable, so the metric stays null. */
export type MetricSource = "measured" | "derived" | "none";

/** Every metric key `sources` / `derived` may carry. A closed union rather than `keyof EvalMetrics`, so the
 *  non-metric fields (runId, grossAdd, provenance, ...) can never be indexed by accident. */
export type EvalMetricKey =
  | "churnPct" | "tokensPerNetLoc" | "tokensPerCleanLoc" | "contextEfficiency" | "toolFailRate"
  | "wastedTokensEst" | "testPassRate" | "specConformance" | "predictedAcceptance"
  | "tokensPerQualityFeature" | "dodCompletion";

const round1 = (n: number): number => Math.round(n * 10) / 10;
const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);
const ktok = (n: number): string => (n >= 1000 ? `${round1(n / 1000)}k` : String(n));
const pad2 = (n: number): string => String(n).padStart(2, "0");
const fmtMs = (ms: number): string => (ms >= 1000 ? `${round1(ms / 1000)}s` : `${ms}ms`);
const signed = (n: number): string => (n > 0 ? `+${n}` : String(n));

/** P-EVAL.4: force a caller-supplied string (a tool name, a command detail, a file path) into the
 *  table-safe ASCII the whole report guarantees. Non-ASCII is the homoglyph vector the security gate
 *  quarantines (the original lesson was U+00D7 in a chart label), and a raw `|`, `"` or newline would
 *  shatter a markdown table row or a mermaid label. Empty in, "-" out, so a cell is never blank. */
const ascii = (s: string, max = 60): string => {
  const clean = s.replace(/[^\x20-\x7E]+/g, "?").replace(/\|/g, "/").replace(/"/g, "'").trim();
  return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean || "-";
};

// ── per-run eval metrics ────────────────────────────────────────────────────────
export interface FileChange { path: string; add: number; del: number; aiAdd?: number; aiDel?: number }

/** P-EVAL.4: one tool call as the run OBSERVED it. EVERY field is optional because the transports disagree
 *  about what they can carry: omp's ACP `tool_call` update ships only the coarse `kind` (read | edit |
 *  other) and never the real toolName, while a self-report channel does ship a name. So `name` is the real
 *  tool name WHEN KNOWN and `kind` is the coarse class; the breakdown groups by name and falls back to
 *  kind, which is what turns "other x23" back into "read x14, edit x6, bash x3 (1 failed)". `detail` is a
 *  one-line, already-redacted string (a path, a command, a query), ASCII-sanitized + truncated at render
 *  time. `ok:false` marks a failed call; `undefined` means the transport carried no per-call status, in
 *  which case the run's `toolFailures` ledger is used to attribute failures instead. */
export interface ToolRecord {
  name?: string;
  kind?: string;
  detail?: string;
  ok?: boolean;
  durationMs?: number;
}

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
  tools?: ToolRecord[]; // P-EVAL.4: per-call detail when the transport carried it (absent on an older client)
}

export interface Provenance { path: string; aiAdd: number; aiDel: number; netKept: number }

/** P-EVAL.4: one row of the tool breakdown. `label` is the real tool name when the transport carried one,
 *  else the coarse kind, else "unknown". `attributed:false` marks the residual bucket holding calls the run
 *  counted in `toolCalls` but could not name, so the totals reconcile without inventing a tool. */
export interface ToolStat {
  label: string; kind: string | null; calls: number; failures: number;
  avgMs: number | null; detail: string | null; attributed: boolean;
}

/** P-EVAL.4: one row of the files-touched table. */
export interface FileTouch { path: string; add: number; del: number; net: number }

export interface EvalMetrics {
  runId: string; model: string;
  grossAdd: number; grossDel: number; netLoc: number;
  churnPct: Metric;
  tokensPerNetLoc: Metric; tokensPerCleanLoc: Metric; contextEfficiency: Metric;
  toolFailRate: Metric; wastedTokensEst: Metric;
  testPassRate: Metric; specConformance: Metric; predictedAcceptance: Metric; tokensPerQualityFeature: Metric;
  provenance: Provenance[];
  // ── P-EVAL.4 additions. ALL optional, and every existing field above keeps its name, type and computed
  // value: eval_metrics_log.ts / eval_metrics_ingest.ts / migration 0011 persist the shape above, and an
  // EvalMetrics rehydrated from an older row carries none of the fields below. Readers must tolerate that.
  dodCompletion?: Metric;                                // definition-of-done completion (the `dod` signal, finally reachable)
  derived?: Partial<Record<EvalMetricKey, Metric>>;       // render-only substitutes; NEVER persisted, NEVER cross-run averaged
  sources?: Partial<Record<EvalMetricKey, MetricSource>>; // provenance per metric key
  toolStats?: ToolStat[];                                // grouped by real tool name, with per-tool failure counts
  filesTouched?: FileTouch[];                            // path / added / removed / net
}

// ── P-EVAL.4: observable verification signals ─────────────────────────────────
// Recognizing a test / verification invocation from whatever the transport DID carry. Deliberately
// conservative and anchored on an explicit runner token: a run that merely EDITED `foo.test.ts` must never
// be credited with having RUN tests. A failure's `reason` ("exit 1") is never matched because it says
// nothing about what ran; only its `cmd` does.
const TEST_RE = /\b(bun test|deno test|npm (?:run )?test|yarn test|pnpm test|make test|go test|cargo test|pytest|vitest|jest|mocha|unittest)\b/i;
const VERIFY_RE = /\b(bun test|deno test|npm (?:run )?test|yarn test|pnpm test|make (?:test|check|lint|typecheck)|go test|cargo (?:test|check|clippy)|pytest|vitest|jest|mocha|unittest|tsc|typecheck|type-check|eslint|biome|ruff|mypy|clippy|bun build|npm run build|lint)\b/i;

const toolText = (t: ToolRecord): string => `${t.name ?? ""} ${t.kind ?? ""} ${t.detail ?? ""}`;
const failText = (f: { tool: string; cmd?: string }): string => `${f.tool} ${f.cmd ?? ""}`;
const trimOr = (s: string | undefined): string | undefined => { const v = (s ?? "").trim(); return v.length > 0 ? v : undefined; };

const UNKNOWN_TOOL = "unknown";
const UNATTRIBUTED = "unattributed";

interface RunSignals { testRuns: number; testFails: number; verified: boolean; endedClean: boolean }

/** P-EVAL.4: what the run's OBSERVED activity says about verification, computed only from telemetry that is
 *  ALWAYS present (the per-call records when the transport carried them, the failure ledger otherwise).
 *  These four numbers are the ENTIRE input to the derived test / spec / DoD substitutes below, which is
 *  exactly why those are proxies and never measurements. PURE. */
function runSignals(run: RunRecord): RunSignals {
  const recs = run.tools ?? [];
  const testRecs = recs.filter((t) => TEST_RE.test(toolText(t)));
  const ledgerTestFails = run.toolFailures.filter((f) => TEST_RE.test(failText(f))).length;
  // A failed test command on the ledger implies at least that many invocations, even when the transport
  // sent no per-call record for them (the old shape has no records at all).
  const testRuns = Math.max(testRecs.length, ledgerTestFails);
  const testOkKnown = testRecs.some((t) => typeof t.ok === "boolean");
  const testFails = testOkKnown ? testRecs.filter((t) => t.ok === false).length : Math.min(testRuns, ledgerTestFails);
  const verified = recs.some((t) => VERIFY_RE.test(toolText(t))) || run.toolFailures.some((f) => VERIFY_RE.test(failText(f)));
  // "Ended clean" = the LAST call that reported a status succeeded. With no per-call status anywhere we can
  // only ask whether the run finished with any failure on its ledger.
  const withOk = recs.filter((t) => typeof t.ok === "boolean");
  const endedClean = withOk.length > 0 ? withOk[withOk.length - 1]!.ok !== false : run.toolFailures.length === 0;
  return { testRuns, testFails, verified, endedClean };
}

/** P-EVAL.4: group the run's tool calls by REAL tool name (falling back to the coarse ACP kind, then
 *  "unknown") with per-group call + failure counts and mean duration. Failure attribution: a group that
 *  carries explicit per-call ok/failed telemetry is authoritative; a group that does not borrows its count
 *  from the run's failure ledger, matched on tool name. A ledger failure naming a tool with no records at
 *  all becomes its own group, because a failure IS a call we know happened. Whatever remains between the
 *  named groups and the run's `toolCalls` total becomes an explicit "unattributed" bucket, so the table
 *  reconciles without either dropping calls or mislabeling them. Sorted attributed-first, then by volume,
 *  then by name, so the rendered table is deterministic. PURE. */
export function toolBreakdown(run: RunRecord): ToolStat[] {
  interface G { kind: string | null; calls: number; failures: number; ms: number[]; detail: string | null; okKnown: boolean }
  const groups = new Map<string, G>();
  const at = (label: string): G => {
    let g = groups.get(label);
    if (!g) { g = { kind: null, calls: 0, failures: 0, ms: [], detail: null, okKnown: false }; groups.set(label, g); }
    return g;
  };
  for (const t of run.tools ?? []) {
    const g = at(trimOr(t.name) ?? trimOr(t.kind) ?? UNKNOWN_TOOL);
    g.calls++;
    if (g.kind == null) g.kind = trimOr(t.kind) ?? null;
    if (g.detail == null) g.detail = trimOr(t.detail) ?? null;
    if (typeof t.ok === "boolean") { g.okKnown = true; if (!t.ok) g.failures++; }
    if (typeof t.durationMs === "number" && Number.isFinite(t.durationMs) && t.durationMs >= 0) g.ms.push(t.durationMs);
  }
  const ledger = new Map<string, number>();
  for (const f of run.toolFailures) {
    const k = trimOr(f.tool) ?? UNKNOWN_TOOL;
    ledger.set(k, (ledger.get(k) ?? 0) + 1);
  }
  for (const [tool, n] of ledger) {
    const known = groups.get(tool);
    if (!known) { const fresh = at(tool); fresh.calls += n; fresh.failures += n; continue; }
    if (!known.okKnown) known.failures = Math.min(known.calls, n);
  }
  const stats: ToolStat[] = [...groups.entries()].map(([label, g]) => ({
    label, kind: g.kind, calls: g.calls, failures: Math.min(g.calls, g.failures),
    avgMs: g.ms.length > 0 ? Math.round(g.ms.reduce((s, x) => s + x, 0) / g.ms.length) : null,
    detail: g.detail, attributed: true,
  }));
  const named = stats.reduce((s, x) => s + x.calls, 0);
  if (run.toolCalls > named) {
    stats.push({ label: UNATTRIBUTED, kind: null, calls: run.toolCalls - named, failures: 0, avgMs: null, detail: null, attributed: false });
  }
  // Plain codepoint compare, NOT localeCompare: this module promises deterministic output, and a
  // locale-sensitive collation would let the same run render a differently-ordered table on another host.
  stats.sort((a, b) => Number(b.attributed) - Number(a.attributed) || b.calls - a.calls || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  return stats;
}

/** P-EVAL.4: the one-line tool summary, e.g. `read x14, edit x6, bash x3 (1 failed)`. PURE. */
export function toolSummaryLine(stats: readonly ToolStat[]): string {
  if (stats.length === 0) return "no tool calls observed";
  return stats.map((s) => `${ascii(s.label, 32)} x${s.calls}${s.failures > 0 ? ` (${s.failures} failed)` : ""}`).join(", ");
}

/** P-EVAL.4: the run's per-file add / remove / net table. Input order is preserved so this table and the
 *  provenance chart read in the same order. PURE. */
export function filesTouched(run: RunRecord): FileTouch[] {
  return run.files.map((f) => ({ path: f.path, add: f.add, del: f.del, net: f.add - f.del }));
}

/** Compute the run's eval metrics. PURE.
 *
 *  Two axes, and the distinction is load-bearing. The MEASURED metrics are computed exactly as P-EVAL.1
 *  wrote them: each carries its evidence tier, and a metric whose signal is absent is `null` +
 *  `needs_signal`, never faked. Those are the values eval_metrics_log.ts persists and eval_metrics_report.ts
 *  averages across runs, so they stay measurement-only forever.
 *
 *  P-EVAL.4 then fills a render-only second axis for the signals nothing in this pipeline populates
 *  (tests / ac / cleanLoc / dod): `derived` holds a documented substitute computed from telemetry that IS
 *  always present, and `sources` records measured | derived | none per metric key. A metric with no
 *  derivable input stays null with source `none`, so the report can say "not measured this run" out loud
 *  instead of printing `needs_signal` on 40% of its rows. */
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

  // ── P-EVAL.4: the definition-of-done metric, finally reachable ──────────────
  // `run.dod` existed on RunRecord since P-EVAL.1 but had no metric of its own: it only ever leaked into
  // predictedAcceptance's blend. Giving it a row means the report states DoD completion directly.
  const measuredDod = run.dod != null && run.dod.total > 0 ? run.dod.met / run.dod.total : null;
  const dodCompletion = measuredDod != null
    ? metric(round1(100 * measuredDod), `${Math.round(100 * measuredDod)}%`, "direct")
    : metric(null, "no DoD checklist", "needs_signal");

  // ── P-EVAL.4: the render-only derived axis ─────────────────────────────────
  const sig = runSignals(run);
  const derived: Partial<Record<EvalMetricKey, Metric>> = {};

  // Tokens per clean line, with no lint signal: discount net LOC by the churn this module already computed.
  // `netLoc` lines landed, but a `churn` share of the adds was overwritten INSIDE the run, so proportionally
  // fewer lines survived to be lint-clean. A substitute DENOMINATOR, never a lint measurement, and always
  // at least 1 so a churn-heavy run cannot divide by zero.
  if (run.cleanLoc == null && netLoc > 0) {
    const surviving = Math.max(1, Math.round(netLoc * (1 - clamp01(churn))));
    derived.tokensPerCleanLoc = metric(round1(out / surviving), `${round1(out / surviving)} gen/line`, "proxy");
  }

  // Test pass rate, with no test report: count test-runner INVOCATIONS and how many of them failed. This is
  // a per-invocation rate, NOT a per-assertion rate. `bun test` failing once means "the suite is red", not
  // "1 of N assertions failed", so the display names its denominator and the row renders as derived.
  if (testPass == null && sig.testRuns > 0) {
    const r = (sig.testRuns - sig.testFails) / sig.testRuns;
    derived.testPassRate = metric(round1(100 * r), `${Math.round(100 * r)}% of ${sig.testRuns} test run${sig.testRuns === 1 ? "" : "s"}`, "proxy");
  }

  // Spec conformance + definition of done, with no AC list and no DoD checklist. There is nothing to check a
  // spec AGAINST here, so these are explicitly PROXIES for "did the run do what it set out to do", built
  // from the only three things always observable: did the calls it made succeed (failRate), did anything
  // verification-class run AT ALL, and did it finish without an outstanding failure. They share inputs and
  // are therefore correlated by construction; spec conformance leans on execution success, DoD on whether
  // the run actually PROVED anything. Neither is a spec check, neither is ever persisted, and both render
  // with source `derived` so no reader mistakes one for a conformance measurement.
  const attempted = calls > 0 || run.files.length > 0;
  const specProxy = attempted ? clamp01(0.6 * (1 - failRate) + 0.25 * (sig.verified ? 1 : 0) + 0.15 * (sig.endedClean ? 1 : 0)) : null;
  const dodProxy = attempted ? clamp01(0.4 * (sig.verified ? 1 : 0) + 0.3 * (sig.endedClean ? 1 : 0) + 0.3 * (1 - failRate)) : null;
  if (specVal == null && specProxy != null) derived.specConformance = metric(round1(100 * specProxy), `${Math.round(100 * specProxy)}%`, "proxy");
  if (measuredDod == null && dodProxy != null) derived.dodCompletion = metric(round1(100 * dodProxy), `${Math.round(100 * dodProxy)}%`, "proxy");

  // Predicted acceptance: the SAME weighted blend as the measured path, fed by whatever is available. When
  // tests were not reported we substitute the DoD signal for the test term (both answer "was this
  // verified"), and the row renders as derived so the reader knows the blend contains proxies.
  if (predictedAcceptance.value == null) {
    const specF = specVal ?? specProxy;
    const doneF = measuredDod ?? dodProxy;
    const passF = testPass ?? (derived.testPassRate?.value != null ? derived.testPassRate.value / 100 : null) ?? doneF;
    if (specF != null && passF != null && doneF != null) {
      const pa = 100 * (0.35 * specF + 0.25 * passF + 0.15 * (1 - clamp01(churnRatio)) + 0.1 * (1 - failRate) + 0.15 * doneF);
      derived.predictedAcceptance = metric(Math.round(pa), `${Math.round(pa)}/100`, "proxy");
    }
  }

  // Tokens per quality feature, with no AC list: the closest observable "delivered unit" is a file that
  // ended the run with surviving net lines. Coarser than a feature, so the display says "/file delivered"
  // rather than "/feature" and never claims a feature count nobody counted.
  const deliveredUnits = provenance.filter((p) => p.netKept > 0).length;
  if (tokensPerQualityFeature.value == null && deliveredUnits > 0) {
    const per = Math.round(tot / deliveredUnits);
    derived.tokensPerQualityFeature = metric(per, `${ktok(per)}/file delivered`, "proxy");
  }

  const churnPct = metric(round1(100 * churn), `${round1(100 * churn)}%`, "proxy");
  const toolFailRate = metric(round1(100 * failRate), `${Math.round(100 * failRate)}%`, "direct");
  const wastedTokensEst = metric(wasted, `~${ktok(wasted)}`, "proxy");

  // Provenance per key. A metric is `measured` when its OWN signal produced it (a direct/proxy tier off the
  // intended input), `derived` when P-EVAL.4 substituted, `none` when it stayed null with nothing to
  // substitute. Note that `needs_signal` PLUS a value is P-EVAL.1's older unnamed substitute case (tokens
  // per clean line falling back to net LOC), which `derived` now names properly.
  const own: readonly (readonly [EvalMetricKey, Metric])[] = [
    ["churnPct", churnPct], ["tokensPerNetLoc", tokensPerNetLoc], ["tokensPerCleanLoc", tokensPerCleanLoc],
    ["contextEfficiency", contextEfficiency], ["toolFailRate", toolFailRate], ["wastedTokensEst", wastedTokensEst],
    ["testPassRate", testPassRate], ["specConformance", specConformance], ["predictedAcceptance", predictedAcceptance],
    ["tokensPerQualityFeature", tokensPerQualityFeature], ["dodCompletion", dodCompletion],
  ];
  const sources: Partial<Record<EvalMetricKey, MetricSource>> = {};
  for (const [k, met] of own) {
    sources[k] = met.tier !== "needs_signal" && met.value != null ? "measured" : derived[k] != null ? "derived" : "none";
  }

  return {
    runId: run.runId, model: run.model, grossAdd, grossDel, netLoc,
    churnPct,
    tokensPerNetLoc, tokensPerCleanLoc, contextEfficiency,
    toolFailRate,
    wastedTokensEst,
    testPassRate, specConformance, predictedAcceptance, tokensPerQualityFeature, provenance,
    dodCompletion, derived, sources,
    toolStats: toolBreakdown(run), filesTouched: filesTouched(run),
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

// ── P-EVAL.4: the metric rows in report order. ONE source of truth drives the rendered tables AND the
// "Not measured this run" section, so a metric can never appear in one and be silently dropped from the
// other (the silent drop is exactly what made a report read as "missing details").
const EFFICIENCY_ROWS: readonly (readonly [EvalMetricKey, string])[] = [
  ["tokensPerNetLoc", "Tokens per net line"],
  ["tokensPerCleanLoc", "Tokens per clean line"],
  ["contextEfficiency", "Context efficiency"],
  ["toolFailRate", "Tool-call failure rate"],
  ["wastedTokensEst", "Estimated wasted tokens"],
  // P-EVAL.4: churn was computed and persisted since P-EVAL.1 (and cross-run averaged by
  // eval_metrics_report.ts) but never rendered anywhere, which is its own missing detail. Appended last so
  // the rows above keep their existing order.
  ["churnPct", "Code churn (deleted / added)"],
];
const CONFORMANCE_ROWS: readonly (readonly [EvalMetricKey, string])[] = [
  ["specConformance", "Spec conformance"],
  ["testPassRate", "Test pass rate"],
  ["dodCompletion", "Definition of done"],
  ["predictedAcceptance", "Predicted acceptance"],
  ["tokensPerQualityFeature", "Tokens per quality feature"],
];

// Accessors rather than an index type, because `dodCompletion` is optional on EvalMetrics (an older
// persisted/hand-built shape has none of the P-EVAL.4 fields) and every reader must tolerate that.
const MEASURED_METRIC: Record<EvalMetricKey, (m: EvalMetrics) => Metric | undefined> = {
  churnPct: (m) => m.churnPct,
  tokensPerNetLoc: (m) => m.tokensPerNetLoc,
  tokensPerCleanLoc: (m) => m.tokensPerCleanLoc,
  contextEfficiency: (m) => m.contextEfficiency,
  toolFailRate: (m) => m.toolFailRate,
  wastedTokensEst: (m) => m.wastedTokensEst,
  testPassRate: (m) => m.testPassRate,
  specConformance: (m) => m.specConformance,
  predictedAcceptance: (m) => m.predictedAcceptance,
  tokensPerQualityFeature: (m) => m.tokensPerQualityFeature,
  dodCompletion: (m) => m.dodCompletion,
};

const SOURCE_LABEL: Record<MetricSource, string> = { measured: "measured", derived: "derived", none: "not measured" };
const NOT_MEASURED = "not measured this run";

// Why a metric could not be measured OR derived. Named per key so the report tells the reader which signal
// to wire up next instead of just printing a blank.
const NO_SIGNAL_REASON: Partial<Record<EvalMetricKey, string>> = {
  tokensPerNetLoc: "no lines were added or removed",
  tokensPerCleanLoc: "no lint-clean LOC signal, and no surviving net lines to stand in for it",
  contextEfficiency: "the run generated no output tokens",
  testPassRate: "no test-runner invocation was observed, so this run neither passed nor failed tests",
  specConformance: "no acceptance criteria, and no tool activity to infer execution from",
  dodCompletion: "no definition-of-done checklist, and no tool activity to infer completion from",
  predictedAcceptance: "its inputs (spec conformance and a verification signal) are both absent",
  tokensPerQualityFeature: "no acceptance criteria, and no file ended the run with surviving lines",
};

/** P-EVAL.4: resolve one row to the number the report should SHOW plus where that number came from. The
 *  derived substitute wins over a measurement that has no signal, because a labelled proxy tells a reader
 *  more than the word `needs_signal`; a measurement with a signal always wins. Falls back to inferring the
 *  source from the tiers when `sources` is absent (an EvalMetrics from before P-EVAL.4). */
function resolveMetric(m: EvalMetrics, key: EvalMetricKey): { shown: Metric; source: MetricSource } {
  const own = MEASURED_METRIC[key](m);
  const sub = m.derived?.[key];
  const source = m.sources?.[key]
    ?? (own != null && own.tier !== "needs_signal" && own.value != null ? "measured" : sub != null ? "derived" : "none");
  if (source === "derived" && sub != null) return { shown: sub, source };
  return { shown: own ?? sub ?? metric(null, NOT_MEASURED, "needs_signal"), source };
}

/** One metric table row: label, the shown value (or an explicit not-measured phrase), the evidence tier,
 *  and the P-EVAL.4 provenance. A null value NEVER renders as a bare number or a blank cell. */
const metricRow = (m: EvalMetrics, key: EvalMetricKey, label: string): string => {
  const { shown, source } = resolveMetric(m, key);
  return row([label, shown.value != null ? ascii(shown.display, 40) : NOT_MEASURED, shown.tier, SOURCE_LABEL[source]]);
};

/** Render the per-run Evals section as deterministic ASCII markdown (tables + xychart-beta charts).
 *
 *  P-EVAL.4: every metric row now carries its provenance (measured | derived | not measured), the tool
 *  breakdown + files-touched tables render whatever per-call detail the caller supplied, and any metric with
 *  no derivable input gets an explicit "not measured this run" line rather than vanishing. The existing
 *  section ORDER and HEADINGS are unchanged and the new sections are appended, so a saved report still
 *  diffs cleanly against one generated before this increment. Every caller-supplied string (tool name,
 *  detail, file path) goes through `ascii()`, so the whole document stays ASCII-only and gate-safe even
 *  when the telemetry carried a homoglyph or a table-breaking pipe. */
export function renderEvalMarkdown(m: EvalMetrics, meta: { costUsd: number; totalTokens: number; when?: string }): string {
  const L: string[] = [];
  L.push(`# Model Evaluation - ${m.model}`, "");
  L.push(`_run ${m.runId}${meta.when ? ` - ${meta.when}` : ""} - $${meta.costUsd.toFixed(2)} - ${ktok(meta.totalTokens)} tokens_`, "");

  L.push("## Efficiency", "");
  L.push(row(["Metric", "Value", "Basis", "Source"]), row(["---", "---", "---", "---"]));
  for (const [key, label] of EFFICIENCY_ROWS) L.push(metricRow(m, key, label));
  L.push("");

  if (m.provenance.length > 0) {
    L.push("## Code provenance (net lines kept, by file)", "");
    L.push(...xychart(`${m.model} net lines kept`, m.provenance.map((p) => ascii(p.path.split("/").pop() ?? p.path, 24)), m.provenance.map((p) => p.netKept)));
  }

  L.push("## Specification conformance and acceptance", "");
  L.push(row(["Metric", "Value", "Basis", "Source"]), row(["---", "---", "---", "---"]));
  for (const [key, label] of CONFORMANCE_ROWS) L.push(metricRow(m, key, label));
  L.push("");

  // P-EVAL.4: tool activity, grouped by REAL tool name when the transport carried one (the coarse ACP kind
  // otherwise), so a 23-call turn reads "read x14, edit x6, bash x3 (1 failed)" instead of "other x23".
  const stats = m.toolStats ?? [];
  if (stats.length > 0) {
    L.push("## Tool activity", "");
    L.push(`_${toolSummaryLine(stats)}_`, "");
    L.push(row(["Tool", "Kind", "Calls", "Failed", "Avg", "Detail"]), row(["---", "---", "---", "---", "---", "---"]));
    for (const s of stats) {
      L.push(row([
        ascii(s.label, 32), s.kind != null ? ascii(s.kind, 16) : "-", s.calls, s.failures,
        s.avgMs != null ? fmtMs(s.avgMs) : "-", s.detail != null ? ascii(s.detail) : "-",
      ]));
    }
    L.push(row(["Total", "-", stats.reduce((n, s) => n + s.calls, 0), stats.reduce((n, s) => n + s.failures, 0), "-", "-"]), "");
  }

  // P-EVAL.4: files touched. A multi-file turn was previously legible only as a chart of net lines kept,
  // which hides the add/remove split that tells you whether a file was written or rewritten.
  const touched = m.filesTouched ?? [];
  if (touched.length > 0) {
    L.push("## Files touched", "");
    L.push(row(["File", "Added", "Removed", "Net"]), row(["---", "---", "---", "---"]));
    for (const f of touched) L.push(row([ascii(f.path, 72), f.add, f.del, signed(f.net)]));
    L.push(row(["Total", m.grossAdd, m.grossDel, signed(m.netLoc)]), "");
  }

  // P-EVAL.4: an unmeasurable metric is stated OUT LOUD. A silent omission is what made the report read as
  // broken; a named gap tells the reader exactly which signal is missing and why.
  const gaps = [...EFFICIENCY_ROWS, ...CONFORMANCE_ROWS].filter(([key]) => resolveMetric(m, key).source === "none");
  if (gaps.length > 0) {
    L.push("## Not measured this run", "");
    for (const [key, label] of gaps) {
      L.push(`- ${label}: ${NOT_MEASURED}, ${NO_SIGNAL_REASON[key] ?? "the signal it needs was not observed"}.`);
    }
    L.push("");
  }
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
