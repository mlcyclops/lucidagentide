// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// The prompt-bar ninja shares the Arcade run frames and integer pixel geometry on both lanes.
// Only his visible silhouette above the composer is interactive; the prompt remains unobstructed.
// P-SEASON.1: hover = a springy hop, click = a leap-dash along the route with fading afterimages, and
// while a special theme is live (document.documentElement.dataset.season) he wears its costume and
// performs its seasonal act during the route's rest.
import { MASCOT_FRAMES, MASCOT_H, MASCOT_PALETTE, MASCOT_W, MASCOT_RUN_FRAMES, MASCOT_RUN_BEAT_MS, MASCOT_RUN_SWEEP_CELLS, mirrorFrame, paintRows, stepMascot, mascotFrame, type MascotInputs, type MascotSnap } from "./mascot.ts";
import { paintSeasonExtras, seasonActAt, seasonActMs, seasonPalette, type SeasonActFrame } from "./mascot_season.ts";
import { seasonById, type SeasonId } from "./seasons.ts";

export const RUNNER_SCALE = 2;
/** Peak lift of the click leap, in cells. The canvas reserves this much sky above the top lane so the
 *  arc is never cut off by the canvas edge. */
export const LEAP_LIFT_CELLS = 12;
const HOP_LIFT_CELLS = 7;
export const RUNNER_HEADROOM = MASCOT_H * RUNNER_SCALE + 10 + LEAP_LIFT_CELLS * RUNNER_SCALE;
const CLIMB_MS = 700;
const MANTLE_MS = 240;
const PAUSE_MS = 500;
const DROP_MS = 420;
const LAND_MS = 170;
const REST_MS = 2600;
/** A seasonal act starts this long into the rest and the rest lingers this long after it ends. */
const ACT_LEAD_MS = 300;
const ACT_TAIL_MS = 700;
export const RUNNER_TIMINGS = { CLIMB_MS, MANTLE_MS, PAUSE_MS, DROP_MS, LAND_MS, REST_MS, ACT_LEAD_MS } as const;
const EDGE_MARGIN = 26;
const IDLE_INPUTS: MascotInputs = { speaking: false, listening: false, working: false };
const idleState = (): MascotInputs => IDLE_INPUTS;

/** Coordinates and scale are device pixels, shared by geometry and painting. */
export interface RunnerLayout { width: number; barTop: number; barBottom: number; height: number; scale: number }
export type RunnerPhase = "run" | "climb" | "mantle" | "sneak" | "pause" | "drop" | "land" | "rest";
export interface RunnerPose {
  phase: RunnerPhase;
  /** ms already spent in `phase` (drives the seasonal act during rest and the leap's room to dash). */
  phaseT: number;
  x: number;
  y: number;
  frame: string;
  mirrored: boolean;
  clipBar: boolean;
}
export interface RunnerCycle { runMs: number; sneakMs: number; restMs: number; total: number; xEdge: number; xExit: number }

/** The rest that fits a seasonal act of `actMs` (0 = no season: the plain rest). */
export function runnerRestMs(actMs: number): number {
  return actMs > 0 ? Math.max(REST_MS, ACT_LEAD_MS + actMs + ACT_TAIL_MS) : REST_MS;
}

/** Both lanes are walked in WHOLE gait beats: the edge and the exit sit an exact number of sweeps from
 *  the entry, so the walk never ends on a partial beat (which would skate the planted foot). */
export function runnerCycle(l: RunnerLayout, restMs: number = REST_MS): RunnerCycle {
  const spriteW = MASCOT_W * l.scale;
  const stepPx = MASCOT_RUN_SWEEP_CELLS * l.scale;
  const runBeats = Math.round((Math.max(spriteW, l.width - EDGE_MARGIN - spriteW) + spriteW) / stepPx);
  const xEdge = -spriteW + runBeats * stepPx;
  // Historical phase name "sneak": the top lane runs at the same no-slip stride as the foot.
  const sneakBeats = Math.max(0, Math.floor((xEdge - Math.min(xEdge - spriteW, Math.max(8, EDGE_MARGIN))) / stepPx));
  const xExit = xEdge - sneakBeats * stepPx;
  const runMs = runBeats * MASCOT_RUN_BEAT_MS;
  const sneakMs = sneakBeats * MASCOT_RUN_BEAT_MS;
  return { runMs, sneakMs, restMs, xEdge, xExit, total: runMs + CLIMB_MS + MANTLE_MS + sneakMs + PAUSE_MS + DROP_MS + LAND_MS + restMs };
}

function setPose(out: RunnerPose, phase: RunnerPhase, phaseT: number, x: number, y: number, frame: string, mirrored: boolean, clipBar: boolean): RunnerPose {
  out.phase = phase; out.phaseT = phaseT; out.x = x; out.y = y; out.frame = frame; out.mirrored = mirrored; out.clipBar = clipBar;
  return out;
}

/** Pure timeline; callers rendering continuously can reuse an output pose and cached cycle. Walking
 *  phases advance x in whole beats, so within a beat the body and its planted foot hold still. */
export function runnerAt(t: number, l: RunnerLayout, out: RunnerPose = { phase: "run", phaseT: 0, x: 0, y: 0, frame: "runA", mirrored: false, clipBar: false }, c: RunnerCycle = runnerCycle(l)): RunnerPose {
  const spriteW = MASCOT_W * l.scale;
  const spriteH = MASCOT_H * l.scale;
  const stepPx = MASCOT_RUN_SWEEP_CELLS * l.scale;
  const mirrored = Math.floor(Math.max(0, t) / c.total) % 2 === 1;
  let tt = Math.max(0, t) % c.total;
  const groundY = l.height - spriteH;
  const topY = l.barTop - spriteH;
  const edge = mirrored ? l.width - spriteW - c.xEdge : c.xEdge;
  const exit = mirrored ? l.width - spriteW - c.xExit : c.xExit;
  if (tt < c.runMs) {
    const beat = Math.floor(tt / MASCOT_RUN_BEAT_MS);
    const x = -spriteW + beat * stepPx;
    return setPose(out, "run", tt, mirrored ? l.width - spriteW - x : x, groundY, MASCOT_RUN_FRAMES[beat % MASCOT_RUN_FRAMES.length]!, mirrored, false);
  }
  tt -= c.runMs;
  if (tt < CLIMB_MS) {
    const k = tt / CLIMB_MS;
    return setPose(out, "climb", tt, edge, groundY + (topY - groundY) * k * k * (3 - 2 * k), Math.floor(t / 160) % 2 ? "hangB" : "hang", mirrored, true);
  }
  tt -= CLIMB_MS;
  if (tt < MANTLE_MS) return setPose(out, "mantle", tt, edge, topY, "mantle", mirrored, true);
  tt -= MANTLE_MS;
  if (tt < c.sneakMs) {
    const beat = Math.floor(tt / MASCOT_RUN_BEAT_MS);
    const x = c.xEdge - beat * stepPx;
    return setPose(out, "sneak", tt, mirrored ? l.width - spriteW - x : x, topY, MASCOT_RUN_FRAMES[beat % MASCOT_RUN_FRAMES.length]!, !mirrored, true);
  }
  tt -= c.sneakMs;
  if (tt < PAUSE_MS) return setPose(out, "pause", tt, exit, topY, "guard", !mirrored, true);
  tt -= PAUSE_MS;
  if (tt < DROP_MS) return setPose(out, "drop", tt, exit, topY + (groundY - topY) * (tt / DROP_MS) ** 2, "fall", mirrored, true);
  tt -= DROP_MS;
  if (tt < LAND_MS) return setPose(out, "land", tt, exit, groundY, "land", mirrored, false);
  tt -= LAND_MS;
  return setPose(out, "rest", tt, exit, groundY, Math.floor(t / 900) % 2 ? "idleB" : "idleA", mirrored, false);
}

/** ms of route left in a WALKING phase (where a dash can carry him forward); 0 elsewhere. */
export function runnerWalkLeft(p: RunnerPose, c: RunnerCycle): number {
  return p.phase === "run" ? c.runMs - p.phaseT : p.phase === "sneak" ? c.sneakMs - p.phaseT : 0;
}

export type RunnerReactionKind = "hop" | "leap";
export interface RunnerReactionBeat {
  frame: string;
  /** Height above the route, in cells (positive = up). */
  lift: number;
  /** 0..1 share of the dash's route advance already covered (always 0 for the hop). */
  travel: number;
  /** In the air: afterimages trail a leap only here. */
  airborne: boolean;
}
const HOP = { crouch: 90, air: 300, land: 110 } as const;
const LEAP = { crouch: 120, air: 480, land: 150 } as const;
const STILL_MS = { hop: 420, leap: 650 } as const;
const HOP_COOLDOWN_MS = 1200;
/** Full length of each reaction; reduced motion plays a short still pose instead of any jump. */
export function runnerReactionMs(kind: RunnerReactionKind, reduced: boolean): number {
  if (reduced) return STILL_MS[kind];
  const b = kind === "hop" ? HOP : LEAP;
  return b.crouch + b.air + b.land;
}
/** Route ms a leap may consume: 44 cells of travel squeezed into one arc, so the dash reads as a burst. */
export const LEAP_ROUTE_MS = 1100;

/** PURE reaction timeline. Hop: anticipation crouch, a parabolic rise and fall, a squash landing. Leap:
 *  deeper crouch, a higher arc in the dash pose while the route advances on an ease-out, squash. */
export function runnerReaction(kind: RunnerReactionKind, t: number, reduced: boolean, out: RunnerReactionBeat = { frame: "guard", lift: 0, travel: 0, airborne: false }): RunnerReactionBeat {
  const tt = Math.max(0, t);
  out.lift = 0; out.travel = 0; out.airborne = false;
  if (reduced) { out.frame = kind === "hop" ? "guard" : "victoryA"; return out; }
  const b = kind === "hop" ? HOP : LEAP;
  if (tt < b.crouch) { out.frame = "crouch"; return out; }
  const s = (tt - b.crouch) / b.air;
  if (s < 1) {
    out.airborne = true;
    out.lift = (kind === "hop" ? HOP_LIFT_CELLS : LEAP_LIFT_CELLS) * 4 * s * (1 - s);
    out.travel = kind === "hop" ? 0 : 1 - (1 - s) ** 3;
    out.frame = kind === "hop" ? (s < 0.5 ? "hopUp" : "hopFall") : s < 0.12 ? "hopUp" : s > 0.86 ? "hopFall" : "dash";
    return out;
  }
  out.travel = kind === "hop" ? 0 : 1;
  out.frame = tt < b.crouch + b.air + b.land * 0.6 ? "crouch" : "guard";
  return out;
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
  const mirroredFrames: Record<string, string[]> = Object.fromEntries(Object.entries(MASCOT_FRAMES).map(([id, frame]) => [id, mirrorFrame(frame)]));
  const l: RunnerLayout = { width: 1, barTop: 1, barBottom: 1, height: 1, scale: 1 };
  const pose: RunnerPose = { phase: "run", phaseT: 0, x: 0, y: 0, frame: "runA", mirrored: false, clipBar: false };
  const ghost: RunnerPose = { ...pose };
  const beat: RunnerReactionBeat = { frame: "guard", lift: 0, travel: 0, airborne: false };
  const ghostBeat: RunnerReactionBeat = { ...beat };
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  let season: SeasonId | null = null;
  let seasonAttr: string | undefined;
  let palette: Record<string, string> = MASCOT_PALETTE;
  let ghostPalettes: Record<string, string>[] = [];
  // Afterimages are composed opaque on their own layer, then laid down with ONE alpha: overlapping
  // ghosts stay clean bands instead of compounding into a muddy smear.
  const trail = document.createElement("canvas");
  const trailCtx = trail.getContext("2d");
  let actMs = 0;
  let cycle = runnerCycle(l);
  let snap: MascotSnap | null = null;
  let dpr = 1;
  let raf = 0;
  let disposed = false;
  let suspended = false;
  let routeTime = 0;
  let lastTime = performance.now();
  let reaction: RunnerReactionKind | null = null;
  let reactionStart = 0;
  let reactionUntil = 0;
  let reactionReduced = false;
  let leapRouteMs = 0;
  let leapQueued = false;
  let hopCooldownUntil = 0;
  let lastKey = "";
  const events = new AbortController();
  const options = { signal: events.signal };

  function setPalette(): void {
    palette = season ? seasonPalette(season, MASCOT_PALETTE) : MASCOT_PALETTE;
    // Afterimages are flat silhouettes in the costume's accent: the newest lifted most of the way to
    // white, older ones closer to the raw accent, so the trail fades into the costume colour.
    const accent = parseInt((palette.G ?? MASCOT_PALETTE.G!).slice(1), 16);
    ghostPalettes = [0.75, 0.45, 0.15].map((w) => {
      const pale = (c: number): number => Math.round(c + (255 - c) * w);
      const glow = `rgb(${pale((accent >> 16) & 255)},${pale((accent >> 8) & 255)},${pale(accent & 255)})`;
      return Object.fromEntries(Object.keys(palette).map((k) => [k, glow]));
    });
  }
  setPalette();
  /** One attribute read per tick; work happens only when the season actually changes. */
  function readSeason(): void {
    const attr = document.documentElement.dataset.season;
    if (attr === seasonAttr) return;
    seasonAttr = attr;
    season = seasonById(attr)?.id ?? null;
    actMs = season ? seasonActMs(season) : 0;
    setPalette();
    // Keep the walker where he is in his cycle when the rest length changes under him.
    const k = routeTime / cycle.total;
    cycle = runnerCycle(l, runnerRestMs(actMs));
    routeTime = k * cycle.total;
    lastKey = "";
  }
  function measure(): void {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    l.width = Math.max(1, Math.floor(wrap.clientWidth * dpr));
    l.height = Math.max(1, Math.floor((wrap.clientHeight + RUNNER_HEADROOM) * dpr));
    l.barTop = Math.round(RUNNER_HEADROOM * dpr);
    l.barBottom = l.height;
    l.scale = Math.max(1, Math.floor(RUNNER_SCALE * dpr));
    cycle = runnerCycle(l, runnerRestMs(actMs));
    // Assigning width/height resets the bitmap even when the value is unchanged, so a repeated
    // measure would erase the sprite. Only resize when the size actually moved.
    if (cv.width !== l.width || cv.height !== l.height) { cv.width = l.width; cv.height = l.height; trail.width = l.width; trail.height = l.height; }
    lastKey = "";
  }
  function react(kind: RunnerReactionKind): void {
    if (suspended || disposed) return;
    const now = performance.now();
    if (now < reactionUntil) {
      // A click lands while the hover hop is still in the air (the usual mouse path): leap the moment
      // he touches down instead of yanking him out of the hop.
      if (kind === "leap" && reaction === "hop") leapQueued = true;
      return;
    }
    // The hop lifts the hit box out from under a resting cursor and lands it back, which re-fires
    // pointerenter: without a cooldown he would bounce for as long as the pointer sits still.
    if (kind === "hop" && now < hopCooldownUntil) return;
    // Only from solid footing: a hop off the climb or the drop would read as a glitch.
    runnerAt(routeTime, l, pose, cycle);
    if (pose.phase === "climb" || pose.phase === "mantle" || pose.phase === "drop") return;
    reaction = kind;
    reactionReduced = reducedMotion?.matches ?? false;
    reactionStart = now;
    reactionUntil = now + runnerReactionMs(reaction, reactionReduced);
    hopCooldownUntil = reactionUntil + HOP_COOLDOWN_MS;
    // The dash carries him along his own route (never off it), and stops a beat short of the lane's end.
    leapRouteMs = reaction === "leap" && !reactionReduced ? Math.max(0, Math.min(LEAP_ROUTE_MS, runnerWalkLeft(pose, cycle) - MASCOT_RUN_BEAT_MS)) : 0;
  }
  hit.addEventListener("pointerenter", () => react("hop"), options);
  hit.addEventListener("focus", () => react("hop"), options);
  hit.addEventListener("click", () => react("leap"), options);

  function tick(now: number): void {
    raf = 0;
    if (disposed || suspended || document.hidden || !ctx) return;
    const dt = Math.min(50, now - lastTime);
    lastTime = now;
    readSeason();
    snap = stepMascot(snap, getState(), now);
    if (reaction && now >= reactionUntil) {
      // Fold the dash into the route: he resumes exactly where he landed, mid-stride, no snap back.
      routeTime += leapRouteMs;
      reaction = null; leapRouteMs = 0; reactionUntil = 0;
      if (leapQueued) { leapQueued = false; react("leap"); }
    }
    const active = snap.state !== "idle";
    if (!active && !reaction && document.activeElement !== hit) routeTime += dt;
    let act: SeasonActFrame | null = null;
    let lift = 0;
    let ghosts = false;
    if (reaction && !active) {
      runnerReaction(reaction, now - reactionStart, reactionReduced, beat);
      runnerAt(routeTime + leapRouteMs * beat.travel, l, pose, cycle);
      pose.frame = beat.frame;
      lift = beat.lift;
      ghosts = reaction === "leap" && beat.airborne;
    } else {
      runnerAt(routeTime, l, pose, cycle);
      if (active) {
        // Real session state always wins over a greeting and keeps the sprite above the input.
        pose.frame = mascotFrame(snap, now);
        pose.y = l.barTop - MASCOT_H * l.scale;
        pose.x = Math.max(0, Math.min(l.width - MASCOT_W * l.scale, pose.x));
        pose.clipBar = true;
      } else if (season && pose.phase === "rest" && pose.phaseT >= ACT_LEAD_MS && pose.phaseT < ACT_LEAD_MS + actMs) {
        act = seasonActAt(season, pose.phaseT - ACT_LEAD_MS);
        pose.frame = act.frame in MASCOT_FRAMES ? act.frame : "idleA";
        pose.mirrored = pose.mirrored !== act.mirrored;
        lift = act.lift;
      }
    }
    const px = Math.round(pose.x), py = Math.round(pose.y - lift * l.scale);
    let key = `${pose.frame}|${px}|${py}|${pose.mirrored ? 1 : 0}|${pose.clipBar ? 1 : 0}|${season ?? ""}`;
    if (act) for (const p of act.props) key += `|${p.sprite}@${p.x},${p.y}`;
    if (ghosts) key += `|g${Math.round(now)}`;
    if (key !== lastKey) {
      lastKey = key;
      ctx.clearRect(0, 0, l.width, l.height);
      ctx.save();
      if (pose.clipBar) { ctx.beginPath(); ctx.rect(0, 0, l.width, l.barTop); ctx.clip(); }
      if (ghosts && trailCtx) {
        // Afterimages: the same timeline sampled 70/140/210 ms earlier. Newest first, each one only
        // fills what newer ghosts left empty (destination-over), so where they overlap the newest wins.
        // A ghost almost on top of the body or of the newer ghost (the slow top of the arc) is skipped.
        trailCtx.clearRect(0, 0, trail.width, trail.height);
        trailCtx.globalCompositeOperation = "destination-over";
        let lastGx = px, lastGy = py;
        for (let i = 1; i <= 3; i++) {
          runnerReaction("leap", now - reactionStart - i * 70, false, ghostBeat);
          if (!ghostBeat.airborne) break;
          runnerAt(routeTime + leapRouteMs * ghostBeat.travel, l, ghost, cycle);
          const gx = Math.round(ghost.x), gy = Math.round(ghost.y - ghostBeat.lift * l.scale);
          if (Math.abs(gx - lastGx) + Math.abs(gy - lastGy) < 8 * l.scale) continue;
          lastGx = gx; lastGy = gy;
          paintRows(trailCtx, (ghost.mirrored ? mirroredFrames : MASCOT_FRAMES)[ghostBeat.frame]!, l.scale, gx, gy, ghostPalettes[i - 1]!);
        }
        trailCtx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = 0.5;
        ctx.drawImage(trail, 0, 0);
        ctx.globalAlpha = 1;
      }
      paintRows(ctx, (pose.mirrored ? mirroredFrames : MASCOT_FRAMES)[pose.frame]!, l.scale, px, py, palette);
      // An act lifts its own costume and keeps its props ground-relative, so it takes the UNLIFTED box;
      // a hop or leap (act = null) carries the costume up with the body.
      if (season) paintSeasonExtras(ctx, season, act, pose.frame, pose.mirrored, l.scale, px, act ? Math.round(pose.y) : py);
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
      lastKey = "";
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
