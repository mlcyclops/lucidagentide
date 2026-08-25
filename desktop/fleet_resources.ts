// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/fleet_resources.ts
//
// P-FLEET.L1: the 75% headroom guard for local lanes. Running N headless LUCID engines on one box is
// useful right up until the box stops being usable - the OS, the browser, and the desktop shell itself
// need headroom. Lane admission is capped by three independent gates, and a refusal always carries the
// MEASURED number, never a silent no:
//   - a hard lane ceiling derived from logical cores (an idle engine is not free);
//   - a system MEMORY watermark: no new lane above 75% used;
//   - a system CPU watermark: no new lane above 75% busy.
//
// Sampling is NOT re-implemented here: the machine reading comes from system_profile.sampleSystem()
// (P-SYSRES.1, ADR-0182 - the existing two-point CPU sample that works on Windows, where os.loadavg()
// is all zeros). This module is ONLY the pure admission verdict over that snapshot.
//
// Doctrine, matching system_profile: this is a UX guard, not a security gate - it FAILS OPEN on missing
// evidence (a broken profiler must not brick the fleet), but the lane CEILING always applies.

import type { SystemSnapshot } from "./system_profile.ts";

/** Everything above this is reserved for the OS, the browser, and the user's other apps. */
export const FLEET_WATERMARK_PCT = 75;

/** Half the logical cores, clamped 1..6. An idle engine still costs scheduler and memory; past six
 *  lanes a dashboard stops being a dashboard and becomes a wall. Unknown cores (failed sample) -> 1. */
export function maxLanesFor(cores: number): number {
  if (!Number.isFinite(cores) || cores <= 0) return 1;
  return Math.max(1, Math.min(6, Math.floor(cores / 2)));
}

export interface LaneAdmission {
  ok: boolean;
  /** Human-readable refusal carrying the measured number. Absent when ok. */
  reason?: string;
  /** The core-derived hard ceiling this machine gets. */
  maxLanes: number;
  /** Echoed evidence for the dashboard's headroom bar. Null = no evidence (sample failed). */
  cpuPct: number | null;
  memPct: number | null;
}

/** PURE: may one MORE lane start, given this machine snapshot and the live lane count? */
export function laneAdmission(snap: SystemSnapshot, liveLanes: number): LaneAdmission {
  const maxLanes = maxLanesFor(snap.cores);
  const memPct = snap.memTotalMB > 0 ? Math.round((100 * (snap.memTotalMB - snap.memFreeMB)) / snap.memTotalMB) : null;
  const cpuPct = snap.cpuBusyPct;
  const base = { maxLanes, cpuPct, memPct };
  if (liveLanes >= maxLanes) {
    return { ...base, ok: false, reason: `lane ceiling reached (${liveLanes}/${maxLanes} on ${snap.cores || "unknown"} logical cores) - stop a lane first` };
  }
  if (memPct !== null && memPct >= FLEET_WATERMARK_PCT) {
    return { ...base, ok: false, reason: `system memory at ${memPct}% (watermark ${FLEET_WATERMARK_PCT}%) - ${snap.memFreeMB}MB free is reserved for the OS and your other apps` };
  }
  if (cpuPct !== null && cpuPct >= FLEET_WATERMARK_PCT) {
    return { ...base, ok: false, reason: `system CPU at ${Math.round(cpuPct)}% (watermark ${FLEET_WATERMARK_PCT}%) - let the current work drain first` };
  }
  return { ...base, ok: true };
}
