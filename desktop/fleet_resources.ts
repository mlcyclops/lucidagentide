// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/fleet_resources.ts
//
// P-FLEET.L2: SUSTAINED-pressure lane admission. This replaces P-FLEET.L1's instantaneous 75% watermark
// plus core-derived lane ceiling, both of which refused work on machines that had headroom to spare.
//
//   - Lane count is UNLIMITED. A fleet's useful size is whatever the box can actually carry, and
//     min(6, cores/2) was a guess dressed up as a limit.
//   - A SPIKE is free. A compile, an AST ingest, a browser opening forty tabs: all peg a core for a
//     second or two. Refusing a lane for that is hostile, and it is what users hit.
//   - What actually makes a machine unusable is pressure that STAYS. So the only refusal is:
//     CPU or MEMORY at/above 90% CONTINUOUSLY for 30 seconds.
//
// A refusal always carries BOTH measured numbers - the percent and how long it has held - because "90%
// for 34s" is a fact the user can act on and "over the watermark" is not.
//
// Sampling is NOT re-implemented here: readings come from system_profile.sampleSystem() (P-SYSRES.1,
// ADR-0182 - the two-point CPU sample that works on Windows, where os.loadavg() is all zeros). This
// module is ONLY the pure window arithmetic and the admission verdict over it.
//
// Doctrine, unchanged from P-FLEET.L1: a UX guard, not a security gate. It FAILS OPEN. A broken
// profiler, a panel that just opened, or a machine nobody watched for ten minutes cannot PROVE
// sustained pressure, so the lane starts. Invariant 3 governs scans, not comfort.

import type { SystemSnapshot } from "./system_profile.ts";

/** The pressure line. At or above this, on either metric, the machine is under load. */
export const FLEET_PRESSURE_PCT = 90;
/** How long pressure must hold, unbroken, before a new lane is refused. Below this it is a burst. */
export const FLEET_SUSTAIN_MS = 30_000;
/** Ring-buffer cap: the window only needs minutes of history, never a session's worth. */
export const FLEET_HISTORY_MAX = 240;

/** One machine reading, timestamped. A null metric is "no evidence", never "fine" and never "hot". */
export interface PressureSample {
  at: number;
  cpuPct: number | null;
  memPct: number | null;
}

export type PressureMetric = "cpuPct" | "memPct";

/** Used memory as a percent of total, or null when the sample carried no memory evidence. */
export function memPctOf(snap: SystemSnapshot): number | null {
  if (!(snap.memTotalMB > 0)) return null;
  return Math.round((100 * (snap.memTotalMB - snap.memFreeMB)) / snap.memTotalMB);
}

/** A system snapshot as a timestamped pressure reading. */
export function pressureOf(snap: SystemSnapshot, at: number): PressureSample {
  return { at, cpuPct: snap.cpuBusyPct, memPct: memPctOf(snap) };
}

/** Append a reading and drop what the window can no longer need. Keeps TWICE the sustain window so a
 *  streak that has just crossed the line still has its oldest hot sample to measure from (trimming to
 *  exactly the window would make a 30s streak read as 27s forever). A clock that jumps BACKWARD resets
 *  the history rather than inventing a streak. Pure: returns a new array. */
export function pushSample(history: PressureSample[], s: PressureSample, windowMs = FLEET_SUSTAIN_MS): PressureSample[] {
  const cutoff = s.at - windowMs * 2;
  const out = history.filter((h) => h.at >= cutoff && h.at <= s.at);
  out.push(s);
  return out.length > FLEET_HISTORY_MAX ? out.slice(out.length - FLEET_HISTORY_MAX) : out;
}

/** How long, unbroken and ending at the NEWEST reading, this metric has been at/above `linePct`.
 *
 *  0 means "not under sustained pressure right now": either the latest reading is below the line, or it
 *  is missing (no evidence), or it is the only hot reading we have - a spike has a value but no duration
 *  yet. A cool OR unknown reading breaks the streak, so a gap in sampling can never be counted as load.
 *  Pure. */
export function hotMs(history: PressureSample[], metric: PressureMetric, linePct = FLEET_PRESSURE_PCT): number {
  const newest = history.length ? history[history.length - 1]! : null;
  if (!newest) return 0;
  const now = newest[metric];
  if (now == null || now < linePct) return 0;
  let since = newest.at;
  for (let i = history.length - 2; i >= 0; i--) {
    const s = history[i]!;
    const v = s[metric];
    if (v == null || v < linePct) break;
    since = s.at;
  }
  return Math.max(0, newest.at - since);
}

export interface LaneAdmission {
  ok: boolean;
  /** Human-readable refusal carrying the measured percent AND the measured duration. Absent when ok. */
  reason?: string;
  /** Latest evidence for the dashboard bars. Null = no evidence (sample failed / none yet). */
  cpuPct: number | null;
  memPct: number | null;
  /** Unbroken ms above the line, per metric. 0 = clear (or a spike with no duration yet). */
  cpuHotMs: number;
  memHotMs: number;
  /** Echoed policy, so the HUD and the master agent never hardcode the numbers. */
  pressurePct: number;
  sustainMs: number;
}

const secs = (ms: number): number => Math.round(ms / 1000);

/** PURE: may one MORE lane start, given this pressure history? Lane COUNT never enters the verdict -
 *  the fleet is unlimited; only sustained machine pressure refuses. */
export function laneAdmission(history: PressureSample[], linePct = FLEET_PRESSURE_PCT, sustainMs = FLEET_SUSTAIN_MS): LaneAdmission {
  const newest = history.length ? history[history.length - 1]! : null;
  const cpuHot = hotMs(history, "cpuPct", linePct);
  const memHot = hotMs(history, "memPct", linePct);
  const base: LaneAdmission = {
    ok: true,
    cpuPct: newest?.cpuPct ?? null,
    memPct: newest?.memPct ?? null,
    cpuHotMs: cpuHot,
    memHotMs: memHot,
    pressurePct: linePct,
    sustainMs,
  };
  const held = `held ${linePct}%+ for ${secs(sustainMs)}s`;
  if (memHot >= sustainMs) {
    return { ...base, ok: false, reason: `system memory has been at ${Math.round(base.memPct ?? linePct)}% for ${secs(memHot)}s (${held} is not a burst) - stop a lane or close something before adding one` };
  }
  if (cpuHot >= sustainMs) {
    return { ...base, ok: false, reason: `system CPU has been at ${Math.round(base.cpuPct ?? linePct)}% for ${secs(cpuHot)}s (${held} is not a burst) - let the current work drain before adding a lane` };
  }
  return base;
}
