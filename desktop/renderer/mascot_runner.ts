// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// The prompt-bar ninja shares the Arcade run frames and integer pixel geometry on both lanes.
// Only his visible silhouette above the composer is interactive; the prompt remains unobstructed.
import { MASCOT_FRAMES, MASCOT_H, MASCOT_W, MASCOT_RUN_FRAMES, MASCOT_RUN_BEAT_MS, MASCOT_RUN_SWEEP_CELLS, mirrorFrame, paintRows, stepMascot, mascotFrame, type MascotInputs, type MascotSnap } from "./mascot.ts";

export const RUNNER_SCALE = 2;
export const RUNNER_HEADROOM = MASCOT_H * RUNNER_SCALE + 10;
const SPEED_RUN = MASCOT_RUN_SWEEP_CELLS / MASCOT_RUN_BEAT_MS;
const CLIMB_MS = 700;
const MANTLE_MS = 240;
const PAUSE_MS = 500;
const DROP_MS = 420;
const LAND_MS = 170;
const REST_MS = 2600;
export const RUNNER_TIMINGS = { CLIMB_MS, MANTLE_MS, PAUSE_MS, DROP_MS, LAND_MS, REST_MS } as const;
const EDGE_MARGIN = 26;
const IDLE_INPUTS: MascotInputs = { speaking: false, listening: false, working: false };
const idleState = (): MascotInputs => IDLE_INPUTS;

/** Coordinates and scale are device pixels, shared by geometry and painting. */
export interface RunnerLayout { width: number; barTop: number; barBottom: number; height: number; scale: number }
export type RunnerPhase = "run" | "climb" | "mantle" | "sneak" | "pause" | "drop" | "land" | "rest";
export interface RunnerPose {
  phase: RunnerPhase;
  x: number;
  y: number;
  frame: string;
  mirrored: boolean;
  clipBar: boolean;
}
export interface RunnerCycle { runMs: number; sneakMs: number; total: number; xEdge: number; xExit: number }

export function runnerCycle(l: RunnerLayout): RunnerCycle {
  const spriteW = MASCOT_W * l.scale;
  const xEdge = Math.max(spriteW, l.width - EDGE_MARGIN - spriteW);
  const xExit = Math.min(xEdge - spriteW, Math.max(8, EDGE_MARGIN));
  const runMs = (xEdge + spriteW) / (SPEED_RUN * l.scale);
  // Historical phase name "sneak": the top lane now runs at the same no-slip stride as the foot.
  const sneakMs = (xEdge - xExit) / (SPEED_RUN * l.scale);
  return { runMs, sneakMs, xEdge, xExit, total: runMs + CLIMB_MS + MANTLE_MS + sneakMs + PAUSE_MS + DROP_MS + LAND_MS + REST_MS };
}

function setPose(out: RunnerPose, phase: RunnerPhase, x: number, y: number, frame: string, mirrored: boolean, clipBar: boolean): RunnerPose {
  out.phase = phase; out.x = x; out.y = y; out.frame = frame; out.mirrored = mirrored; out.clipBar = clipBar;
  return out;
}

/** Pure timeline; callers rendering continuously can reuse an output pose and cached cycle. */
export function runnerAt(t: number, l: RunnerLayout, out: RunnerPose = { phase: "run", x: 0, y: 0, frame: "runA", mirrored: false, clipBar: false }, c: RunnerCycle = runnerCycle(l)): RunnerPose {
  const spriteW = MASCOT_W * l.scale;
  const spriteH = MASCOT_H * l.scale;
  const mirrored = Math.floor(Math.max(0, t) / c.total) % 2 === 1;
  let tt = Math.max(0, t) % c.total;
  const groundY = l.height - spriteH;
  const topY = l.barTop - spriteH;
  const edge = mirrored ? l.width - spriteW - c.xEdge : c.xEdge;
  const exit = mirrored ? l.width - spriteW - c.xExit : c.xExit;
  if (tt < c.runMs) {
    const x = -spriteW + tt * SPEED_RUN * l.scale;
    return setPose(out, "run", mirrored ? l.width - spriteW - x : x, groundY, MASCOT_RUN_FRAMES[Math.floor(tt / MASCOT_RUN_BEAT_MS) % MASCOT_RUN_FRAMES.length]!, mirrored, false);
  }
  tt -= c.runMs;
  if (tt < CLIMB_MS) {
    const k = tt / CLIMB_MS;
    return setPose(out, "climb", edge, groundY + (topY - groundY) * k * k * (3 - 2 * k), Math.floor(t / 160) % 2 ? "hangB" : "hang", mirrored, true);
  }
  tt -= CLIMB_MS;
  if (tt < MANTLE_MS) return setPose(out, "mantle", edge, topY, "mantle", mirrored, true);
  tt -= MANTLE_MS;
  if (tt < c.sneakMs) {
    const x = c.xEdge - tt * SPEED_RUN * l.scale;
    return setPose(out, "sneak", mirrored ? l.width - spriteW - x : x, topY, MASCOT_RUN_FRAMES[Math.floor(tt / MASCOT_RUN_BEAT_MS) % MASCOT_RUN_FRAMES.length]!, !mirrored, true);
  }
  tt -= c.sneakMs;
  if (tt < PAUSE_MS) return setPose(out, "pause", exit, topY, "guard", !mirrored, true);
  tt -= PAUSE_MS;
  if (tt < DROP_MS) return setPose(out, "drop", exit, topY + (groundY - topY) * (tt / DROP_MS) ** 2, "fall", mirrored, true);
  tt -= DROP_MS;
  if (tt < LAND_MS) return setPose(out, "land", exit, groundY, "land", mirrored, false);
  return setPose(out, "rest", exit, groundY, Math.floor(t / 900) % 2 ? "idleB" : "idleA", mirrored, false);
}

export interface RunnerHandle { setSuspended(suspended: boolean): void; dispose(): void }

/** The canvas is pointer-transparent. Its separate button is clipped to the visible sprite ABOVE
 * the prompt, and uses native Enter/Space activation without a global keyboard handler. */
export function mountComposerRunner(wrap: HTMLElement, getState: () => MascotInputs = idleState): RunnerHandle {
  const cv = document.createElement("canvas");
  cv.setAttribute("aria-hidden", "true");
  cv.style.cssText = `position:absolute;left:0;right:0;top:${-RUNNER_HEADROOM}px;height:calc(100% + ${RUNNER_HEADROOM}px);pointer-events:none;z-index:3`;
  const hit = document.createElement("button");
  hit.type = "button";
  hit.className = "composer-mascot-hit";
  // Geometry is INLINE, not from the stylesheet: an in-flow hit box would resize the composer on
  // every frame, which retriggers the resize observer, which resets the canvas bitmap, which leaves
  // the ninja invisible. The class only carries appearance and the focus ring.
  hit.style.cssText = "position:absolute;padding:0;border:0;background:transparent";
  hit.setAttribute("aria-label", "Greet LUCID ninja");
  wrap.append(cv, hit);
  const ctx = cv.getContext("2d");
  const mirroredFrames = Object.fromEntries(Object.entries(MASCOT_FRAMES).map(([id, frame]) => [id, mirrorFrame(frame)]));
  const l: RunnerLayout = { width: 1, barTop: 1, barBottom: 1, height: 1, scale: 1 };
  const pose: RunnerPose = { phase: "run", x: 0, y: 0, frame: "runA", mirrored: false, clipBar: false };
  let cycle = runnerCycle(l);
  let snap: MascotSnap | null = null;
  let dpr = 1;
  let raf = 0;
  let disposed = false;
  let suspended = false;
  let routeTime = 0;
  let lastTime = performance.now();
  let reactionUntil = 0;
  let reactionStart = 0;
  let greeting = false;
  let lastFrame = "";
  let lastX = NaN, lastY = NaN;
  let lastMirror = false, lastClip = false;
  const events = new AbortController();
  const options = { signal: events.signal };

  function measure(): void {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    l.width = Math.max(1, Math.floor(wrap.clientWidth * dpr));
    l.height = Math.max(1, Math.floor((wrap.clientHeight + RUNNER_HEADROOM) * dpr));
    l.barTop = Math.round(RUNNER_HEADROOM * dpr);
    l.barBottom = l.height;
    l.scale = Math.max(1, Math.floor(RUNNER_SCALE * dpr));
    cycle = runnerCycle(l);
    // Assigning width/height resets the bitmap even when the value is unchanged, so a repeated
    // measure would erase the sprite. Only resize when the size actually moved.
    if (cv.width !== l.width || cv.height !== l.height) { cv.width = l.width; cv.height = l.height; }
    lastFrame = "";
  }
  function react(clicked: boolean): void {
    if (suspended || disposed) return;
    const now = performance.now();
    if (!clicked && now < reactionUntil) return;
    greeting = clicked;
    reactionStart = now;
    reactionUntil = now + (clicked ? 650 : 400);
  }
  hit.addEventListener("pointerenter", () => react(false), options);
  hit.addEventListener("focus", () => react(false), options);
  hit.addEventListener("click", () => react(true), options);

  function tick(now: number): void {
    raf = 0;
    if (disposed || suspended || document.hidden || !ctx) return;
    const dt = Math.min(50, now - lastTime);
    lastTime = now;
    snap = stepMascot(snap, getState(), now);
    const reacting = now < reactionUntil;
    const active = snap.state !== "idle";
    if (!active && !reacting && document.activeElement !== hit) routeTime += dt;
    runnerAt(routeTime, l, pose, cycle);
    if (active) {
      // Real session state always wins over a greeting and keeps the sprite above the input.
      pose.frame = mascotFrame(snap, now);
      pose.y = l.barTop - MASCOT_H * l.scale;
      pose.x = Math.max(0, Math.min(l.width - MASCOT_W * l.scale, pose.x));
      pose.clipBar = true;
    } else if (reacting) {
      pose.frame = greeting ? (now - reactionStart < 220 ? "victoryA" : "victoryB") : "guard";
    }
    const px = Math.round(pose.x), py = Math.round(pose.y);
    if (pose.frame !== lastFrame || px !== lastX || py !== lastY || pose.mirrored !== lastMirror || pose.clipBar !== lastClip) {
      lastFrame = pose.frame; lastX = px; lastY = py; lastMirror = pose.mirrored; lastClip = pose.clipBar;
      ctx.clearRect(0, 0, l.width, l.height);
      ctx.save();
      if (pose.clipBar) { ctx.beginPath(); ctx.rect(0, 0, l.width, l.barTop); ctx.clip(); }
      paintRows(ctx, pose.mirrored ? mirroredFrames[pose.frame]! : MASCOT_FRAMES[pose.frame]!, l.scale, px, py);
      ctx.restore();
      // Never intercept the input band, including when the sprite climbs behind it.
      const left = Math.max(0, px), top = Math.max(0, py);
      const width = Math.max(0, Math.min(l.width, px + MASCOT_W * l.scale) - left);
      const height = Math.max(0, Math.min(l.barTop, py + MASCOT_H * l.scale) - top);
      hit.hidden = width === 0 || height === 0;
      hit.style.left = `${left / dpr}px`;
      hit.style.top = `${top / dpr - RUNNER_HEADROOM}px`;
      hit.style.width = `${width / dpr}px`;
      hit.style.height = `${height / dpr}px`;
    }
    raf = requestAnimationFrame(tick);
  }
  function schedule(): void {
    lastTime = performance.now();
    if (!raf && !disposed && !suspended && !document.hidden && ctx) raf = requestAnimationFrame(tick);
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { cancelAnimationFrame(raf); raf = 0; } else schedule();
  }, options);
  window.addEventListener("resize", measure, options);
  const observer = new ResizeObserver(measure);
  observer.observe(wrap);
  hit.hidden = true;
  measure();
  schedule();
  return {
    setSuspended(value) {
      if (disposed || suspended === value) return;
      suspended = value;
      cv.hidden = value;
      hit.hidden = true;
      lastFrame = "";
      if (value) { cancelAnimationFrame(raf); raf = 0; if (document.activeElement === hit) hit.blur(); }
      else schedule();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      observer.disconnect();
      events.abort();
      cv.remove(); hit.remove();
    },
  };
}
