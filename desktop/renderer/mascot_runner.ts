// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/mascot_runner.ts - P-MASCOT.2: the mini ninja who parkours the prompt bar.
//
// A smaller LUCID scampers along the FOOT of the composer, slips up BEHIND it (he vanishes into the
// bar band bottom-up - cartoon logic, sold by clipping), pops over the top edge, sneaks along it,
// pauses, and silently drops back down (invisible while crossing the band), then rests and runs the
// route MIRRORED the other way. The choreography is a PURE timeline (`runnerAt`) over a layout box, so
// every phase, position, and clip decision is unit-tested; the mount is a thin canvas shell.
//
// Runs whenever the lucid-agent role is active - immersive or parked - because the prompt bar exists in
// both. pointer-events: none always; he can never block a click.

import { MASCOT_FRAMES, MASCOT_H, MASCOT_W, mirrorFrame, paintRows } from "./mascot.ts";

export const RUNNER_SCALE = 2;
export const RUNNER_HEADROOM = MASCOT_H * RUNNER_SCALE + 10; // crawl lane above the bar
const SPEED_RUN = 0.11;   // px/ms along the foot of the bar
const SPEED_SNEAK = 0.05; // px/ms along the top edge
const CLIMB_MS = 700;
const MANTLE_MS = 240; // the pull-over at the top edge (P-MASCOT.3)
const PAUSE_MS = 500;
const DROP_MS = 420;
const LAND_MS = 170;  // squash on impact (P-MASCOT.3)
const REST_MS = 2600;
/** Fixed phase timings, exported for tests + demos (distance-based run/sneak come from runnerCycle). */
export const RUNNER_TIMINGS = { CLIMB_MS, MANTLE_MS, PAUSE_MS, DROP_MS, LAND_MS, REST_MS } as const;
const EDGE_MARGIN = 26; // how far from the bar's end he climbs/exits

/** The overlay box, in canvas coordinates: the bar band is [barTop, barBottom]. `scale` is the ACTUAL
 *  paint scale (device px per sprite cell) - geometry and painting MUST share it. LIVE BUG 2026-08-01:
 *  positions were computed at CSS scale while painting at scale*dpr, so on retina the sprite's lower
 *  half fell below the canvas (the "missing legs"); the pinned QA ran at dpr 1 and never saw it. */
export interface RunnerLayout { width: number; barTop: number; barBottom: number; height: number; scale: number }

export type RunnerPhase = "run" | "climb" | "mantle" | "sneak" | "pause" | "drop" | "land" | "rest";
export interface RunnerPose {
  phase: RunnerPhase;
  x: number;      // sprite left, canvas px
  y: number;      // sprite top, canvas px
  frame: string;  // MASCOT_FRAMES id
  mirrored: boolean;
  /** When true the painter clips OUT the bar band, so the sprite vanishes while crossing it. */
  clipBar: boolean;
}

export interface RunnerCycle {
  runMs: number; sneakMs: number; total: number;
  xEdge: number; xExit: number;
}

/** Per-cycle timings for a layout (distance-based phases scale with the bar's width). */
export function runnerCycle(l: RunnerLayout): RunnerCycle {
  const spriteW = MASCOT_W * l.scale;
  const xEdge = Math.max(spriteW, l.width - EDGE_MARGIN - spriteW);
  const xExit = Math.min(xEdge - spriteW, Math.max(8, EDGE_MARGIN));
  const runMs = (xEdge + spriteW) / SPEED_RUN;
  const sneakMs = Math.max(800, (xEdge - xExit) / SPEED_SNEAK);
  return { runMs, sneakMs, xEdge, xExit, total: runMs + CLIMB_MS + MANTLE_MS + sneakMs + PAUSE_MS + DROP_MS + LAND_MS + REST_MS };
}

/** The pose at absolute time `t` (ms). Cycles alternate direction; positions/frames are mirrored on odd
 *  cycles by reflecting x. Pure. */
export function runnerAt(t: number, l: RunnerLayout): RunnerPose {
  const c = runnerCycle(l);
  const spriteW = MASCOT_W * l.scale;
  const spriteH = MASCOT_H * l.scale;
  const cycle = Math.floor(Math.max(0, t) / c.total);
  const mirrored = cycle % 2 === 1;
  let tt = Math.max(0, t) % c.total;
  const groundY = l.height - spriteH;
  const topY = l.barTop - spriteH;
  const reflect = (x: number): number => (mirrored ? l.width - spriteW - x : x);
  const beat = (ms: number, frames: readonly string[]): string => frames[Math.floor(t / ms) % frames.length]!;
  if (tt < c.runMs) {
    const x = -spriteW + tt * SPEED_RUN;
    // Four-beat gait (contact, pass, contact, pass) at ~10.5 steps/s - the classic smooth run cycle.
    return { phase: "run", x: reflect(x), y: groundY, frame: beat(95, ["runA", "runB", "runC", "runD"]), mirrored, clipBar: false };
  }
  tt -= c.runMs;
  if (tt < CLIMB_MS) {
    // Ease-in-out on the ascent + an alternating grip, so the climb reads as pulls, not an elevator.
    const k = tt / CLIMB_MS;
    const e = k * k * (3 - 2 * k);
    const y = groundY + (topY - groundY) * e;
    return { phase: "climb", x: reflect(c.xEdge), y, frame: beat(160, ["hang", "hangB"]), mirrored, clipBar: true };
  }
  tt -= CLIMB_MS;
  if (tt < MANTLE_MS) {
    return { phase: "mantle", x: reflect(c.xEdge), y: topY, frame: "mantle", mirrored, clipBar: true };
  }
  tt -= MANTLE_MS;
  if (tt < c.sneakMs) {
    const x = c.xEdge + (c.xExit - c.xEdge) * (tt / c.sneakMs);
    // Sneaking BACK the way he came, so the sprite faces the travel direction: flip the mirror.
    return { phase: "sneak", x: reflect(x), y: topY, frame: beat(150, ["sneakA", "sneakB", "sneakA", "idleB"]), mirrored: !mirrored, clipBar: true };
  }
  tt -= c.sneakMs;
  if (tt < PAUSE_MS) {
    return { phase: "pause", x: reflect(c.xExit), y: topY, frame: "sneakA", mirrored: !mirrored, clipBar: true };
  }
  tt -= PAUSE_MS;
  if (tt < DROP_MS) {
    const k = tt / DROP_MS;
    const y = topY + (groundY - topY) * k * k; // gravity ease-in
    return { phase: "drop", x: reflect(c.xExit), y, frame: "fall", mirrored, clipBar: true };
  }
  tt -= DROP_MS;
  if (tt < LAND_MS) {
    return { phase: "land", x: reflect(c.xExit), y: groundY, frame: "land", mirrored, clipBar: false };
  }
  tt -= LAND_MS;
  return { phase: "rest", x: reflect(c.xExit), y: groundY, frame: beat(900, ["idleA", "idleB"]), mirrored, clipBar: false };
}

export interface RunnerHandle { dispose(): void }

/** Mount the runner over `wrap` (the composer wrap). The canvas extends RUNNER_HEADROOM above the wrap
 *  and hugs its width; the wrap itself is the clip band. Never intercepts pointer events. */
export function mountComposerRunner(wrap: HTMLElement): RunnerHandle {
  const cv = document.createElement("canvas");
  cv.style.cssText = `position:absolute;left:0;right:0;top:${-RUNNER_HEADROOM}px;height:calc(100% + ${RUNNER_HEADROOM}px);pointer-events:none;z-index:3`;
  wrap.appendChild(cv);
  const ctx = cv.getContext("2d")!;
  const t0 = performance.now();
  let last = "";
  let raf = 0;
  // P-MASCOT.3: rAF-driven painting - device-pixel positions at display rate make the motion glide
  // (the old 50ms interval moved him in ~5px hops). The pose key still skips repaints at rest.
  const tick = (): void => {
    raf = requestAnimationFrame(tick);
    if (document.hidden) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(wrap.clientWidth * dpr));
    const h = Math.max(1, Math.floor((wrap.clientHeight + RUNNER_HEADROOM) * dpr));
    const scale = Math.max(2, Math.round(RUNNER_SCALE * dpr)); // ONE scale for geometry AND paint
    const l: RunnerLayout = { width: w, barTop: RUNNER_HEADROOM * dpr, barBottom: h, height: h, scale };
    const pose = runnerAt(performance.now() - t0, l);
    const px = Math.round(pose.x), py = Math.round(pose.y); // device-pixel snap keeps the art crisp
    const key = `${pose.frame}:${px}:${py}:${pose.mirrored}`;
    if (key === last && cv.width === w && cv.height === h) return;
    last = key;
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    if (pose.clipBar) {
      ctx.beginPath();
      ctx.rect(0, 0, w, l.barTop); // above the bar
      // Nothing below barBottom exists inside this overlay (the band runs to the canvas foot), so a
      // single top rect is the whole visible region while crossing.
      ctx.clip();
    }
    const rows = pose.mirrored ? mirrorFrame(MASCOT_FRAMES[pose.frame]!) : MASCOT_FRAMES[pose.frame]!;
    paintRows(ctx, rows, l.scale, px, py); // the SAME scale the pose was computed with - never diverge
    ctx.restore();
  };
  tick();
  return { dispose() { cancelAnimationFrame(raf); cv.remove(); } };
}
