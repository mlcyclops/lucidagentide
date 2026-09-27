// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/turn_progress.ts - P-PROGRESS.1: what a worker (the master chat, a fleet lane) can honestly say
// about a turn in flight: how long it has run, when it last gave a sign of life, which tool calls it is
// waiting on, whether it is alive, and how far along it probably is.
//
// The estimate is a HISTORY, never a promise. A chat turn has no known length; what exists is how long
// this model's recent turns took on this machine, so the estimate is the 75th percentile of those, the
// percent is elapsed over that figure and stops at 95 until the turn actually ends, and past the typical
// length the view says "longer than usual" instead of inventing a new finish time. No samples means no
// number (basis "none"), not a made-up one.
//
// Liveness is EVIDENCE, and only evidence: the last streamed event, the open tool calls, the watchdog's last
// action, and whether the child process is gone. It is the visible companion of health_watch.ts (which acts)
// and never acts itself. The two agree on "activity" because both read the same lastActivityAt the sink
// stamps.
//
// Pure: DOM-free, IO-free, global-free. Time always arrives as `now`.

import type { PendingView } from "./turn_pending.ts";

/** The polling cadence of the engine's `progress` event during a turn. */
export const PROGRESS_TICK_MS = 5_000;
/** A signal younger than this is "streaming": the model is producing right now. */
export const STREAMING_MS = 5_000;
/** Silence with no open tool call past this is "quiet": shown long before the watchdog's 90 s. */
export const QUIET_MS = 30_000;
/** A watchdog probe or recover younger than this is what the user should see. */
const HEALTH_RECENT_MS = 60_000;
/** Percent never reaches 100 while a turn runs: only `done` finishes a bar. */
const PERCENT_CAP = 95;
/** Samples kept per history, oldest dropped first. */
const HISTORY_CAP = 200;
/** Turn samples this model needs before its own history is trusted over the pooled one. */
const MIN_MODEL_SAMPLES = 3;
/** Pooled samples (any model) needed before any estimate is shown. */
const MIN_ANY_SAMPLES = 5;

export type LivenessState = "idle" | "streaming" | "working" | "thinking" | "quiet" | "probing" | "recovering" | "dead";

export interface Liveness {
  state: LivenessState;
  /** One short phrase for the pill ("alive, streaming", "waiting on bash for 42 s", "no sign of life for 2 m"). */
  label: string;
  /** The sentence under it: what the evidence is and what happens next. */
  detail: string;
}

export interface TurnEstimate {
  /** Ms until the typical length is reached; 0 once past it; null with no history. */
  etaMs: number | null;
  /** 0 to 95 while running; null with no history. */
  percent: number | null;
  /** Where the typical figure came from. */
  basis: "model" | "any" | "none";
  samples: number;
  /** The 75th percentile of the sampled turn lengths, in ms. */
  typicalMs: number | null;
  /** The turn has run longer than the typical length. */
  overrun: boolean;
}

/** One open tool call as the progress view shows it: the pending label plus the tool's typical length. */
export interface OpenStep extends PendingView {
  typicalMs?: number;
}

export interface ProgressView {
  elapsedMs: number;
  /** Ms since the last streamed event of this turn. */
  lastSignalMs: number;
  /** Tool calls settled this turn. */
  stepsDone: number;
  /** Tool calls still awaited, longest-running first. */
  stepsOpen: OpenStep[];
  liveness: Liveness;
  estimate: TurnEstimate;
}

export interface TurnSample { model: string; totalMs: number }

/** Recent turn and tool lengths, bounded. Seeded from the latency ledger at boot and fed live. */
export class DurationHistory {
  readonly #turns: TurnSample[] = [];
  readonly #tools = new Map<string, number[]>();
  readonly #cap: number;

  constructor(cap = HISTORY_CAP) { this.#cap = usableCount(cap) || HISTORY_CAP; }

  addTurn(model: string, totalMs: number): void {
    if (!usable(totalMs) || totalMs === 0) return;
    this.#turns.push({ model: (model || "").trim(), totalMs });
    if (this.#turns.length > this.#cap) this.#turns.splice(0, this.#turns.length - this.#cap);
  }

  addTool(name: string, ms: number): void {
    const key = (name || "").trim().toLowerCase();
    if (!key || !usable(ms)) return;
    const arr = this.#tools.get(key) ?? [];
    arr.push(ms);
    if (arr.length > this.#cap) arr.splice(0, arr.length - this.#cap);
    this.#tools.set(key, arr);
  }

  /** Feed the desktop/latency_log.ts JSONL lines ({model, totalMs, ok}). Only ok turns with a real length
   *  count; a malformed line is skipped, never thrown. */
  seedFromLatencyLines(lines: Iterable<string>): number {
    let n = 0;
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try {
        const o = JSON.parse(t) as { model?: unknown; totalMs?: unknown; ok?: unknown };
        if (o.ok === false || typeof o.model !== "string" || typeof o.totalMs !== "number") continue;
        const before = this.#turns.length;
        this.addTurn(o.model, o.totalMs);
        if (this.#turns.length !== before || this.#turns.length === this.#cap) n++;
      } catch { /* a bad line is not history */ }
    }
    return n;
  }

  turnSamples(model?: string): number[] {
    const m = (model ?? "").trim();
    return this.#turns.filter((t) => !m || t.model === m).map((t) => t.totalMs);
  }

  /** P-PROGRESS.2: this tool's sampled lengths (for estimateFromSamples on an open call). */
  toolSamples(name: string): readonly number[] {
    return this.#tools.get((name || "").trim().toLowerCase()) ?? [];
  }

  /** The 75th percentile of this tool's sampled lengths, or undefined before two samples. */
  toolTypical(name: string): number | undefined {
    const arr = this.#tools.get((name || "").trim().toLowerCase());
    if (!arr || arr.length < 2) return undefined;
    return percentile(arr, 0.75);
  }

  get size(): number { return this.#turns.length; }
}

export interface EstimateInput {
  elapsedMs: number;
  model: string;
  history: DurationHistory;
}

/** Elapsed against the typical length of this model's recent turns (or every model's, when this one has
 *  too few). Pure. */
export function estimateTurn(i: EstimateInput): TurnEstimate {
  let samples = i.history.turnSamples(i.model);
  let basis: TurnEstimate["basis"] = "model";
  if (samples.length < MIN_MODEL_SAMPLES) {
    samples = i.history.turnSamples();
    basis = "any";
    if (samples.length < MIN_ANY_SAMPLES) return NO_ESTIMATE;
  }
  return estimateFromSamples(i.elapsedMs, samples, 1, basis);
}

const NO_ESTIMATE: TurnEstimate = { etaMs: null, percent: null, basis: "none", samples: 0, typicalMs: null, overrun: false };

/** P-PROGRESS.2: the same labelled percentile for any worker with a sample set (a subagent run against
 *  the lengths of finished runs, a turn against past turns). Fewer than `minSamples` usable lengths is
 *  basis "none": no number. Pure. */
export function estimateFromSamples(elapsedMs: number, samples: readonly number[], minSamples = 2, basis: TurnEstimate["basis"] = "any"): TurnEstimate {
  if (!usable(elapsedMs)) return NO_ESTIMATE;
  const good = samples.filter((s) => usable(s) && s > 0);
  if (!good.length || good.length < minSamples) return NO_ESTIMATE;
  const typicalMs = Math.max(1, percentile(good, 0.75));
  const overrun = elapsedMs > typicalMs;
  const percent = Math.min(PERCENT_CAP, Math.floor((elapsedMs / typicalMs) * 100));
  return { etaMs: overrun ? 0 : typicalMs - elapsedMs, percent, basis, samples: good.length, typicalMs, overrun };
}

/** P-PROGRESS.2: the ETA words for a running worker. With history: "about 1 m left (est.)" or "longer than
 *  usual (typically 2 m)". Without: "ETA estimating", said plainly so a missing number reads as "not known
 *  yet" rather than as nothing at all. Pure. */
export function etaPhrase(e: TurnEstimate): string {
  if (e.typicalMs === null) return ETA_ESTIMATING;
  return e.overrun ? `longer than usual (typically ${humanMs(e.typicalMs)})` : `about ${humanMs(e.etaMs ?? 0)} left (est.)`;
}

/** What a running worker with no usable history shows in place of a number. */
export const ETA_ESTIMATING = "ETA estimating";

/** P-PROGRESS.2: the whole prompt's ETA: the turn itself plus every helper still working for it (subagent
 *  runs outlive the turn). `turn` is null once the turn ended; each helper is ms left, or null when its time
 *  left is not known. The prompt ends when its slowest part ends, so the figure is the largest known one;
 *  when some parts are unknown it is a floor ("at least"), and with nothing known it is "ETA estimating".
 *  "" when nothing is running. Pure. */
export function wholeEtaPhrase(turn: TurnEstimate | null, helpers: readonly (number | null)[]): string {
  if (!helpers.length) return turn ? etaPhrase(turn) : "";
  const parts = turn ? [...helpers, turn.typicalMs === null || turn.overrun ? null : turn.etaMs] : [...helpers];
  const known = parts.filter((p): p is number => p !== null && usable(p));
  if (!known.length) return ETA_ESTIMATING;
  const most = humanMs(Math.max(...known));
  return known.length === parts.length ? `about ${most} left (est.)` : `at least ${most} left (est.)`;
}

export interface LivenessInput {
  busy: boolean;
  dead: boolean;
  /** Ms since the last streamed event. */
  lastSignalMs: number;
  stepsOpen: readonly OpenStep[];
  lastHealth?: { action: "probe" | "recover"; at: number } | null;
  now: number;
}

/** What the evidence says about the worker right now. Order is evidence strength: a dead child outranks
 *  everything, a recent watchdog action outranks silence, an open tool call explains silence, and only
 *  unexplained silence past QUIET_MS is called quiet. Pure. */
export function livenessVerdict(i: LivenessInput): Liveness {
  if (i.dead) return { state: "dead", label: "agent process exited", detail: "The worker's agent process is gone. Restart it here; the conversation is kept and no app restart is needed." };
  if (!i.busy) return { state: "idle", label: "idle", detail: "No turn in flight." };
  const h = i.lastHealth;
  if (h && usable(i.now - h.at) && i.now - h.at < HEALTH_RECENT_MS) {
    return h.action === "recover"
      ? { state: "recovering", label: `recovering (${humanMs(i.now - h.at)} ago)`, detail: "The watchdog restarted the agent process and is resuming the same session and the same run." }
      : { state: "probing", label: `asked for status ${humanMs(i.now - h.at)} ago`, detail: "The watchdog sent a status question into the running turn. An answer resets the clock; none within a few minutes leads to a recovery." };
  }
  const silent = usable(i.lastSignalMs) ? i.lastSignalMs : Number.POSITIVE_INFINITY;
  if (silent < STREAMING_MS) return { state: "streaming", label: "alive, streaming", detail: "Output arrived within the last few seconds." };
  const longest = i.stepsOpen[0];
  if (longest) {
    const typ = longest.typicalMs !== undefined ? ` (usually about ${humanMs(longest.typicalMs)})` : "";
    return { state: "working", label: `waiting on ${shortLabel(longest.label)} for ${humanMs(longest.elapsedMs)}`, detail: `A tool call is running${typ}. Silence while it runs is normal; the watchdog never interrupts an open call.` };
  }
  if (silent < QUIET_MS) return { state: "thinking", label: `waiting for the model (${humanMs(silent)})`, detail: "No tool call is open; the model has not sent anything for a moment." };
  return { state: "quiet", label: `no sign of life for ${humanMs(silent)}`, detail: "Nothing streamed and no tool call is open. The watchdog asks for status after 3 minutes and recovers the session after 7." };
}

export interface ProgressInput {
  busy: boolean;
  dead: boolean;
  startedAt: number | null;
  lastActivityAt: number;
  stepsDone: number;
  stepsOpen: readonly PendingView[];
  lastHealth?: { action: "probe" | "recover"; at: number } | null;
  model: string;
  history: DurationHistory;
  /** The real tool name behind a pending label, when known (tool-meta), so the typical length keys on it. */
  toolNameOf?: (label: string) => string | undefined;
  now: number;
}

/** The whole progress view for one worker at `now`. Pure. */
export function progressView(i: ProgressInput): ProgressView {
  const elapsedMs = i.startedAt !== null && usable(i.now - i.startedAt) ? i.now - i.startedAt : 0;
  const lastSignalMs = usable(i.now - i.lastActivityAt) ? i.now - i.lastActivityAt : 0;
  const stepsOpen: OpenStep[] = i.stepsOpen.map((s) => {
    const name = i.toolNameOf?.(s.label) ?? s.label.split(":")[0]!;
    const typicalMs = i.history.toolTypical(name);
    return typicalMs === undefined ? { ...s } : { ...s, typicalMs };
  });
  return {
    elapsedMs,
    lastSignalMs,
    stepsDone: usableCount(i.stepsDone),
    stepsOpen,
    liveness: livenessVerdict({ busy: i.busy, dead: i.dead, lastSignalMs, stepsOpen, lastHealth: i.lastHealth, now: i.now }),
    estimate: i.busy ? estimateTurn({ elapsedMs, model: i.model, history: i.history }) : { etaMs: null, percent: null, basis: "none", samples: 0, typicalMs: null, overrun: false },
  };
}

/** One line for a HUD or a card: "42 s · step 4 · about 1 m left (est.)" / "longer than usual (typically 2 m)".
 *  P-PROGRESS.2: a running worker always carries an ETA part; with no history it says "ETA estimating". */
export function progressLine(p: ProgressView): string {
  const bits = [humanMs(p.elapsedMs)];
  const steps = p.stepsDone + p.stepsOpen.length;
  if (steps) bits.push(`step ${steps}`);
  const running = p.liveness.state !== "idle" && p.liveness.state !== "dead";
  if (running) bits.push(etaPhrase(p.estimate));
  return bits.join(" \u00b7 ");
}

export function humanMs(ms: number): string {
  if (!usable(ms)) return "?";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs ? `${m} m ${rs} s` : `${m} m`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} m`;
}

// --- internals ---------------------------------------------------------------------------------------

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx]!;
}

function shortLabel(label: string): string {
  const t = label.trim();
  return t.length > 40 ? t.slice(0, 39) + "\u2026" : t;
}

function usable(n: number): boolean {
  return Number.isFinite(n) && n >= 0;
}

function usableCount(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
