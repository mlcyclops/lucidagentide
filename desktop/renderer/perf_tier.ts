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

import type { PersonalGraphData } from "./bridge.ts";
import type { KVStore } from "./swr_cache.ts";

export type PerfTier = "full" | "reduced" | "minimal";
export type PerfMode = "auto" | PerfTier;

export interface PerfSignals {
  onBattery: boolean; // discharging right now
  batteryLevel: number | null; // 0..1, null = unknown
  cores: number | null; // navigator.hardwareConcurrency, null = unknown
  reducedMotion: boolean; // OS prefers-reduced-motion
}

const LOW_BATTERY = 0.2; // discharging at/below this → minimal (stop discretionary rendering)
const WEAK_CORES = 4; // at/below this many logical cores → reduced even on AC

/** Fail-safe normalize of a persisted mode (P-ROLE.1 pattern): anything unrecognized → "auto". */
export function normalizePerfMode(raw: string | null | undefined): PerfMode {
  return raw === "full" || raw === "reduced" || raw === "minimal" || raw === "auto" ? raw : "auto";
}

/** The active render tier. An explicit user mode ALWAYS wins; "auto" derives from the machine:
 *  low battery → minimal; on battery or a weak CPU or OS reduced-motion → reduced; else full.
 *  Unknown signals never degrade (no battery info reads as plugged in) - degrade only on evidence. */
export function resolveTier(mode: PerfMode, s: PerfSignals): PerfTier {
  if (mode !== "auto") return mode;
  if (s.onBattery && s.batteryLevel !== null && s.batteryLevel <= LOW_BATTERY) return "minimal";
  if (s.onBattery) return "reduced";
  if (s.cores !== null && s.cores > 0 && s.cores <= WEAK_CORES) return "reduced";
  if (s.reducedMotion) return "reduced";
  return "full";
}

/** Poll cadence for a base interval: battery tiers stretch 4x, a hidden window stretches 4x more
 *  (nothing visible needs freshness; the caller catches up on visibilitychange). Compounding is
 *  deliberate: hidden-on-battery is the case that drains laptops. */
export function pollDelay(baseMs: number, tier: PerfTier, hidden: boolean): number {
  return baseMs * (tier === "full" ? 1 : 4) * (hidden ? 4 : 1);
}

export interface GraphTierOpts {
  forceCalm: boolean; // graph.ts calm mode: no particle flow, instant fit, loop parks when idle
  settleFrames: number; // force-sim budget (frames); lower = shorter O(n²) burst on mount
  nodeCap: number | null; // draw at most N most-connected nodes (null = uncapped)
}

/** Per-tier rendering knobs for mountGraph. "minimal" is only reached via the user's explicit
 *  "Render anyway" (the default minimal experience is the paused card - no mount at all). */
export function graphOpts(tier: PerfTier): GraphTierOpts {
  if (tier === "full") return { forceCalm: false, settleFrames: 480, nodeCap: null };
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

export interface PerfTierWatcher {
  tier(): PerfTier;
  mode(): PerfMode;
  /** Cycle auto → full → reduced → minimal → auto; persists; notifies subscribers. */
  cycleMode(): PerfMode;
  onChange(cb: (tier: PerfTier, mode: PerfMode) => void): void;
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
export function watchPerfTier(kv?: KVStore | null): PerfTierWatcher {
  const store = kv !== undefined ? kv : defaultStore();
  let mode = normalizePerfMode(store?.getItem(MODE_KEY));
  const signals: PerfSignals = {
    onBattery: false,
    batteryLevel: null,
    cores: typeof navigator !== "undefined" ? (navigator.hardwareConcurrency ?? null) : null,
    reducedMotion: typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches,
  };
  let cur = resolveTier(mode, signals);
  const subs: Array<(t: PerfTier, m: PerfMode) => void> = [];
  const notify = (): void => {
    for (const s of subs) s(cur, mode);
  };
  const recompute = (): void => {
    const next = resolveTier(mode, signals);
    if (next !== cur) {
      cur = next;
      notify();
    }
  };
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
      mode = mode === "auto" ? "full" : mode === "full" ? "reduced" : mode === "reduced" ? "minimal" : "auto";
      store?.setItem(MODE_KEY, mode);
      cur = resolveTier(mode, signals);
      notify();
      return mode;
    },
    onChange(cb) {
      subs.push(cb);
    },
  };
}
