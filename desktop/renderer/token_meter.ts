// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/token_meter.ts - P-TOKENS.1: the PURE data behind the composer's token popover (the small
// up-arrow button above Send). It folds the live event stream into context fill, cost, per-tool-call spend, and
// the harness health-check count.
//
// Honesty is the whole point of this module. Over ACP the provider reports CONTEXT fill (`used`), the context
// window (`size`), and `cost` in USD. It reports NO per-turn output tokens and NO cache breakdown on this path.
// So: the three provider figures stay null until a `usage` event actually arrives; the output figure is the
// renderer's own local ESTIMATE and every row derived from it is `measured:false`; and a per-call context delta
// is ATTRIBUTION (window growth bracketed by two usage samples), never a provider per-call number.
//
// A metric that never arrived renders "not reported". Never `$0.00`, never `0 tokens`: an UNREPORTED zero is a
// fabrication, while a REPORTED zero is a fact and stays `measured:true`. That distinction is the whole reason
// `measured` rides on every row: the DOM layer renders rows verbatim, does no arithmetic, and therefore can
// never launder an estimate into a provider figure. All formatting and all tone thresholds live here.

export interface ToolSpend {
  id: string; name: string; detail: string;
  startedAt: number; endedAt?: number;
  /** Context growth attributed to this call: ctxTokens after it settled minus ctxTokens when it started.
   *  `null` until two usage samples bracket the call. Attribution, not a provider figure. */
  ctxDelta: number | null;
  failed?: boolean;
  /** Attribution bookkeeping, not display data: the measured context fill and the usage-sample count as of
   *  this call's start. Both are needed to answer "did two samples actually bracket this call?", which is the
   *  difference between an honest delta and a fabricated 0. Optional so a literal of the display shape still
   *  typechecks. */
  ctxAtStart?: number | null;
  samplesAtStart?: number;
}

export interface MeterState {
  /** MEASURED, from `usage`. null = the provider has not reported yet. */
  ctxTokens: number | null;
  ctxSize: number | null;
  costUsd: number | null;
  /** ESTIMATED locally. */
  outTokens: number;
  /** Counters. */
  turns: number; toolCalls: number; toolFailures: number; healthChecks: number; usageSamples: number;
  tools: ToolSpend[];   // bounded by TOOLS_MAX, oldest dropped
  startedAt: number; lastAt: number;
}

export const TOOLS_MAX = 60;

const NOT_REPORTED = "not reported";
/** Why a provider row is blank. Shown verbatim on hover, so it has to read as a sentence to a user. */
const PROVIDER_HINT =
  "The provider has not reported this over ACP yet, so this build is not claiming a number. Unknown is not zero.";
/** Why the output row can never be labelled as measured. Contains the word "estimate" on purpose. */
const ESTIMATE_HINT =
  "Local estimate: the provider does not report per-turn output tokens on this path, so the renderer counts the "
  + "streamed text itself. This is an estimate, not a provider figure.";
const HEALTH_HINT =
  "How many times the harness noticed this session go quiet and checked on it for you.";
const DELTA_HINT =
  "The duration is measured locally. The context figure is ATTRIBUTED: it is the window growth between the usage "
  + "sample before this call and the one after it, not a per-call number the provider sent.";
const DELTA_NONE_HINT =
  "No two usage samples bracket this call, so its context growth is unknown. Unknown is not zero, so this row "
  + "does not claim a number.";
const MODEL_EMPTY_HINT =
  "The usage ledger has no per-model rows yet, so this build is not claiming any spend per model.";
const MODEL_UNNAMED_HINT =
  "The usage ledger did not name the model these figures belong to, so they cannot be attributed to one.";

/** A finite, non-negative count, or null when the value is unusable. Unknown is never coerced to 0 here: that
 *  coercion is exactly the fabrication this module exists to prevent. */
function count(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

/** A finite, non-negative USD amount, or null. A negative cost is nonsense, and nonsense is not a measurement. */
function money(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** A clock reading with a caller-supplied fallback: an unusable `now` must never poison stored arithmetic. */
function at(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Percent of the window in use, or null while either half is unreported. Capped at 100 because a `used` above
 *  `size` is a provider quirk, not 140% of a window. */
function ctxPct(used: number | null, size: number | null): number | null {
  if (used === null || size === null || size <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((used / size) * 100)));
}

/** The single source of the fill thresholds: warn at 75%, danger at 90%. An unknown fill is not "high", and the
 *  row/badge label carries the honesty, so it renders in the calm tone rather than crying wolf on a cold boot. */
function pctTone(pct: number | null): "ok" | "warn" | "danger" {
  if (pct === null) return "ok";
  if (pct >= 90) return "danger";
  if (pct >= 75) return "warn";
  return "ok";
}

export function newMeter(now: number): MeterState {
  const t = at(now, 0);
  return {
    ctxTokens: null, ctxSize: null, costUsd: null,
    outTokens: 0,
    turns: 0, toolCalls: 0, toolFailures: 0, healthChecks: 0, usageSamples: 0,
    tools: [],
    startedAt: t, lastAt: t,
  };
}

/** New session / cleared thread. Deliberately a fresh meter and not a partial wipe: carrying a stale provider
 *  figure across a session boundary would attribute one session's spend to another. */
export function resetMeter(now: number): MeterState {
  return newMeter(now);
}

/** Late attribution: a usage sample that lands AFTER a call settled is the second bracket, so it can close a
 *  delta the end could not. Returns the same object when there is nothing to attribute. */
function settleDelta(s: ToolSpend, ctxTokens: number): ToolSpend {
  if (s.endedAt === undefined || s.ctxDelta !== null) return s;
  const start = s.ctxAtStart;
  if (start === null || start === undefined) return s;
  return { ...s, ctxDelta: ctxTokens - start };
}

export function onUsage(m: MeterState, e: { used: number; size: number; cost: number }, now: number): MeterState {
  const used = count(e?.used), size = count(e?.size), cost = money(e?.cost);
  // An unparseable sample is not a sample: counting it would inflate `usageSamples`, which is what the delta
  // bracketing test relies on, and would move `lastAt` on no evidence.
  if (used === null && size === null && cost === null) return m;
  const ctxTokens = used ?? m.ctxTokens;
  return {
    ...m,
    ctxTokens,
    // A field this sample did not carry keeps its last REPORTED value; it was measured once and still is.
    ctxSize: size ?? m.ctxSize,
    costUsd: cost ?? m.costUsd,
    usageSamples: m.usageSamples + 1,
    tools: ctxTokens === null ? m.tools : m.tools.map((s) => settleDelta(s, ctxTokens)),
    lastAt: at(now, m.lastAt),
  };
}

export function onToolStart(m: MeterState, id: string, name: string, detail: string, now: number): MeterState {
  const t = at(now, m.lastAt);
  const spend: ToolSpend = {
    id: String(id ?? ""), name: String(name ?? ""), detail: String(detail ?? ""),
    startedAt: t, ctxDelta: null,
    ctxAtStart: m.ctxTokens, samplesAtStart: m.usageSamples,
  };
  const tools = m.tools.concat(spend);
  return {
    ...m,
    tools: tools.length > TOOLS_MAX ? tools.slice(tools.length - TOOLS_MAX) : tools,
    toolCalls: m.toolCalls + 1,
    lastAt: t,
  };
}

export function onToolEnd(m: MeterState, id: string, now: number, failed?: boolean): MeterState {
  const key = String(id ?? "");
  let idx = -1;
  for (let i = m.tools.length - 1; i >= 0; i--) {
    const s = m.tools[i]!;
    if (s.id === key && s.endedAt === undefined) { idx = i; break; }
  }
  // A call we never saw start cannot be attributed, and inventing a row for it would put a fabricated duration
  // in front of the user. Drop the event, keep the state.
  if (idx < 0) return m;
  const s = m.tools[idx]!;
  const t = at(now, m.lastAt);
  const start = s.ctxAtStart;
  const bracketed = start !== null && start !== undefined
    && m.ctxTokens !== null
    && m.usageSamples > (s.samplesAtStart ?? 0);
  const tools = m.tools.slice();
  tools[idx] = {
    ...s,
    endedAt: Math.max(t, s.startedAt),   // never a negative duration, whatever the clock did
    failed: failed === true,
    ctxDelta: bracketed ? m.ctxTokens! - start! : s.ctxDelta,
  };
  return {
    ...m,
    tools,
    toolFailures: m.toolFailures + (failed === true ? 1 : 0),
    lastAt: t,
  };
}

/** `totalEstimatedTokens` is the renderer's CUMULATIVE local estimate (TokenSpeedEngine), so it replaces rather
 *  than accumulates. An unusable value is ignored outright instead of zeroing a running estimate. */
export function onOutput(m: MeterState, totalEstimatedTokens: number, now: number): MeterState {
  const n = count(totalEstimatedTokens);
  if (n === null) return m;
  return { ...m, outTokens: n, lastAt: at(now, m.lastAt) };
}

export function onHealth(m: MeterState, now: number): MeterState {
  return { ...m, healthChecks: m.healthChecks + 1, lastAt: at(now, m.lastAt) };
}

export function onTurnEnd(m: MeterState, now: number): MeterState {
  return { ...m, turns: m.turns + 1, lastAt: at(now, m.lastAt) };
}

/** A label/value row for the popover. The DOM layer renders these verbatim and does NO arithmetic. */
export interface MeterRow {
  label: string; value: string;
  /** Hover explanation. REQUIRED when `measured` is false, so an estimate is never shown unlabelled. */
  hint?: string;
  measured: boolean;
  tone?: "ok" | "warn" | "danger";
}

/** Headline rows: context fill, window, output (estimated), cost, turns, tool calls, health checks. */
export function meterRows(m: MeterState): MeterRow[] {
  const pct = ctxPct(m.ctxTokens, m.ctxSize);
  const rows: MeterRow[] = [];

  // Context fill is reported EXACTLY, so it is shown exactly: this is the one token number the provider sends,
  // and rounding it to "1.0k" would blur the only measured figure on the panel.
  rows.push(m.ctxTokens === null
    ? { label: "Context used", value: NOT_REPORTED, measured: false, hint: PROVIDER_HINT }
    : {
        label: "Context used",
        value: m.ctxSize === null
          ? String(m.ctxTokens)
          : `${m.ctxTokens} / ${m.ctxSize}${pct === null ? "" : ` (${pct}%)`}`,
        measured: true,
        tone: pctTone(pct),
      });

  rows.push(m.ctxSize === null
    ? { label: "Context window", value: NOT_REPORTED, measured: false, hint: PROVIDER_HINT }
    : { label: "Context window", value: fmtTokens(m.ctxSize), measured: true });

  // Always measured:false, always hinted. "none yet" rather than "0" because a cold meter has not observed a
  // zero-token turn, it has observed nothing at all.
  rows.push({
    label: "Output (estimated)",
    value: m.outTokens > 0 ? fmtTokens(m.outTokens) : "none yet",
    measured: false,
    hint: ESTIMATE_HINT,
  });

  rows.push(m.costUsd === null
    ? { label: "Cost", value: NOT_REPORTED, measured: false, hint: PROVIDER_HINT }
    // A REPORTED zero is a fact: "$0.00" stays measured. Only an unreported cost reads "not reported".
    : { label: "Cost", value: fmtUsd(m.costUsd), measured: true });

  rows.push({ label: "Turns", value: String(m.turns), measured: true });

  rows.push({
    label: "Tool calls",
    value: m.toolFailures > 0 ? `${m.toolCalls} (${m.toolFailures} failed)` : String(m.toolCalls),
    measured: true,
    tone: m.toolFailures > 0 ? "danger" : "ok",
  });

  rows.push({ label: "Health checks", value: String(m.healthChecks), measured: true, hint: HEALTH_HINT });

  return rows;
}

/** One text child per row (Invariant #11): a tool title with its newlines flattened, ellipsis-safe. */
function toolLabel(s: ToolSpend): string {
  const name = s.name.replace(/\s+/g, " ").trim() || "tool";
  const detail = s.detail.replace(/\s+/g, " ").trim();
  return detail ? `${name}: ${detail}` : name;
}

/** One row per tool call, newest FIRST, with duration and attributed context delta. */
export function toolRows(m: MeterState): MeterRow[] {
  const rows: MeterRow[] = [];
  for (let i = m.tools.length - 1; i >= 0; i--) {
    const s = m.tools[i]!;
    const dur = fmtMs(s.endedAt === undefined ? undefined : s.endedAt - s.startedAt);
    const d = s.ctxDelta;
    // Signed, so a context compaction reads as a shrink instead of silently clamping to 0.
    const ctx = d === null ? "context growth not attributed" : `context ${d < 0 ? "-" : "+"}${fmtTokens(Math.abs(d))}`;
    rows.push({
      label: toolLabel(s),
      value: `${dur}, ${ctx}`,
      // The duration is measured but the context figure is attribution, and a row is only as trustworthy as its
      // weakest number, so the whole row declares itself unmeasured and explains why in the hint.
      measured: false,
      hint: d === null ? DELTA_NONE_HINT : DELTA_HINT,
      tone: s.failed === true ? "danger" : "ok",
    });
  }
  return rows;
}

/** Per-model rollup (from the engine's /api/usage ledger). */
export interface ModelSpend { model: string; inTokens: number; outTokens: number; costUsd: number; turns: number }

export function modelRows(spend: readonly ModelSpend[]): MeterRow[] {
  const list = Array.isArray(spend) ? spend : [];
  if (list.length === 0) {
    return [{ label: "Per-model spend", value: "not recorded yet", measured: false, hint: MODEL_EMPTY_HINT }];
  }
  return list.map((s) => {
    const turns = count(s?.turns);
    const value = `in ${fmtTokens(count(s?.inTokens))}, out ${fmtTokens(count(s?.outTokens))}, `
      + `${fmtUsd(money(s?.costUsd))}, ${turns === null ? "turns not reported" : `${turns} ${turns === 1 ? "turn" : "turns"}`}`;
    const name = typeof s?.model === "string" ? s.model.replace(/\s+/g, " ").trim() : "";
    // Fail-closed: unattributable figures are not presented as a model's spend.
    return name
      ? { label: name, value, measured: true }
      : { label: "unknown model", value, measured: false, hint: MODEL_UNNAMED_HINT };
  });
}

/** The button's own glance state: context fill percent, a short label, and a tone that turns warn at 75% and
 *  danger at 90%. `pct` is null until the provider reports, and the label then says so. */
export function meterBadge(m: MeterState): { pct: number | null; label: string; tone: "ok" | "warn" | "danger" } {
  const pct = ctxPct(m.ctxTokens, m.ctxSize);
  return {
    pct,
    label: pct === null ? `Context ${NOT_REPORTED}` : `Context ${pct}%`,
    tone: pctTone(pct),
  };
}

/** 1234 -> "1.2k", null -> "not reported". */
export function fmtTokens(n: number | null): string {
  // Number.isFinite also rejects an undefined/null that slipped past the type, so a JS caller cannot make this
  // print "NaN" or "0" for a figure that was never reported.
  if (n === null || !Number.isFinite(n)) return NOT_REPORTED;
  if (n < 0) return "0";              // there is no such thing as a negative token count
  if (n < 1000) return String(Math.round(n));
  // Roll to "M" a hair early so 999_999 never renders as the nonsensical "1000.0k".
  if (n < 999_950) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** null -> "not reported", 0 -> "$0.00" ONLY when measured (callers gate on `costUsd !== null`). */
export function fmtUsd(n: number | null): string {
  if (n === null || !Number.isFinite(n) || n < 0) return NOT_REPORTED;
  // A real charge under a cent must not render as "$0.00": that reads as free, which is the same lie as a
  // fabricated zero, just cheaper.
  if (n > 0 && n < 0.005) return "< $0.01";
  return `$${n.toFixed(2)}`;
}

/** undefined -> "running" (the call has not settled). An unusable duration is "not reported", never "running":
 *  claiming a settled call is still in flight would misreport it. */
export function fmtMs(ms: number | undefined): string {
  if (ms === undefined) return "running";
  if (!Number.isFinite(ms) || ms < 0) return NOT_REPORTED;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}m ${total % 60}s`;
}
