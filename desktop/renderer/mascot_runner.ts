// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// The prompt-bar ninja shares the Arcade's frames and integer pixel geometry.
// Only his visible silhouette above the composer is interactive; the prompt remains unobstructed.
// P-SEASON.1: hover = a springy hop, and while a special theme is live (document.documentElement.dataset.season)
// he wears its costume and now and then performs its seasonal act.
// P-MINI.3 (ADR-0596): he is calm. HOME is the right end of the bar top, where he practices, meditates or just
// breathes for long stretches, and sits down to type while a turn runs. About every five minutes he walks to
// the left end and back. A double-click sends him dashing off the bar, a right-click turns him off. He is drawn
// at the user's size (one or two CSS pixels per cell) in the color theme's palette.
import { MASCOT_FRAMES, MASCOT_H, MASCOT_W, MASCOT_RUN_FRAMES, MASCOT_RUN_BEAT_MS, MASCOT_RUN_SWEEP_CELLS, mascotActivityFrame, mascotFrame, mirrorFrame, paintRows, stepMascot, type MascotInputs, type MascotSnap } from "./mascot.ts";
import { paintSeasonExtras, seasonActAt, seasonActMs, seasonPalette, type SeasonActFrame } from "./mascot_season.ts";
import { seasonById, type SeasonId } from "./seasons.ts";
import { SCENE_H, SCENE_W, TYPING_BEAT_MS, sceneRows, typingRows } from "./mascot_mini.ts"; // P-MINI.1 (ADR-0580): the seated poses
import { themedMascotPalette } from "./mascot_theme.ts";
import { MASCOT_CELL_CSS, type MascotSize } from "./mini_lucid.ts";

/** Peak lift of the dash, in cells. */
export const LEAP_LIFT_CELLS = 12;
const HOP_LIFT_CELLS = 7;
const GREET_LIFT_CELLS = 9;
/** Sky kept above his hood, in cells: the dash's arc, and a seasonal act's jump and props (a raised torch
 *  reaches about 25 cells over the hood), so nothing is cut off by the canvas edge. */
export const RUNNER_SKY_CELLS = 30;
/** Cells between him and either end of the bar, at home and at the far end of a traverse. */
export const RUNNER_EDGE_CELLS = 6;
const IDLE_INPUTS: MascotInputs = { speaking: false, listening: false, working: false };
const idleState = (): MascotInputs => IDLE_INPUTS;

/** CSS pixels the canvas reaches above the bar for a cell size of `cellCss` CSS px. */
export function runnerHeadroom(cellCss: number): number {
  return (MASCOT_H + RUNNER_SKY_CELLS) * cellCss;
}

/** Device pixels per sprite cell: whole pixels only, so the pixel art stays crisp at any DPR. */
export function runnerCellPx(size: MascotSize, dpr: number): number {
  return Math.max(1, Math.floor(MASCOT_CELL_CSS[size] * dpr));
}

/** Coordinates and scale are device pixels, shared by geometry and painting. `barTop` is the top edge of the
 *  VISIBLE bar (the composer's input row), which may sit below the wrap's own top; `barLeft`/`barRight` are
 *  its ends, defaulting to the canvas's. */
export interface RunnerLayout { width: number; barTop: number; height: number; scale: number; barLeft?: number; barRight?: number }

/** Where he lives on a layout, in whole device pixels. */
export interface RunnerPlan {
  width: number;
  barTop: number;
  scale: number;
  spriteW: number;
  /** Travel per gait beat (the no-slip stride). */
  stepPx: number;
  homeX: number;
  /** Whole gait beats from home to the far end of a traverse. */
  beats: number;
  endX: number;
  walkMs: number;
  traverseMs: number;
}

/** A pause at the far end of a traverse: he looks out past the end, then back toward home. */
const LOOK_MS = 1800;
/** A bar where he cannot walk at least his own width gets no traverse: the walk would be a shuffle. */
const MIN_TRAVERSE_CELLS = MASCOT_W;

/** PURE: home is the bar's right end, his right edge RUNNER_EDGE_CELLS inside it; the far end of a traverse is
 *  a whole number of strides away, never closer than the same margin to the bar's left end. */
export function runnerPlan(l: RunnerLayout): RunnerPlan {
  const spriteW = MASCOT_W * l.scale;
  const stepPx = MASCOT_RUN_SWEEP_CELLS * l.scale;
  const margin = RUNNER_EDGE_CELLS * l.scale;
  const left = Math.max(0, Math.round(l.barLeft ?? 0));
  const right = Math.min(l.width, Math.round(l.barRight ?? l.width));
  const homeX = Math.max(0, right - spriteW - margin);
  const beats = Math.max(0, Math.floor((homeX - left - margin) / stepPx));
  const walkMs = beats * MASCOT_RUN_BEAT_MS;
  return { width: l.width, barTop: l.barTop, scale: l.scale, spriteW, stepPx, homeX, beats, endX: homeX - beats * stepPx, walkMs, traverseMs: 2 * walkMs + LOOK_MS };
}

const bottoms = new WeakMap<readonly string[], number>();
/** PURE: the lowest row of `rows` with a painted cell (-1 when none). Frames and scenes leave empty rows under
 *  the figure (a seated pose ends well above its grid's floor), so "on the bar" is measured off the paint.
 *  Cached per rows array. */
export function paintedBottom(rows: readonly string[]): number {
  let b = bottoms.get(rows);
  if (b === undefined) {
    b = rows.length - 1;
    while (b >= 0 && !/[^.]/.test(rows[b]!)) b--;
    bottoms.set(rows, b);
  }
  return b;
}

/** PURE: the sprite top that puts the lowest painted row of `frame` right on the bar top. */
export function standTop(p: RunnerPlan, frame: string): number {
  return p.barTop - (paintedBottom(MASCOT_FRAMES[frame] ?? MASCOT_FRAMES.idleA!) + 1) * p.scale;
}

/** PURE: where a seated scene (SCENE_W x SCENE_H) sits, in device pixels: on the bar top, at `walkerX`, kept
 *  inside the bar's width. */
export function typingBox(l: RunnerLayout, walkerX: number): { x: number; y: number; w: number; h: number } {
  const w = SCENE_W * l.scale;
  const h = SCENE_H * l.scale;
  return { x: Math.round(Math.max(0, Math.min(l.width - w, walkerX))), y: l.barTop - h, w, h };
}

/** PURE: a seated scene (`rows`) at home: its figure (centered in the wider scene) exactly where he stands, and
 *  its lowest painted row on the bar top. */
export function homeSeatBox(l: RunnerLayout, p: RunnerPlan, rows: readonly string[]): { x: number; y: number; w: number; h: number } {
  const box = typingBox(l, p.homeX - ((SCENE_W - MASCOT_W) / 2) * l.scale);
  box.y = l.barTop - (paintedBottom(rows) + 1) * l.scale;
  return box;
}

export interface RunnerPose {
  x: number;
  y: number;
  frame: string;
  mirrored: boolean;
  /** Height above the bar, in cells (positive = up). */
  lift: number;
  /** In the air during a dash: afterimages trail him only here. */
  airborne: boolean;
}
export function newRunnerPose(): RunnerPose {
  return { x: 0, y: 0, frame: "idleA", mirrored: true, lift: 0, airborne: false };
}
/** Every pose stands on the bar: y is the frame's own grounded top (standTop), before any lift. */
function setPose(out: RunnerPose, p: RunnerPlan, x: number, frame: string, mirrored: boolean, lift = 0, airborne = false): RunnerPose {
  out.x = x; out.y = standTop(p, frame); out.frame = frame; out.mirrored = mirrored; out.lift = lift; out.airborne = airborne;
  return out;
}
const gaitFrame = (beat: number): string => MASCOT_RUN_FRAMES[beat % MASCOT_RUN_FRAMES.length]!;

/** PURE traverse timeline: from home to the far end in whole beats (the body holds still within a beat, so the
 *  planted foot never skates), a look out and back, then home again. Frames face right; mirrored = facing left. */
export function traverseAt(t: number, p: RunnerPlan, out: RunnerPose = newRunnerPose()): RunnerPose {
  const tt = Math.max(0, t);
  if (tt < p.walkMs) {
    const beat = Math.floor(tt / MASCOT_RUN_BEAT_MS);
    return setPose(out, p, p.homeX - beat * p.stepPx, gaitFrame(beat), true);
  }
  const look = tt - p.walkMs;
  if (look < LOOK_MS) return look < LOOK_MS / 2 ? setPose(out, p, p.endX, "guard", true) : setPose(out, p, p.endX, "idleB", false);
  const back = look - LOOK_MS;
  if (back < p.walkMs) {
    const beat = Math.floor(back / MASCOT_RUN_BEAT_MS);
    return setPose(out, p, p.endX + beat * p.stepPx, gaitFrame(beat), false);
  }
  return setPose(out, p, p.homeX, "idleA", true);
}

/** PURE: a turn starts mid-traverse, so he heads home now. A time on the outbound leg (or the look) maps to the
 *  homeward leg at the same spot; a time already on the homeward leg is returned unchanged. */
export function traverseTurnBack(t: number, p: RunnerPlan): number {
  if (t >= p.walkMs + LOOK_MS) return t;
  if (t >= p.walkMs) return p.walkMs + LOOK_MS;
  const beat = Math.floor(Math.max(0, t) / MASCOT_RUN_BEAT_MS);
  return p.walkMs + LOOK_MS + (p.beats - beat) * MASCOT_RUN_BEAT_MS;
}

/** Whole beats for the walk back in from off the bar on `side` (-1 = left end, 1 = right end) to home. */
export function returnBeats(p: RunnerPlan, side: -1 | 1): number {
  return Math.ceil((side < 0 ? p.homeX + p.spriteW : p.width - p.homeX) / p.stepPx);
}

/** PURE: he walks back in from off the bar on `side`, starting wholly out of sight, and stops at home. */
export function returnAt(t: number, p: RunnerPlan, side: -1 | 1, out: RunnerPose = newRunnerPose()): RunnerPose {
  const n = returnBeats(p, side);
  const beat = Math.floor(Math.max(0, t) / MASCOT_RUN_BEAT_MS);
  if (beat >= n) return setPose(out, p, p.homeX, "idleA", true);
  const left = (n - beat) * p.stepPx;
  return side < 0 ? setPose(out, p, p.homeX - left, gaitFrame(beat), false) : setPose(out, p, p.homeX + left, gaitFrame(beat), true);
}

const DASH = { crouch: 140, air: 620, tail: 240 } as const;
/** Crouch, the dash itself, and a tail in which his afterimages finish fading off the bar. */
export const DASH_MS = DASH.crouch + DASH.air + DASH.tail;

/** PURE: away from the side of the bar the pointer is on. At home (the right end) that is the left end. */
export function dashDirection(pointerX: number, barWidth: number): -1 | 1 {
  return pointerX < barWidth / 2 ? 1 : -1;
}

/** PURE dash timeline: a crouch, then a fast arcing burst from `fromX` until he is wholly off the bar's `dir`
 *  end, where he stays (out of sight) for the tail. */
export function dashAt(t: number, p: RunnerPlan, fromX: number, dir: -1 | 1, out: RunnerPose = newRunnerPose()): RunnerPose {
  const mirrored = dir < 0;
  if (t < DASH.crouch) return setPose(out, p, fromX, "crouch", mirrored);
  const target = dir < 0 ? -p.spriteW : p.width;
  const s = (t - DASH.crouch) / DASH.air;
  if (s >= 1) return setPose(out, p, target, "dash", mirrored);
  const x = Math.round(fromX + (target - fromX) * (1 - (1 - s) ** 2));
  return setPose(out, p, x, s < 0.12 ? "hopUp" : "dash", mirrored, LEAP_LIFT_CELLS * 4 * s * (1 - s), true);
}

// ── home activities ─────────────────────────────────────────────────────────────────────────────────

export type PracticeForm = "kata" | "shuriken" | "staff";
export type HomeActivityKind = PracticeForm | "meditate" | "breathe" | "season";
export interface HomeActivity { kind: HomeActivityKind; ms: number }
export const HOME_MIN_MS = 20_000;
export const HOME_MAX_MS = 45_000;
/** One pass of each form's beat list in mascot.ts WORK_LOOPS (a test pins these to the loops). */
export const PRACTICE_LOOP_MS: Record<PracticeForm, number> = { kata: 2320, shuriken: 1740, staff: 1240 };
const PRACTICE_REPS: Record<PracticeForm, number> = { kata: 1, shuriken: 2, staff: 2 };
/** A still, breathing hold after every set: practice is gentle, not a workout. */
const PRACTICE_HOLD_MS = 4000;
const PRACTICE_FORMS: readonly PracticeForm[] = ["kata", "shuriken", "staff"];
const HOME_CALM = ["practice", "meditate", "breathe"] as const;
/** After an activity, the chance a live season's act plays next. */
export const SEASON_ACT_CHANCE = 0.3;
/** A seasonal act starts this long into its slot and the slot lingers this long after it ends. */
const ACT_LEAD_MS = 300;
const ACT_TAIL_MS = 700;

/** One practice set: the form's loop played `reps` times, then the hold. */
export function practiceSetMs(form: PracticeForm): number {
  return PRACTICE_LOOP_MS[form] * PRACTICE_REPS[form] + PRACTICE_HOLD_MS;
}

const pick = <T>(xs: readonly T[], r: number): T => xs[Math.min(xs.length - 1, Math.floor(Math.max(0, r) * xs.length))]!;

/** PURE: what he does next at home, from an injected random source. Practice, meditation and plain breathing
 *  take turns (never the same one twice running) for 20 to 45 s; practice is cut to whole sets, so it always
 *  ends on a still hold. While a season is live (`seasonActMs` > 0) its act sometimes plays in between. */
export function nextHomeActivity(rand: () => number, prev: HomeActivityKind | null, seasonActMs = 0): HomeActivity {
  if (seasonActMs > 0 && prev !== null && prev !== "season" && rand() < SEASON_ACT_CHANCE) return { kind: "season", ms: ACT_LEAD_MS + seasonActMs + ACT_TAIL_MS };
  const prevCalm = prev === null || prev === "season" ? null : prev === "meditate" || prev === "breathe" ? prev : "practice";
  const calm = pick(HOME_CALM.filter((c) => c !== prevCalm), rand());
  const want = HOME_MIN_MS + rand() * (HOME_MAX_MS - HOME_MIN_MS);
  if (calm !== "practice") return { kind: calm, ms: Math.round(want) };
  const form = pick(PRACTICE_FORMS, rand());
  const set = practiceSetMs(form);
  const sets = Math.min(Math.floor(HOME_MAX_MS / set), Math.max(Math.ceil(HOME_MIN_MS / set), Math.round(want / set)));
  return { kind: form, ms: sets * set };
}

/** What a home activity shows `t` ms in: a standing frame, the seated meditation (breathing, now and then a
 *  glance up), or a seasonal act (`actT` >= 0 is the act's own time). */
export interface HomeLook { seated: boolean; frame: string; breathe: boolean; lookUp: boolean; actT: number }
const MEDITATE_BREATH_MS = 3200;
const MEDITATE_GLANCE_EVERY_MS = 9000;
const MEDITATE_GLANCE_MS = 1000;

/** PURE. Reduced motion holds one still picture per activity and skips the act. */
export function homeLook(a: HomeActivity, t: number, reduced: boolean, actMs: number, out: HomeLook = { seated: false, frame: "idleA", breathe: false, lookUp: false, actT: -1 }): HomeLook {
  const tt = Math.max(0, t);
  out.seated = false; out.frame = "idleA"; out.breathe = false; out.lookUp = false; out.actT = -1;
  if (a.kind === "meditate") {
    out.seated = true;
    if (!reduced) {
      out.breathe = tt % MEDITATE_BREATH_MS >= MEDITATE_BREATH_MS / 2;
      out.lookUp = tt % MEDITATE_GLANCE_EVERY_MS >= MEDITATE_GLANCE_EVERY_MS - MEDITATE_GLANCE_MS;
    }
  } else if (a.kind === "breathe") {
    // An unknown activity name plays the idle loop: breathing, a shift of weight, a blink.
    if (!reduced) out.frame = mascotActivityFrame("idle", tt);
  } else if (a.kind === "season") {
    if (!reduced && actMs > 0 && tt >= ACT_LEAD_MS && tt < ACT_LEAD_MS + actMs) out.actT = tt - ACT_LEAD_MS;
  } else if (reduced) {
    out.frame = "guard";
  } else {
    const u = tt % practiceSetMs(a.kind);
    const play = PRACTICE_LOOP_MS[a.kind] * PRACTICE_REPS[a.kind];
    out.frame = u < play ? mascotActivityFrame(a.kind, u) : mascotActivityFrame("idle", u - play);
  }
  return out;
}

// ── the brain: where he is and what he is doing ────────────────────────────────────────────────────

export type RunnerMode = "home" | "traverse" | "dash" | "away" | "return" | "gone";
export interface RunnerBrain {
  mode: RunnerMode;
  /** ms spent in `mode` (drives the traverse, dash, away and return timelines). */
  modeT: number;
  activity: HomeActivity;
  activityT: number;
  /** Idle time at home left before the next traverse is due. */
  untilTraverse: number;
  /** The end of the bar a dash went off (and a return comes in from): -1 left, 1 right. */
  side: -1 | 1;
  /** Where the dash took off, device px. */
  fromX: number;
}
/** What the brain reads each step. */
export interface RunnerWorld {
  /** A session state other than idle (working, speaking, listening, the victory beat). */
  busy: boolean;
  reduced: boolean;
  visitor: boolean;
  /** Length of the live season's act, 0 when no season is live. */
  actMs: number;
  rand: () => number;
  plan: RunnerPlan;
}
export const TRAVERSE_MIN_MS = 240_000;
export const TRAVERSE_MAX_MS = 360_000;
/** A resident sent off by a double-click walks back in after this long. */
export const AWAY_MS = 90_000;

/** About five minutes, jittered so he never feels like a clock. */
export function traverseDelay(rand: () => number): number {
  return TRAVERSE_MIN_MS + rand() * (TRAVERSE_MAX_MS - TRAVERSE_MIN_MS);
}

export function createRunnerBrain(rand: () => number, seasonActMs = 0): RunnerBrain {
  return { mode: "home", modeT: 0, activity: nextHomeActivity(rand, null, seasonActMs), activityT: 0, untilTraverse: traverseDelay(rand), side: -1, fromX: 0 };
}

function goHome(b: RunnerBrain, w: RunnerWorld): void {
  b.mode = "home"; b.modeT = 0;
  b.activity = nextHomeActivity(w.rand, b.activity.kind, w.actMs); b.activityT = 0;
}
function leave(b: RunnerBrain, w: RunnerWorld): "dismiss" | null {
  b.modeT = 0;
  if (w.visitor) { b.mode = "gone"; return "dismiss"; }
  b.mode = "away";
  return null;
}

/** PURE step. Returns "dismiss" exactly once: when a visitor's dash has carried him off. Home time (the
 *  activity and the traverse clock) only runs while the session is idle; a traverse that is due waits for the
 *  current activity to finish, so he never springs up mid-meditation. */
export function stepRunnerBrain(b: RunnerBrain, dt: number, w: RunnerWorld): "dismiss" | null {
  const d = Math.max(0, dt);
  switch (b.mode) {
    case "home": {
      if (w.busy) return null;
      b.activityT += d;
      b.untilTraverse -= d;
      if (b.activityT < b.activity.ms) return null;
      if (b.untilTraverse <= 0) {
        b.untilTraverse = traverseDelay(w.rand);
        // Reduced motion, or a bar too short to walk: he stays home and the clock starts over.
        if (!w.reduced && w.plan.beats * MASCOT_RUN_SWEEP_CELLS >= MIN_TRAVERSE_CELLS) { b.mode = "traverse"; b.modeT = 0; return null; }
      }
      b.activity = nextHomeActivity(w.rand, b.activity.kind, w.actMs);
      b.activityT = 0;
      return null;
    }
    case "traverse":
      b.modeT += d;
      if (w.busy) b.modeT = traverseTurnBack(b.modeT, w.plan);
      if (b.modeT >= w.plan.traverseMs) goHome(b, w);
      return null;
    case "dash":
      b.modeT += d;
      return b.modeT >= DASH_MS ? leave(b, w) : null;
    case "away":
      b.modeT += d;
      if (b.modeT >= AWAY_MS) {
        if (w.reduced) goHome(b, w);
        else { b.mode = "return"; b.modeT = 0; }
      }
      return null;
    case "return":
      b.modeT += d;
      if (b.modeT >= returnBeats(w.plan, b.side) * MASCOT_RUN_BEAT_MS) goHome(b, w);
      return null;
    default:
      return null;
  }
}

/** PURE: a double-click or double tap sends him off the bar's `dir` end from `fromX`. Only while he is on the
 *  bar. Reduced motion skips the dash: he simply leaves (a visitor's "dismiss" is returned at once). */
export function startDash(b: RunnerBrain, dir: -1 | 1, fromX: number, w: RunnerWorld): "dismiss" | null {
  if (b.mode !== "home" && b.mode !== "traverse" && b.mode !== "return") return null;
  b.side = dir; b.fromX = fromX;
  if (w.reduced) return leave(b, w);
  b.mode = "dash"; b.modeT = 0;
  return null;
}

// ── gestures ───────────────────────────────────────────────────────────────────────────────────────

export type RunnerGesture = "click" | "dblclick" | "tap" | "contextmenu";
export type GestureAction = "none" | "greet" | "dash" | "off";
/** Two touch or pen taps this close together are a double tap. */
export const DOUBLE_TAP_MS = 350;
export interface GestureMemory { lastTapAt: number; off: boolean }

/** PURE: a click greets him, a double-click (or two taps within DOUBLE_TAP_MS) sends him off, a right-click
 *  turns him off, once; after that nothing reaches him. A tap's own click still greets; the dash supersedes it. */
export function runnerGesture(m: GestureMemory, g: RunnerGesture, now: number): GestureAction {
  if (m.off) return "none";
  switch (g) {
    case "contextmenu": m.off = true; return "off";
    case "dblclick": return "dash";
    case "click": return "greet";
    case "tap":
      if (now - m.lastTapAt <= DOUBLE_TAP_MS) { m.lastTapAt = -Infinity; return "dash"; }
      m.lastTapAt = now;
      return "none";
  }
}

// ── hover hop and the click greeting ───────────────────────────────────────────────────────────────

export type RunnerReactionKind = "hop" | "greet";
export interface RunnerReactionBeat {
  frame: string;
  /** Height above the bar, in cells (positive = up). */
  lift: number;
}
const HOP = { crouch: 90, air: 300, land: 110, wave: 0 } as const;
const GREET = { crouch: 90, air: 340, land: 110, wave: 520 } as const;
const STILL_MS = { hop: 420, greet: 650 } as const;
const HOP_COOLDOWN_MS = 1200;
/** Full length of each reaction; reduced motion plays a short still pose instead of any jump. */
export function runnerReactionMs(kind: RunnerReactionKind, reduced: boolean): number {
  if (reduced) return STILL_MS[kind];
  const b = kind === "hop" ? HOP : GREET;
  return b.crouch + b.air + b.land + b.wave;
}

/** PURE reaction timeline, in place. Hop: anticipation crouch, a parabolic rise and fall, a squash landing.
 *  Greet: a higher hop, then a wave. */
export function runnerReaction(kind: RunnerReactionKind, t: number, reduced: boolean, out: RunnerReactionBeat = { frame: "guard", lift: 0 }): RunnerReactionBeat {
  const tt = Math.max(0, t);
  out.lift = 0;
  if (reduced) { out.frame = kind === "hop" ? "guard" : "victoryA"; return out; }
  const b = kind === "hop" ? HOP : GREET;
  if (tt < b.crouch) { out.frame = "crouch"; return out; }
  const s = (tt - b.crouch) / b.air;
  if (s < 1) {
    out.lift = (kind === "hop" ? HOP_LIFT_CELLS : GREET_LIFT_CELLS) * 4 * s * (1 - s);
    out.frame = s < 0.5 ? "hopUp" : "hopFall";
    return out;
  }
  const landed = tt - b.crouch - b.air;
  if (landed < b.land * 0.6) out.frame = "crouch";
  else if (landed < b.land || kind === "hop") out.frame = "guard";
  else out.frame = landed - b.land < b.wave / 2 ? "victoryA" : "victoryB";
  return out;
}

// ── the mount ──────────────────────────────────────────────────────────────────────────────────────

export interface RunnerHandle {
  setSuspended(suspended: boolean): void;
  /** Redraw at another size in place: the canvas and the hit box are re-measured, nothing is remounted. */
  setSize(size: MascotSize): void;
  dispose(): void;
}

/** P-MINI.1 (ADR-0580), P-MINI.3 (ADR-0596). `workPose: "typing"` seats him at a keyboard while a turn runs, in
 *  place of the standing activity loop. `size` (default "small") is the cell size. A double-click sends him
 *  off: a resident (the default) walks back in after a while; a `visitor` does not come back, `onDismiss` is
 *  called once instead. A right-click stops him at once and calls `onTurnOff` once. In both cases the owner
 *  disposes the runner. */
export interface RunnerOptions { workPose?: "activity" | "typing"; size?: MascotSize; visitor?: boolean; onDismiss?: () => void; onTurnOff?: () => void }

/** The wrap's and the input row's rects as one comparable string. */
function barGeometryKey(wr: DOMRect, rr: DOMRect | undefined): string {
  return `${wr.left},${wr.top},${wr.width},${wr.height}|${rr ? `${rr.left},${rr.top},${rr.width},${rr.height}` : "-"}`;
}

const HIT_LABEL = "Lucid: double-click to send him off, right-click to turn him off";
/** Seated meditation rows by breathe/glance: four pictures, built once. */
const seatCache = new Map<string, string[]>();
function seatRows(breathe: boolean, lookUp: boolean): string[] {
  const key = `${breathe ? 1 : 0}${lookUp ? 1 : 0}`;
  let rows = seatCache.get(key);
  if (!rows) { rows = sceneRows("idle", 0, { breathe, lookUp }); seatCache.set(key, rows); }
  return rows;
}

/** The canvas is pointer-transparent. Its separate button is clipped to the visible sprite ABOVE
 * the prompt, and uses native Enter/Space activation without a global keyboard handler. */
export function mountComposerRunner(wrap: HTMLElement, getState: () => MascotInputs = idleState, opts: RunnerOptions = {}): RunnerHandle {
  let size: MascotSize = opts.size ?? "small";
  let headroom = 0;
  const cv = document.createElement("canvas");
  cv.setAttribute("aria-hidden", "true");
  const hit = document.createElement("button");
  hit.type = "button";
  hit.className = "composer-mascot-hit";
  // Geometry is INLINE, not from the stylesheet: an in-flow hit box would resize the composer on
  // every frame, which retriggers the resize observer, which resets the canvas bitmap, which leaves
  // the ninja invisible. The class only carries appearance and the focus ring.
  hit.style.cssText = "position:absolute;padding:0;border:0;background:transparent";
  hit.setAttribute("aria-label", HIT_LABEL);
  hit.dataset.tip = HIT_LABEL; // P-TIP.1 (ADR-0599): premium tooltip, not a native title
  wrap.append(cv, hit);
  const ctx = cv.getContext("2d");
  const mirroredFrames: Record<string, string[]> = Object.fromEntries(Object.entries(MASCOT_FRAMES).map(([id, frame]) => [id, mirrorFrame(frame)]));
  const l: RunnerLayout = { width: 1, barTop: 1, height: 1, scale: 1 };
  let plan = runnerPlan(l);
  const pose = newRunnerPose();
  const ghost = newRunnerPose();
  const beat: RunnerReactionBeat = { frame: "guard", lift: 0 };
  const look: HomeLook = { seated: false, frame: "idleA", breathe: false, lookUp: false, actT: -1 };
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  let season: SeasonId | null = null;
  let seasonAttr: string | undefined;
  let base: Record<string, string> | null = null;
  let palette: Record<string, string> = themedMascotPalette();
  let ghostPalettes: Record<string, string>[] = [];
  // Afterimages are composed opaque on their own layer, then laid down with ONE alpha: overlapping
  // ghosts stay clean bands instead of compounding into a muddy smear.
  const trail = document.createElement("canvas");
  const trailCtx = trail.getContext("2d");
  const world: RunnerWorld = { busy: false, reduced: false, visitor: opts.visitor === true, actMs: 0, rand: Math.random, plan };
  const brain = createRunnerBrain(Math.random);
  const gestures: GestureMemory = { lastTapAt: -Infinity, off: false };
  let snap: MascotSnap | null = null;
  let dpr = 1;
  let raf = 0;
  let disposed = false;
  let suspended = false;
  let gone = false; // P-MINI.3: dismissed (a visitor's dash) or turned off; he never draws again
  let lastTime = performance.now();
  let reaction: RunnerReactionKind | null = null;
  let reactionStart = 0;
  let reactionUntil = 0;
  let reactionReduced = false;
  let greetQueued = false;
  let hopCooldownUntil = 0;
  let typingSince = -1; // P-MINI.1: when the current typing spell began, -1 while he is not typing
  let standX = 0; // where he stands now, device px: a dash takes off from here
  let barRow: HTMLElement | null = null; // the input row being measured and observed
  let barKey = ""; // the wrap and row rects at the last measure
  let barCheckAt = 0;
  let lastKey = "";
  const events = new AbortController();
  const options = { signal: events.signal };
  const reduced = (): boolean => reducedMotion?.matches ?? false;

  /** One theme read and one attribute read per tick; work happens only when either actually changes. */
  function readLook(): void {
    const b = themedMascotPalette();
    const attr = document.documentElement.dataset.season;
    if (b === base && attr === seasonAttr) return;
    base = b;
    if (attr !== seasonAttr) {
      seasonAttr = attr;
      season = seasonById(attr)?.id ?? null;
      world.actMs = season ? seasonActMs(season) : 0;
      // A season act queued for a season that just ended has nothing to play: move on.
      if (!season && brain.activity.kind === "season") { brain.activity = nextHomeActivity(Math.random, "season", 0); brain.activityT = 0; }
    }
    palette = season ? seasonPalette(season, b) : b;
    // Afterimages are flat silhouettes in the costume's accent: the newest lifted most of the way to
    // white, older ones closer to the raw accent, so the trail fades into the costume color.
    const accent = parseInt((palette.G ?? b.G ?? "#41ff8b").slice(1), 16);
    ghostPalettes = [0.75, 0.45, 0.15].map((w) => {
      const pale = (c: number): number => Math.round(c + (255 - c) * w);
      const glow = `rgb(${pale((accent >> 16) & 255)},${pale((accent >> 8) & 255)},${pale(accent & 255)})`;
      return Object.fromEntries(Object.keys(palette).map((k) => [k, glow]));
    });
    lastKey = "";
  }
  function measure(): void {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const room = runnerHeadroom(MASCOT_CELL_CSS[size]);
    if (room !== headroom) {
      headroom = room;
      cv.style.cssText = `position:absolute;left:0;right:0;top:${-headroom}px;height:calc(100% + ${headroom}px);pointer-events:none;z-index:3`;
    }
    l.width = Math.max(1, Math.floor(wrap.clientWidth * dpr));
    l.height = Math.max(1, Math.floor((wrap.clientHeight + headroom) * dpr));
    // The visible bar is the input row inside the wrap (the wrap's own top edge is padding he would float
    // above). Offsets are into the wrap's padding box, which the absolutely placed canvas spans.
    // The input box itself, so home is its right corner and not the lower, narrower send button beside it.
    const row = wrap.querySelector<HTMLElement>(".composer-row > .composer") ?? wrap.querySelector<HTMLElement>(".composer-row");
    // The app may rebuild the row: watch whichever row is current, so its resizes re-measure too.
    if (row !== barRow) {
      if (barRow) observer.unobserve(barRow);
      if (row) observer.observe(row);
      barRow = row;
    }
    const rr = row?.getBoundingClientRect();
    const wr = wrap.getBoundingClientRect();
    barKey = barGeometryKey(wr, rr);
    if (rr && rr.width > 0 && rr.height > 0) {
      // Rects are in VISUAL pixels, which an app zoom (CSS zoom on an ancestor) scales; the canvas bitmap is
      // sized from clientWidth, in the wrap's own LAYOUT pixels. Convert, or he drifts past the bar's end by
      // the zoom factor.
      const k = wr.width > 0 ? wrap.offsetWidth / wr.width : 1;
      const ox = wr.left + wrap.clientLeft / k, oy = wr.top + wrap.clientTop / k;
      l.barTop = Math.round((headroom + Math.max(0, rr.top - oy) * k) * dpr);
      l.barLeft = Math.round(Math.max(0, rr.left - ox) * k * dpr);
      l.barRight = Math.round((rr.right - ox) * k * dpr);
    } else {
      l.barTop = Math.round(headroom * dpr);
      l.barLeft = 0;
      l.barRight = l.width;
    }
    l.scale = runnerCellPx(size, dpr);
    const old = plan;
    plan = runnerPlan(l);
    world.plan = plan;
    // A walk in progress keeps its share of the way when the bar or his size changes under him.
    if (brain.mode === "traverse") brain.modeT = (brain.modeT / old.traverseMs) * plan.traverseMs;
    else if (brain.mode === "return") brain.modeT = (brain.modeT / returnBeats(old, brain.side)) * returnBeats(plan, brain.side);
    else if (brain.mode === "dash" && old.width > 0) brain.fromX = Math.round((brain.fromX / old.width) * plan.width);
    // Assigning width/height resets the bitmap even when the value is unchanged, so a repeated
    // measure would erase the sprite. Only resize when the size actually moved.
    if (cv.width !== l.width || cv.height !== l.height) { cv.width = l.width; cv.height = l.height; trail.width = l.width; trail.height = l.height; }
    lastKey = "";
  }
  /** Device-px box to the hit button, in the wrap's CSS px. */
  function placeHit(x: number, y: number, w: number, h: number): void {
    hit.hidden = w <= 0 || h <= 0;
    hit.style.left = `${x / dpr}px`;
    hit.style.top = `${y / dpr - headroom}px`;
    hit.style.width = `${w / dpr}px`;
    hit.style.height = `${h / dpr}px`;
  }
  function stop(): void {
    gone = true;
    cancelAnimationFrame(raf); raf = 0;
    if (document.activeElement === hit) hit.blur();
    cv.hidden = true;
    hit.hidden = true;
  }
  function react(kind: RunnerReactionKind): void {
    if (suspended || disposed || gone) return;
    if (brain.mode !== "home" && brain.mode !== "traverse" && brain.mode !== "return") return;
    // A turn's pose wins: no hop off the keyboard or mid-sentence.
    if (snap && snap.state !== "idle") return;
    const now = performance.now();
    if (now < reactionUntil) {
      // A click lands while the hover hop is still in the air (the usual mouse path): greet the moment he
      // touches down instead of yanking him out of the hop.
      if (kind === "greet" && reaction === "hop") greetQueued = true;
      return;
    }
    // The hop lifts the hit box out from under a resting cursor and lands it back, which re-fires
    // pointerenter: without a cooldown he would bounce for as long as the pointer sits still.
    if (kind === "hop" && now < hopCooldownUntil) return;
    reaction = kind;
    reactionReduced = reduced();
    reactionStart = now;
    reactionUntil = now + runnerReactionMs(kind, reactionReduced);
    hopCooldownUntil = reactionUntil + HOP_COOLDOWN_MS;
    lastKey = "";
  }
  function dash(clientX: number): void {
    if (suspended || disposed || gone) return;
    const rect = wrap.getBoundingClientRect();
    world.reduced = reduced();
    const k = rect.width > 0 ? wrap.offsetWidth / rect.width : 1; // visual to layout pixels, as in measure()
    const dismissed = startDash(brain, dashDirection((clientX - rect.left) * k * dpr, l.width), standX, world) === "dismiss";
    reaction = null; reactionUntil = 0; greetQueued = false;
    lastKey = "";
    if (dismissed) { stop(); opts.onDismiss?.(); }
  }
  hit.addEventListener("pointerenter", () => react("hop"), options);
  hit.addEventListener("focus", () => react("hop"), options);
  hit.addEventListener("click", () => { if (runnerGesture(gestures, "click", performance.now()) === "greet") react("greet"); }, options);
  hit.addEventListener("dblclick", (e) => { if (runnerGesture(gestures, "dblclick", performance.now()) === "dash") dash(e.clientX); }, options);
  // Touch and pen: a double tap rarely becomes a dblclick, so two quick taps are counted here.
  hit.addEventListener("pointerup", (e) => {
    if (e.pointerType !== "mouse" && runnerGesture(gestures, "tap", performance.now()) === "dash") dash(e.clientX);
  }, options);
  hit.addEventListener("contextmenu", (e) => {
    // Both: the app's own right-click menu must never open over him.
    e.preventDefault();
    e.stopPropagation();
    if (runnerGesture(gestures, "contextmenu", performance.now()) === "off") { stop(); opts.onTurnOff?.(); }
  }, options);

  function tick(now: number): void {
    raf = 0;
    if (disposed || suspended || gone || document.hidden || !ctx) return;
    const dt = Math.min(50, now - lastTime);
    lastTime = now;
    // The centered input row can shift with nothing for a ResizeObserver to report (or be rebuilt by the
    // app), so twice a second the two rects are compared and a change re-measures.
    if (now - barCheckAt >= 500) {
      barCheckAt = now;
      if (barGeometryKey(wrap.getBoundingClientRect(), barRow?.isConnected ? barRow.getBoundingClientRect() : undefined) !== barKey) measure();
    }
    readLook();
    snap = stepMascot(snap, getState(), now);
    if (reaction && now >= reactionUntil) {
      reaction = null; reactionUntil = 0;
      if (greetQueued) { greetQueued = false; react("greet"); }
    }
    const busy = snap.state !== "idle";
    world.busy = busy;
    world.reduced = reduced();
    // He holds still while greeting and while his button has keyboard focus, so the focus ring stays put.
    const hold = reaction !== null || (document.activeElement === hit && brain.mode !== "dash");
    if (stepRunnerBrain(brain, hold ? 0 : dt, world) === "dismiss") { stop(); opts.onDismiss?.(); return; }
    if (brain.mode === "away") {
      if (lastKey !== "away") { lastKey = "away"; ctx.clearRect(0, 0, l.width, l.height); hit.hidden = true; }
      raf = requestAnimationFrame(tick);
      return;
    }
    const typing = opts.workPose === "typing" && snap.state === "working";
    if (typing && typingSince < 0) typingSince = now;
    else if (!typing) typingSince = -1;
    let rows: readonly string[] | null = null;
    let rowsKey = "";
    let act: SeasonActFrame | null = null;
    let ghosts = false;
    if (brain.mode === "traverse") traverseAt(brain.modeT, plan, pose);
    else if (brain.mode === "return") returnAt(brain.modeT, plan, brain.side, pose);
    else if (brain.mode === "dash") { dashAt(brain.modeT, plan, brain.fromX, brain.side, pose); ghosts = pose.airborne; }
    else {
      setPose(pose, plan, plan.homeX, "idleA", true);
      if (typing) {
        // Seated at the keyboard. Its own paint: the scene is a composed grid, not a MASCOT_FRAMES id, and a
        // holiday costume is cut for the standing figure (the season's palette still applies).
        const elapsed = world.reduced ? 0 : now - typingSince;
        rows = typingRows(elapsed);
        rowsKey = `t${Math.floor(elapsed / TYPING_BEAT_MS)}`;
      } else if (busy) {
        pose.frame = mascotFrame(snap, now);
      } else {
        homeLook(brain.activity, brain.activityT, world.reduced, world.actMs, look);
        if (look.seated) {
          rows = seatRows(look.breathe, look.lookUp);
          rowsKey = `m${look.breathe ? 1 : 0}${look.lookUp ? 1 : 0}`;
        } else if (look.actT >= 0 && season) {
          act = seasonActAt(season, look.actT);
          pose.frame = act.frame in MASCOT_FRAMES ? act.frame : "idleA";
          pose.mirrored = pose.mirrored !== act.mirrored;
          pose.lift = act.lift;
        } else pose.frame = look.frame;
      }
    }
    if (reaction && !busy && brain.mode !== "dash") {
      // A hop or greeting stands him up wherever he is, seated or mid-act.
      runnerReaction(reaction, now - reactionStart, reactionReduced, beat);
      rows = null; act = null;
      pose.frame = beat.frame;
      pose.lift = beat.lift;
    }
    // Feet on the bar for whatever frame he ended up in. A seasonal act keeps the idle stance's box (set at
    // home above): its frames and props are choreographed against one ground line.
    if (!act) pose.y = standTop(plan, pose.frame);
    standX = pose.x;
    if (rows) {
      const box = homeSeatBox(l, plan, rows);
      const key = `${rowsKey}|${box.x}|${box.y}`;
      if (key !== lastKey) {
        lastKey = key;
        ctx.clearRect(0, 0, l.width, l.height);
        paintRows(ctx, rows, l.scale, box.x, box.y, palette);
        placeHit(box.x, box.y, box.w, l.barTop - box.y);
      }
      raf = requestAnimationFrame(tick);
      return;
    }
    const px = Math.round(pose.x), py = Math.round(pose.y - pose.lift * l.scale);
    let key = `${pose.frame}|${px}|${py}|${pose.mirrored ? 1 : 0}`;
    if (act) for (const p of act.props) key += `|${p.sprite}@${p.x},${p.y}`;
    if (ghosts) key += `|g${Math.round(now)}`;
    if (key !== lastKey) {
      lastKey = key;
      ctx.clearRect(0, 0, l.width, l.height);
      ctx.save();
      // He is always on the bar top: nothing he paints (a dropping prop, a ghost) may cover the input.
      ctx.beginPath(); ctx.rect(0, 0, l.width, l.barTop); ctx.clip();
      if (ghosts && trailCtx) {
        // Afterimages: the same timeline sampled 70/140/210 ms earlier. Newest first, each one only
        // fills what newer ghosts left empty (destination-over), so where they overlap the newest wins.
        // A ghost almost on top of the body or of the newer ghost is skipped.
        trailCtx.clearRect(0, 0, trail.width, trail.height);
        trailCtx.globalCompositeOperation = "destination-over";
        let lastGx = px, lastGy = py;
        for (let i = 1; i <= 3; i++) {
          dashAt(brain.modeT - i * 70, plan, brain.fromX, brain.side, ghost);
          if (!ghost.airborne) break;
          const gx = Math.round(ghost.x), gy = Math.round(ghost.y - ghost.lift * l.scale);
          if (Math.abs(gx - lastGx) + Math.abs(gy - lastGy) < 8 * l.scale) continue;
          lastGx = gx; lastGy = gy;
          paintRows(trailCtx, (ghost.mirrored ? mirroredFrames : MASCOT_FRAMES)[ghost.frame]!, l.scale, gx, gy, ghostPalettes[i - 1]!);
        }
        trailCtx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = 0.5;
        ctx.drawImage(trail, 0, 0);
        ctx.globalAlpha = 1;
      }
      paintRows(ctx, (pose.mirrored ? mirroredFrames : MASCOT_FRAMES)[pose.frame]!, l.scale, px, py, palette);
      // An act lifts its own costume and keeps its props ground-relative, so it takes the UNLIFTED box;
      // a hop (act = null) carries the costume up with the body.
      if (season) paintSeasonExtras(ctx, season, act, pose.frame, pose.mirrored, l.scale, px, act ? Math.round(pose.y) : py);
      ctx.restore();
      if (brain.mode === "dash") hit.hidden = true; // no second gesture lands on him mid-dash
      else {
        // Never intercept the input band.
        const left = Math.max(0, px), top = Math.max(0, py);
        placeHit(left, top, Math.min(l.width, px + MASCOT_W * l.scale) - left, Math.min(l.barTop, py + MASCOT_H * l.scale) - top);
      }
    }
    raf = requestAnimationFrame(tick);
  }
  function schedule(): void {
    lastTime = performance.now();
    if (!raf && !disposed && !suspended && !gone && !document.hidden && ctx) raf = requestAnimationFrame(tick);
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
      if (disposed || gone || suspended === value) return;
      suspended = value;
      cv.hidden = value;
      hit.hidden = true;
      lastKey = "";
      if (value) { cancelAnimationFrame(raf); raf = 0; if (document.activeElement === hit) hit.blur(); }
      else schedule();
    },
    setSize(next) {
      if (disposed || next === size) return;
      size = next;
      measure();
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
