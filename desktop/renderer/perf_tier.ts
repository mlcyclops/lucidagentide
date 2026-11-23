// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/perf_tier.ts - P-PERF.2 (ADR-0129): power/spec-aware performance tiers.
//
// On a battery-throttled laptop the KG force simulation + fixed polling intervals starve the renderer
// event loop (late toasts, sluggish panel/model switches). This module decides HOW MUCH rendering work
// the machine should be asked to do right now. It never gates DATA access - the agent's knowledge
// reads/writes are untouched; only the visualization fidelity and poll cadence adapt.
//
//   - resolveTier : pure decision - user mode override, else battery/CPU/reduced-motion signals
//   - pollDelay   : pure poll-cadence backoff (battery tiers stretch, hidden windows stretch more)
//   - graphOpts   : per-tier knobs for graph.ts (calm, settle budget, node cap)
//   - capGraph    : pure top-hubs node cap (the P-KG-CODE.1 CAP=600 idea, reusable + snapshot-safe)
//   - watchPerfTier: thin runtime sampler (Battery API + hardwareConcurrency + reduced-motion) with a
//                    localStorage-persisted user mode - the pure core stays headlessly testable.
//   - P-VIZ.GPU1 (ADR-0651): the GPU class (gpu_probe.ts) joins the signals, `ultra` and `cinematic` sit above
//     `full`, and createFrameGovernor is the 3 s frame-time check Visualize uses to step Auto down one tier.

import type { PersonalGraphData } from "./bridge.ts";
import { probeGpu, type GpuClass, type GpuProbe } from "./gpu_probe.ts";
import type { KVStore } from "./swr_cache.ts";

/** P-VIZ.GPU1 (ADR-0651): `ultra` and `cinematic` sit above `full`. They only add Visualize fidelity; every other
 *  consumer (Knowledge Graph, poll cadence, preview curtain) reads them as `full` through baseTier. */
export type PerfTier = "full" | "reduced" | "minimal" | "ultra" | "cinematic";
export type PerfMode = "auto" | PerfTier;
/** The three tiers everything outside Visualize knows. */
export type BaseTier = "full" | "reduced" | "minimal";
/** Weakest first: the governor steps down along it. */
export const PERF_TIERS: readonly PerfTier[] = ["minimal", "reduced", "full", "ultra", "cinematic"];

export interface PerfSignals {
  onBattery: boolean; // discharging right now
  batteryLevel: number | null; // 0..1, null = unknown
  cores: number | null; // navigator.hardwareConcurrency, null = unknown
  reducedMotion: boolean; // OS prefers-reduced-motion
  /** P-VIZ.GPU1: the GPU class (gpu_probe.ts); null or absent = unknown (never degrades). */
  gpu?: GpuClass | null;
}

const LOW_BATTERY = 0.2; // discharging at/below this → minimal (stop discretionary rendering)
const WEAK_CORES = 4; // at/below this many logical cores → reduced even on AC

/** Fail-safe normalize of a persisted mode (P-ROLE.1 pattern): anything unrecognized → "auto". */
export function normalizePerfMode(raw: string | null | undefined): PerfMode {
  return raw === "auto" || (PERF_TIERS as readonly (string | null | undefined)[]).includes(raw) ? (raw as PerfMode) : "auto";
}

/** ultra and cinematic are `full` to everything that is not Visualize. */
export function baseTier(t: PerfTier): BaseTier {
  return t === "ultra" || t === "cinematic" ? "full" : t;
}

/** One tier down (minimal stays minimal). */
export function stepDownTier(t: PerfTier): PerfTier {
  return PERF_TIERS[Math.max(0, PERF_TIERS.indexOf(t) - 1)]!;
}

/** `t`, but never above `cap` (null = no cap). */
export function capTier(t: PerfTier, cap: PerfTier | null): PerfTier {
  return cap !== null && PERF_TIERS.indexOf(t) > PERF_TIERS.indexOf(cap) ? cap : t;
}

/** The active render tier. An explicit user mode ALWAYS wins; "auto" derives from the machine:
 *  a software GPU or low battery → minimal; on battery or a weak CPU or OS reduced-motion → reduced;
 *  a discrete GPU on AC → ultra; else (an integrated or unknown GPU) full. Auto never picks cinematic.
 *  Unknown signals never degrade (no battery info reads as plugged in) - degrade only on evidence. */
export function resolveTier(mode: PerfMode, s: PerfSignals): PerfTier {
  if (mode !== "auto") return mode;
  if (s.gpu === "software") return "minimal";
  if (s.onBattery && s.batteryLevel !== null && s.batteryLevel <= LOW_BATTERY) return "minimal";
  if (s.onBattery) return "reduced";
  if (s.cores !== null && s.cores > 0 && s.cores <= WEAK_CORES) return "reduced";
  if (s.reducedMotion) return "reduced";
  if (s.gpu === "discrete") return "ultra";
  return "full";
}

// ── P-VIZ.GPU1: the frame-time governor ──────────────────────────────────────

/** Frames are ignored this long after a mount (shader compiles, texture uploads, the first fit). */
export const GOVERNOR_SETTLE_MS = 2000;
/** The check: this much busy rendering is measured before a verdict. */
export const GOVERNOR_WINDOW_MS = 3000;
/** A frame misses when it takes longer than this many times its budget (vsync quantization on 75 Hz or 144 Hz
 *  panels stretches a healthy 60 fps budget to at most ~1.6x). */
export const GOVERNOR_SLACK = 1.75;
/** The check misses when more than this share of its frames missed. */
export const GOVERNOR_MISS_SHARE = 0.5;
/** Gaps longer than this are a stall (tab switch, a dialog, a GC pause), not a frame rate: not counted. */
const GOVERNOR_STALL_MS = 250;
const GOVERNOR_MIN_FRAMES = 10;

export type GovernorVerdict = "pending" | "ok" | "miss";
export interface GovernorStats { verdict: GovernorVerdict; frames: number; meanMs: number; slowShare: number; budgetMs: number }

/** Measures delivered frame intervals while the scene is busy and gives one verdict per mount. Counters only:
 *  safe to call every frame. The caller decides what a miss does (Visualize steps Auto down one tier). */
export interface FrameGovernor {
  /** One busy frame: `frameMs` since the previous busy frame, `budgetMs` the interval the loop asked for. */
  sample(now: number, frameMs: number, budgetMs: number): GovernorVerdict;
  verdict(): GovernorVerdict;
  stats(): GovernorStats;
}

export function createFrameGovernor(startedAt: number): FrameGovernor {
  let verdict: GovernorVerdict = "pending";
  let frames = 0, slow = 0, sumMs = 0, budget = 0;
  return {
    sample(now, frameMs, budgetMs) {
      if (verdict !== "pending" || now - startedAt < GOVERNOR_SETTLE_MS || frameMs <= 0 || frameMs > GOVERNOR_STALL_MS) return verdict;
      frames++;
      sumMs += frameMs;
      budget = budgetMs;
      if (frameMs > budgetMs * GOVERNOR_SLACK) slow++;
      if (sumMs >= GOVERNOR_WINDOW_MS && frames >= GOVERNOR_MIN_FRAMES) verdict = slow / frames > GOVERNOR_MISS_SHARE ? "miss" : "ok";
      return verdict;
    },
    verdict: () => verdict,
    stats: () => ({ verdict, frames, meanMs: frames ? sumMs / frames : 0, slowShare: frames ? slow / frames : 0, budgetMs: budget }),
  };
}

/** Poll cadence for a base interval: battery tiers stretch 4x, a hidden window stretches 4x more
 *  (nothing visible needs freshness; the caller catches up on visibilitychange). Compounding is
 *  deliberate: hidden-on-battery is the case that drains laptops. */
export function pollDelay(baseMs: number, tier: PerfTier, hidden: boolean): number {
  return baseMs * (baseTier(tier) === "full" ? 1 : 4) * (hidden ? 4 : 1);
}

export interface GraphTierOpts {
  forceCalm: boolean; // graph.ts calm mode: no particle flow, instant fit, loop parks when idle
  settleFrames: number; // force-sim budget (frames); lower = shorter O(n²) burst on mount
  nodeCap: number | null; // draw at most N most-connected nodes (null = uncapped)
}

/** Per-tier rendering knobs for mountGraph. "minimal" is only reached via the user's explicit
 *  "Render anyway" (the default minimal experience is the paused card - no mount at all). */
export function graphOpts(tier: PerfTier): GraphTierOpts {
  if (baseTier(tier) === "full") return { forceCalm: false, settleFrames: 480, nodeCap: null };
  if (tier === "reduced") return { forceCalm: true, settleFrames: 240, nodeCap: 400 };
  return { forceCalm: true, settleFrames: 120, nodeCap: 250 };
}

/** Non-mutating top-hubs cap (most-connected by `count`, edges filtered to survivors) - the code-graph
 *  CAP pattern generalized. The FULL data stays with the caller (search, facts, signatures); only the
 *  drawn subset shrinks. */
export function capGraph(data: PersonalGraphData, cap: number | null): { data: PersonalGraphData; capped: number } {
  if (cap === null || data.nodes.length <= cap) return { data, capped: 0 };
  const keep = new Set([...data.nodes].sort((a, b) => b.count - a.count).slice(0, cap).map((n) => n.id));
  return {
    data: {
      ...data,
      nodes: data.nodes.filter((n) => keep.has(n.id)),
      edges: data.edges.filter((e) => keep.has(e.from) && keep.has(e.to)),
    },
    capped: data.nodes.length - cap,
  };
}

// ── runtime sampler ──────────────────────────────────────────────────────────

/** The Battery Status API surface we consume (Chromium ships it; absent elsewhere → guarded). */
interface BatteryLike {
  charging: boolean;
  level: number;
  addEventListener?: (type: string, listener: () => void) => void;
}

const MODE_KEY = "lucid.perfMode";

/** The cycle order: the original four first (auto → full → reduced → minimal), then the GPU tiers. */
const MODE_CYCLE: readonly PerfMode[] = ["auto", "full", "reduced", "minimal", "ultra", "cinematic"];

export interface PerfTierWatcher {
  tier(): PerfTier;
  mode(): PerfMode;
  /** Cycle auto → full → reduced → minimal → ultra → cinematic → auto; persists; notifies subscribers. Clears a
   *  governor step-down. */
  cycleMode(): PerfMode;
  onChange(cb: (tier: PerfTier, mode: PerfMode) => void): void;
  /** P-VIZ.GPU1: the probed GPU (null until the probe answers). */
  gpu(): GpuProbe | null;
  /** P-VIZ.GPU1: the frame-time governor missed its budget. Under Auto, cap the tier one below the current one for
   *  the rest of the session (or until the user picks a mode) and notify; an explicit mode is never touched.
   *  Returns the new tier, or null when nothing changed. */
  stepDown(): PerfTier | null;
  /** P-VIZ.GPU1: the tier the governor stepped Auto down from (null: no step-down). */
  steppedFrom(): PerfTier | null;
}

/** localStorage when available (renderer), else null (tests inject their own store). */
function defaultStore(): KVStore | null {
  try {
    if (typeof localStorage !== "undefined") return localStorage as unknown as KVStore; // structural match, same seam as swr_cache
  } catch {
    /* sandboxed */
  }
  return null;
}

/** Sample the machine + user mode and keep the resolved tier current. Battery state arrives async
 *  (Battery API is promise-based) and updates on charging/level events; until it resolves the machine
 *  is treated as plugged in (degrade only on evidence). */
export function watchPerfTier(kv?: KVStore | null, gpuProbe: () => Promise<GpuProbe | null> = probeGpu): PerfTierWatcher {
  const store = kv !== undefined ? kv : defaultStore();
  let mode = normalizePerfMode(store?.getItem(MODE_KEY));
  const signals: PerfSignals = {
    onBattery: false,
    batteryLevel: null,
    cores: typeof navigator !== "undefined" ? (navigator.hardwareConcurrency ?? null) : null,
    reducedMotion: typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches,
    gpu: null,
  };
  let gpuInfo: GpuProbe | null = null;
  /** P-VIZ.GPU1: the governor's cap under Auto (null = none). */
  let cap: PerfTier | null = null;
  const resolve = (): PerfTier => capTier(resolveTier(mode, signals), mode === "auto" ? cap : null);
  let cur = resolve();
  const subs: Array<(t: PerfTier, m: PerfMode) => void> = [];
  const notify = (): void => {
    for (const s of subs) s(cur, mode);
  };
  const recompute = (): void => {
    const next = resolve();
    if (next !== cur) {
      cur = next;
      notify();
    }
  };
  // P-VIZ.GPU1: the GPU class arrives once (WebGL string + Electron info); until then the GPU is unknown.
  gpuProbe()
    .then((p) => {
      gpuInfo = p;
      signals.gpu = p?.cls ?? null;
      recompute();
    })
    .catch(() => {
      /* no probe - the GPU stays unknown */
    });
  const nav = typeof navigator !== "undefined" ? (navigator as Navigator & { getBattery?: () => Promise<BatteryLike> }) : null;
  nav?.getBattery
    ?.()
    .then((b) => {
      const sync = (): void => {
        signals.onBattery = !b.charging;
        signals.batteryLevel = typeof b.level === "number" ? b.level : null;
        recompute();
      };
      sync();
      b.addEventListener?.("chargingchange", sync);
      b.addEventListener?.("levelchange", sync);
    })
    .catch(() => {
      /* no battery info - stay plugged-in */
    });
  return {
    tier: () => cur,
    mode: () => mode,
    cycleMode() {
      mode = MODE_CYCLE[(MODE_CYCLE.indexOf(mode) + 1) % MODE_CYCLE.length]!;
      store?.setItem(MODE_KEY, mode);
      cap = null; // a user choice re-arms the governor from the machine's own tier
      cur = resolve();
      notify();
      return mode;
    },
    onChange(cb) {
      subs.push(cb);
    },
    gpu: () => gpuInfo,
    stepDown() {
      if (mode !== "auto") return null;
      const next = stepDownTier(cur);
      if (next === cur) return null;
      cap = next;
      recompute();
      return cur;
    },
    steppedFrom() {
      if (mode !== "auto" || cap === null) return null;
      const uncapped = resolveTier(mode, signals);
      return uncapped !== cur ? uncapped : null;
    },
  };
}
