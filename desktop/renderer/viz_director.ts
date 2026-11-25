// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_director.ts - P-VIZ.2 (ADR-0623): the Visualize view's camera director (PURE).
//
// It decides WHERE the auto camera looks: the node where the action is most. Each node scores its smoothed
// working intensity (viz_model.nodeIntensity, the normalized est. tok/s or step pulse) plus a "heat" that
// cues add (a surge, a spawn, a power-down) and that decays exponentially. The focus is sticky: a challenger
// must lead clearly (SWITCH_MARGIN and SWITCH_ADD) and the current focus must have held for HOLD_MS, so the
// camera never flicks between two busy agents. A kill or a tool failure GRABS the focus at once for GRAB_MS
// (a second grab inside GRAB_MIN_MS is ignored). When everything is quiet for QUIET_MS the focus goes to
// null: the camera pulls back to the overview. Ties keep the current focus, else the earlier node in input
// order (the hub first), so the same inputs always give the same focus.
//
// Also pure camera math the scene applies each frame: a critically damped spring (no overshoot, no matter the
// frame rate) and the distance that frames an object of a given height to a fraction of the view height.
// DOM-free and three-free: viz_scene.ts drives it and viz_director.test.ts pins the rules.

export type DirectorCue = "surge" | "spawn" | "tool-failed" | "paused" | "ended" | "killed";

/** One node as the director sees it: `activity` is 0..1 (how hard it is working right now). */
export interface DirectorNode { id: string; activity: number }

export interface DirectorState {
  focus: string | null;
  /** When the current focus was taken (the hold runs from here). */
  since: number;
  grab: { id: string; at: number; until: number } | null;
  /** Decaying event heat per node, as of `at`. */
  heat: Map<string, number>;
  /** Smoothed activity per node. */
  act: Map<string, number>;
  /** When everything went quiet (0 = something is happening). */
  quietSince: number;
  at: number;
}

/** The current focus holds at least this long before a challenger can take it. */
export const HOLD_MS = 4000;
/** A kill or tool failure owns the focus this long. */
export const GRAB_MS = 2600;
/** A newer grab cannot replace a grab younger than this. */
export const GRAB_MIN_MS = 1200;
/** Event heat decays with this time constant. */
export const HEAT_TAU_MS = 3000;
/** Activity is smoothed with this time constant (the model's rate is already an EMA; this calms the edges). */
export const ACT_TAU_MS = 1200;
/** A challenger takes over only above current * SWITCH_MARGIN + SWITCH_ADD. */
export const SWITCH_MARGIN = 1.3;
export const SWITCH_ADD = 0.06;
/** Below this score a node is quiet. */
export const IDLE_SCORE = 0.06;
/** Everything quiet this long: back to the overview (focus null). */
export const QUIET_MS = 6000;
/** The heat each cue adds. */
export const CUE_HEAT: Record<DirectorCue, number> = { surge: 0.7, spawn: 0.35, "tool-failed": 0.9, paused: 0.5, ended: 0.4, killed: 1.0 };

export function createDirector(now = 0): DirectorState {
  return { focus: null, since: now, grab: null, heat: new Map(), act: new Map(), quietSince: now, at: now };
}

function decay(d: DirectorState, now: number): void {
  const dt = Math.max(0, now - d.at);
  if (dt > 0) {
    const k = Math.exp(-dt / HEAT_TAU_MS);
    for (const [id, h] of d.heat) {
      const v = h * k;
      if (v < 0.001) d.heat.delete(id); else d.heat.set(id, v);
    }
  }
}

/** Something happened on `node`. A kill or a tool failure grabs the focus right away. */
export function cue(d: DirectorState, node: string, kind: DirectorCue, now: number): void {
  decay(d, now);
  d.at = Math.max(d.at, now);
  d.heat.set(node, (d.heat.get(node) ?? 0) + CUE_HEAT[kind]);
  if (kind !== "killed" && kind !== "tool-failed") return;
  if (d.grab && now < d.grab.until && now - d.grab.at < GRAB_MIN_MS) return;
  d.grab = { id: node, at: now, until: now + GRAB_MS };
  if (d.focus !== node) { d.focus = node; d.since = now; }
}

/** The node's current score (smoothed activity plus heat). */
export function scoreOf(d: DirectorState, id: string): number {
  return (d.act.get(id) ?? 0) + (d.heat.get(id) ?? 0);
}

/** Advance to `now` with the live node list (in a stable order) and return the focus (null: the overview). */
export function directorStep(d: DirectorState, nodes: readonly DirectorNode[], now: number): string | null {
  const dt = Math.max(0, now - d.at);
  decay(d, now);
  d.at = Math.max(d.at, now);
  const ids = new Set<string>();
  const k = 1 - Math.exp(-dt / ACT_TAU_MS);
  for (const n of nodes) {
    ids.add(n.id);
    const a = Math.max(0, Math.min(1, n.activity));
    const prev = d.act.get(n.id);
    d.act.set(n.id, prev === undefined ? a : prev + (a - prev) * k);
  }
  for (const id of [...d.act.keys()]) if (!ids.has(id)) d.act.delete(id);
  for (const id of [...d.heat.keys()]) if (!ids.has(id)) d.heat.delete(id);

  if (d.grab) {
    if (now < d.grab.until && ids.has(d.grab.id)) { d.focus = d.grab.id; return d.focus; }
    d.grab = null;
  }

  let best: string | null = null, bestScore = -1;
  if (d.focus && ids.has(d.focus)) { best = d.focus; bestScore = scoreOf(d, d.focus); }
  for (const n of nodes) {
    const s = scoreOf(d, n.id);
    if (s > bestScore) { best = n.id; bestScore = s; }
  }

  if (bestScore >= IDLE_SCORE) d.quietSince = 0;
  else if (d.quietSince === 0) d.quietSince = now;

  if (!d.focus || !ids.has(d.focus)) {
    const next = bestScore >= IDLE_SCORE ? best : null;
    if (next !== d.focus) { d.focus = next; d.since = now; }
    return d.focus;
  }
  if (d.quietSince && now - d.quietSince >= QUIET_MS && now - d.since >= HOLD_MS) {
    d.focus = null; d.since = now;
    return null;
  }
  if (best && best !== d.focus && now - d.since >= HOLD_MS && bestScore > scoreOf(d, d.focus) * SWITCH_MARGIN + SWITCH_ADD) {
    d.focus = best; d.since = now;
  }
  return d.focus;
}

/** One step of a critically damped spring toward `target` (exact for any dt, so it never overshoots).
 *  `omega` is the natural frequency in rad/s (settles in about 4.6 / omega seconds). Returns [x, v]. */
export function springStep(x: number, v: number, target: number, omega: number, dt: number): [number, number] {
  if (dt <= 0) return [x, v];
  const e = Math.exp(-omega * dt);
  const d0 = x - target;
  const c = v + omega * d0;
  return [target + (d0 + c * dt) * e, (v - omega * c * dt) * e];
}

/** The perspective camera distance at which an object `height` world units tall fills `fill` of the view
 *  height, for a vertical field of view of `fovDeg` degrees. */
export function frameDistance(height: number, fovDeg: number, fill: number): number {
  const half = Math.tan((fovDeg * Math.PI) / 360);
  return height / (2 * Math.max(0.01, fill) * Math.max(1e-4, half));
}

/** The shortest signed angle from `from` to `to`, in (-PI, PI]. */
export function angleDelta(from: number, to: number): number {
  const d = (to - from) % (Math.PI * 2);
  return d > Math.PI ? d - Math.PI * 2 : d <= -Math.PI ? d + Math.PI * 2 : d;
}
