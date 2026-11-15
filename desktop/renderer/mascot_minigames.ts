// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Three self-contained local mini games for the agent arcade. Same discipline as mascot_game.ts:
// the engines are pure (no DOM, no clock, no Math.random), determinism comes from an integer seed
// carried inside the state, and every painter is nearest-neighbor fillRect at integer scale.

import { MASCOT_H, MASCOT_THEMES, MASCOT_W, paintFrame } from './mascot.ts';
import type { ArcadeScorePort } from './mascot_game.ts';
import { MASCOT_CELL_CSS, type MascotSize } from './mini_lucid.ts';

export interface MiniGameHandle {
  /** Toggle Start/Pause/Resume, or restart a finished run. */
  start(): void;
  /** Pause and release input; keeps the last frame painted. */
  stop(): void;
  /** P-MINI.3 (ADR-0596): resize the ninja live. The run keeps going; nothing restarts. */
  setMascotSize(size: MascotSize): void;
  /** Tear down listeners, rAF and DOM. Idempotent. */
  dispose(): void;
}

export interface MiniGameToolbar {
  start: HTMLButtonElement;
  score: HTMLOutputElement;
  total: HTMLOutputElement;
  /** The cabinet includes the shared toolbar in the focus boundary. */
  cabinet: HTMLElement;
}

export interface MiniGameDef {
  id: 'shuriken' | 'kata' | 'stack';
  name: string;
  blurb: string;
  /** `size` is the ninja size the game opens with (default "small"). */
  mount(host: HTMLElement, toolbar: MiniGameToolbar, scorePort?: ArcadeScorePort, size?: MascotSize): MiniGameHandle;
}

const CANVAS_HEIGHT = 180;
/** The floor every mini game stands the ninja on, in canvas pixels from the top. */
export const MINI_FLOOR_Y = 172;
const MIN_WIDTH = 260;

/** P-MINI.3 (ADR-0596): CSS pixels per sprite cell. Large is the classic 2; small is mini Lucid's 1. Every
 *  sprite-relative length in these games is a multiple of this one value. */
export function miniSpriteScale(size: MascotSize): number {
  return MASCOT_CELL_CSS[size] ?? MASCOT_CELL_CSS.small;
}

/** Where each game paints its ninja, in canvas pixels: feet on MINI_FLOOR_Y at either size. */
export function miniSpriteRect(game: MiniGameDef['id'], width: number, size: MascotSize): { x: number; y: number; w: number; h: number } {
  const scale = miniSpriteScale(size);
  const w = MASCOT_W * scale;
  const h = MASCOT_H * scale;
  const x = game === 'shuriken' ? 2 : game === 'kata' ? Math.round(clampWidth(width) / 2 - w / 2) : 0;
  return { x, y: MINI_FLOOR_Y - h, w, h };
}

/** Longest slice fed to an engine in one call, and the fixed substep inside it. Identical to the
 *  arcade: a stalled tab must not tunnel a shuriken straight through a target. */
const MAX_SLICE_MS = 100;
const SUBSTEP_MS = 16;

/** The same LCG the arcade uses. Seeds are unsigned 32 bit and live inside the state. */
function nextSeed(seed: number): number {
  return (Math.imul(seed, 1664525) + 1013904223) >>> 0;
}

function clampWidth(width: number): number {
  return Math.max(MIN_WIDTH, Number.isFinite(width) ? Math.floor(width) : 640);
}

// ---------------------------------------------------------------------------------------------
// 1. Shuriken range
// ---------------------------------------------------------------------------------------------

export type ShurikenAction = 'lane-up' | 'lane-down' | 'throw';

export interface ShurikenTarget {
  id: number;
  kind: 'target' | 'dummy';
  lane: number;
  x: number;
  width: number;
  speed: number;
  hit: boolean;
  popMs: number;
}

export interface ShurikenShot { id: number; lane: number; x: number; spent: boolean }

export interface ShurikenState {
  phase: 'playing' | 'over';
  width: number;
  elapsedMs: number;
  remainingMs: number;
  lane: number;
  score: number;
  /** Consecutive hits already banked. The NEXT hit is paid at shurikenMultiplier(combo). */
  combo: number;
  bestCombo: number;
  hits: number;
  misses: number;
  strikes: number;
  targets: ShurikenTarget[];
  shots: ShurikenShot[];
  spawnMs: number;
  cooldownMs: number;
  throwMs: number;
  flashMs: number;
  seed: number;
  nextId: number;
  /** P-MINI.3 (ADR-0596): the ninja size; launch point, lanes, marks and shots all derive from it. */
  size: MascotSize;
}

export const SHURIKEN_LANES = 3;
export const SHURIKEN_RUN_MS = 60000;
export const SHURIKEN_HIT_POINTS = 10;
export const SHURIKEN_DUMMY_PENALTY = 1;
export const SHURIKEN_MAX_MULTIPLIER = 5;
const SHURIKEN_SHOT_SPEED = 330;
const SHURIKEN_COOLDOWN_MS = 200;

export interface ShurikenGeometry {
  /** Where a throw leaves the hand: just past the sprite's right edge. */
  launchX: number;
  /** Lane centers, top to bottom, all inside the standing sprite's height so every throw is from the hand. */
  laneY: readonly number[];
  shotWidth: number;
  targetWidth: number;
  dummyWidth: number;
}

/** P-MINI.3 (ADR-0596): the whole range in sprite cells, times the one sprite scale. Large reproduces the
 *  classic numbers exactly (launch 84, lanes 84/112/140, shot 10, mark 22, dummy 20). Speeds stay in canvas
 *  pixels: the range is the panel's width, not the ninja's, and a hit depends only on sharing a lane, so a
 *  smaller ninja and smaller marks are exactly as hittable. */
export function shurikenGeometry(size: MascotSize): ShurikenGeometry {
  const s = miniSpriteScale(size);
  return {
    launchX: 4 + MASCOT_W * s,
    laneY: [MINI_FLOOR_Y - 44 * s, MINI_FLOOR_Y - 30 * s, MINI_FLOOR_Y - 16 * s],
    shotWidth: 5 * s, targetWidth: 11 * s, dummyWidth: 10 * s,
  };
}

/** Payout multiplier for the next hit, given the consecutive hits already banked. */
export function shurikenMultiplier(combo: number): number {
  return Math.min(SHURIKEN_MAX_MULTIPLIER, 1 + Math.max(0, Math.floor(combo)));
}

export function createShurikenState(width = 640, seed = 1, size: MascotSize = 'small'): ShurikenState {
  return {
    phase: 'playing', width: clampWidth(width), elapsedMs: 0, remainingMs: SHURIKEN_RUN_MS,
    lane: 1, score: 0, combo: 0, bestCombo: 0, hits: 0, misses: 0, strikes: 0,
    targets: [], shots: [], spawnMs: 500, cooldownMs: 0, throwMs: 0, flashMs: 0,
    seed: seed >>> 0, nextId: 0, size,
  };
}

/** P-MINI.3 (ADR-0596): a live size switch. Marks already on the range take the new size in place; shots
 *  read their width from the state, and lanes are drawn from it, so the run simply carries on. */
export function setShurikenMascotSize(state: ShurikenState, size: MascotSize): ShurikenState {
  if (state.size === size) return state;
  const g = shurikenGeometry(size);
  return {
    ...state, size,
    targets: state.targets.map(t => ({ ...t, width: t.kind === 'dummy' ? g.dummyWidth : g.targetWidth })),
  };
}

/** Edge triggered. Returns the same object when the action changes nothing, so a clamped lane
 *  press at the top or bottom rail is genuinely a no-op rather than a fresh identical state. */
export function applyShurikenInput(state: ShurikenState, action: ShurikenAction): ShurikenState {
  if (state.phase !== 'playing') return state;
  if (action === 'lane-up' || action === 'lane-down') {
    const lane = Math.max(0, Math.min(SHURIKEN_LANES - 1, state.lane + (action === 'lane-up' ? -1 : 1)));
    return lane === state.lane ? state : { ...state, lane };
  }
  if (state.cooldownMs > 0) return state;
  return {
    ...state,
    cooldownMs: SHURIKEN_COOLDOWN_MS,
    throwMs: 170,
    nextId: state.nextId + 1,
    shots: [...state.shots, { id: state.nextId, lane: state.lane, x: shurikenGeometry(state.size).launchX, spent: false }],
  };
}

// Mutates only the private copy made by stepShuriken.
function advanceShuriken(next: ShurikenState, dtMs: number): void {
  const dt = dtMs / 1000;
  next.elapsedMs += dtMs;
  next.remainingMs = Math.max(0, next.remainingMs - dtMs);
  next.cooldownMs = Math.max(0, next.cooldownMs - dtMs);
  next.throwMs = Math.max(0, next.throwMs - dtMs);
  next.flashMs = Math.max(0, next.flashMs - dtMs);
  for (const target of next.targets) {
    if (target.hit) target.popMs = Math.max(0, target.popMs - dtMs);
    else target.x -= target.speed * dt;
  }
  for (const shot of next.shots) {
    if (!shot.spent) shot.x += SHURIKEN_SHOT_SPEED * dt;
  }
  const geometry = shurikenGeometry(next.size);
  for (const shot of next.shots) {
    if (shot.spent) continue;
    for (const target of next.targets) {
      if (target.hit || target.lane !== shot.lane) continue;
      if (shot.x + geometry.shotWidth < target.x || shot.x > target.x + target.width) continue;
      shot.spent = true;
      target.hit = true;
      target.popMs = 220;
      next.flashMs = 150;
      if (target.kind === 'dummy') {
        // A straw dummy is a training partner, not a mark. Striking one costs a point and the streak.
        next.score = Math.max(0, next.score - SHURIKEN_DUMMY_PENALTY);
        next.combo = 0;
        next.strikes++;
      } else {
        next.score += SHURIKEN_HIT_POINTS * shurikenMultiplier(next.combo);
        next.combo++;
        next.hits++;
        if (next.combo > next.bestCombo) next.bestCombo = next.combo;
      }
      break;
    }
    if (!shot.spent && shot.x > next.width) {
      shot.spent = true;
      next.combo = 0;
      next.misses++;
    }
  }
  next.spawnMs -= dtMs;
  if (next.spawnMs <= 0 && next.remainingMs > 0) {
    const rolled = nextSeed(next.seed);
    next.seed = rolled;
    const kind = (rolled >>> 5) % 4 === 0 ? 'dummy' : 'target';
    next.targets.push({
      id: next.nextId++, kind, lane: rolled % SHURIKEN_LANES, x: next.width + 18,
      width: kind === 'dummy' ? geometry.dummyWidth : geometry.targetWidth, speed: 58 + ((rolled >>> 9) % 5) * 16,
      hit: false, popMs: 0,
    });
    next.spawnMs += 560 + (rolled >>> 13) % 460;
  }
  if (next.remainingMs <= 0) next.phase = 'over';
}

export function stepShuriken(state: ShurikenState, elapsedMs: number): ShurikenState {
  if (state.phase !== 'playing' || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return state;
  let remaining = Math.min(MAX_SLICE_MS, elapsedMs);
  const next: ShurikenState = {
    ...state,
    targets: state.targets.map(target => ({ ...target })),
    shots: state.shots.map(shot => ({ ...shot })),
  };
  while (remaining > 0) {
    const slice = Math.min(SUBSTEP_MS, remaining);
    advanceShuriken(next, slice);
    remaining -= slice;
  }
  next.targets = next.targets.filter(target => (target.hit ? target.popMs > 0 : target.x + target.width > -12));
  next.shots = next.shots.filter(shot => !shot.spent);
  return next;
}

// ---------------------------------------------------------------------------------------------
// 2. Kata memory
// ---------------------------------------------------------------------------------------------

export type KataPose = 'punch' | 'kick' | 'duck' | 'jump';
export const KATA_POSES: readonly KataPose[] = ['punch', 'kick', 'duck', 'jump'];

export interface KataState {
  /** demo: LUCID shows the kata. input: the player repeats it. clear: the round paid out. */
  phase: 'demo' | 'input' | 'clear' | 'over';
  round: number;
  sequence: KataPose[];
  /** Index into the sequence for whichever of demo or input is running. */
  cursor: number;
  beatMs: number;
  score: number;
  lastPose: KataPose | null;
  wrongPose: KataPose | null;
  flashMs: number;
  elapsedMs: number;
  seed: number;
  width: number;
  /** P-MINI.3 (ADR-0596): the ninja size. Only the painter reads it: a pose is judged, never measured. */
  size: MascotSize;
}

export const KATA_BEAT_MS = 520;
export const KATA_SHOW_MS = 340;
export const KATA_CLEAR_MS = 780;

function rollPose(seed: number): { seed: number; pose: KataPose } {
  const rolled = nextSeed(seed);
  return { seed: rolled, pose: KATA_POSES[(rolled >>> 7) % KATA_POSES.length]! };
}

/** Longer katas pay more PER POSE, not merely more in total: recalling six beats is far harder
 *  than recalling two, so a flat rate would make the long rounds the worst value in the game. */
export function kataPayout(length: number): number {
  const n = Math.max(0, Math.floor(length));
  return n * (n + 1) * 5;
}

export function createKataState(width = 640, seed = 1, size: MascotSize = 'small'): KataState {
  const first = rollPose(seed >>> 0);
  return {
    phase: 'demo', round: 1, sequence: [first.pose], cursor: 0, beatMs: KATA_BEAT_MS,
    score: 0, lastPose: null, wrongPose: null, flashMs: 0, elapsedMs: 0,
    seed: first.seed, width: clampWidth(width), size,
  };
}

/** Edge triggered. Poses outside the input phase are ignored, so a mash during the demo or during
 *  the payout pause can neither end the run nor index past the sequence. */
export function applyKataInput(state: KataState, pose: KataPose): KataState {
  if (state.phase !== 'input') return state;
  const expected = state.sequence[state.cursor];
  if (expected === undefined) return state;
  if (pose !== expected) {
    return { ...state, phase: 'over', lastPose: pose, wrongPose: pose, flashMs: 420 };
  }
  const cursor = state.cursor + 1;
  if (cursor < state.sequence.length) {
    return { ...state, cursor, lastPose: pose, flashMs: 180 };
  }
  return {
    ...state, phase: 'clear', cursor, lastPose: pose, flashMs: 320,
    beatMs: KATA_CLEAR_MS, score: state.score + kataPayout(state.sequence.length),
  };
}

export function stepKata(state: KataState, elapsedMs: number): KataState {
  if (state.phase === 'over' || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return state;
  let remaining = Math.min(MAX_SLICE_MS, elapsedMs);
  const next: KataState = { ...state, sequence: [...state.sequence] };
  while (remaining > 0) {
    const slice = Math.min(SUBSTEP_MS, remaining);
    remaining -= slice;
    next.elapsedMs += slice;
    next.flashMs = Math.max(0, next.flashMs - slice);
    if (next.phase === 'input') continue;
    next.beatMs -= slice;
    if (next.beatMs > 0) continue;
    if (next.phase === 'demo') {
      next.cursor++;
      next.beatMs = KATA_BEAT_MS;
      if (next.cursor >= next.sequence.length) {
        next.phase = 'input';
        next.cursor = 0;
        next.beatMs = 0;
        next.lastPose = null;
      }
      continue;
    }
    // clear: the kata grows by exactly one pose, then it is demonstrated again from the top.
    const grown = rollPose(next.seed);
    next.seed = grown.seed;
    next.sequence.push(grown.pose);
    next.round++;
    next.phase = 'demo';
    next.cursor = 0;
    next.beatMs = KATA_BEAT_MS;
    next.lastPose = null;
  }
  return next;
}

// ---------------------------------------------------------------------------------------------
// 3. Rooftop stack
// ---------------------------------------------------------------------------------------------

export interface StackBlock { x: number; width: number }

export interface StackState {
  phase: 'playing' | 'over';
  width: number;
  tower: StackBlock[];
  /** Placed crates above the foundation. This is the tower height shown to the player. */
  height: number;
  score: number;
  perfects: number;
  blockX: number;
  blockWidth: number;
  direction: 1 | -1;
  lastTrim: number;
  perfectMs: number;
  flashMs: number;
  elapsedMs: number;
  seed: number;
  /** P-MINI.3 (ADR-0596): the size of the watcher on the ledge. The crates are the tower's own geometry,
   *  sized to the panel and not to him, so the tower plays the same at either size. */
  size: MascotSize;
}

export const STACK_START_WIDTH = 96;
export const STACK_PERFECT_PX = 2;
export const STACK_PERFECT_GAIN = 4;
export const STACK_BLOCK_HEIGHT = 12;
export const STACK_HEIGHT_POINTS = 10;
export const STACK_PERFECT_BONUS = 15;

/** Pixels per second for the sliding crate. A wide panel gets a proportionally faster crate, so one
 *  sweep takes about the same time whatever the composer width happens to be. */
export function stackSpeed(height: number, width = 640): number {
  return Math.min(340, 92 + Math.max(0, height) * 13) * Math.max(1, clampWidth(width) / 420);
}

export function createStackState(width = 640, seed = 1, size: MascotSize = 'small'): StackState {
  const canvas = clampWidth(width);
  const baseX = Math.round((canvas - STACK_START_WIDTH) / 2);
  return {
    phase: 'playing', width: canvas, tower: [{ x: baseX, width: STACK_START_WIDTH }],
    height: 0, score: 0, perfects: 0, blockX: 0, blockWidth: STACK_START_WIDTH, direction: 1,
    lastTrim: 0, perfectMs: 0, flashMs: 0, elapsedMs: 0, seed: seed >>> 0, size,
  };
}

/** The watcher's ledge scales with him (76 classic), so a small ninja is not lost on a slab built for the
 *  big one, and at either size it ends well short of the narrowest tower's foundation. */
export function stackLedgeWidth(size: MascotSize): number {
  return 38 * miniSpriteScale(size);
}

/** Edge triggered drop. Overhang is trimmed away for good; a centered drop inside STACK_PERFECT_PX
 *  buys a little width back. Missing the tower outright ends the run. */
export function dropStackBlock(state: StackState): StackState {
  if (state.phase !== 'playing') return state;
  const base = state.tower[state.tower.length - 1]!;
  const left = Math.max(state.blockX, base.x);
  const right = Math.min(state.blockX + state.blockWidth, base.x + base.width);
  const overlap = right - left;
  if (overlap <= 0) {
    return { ...state, phase: 'over', lastTrim: state.blockWidth, flashMs: 520 };
  }
  const offset = Math.abs((state.blockX + state.blockWidth / 2) - (base.x + base.width / 2));
  const perfect = offset <= STACK_PERFECT_PX;
  const placedWidth = perfect
    ? Math.min(STACK_START_WIDTH, base.width + STACK_PERFECT_GAIN)
    : overlap;
  const placedX = perfect
    ? Math.max(0, Math.min(state.width - placedWidth, base.x - (placedWidth - base.width) / 2))
    : left;
  const height = state.height + 1;
  // Alternate the entry side so the tower cannot be farmed by holding one rhythm.
  const direction: 1 | -1 = height % 2 === 0 ? 1 : -1;
  const rolled = nextSeed(state.seed);
  return {
    ...state,
    tower: [...state.tower, { x: placedX, width: placedWidth }],
    height,
    score: state.score + STACK_HEIGHT_POINTS + (perfect ? STACK_PERFECT_BONUS : 0),
    perfects: state.perfects + (perfect ? 1 : 0),
    blockWidth: placedWidth,
    blockX: direction === 1 ? 0 : Math.max(0, state.width - placedWidth),
    direction,
    lastTrim: perfect ? 0 : state.blockWidth - overlap,
    perfectMs: perfect ? 420 : 0,
    flashMs: 200,
    seed: rolled,
  };
}

export function stepStack(state: StackState, elapsedMs: number): StackState {
  if (state.phase !== 'playing' || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return state;
  let remaining = Math.min(MAX_SLICE_MS, elapsedMs);
  const next: StackState = { ...state, tower: state.tower.map(block => ({ ...block })) };
  const travel = Math.max(0, next.width - next.blockWidth);
  while (remaining > 0) {
    const slice = Math.min(SUBSTEP_MS, remaining);
    remaining -= slice;
    next.elapsedMs += slice;
    next.flashMs = Math.max(0, next.flashMs - slice);
    next.perfectMs = Math.max(0, next.perfectMs - slice);
    let x = next.blockX + next.direction * stackSpeed(next.height, next.width) * (slice / 1000);
    if (x <= 0) { x = 0; next.direction = 1; }
    else if (x >= travel) { x = travel; next.direction = -1; }
    next.blockX = x;
  }
  return next;
}

// ---------------------------------------------------------------------------------------------
// Painters. Pure: state plus palette in, pixels out. Integer fillRect only.
// ---------------------------------------------------------------------------------------------

type Palette = Record<string, string>;

function fillBackdrop(ctx: CanvasRenderingContext2D, width: number, palette: Palette): void {
  ctx.fillStyle = palette.B!;
  ctx.fillRect(0, 0, width, CANVAS_HEIGHT);
}

function hudText(ctx: CanvasRenderingContext2D, palette: Palette, text: string, x: number, y: number, align: CanvasTextAlign = 'left'): void {
  ctx.fillStyle = palette.W!;
  ctx.font = '12px monospace';
  ctx.textAlign = align;
  ctx.fillText(text, Math.round(x), y);
}

/** The small-size mark (11 px) or straw dummy (10 px wide), the classic art at half size in whole pixels. */
function paintSmallMark(ctx: CanvasRenderingContext2D, palette: Palette, target: ShurikenTarget, x: number, y: number): void {
  if (target.kind === 'dummy') {
    ctx.fillStyle = palette.s!;
    ctx.fillRect(x + 2, y - 7, 6, 14);
    ctx.fillStyle = palette.S!;
    ctx.fillRect(x + 3, y - 6, 2, 12);
    ctx.fillStyle = palette.k!;
    ctx.fillRect(x + 1, y - 5, 8, 2);
    ctx.fillRect(x + 1, y + 3, 8, 2);
    ctx.fillStyle = palette.L!;
    ctx.fillRect(x + 4, y + 7, 2, 3);
    return;
  }
  if (target.hit) {
    ctx.fillStyle = palette.G!;
    const burst = Math.max(1, Math.round(target.popMs / 52));
    ctx.fillRect(x + 5 - burst, y, burst * 2 + 1, 1);
    ctx.fillRect(x + 5, y - burst, 1, burst * 2 + 1);
    return;
  }
  ctx.fillStyle = palette.k!;
  ctx.fillRect(x, y - 5, 11, 11);
  ctx.fillStyle = palette.M!;
  ctx.fillRect(x + 1, y - 4, 9, 9);
  ctx.fillStyle = palette.W!;
  ctx.fillRect(x + 2, y - 3, 7, 7);
  ctx.fillStyle = palette.k!;
  ctx.fillRect(x + 3, y - 2, 5, 5);
  ctx.fillStyle = palette.G!;
  ctx.fillRect(x + 4, y - 1, 3, 3);
}

export function paintShurikenRange(ctx: CanvasRenderingContext2D, state: ShurikenState, palette: Palette, playing: boolean): void {
  const width = state.width;
  fillBackdrop(ctx, width, palette);
  ctx.fillStyle = palette.D!;
  for (let x = 0; x < width; x += 56) ctx.fillRect(x + 4, 26, 48, CANVAS_HEIGHT - 44);
  ctx.fillStyle = palette.K!;
  for (let x = 0; x < width; x += 56) ctx.fillRect(x + 4, 26, 48, 4);
  const s = miniSpriteScale(state.size);
  const { launchX, laneY } = shurikenGeometry(state.size);
  // The classic art is hand-placed for scale 2; small gets its own half-size art rather than a
  // fractional scale, which would blur every edge (P-MINI.3 (ADR-0596)).
  const big = s >= 2;
  for (let lane = 0; lane < SHURIKEN_LANES; lane++) {
    const y = laneY[lane]!;
    ctx.fillStyle = lane === state.lane ? palette.g! : palette.L!;
    ctx.fillRect(launchX - 3 * s, y + Math.round(7.5 * s), width - launchX + 3 * s, s);
  }
  ctx.fillStyle = palette.g!;
  ctx.fillRect(0, MINI_FLOOR_Y, width, 2);
  for (const target of state.targets) {
    const x = Math.round(target.x);
    const y = laneY[target.lane] ?? laneY[1]!;
    if (!big) {
      paintSmallMark(ctx, palette, target, x, y);
      continue;
    }
    if (target.kind === 'dummy') {
      ctx.fillStyle = palette.s!;
      ctx.fillRect(x + 4, y - 14, 12, 28);
      ctx.fillStyle = palette.S!;
      ctx.fillRect(x + 6, y - 12, 4, 24);
      ctx.fillStyle = palette.k!;
      ctx.fillRect(x + 2, y - 10, 16, 3);
      ctx.fillRect(x + 2, y + 6, 16, 3);
      ctx.fillStyle = palette.L!;
      ctx.fillRect(x + 8, y + 14, 4, 6);
      continue;
    }
    if (target.hit) {
      ctx.fillStyle = palette.G!;
      const burst = Math.max(2, Math.round(target.popMs / 26));
      ctx.fillRect(x + 11 - burst, y - 2, burst * 2, 3);
      ctx.fillRect(x + 10, y - 1 - burst, 3, burst * 2);
      continue;
    }
    // Concentric rings, painted largest first: outline, steel, white, neon center.
    ctx.fillStyle = palette.k!;
    ctx.fillRect(x, y - 11, 22, 22);
    ctx.fillStyle = palette.M!;
    ctx.fillRect(x + 1, y - 10, 20, 20);
    ctx.fillStyle = palette.k!;
    ctx.fillRect(x + 3, y - 8, 16, 16);
    ctx.fillStyle = palette.W!;
    ctx.fillRect(x + 5, y - 6, 12, 12);
    ctx.fillStyle = palette.k!;
    ctx.fillRect(x + 7, y - 4, 8, 8);
    ctx.fillStyle = palette.G!;
    ctx.fillRect(x + 9, y - 2, 4, 4);
  }
  ctx.fillStyle = palette.M!;
  for (const shot of state.shots) {
    const x = Math.round(shot.x);
    const y = laneY[shot.lane] ?? laneY[1]!;
    const spin = Math.floor(state.elapsedMs / 45) % 2 === 0;
    if (!big) {
      // A five-pixel star: upright cross, then a block with the hub hole.
      if (spin) {
        ctx.fillRect(x, y, 5, 1);
        ctx.fillRect(x + 2, y - 2, 1, 5);
      } else {
        ctx.fillRect(x + 1, y - 1, 3, 3);
        ctx.fillStyle = palette.k!;
        ctx.fillRect(x + 2, y, 1, 1);
        ctx.fillStyle = palette.M!;
      }
    } else if (spin) {
      ctx.fillRect(x, y - 2, 10, 4);
      ctx.fillRect(x + 3, y - 5, 4, 10);
    } else {
      ctx.fillRect(x + 1, y - 4, 8, 8);
      ctx.fillStyle = palette.k!;
      ctx.fillRect(x + 4, y - 1, 2, 2);
      ctx.fillStyle = palette.M!;
    }
  }
  const frame = state.throwMs > 90 ? 'punchB' : state.throwMs > 0 ? 'punchD' : playing ? 'guard' : 'idleA';
  const sprite = miniSpriteRect('shuriken', width, state.size);
  paintFrame(ctx, frame, s, sprite.x, sprite.y, palette);
  ctx.fillStyle = palette.G!;
  const aimY = laneY[state.lane]!;
  if (big) {
    ctx.fillRect(launchX - 8, aimY - 1, 6, 3);
    ctx.fillRect(launchX - 4, aimY - 4, 3, 9);
  } else {
    ctx.fillRect(launchX - 4, aimY, 3, 1);
    ctx.fillRect(launchX - 3, aimY - 2, 1, 5);
  }
  hudText(ctx, palette, `${Math.ceil(state.remainingMs / 1000)}s`, 6, 18);
  hudText(ctx, palette, `Run ${state.score}`, Math.round(width / 2), 18, 'center');
  hudText(ctx, palette, `x${shurikenMultiplier(state.combo)}`, width - 6, 18, 'right');
  if (!playing) {
    hudText(ctx, palette, state.phase === 'over'
      ? `Range closed. ${state.hits} hits, best streak ${state.bestCombo}.`
      : 'Paused. Resume to keep throwing.', Math.round(width / 2), CANVAS_HEIGHT - 8, 'center');
  }
}

const KATA_FRAMES: Record<KataPose, string> = { punch: 'punchB', kick: 'kickC', duck: 'sneakA', jump: 'fall' };

export function paintKataFloor(ctx: CanvasRenderingContext2D, state: KataState, palette: Palette, playing: boolean): void {
  const width = state.width;
  fillBackdrop(ctx, width, palette);
  ctx.fillStyle = palette.D!;
  ctx.fillRect(0, 40, width, CANVAS_HEIGHT - 40);
  ctx.fillStyle = palette.K!;
  for (let x = 0; x < width; x += 48) ctx.fillRect(x + 2, 44, 44, CANVAS_HEIGHT - 50);
  ctx.fillStyle = palette.g!;
  ctx.fillRect(0, MINI_FLOOR_Y, width, 2);
  // Progress pips: one square per pose, never wrapping prose.
  const count = state.sequence.length;
  const pitch = 10;
  const originX = Math.max(4, Math.round((width - count * pitch) / 2));
  const showing = state.phase === 'demo' && state.beatMs > KATA_BEAT_MS - KATA_SHOW_MS;
  for (let i = 0; i < count; i++) {
    const x = originX + i * pitch;
    if (x + 8 > width) break;
    const lit = state.phase === 'demo' ? (showing ? i === state.cursor : false) : i < state.cursor;
    ctx.fillStyle = lit ? palette.G! : palette.L!;
    ctx.fillRect(x, 10, 8, 8);
    ctx.fillStyle = palette.k!;
    ctx.fillRect(x + 2, 12, 4, 4);
  }
  const pose = state.phase === 'demo' && showing ? state.sequence[state.cursor] ?? null : state.lastPose;
  const frame = state.phase === 'over' ? 'land' : pose ? KATA_FRAMES[pose] : 'guard';
  const sprite = miniSpriteRect('kata', width, state.size);
  paintFrame(ctx, frame, miniSpriteScale(state.size), sprite.x, sprite.y, palette);
  if (state.flashMs > 0) {
    ctx.fillStyle = state.phase === 'over' ? palette.s! : palette.G!;
    ctx.fillRect(0, 26, width, 2);
  }
  hudText(ctx, palette, `Round ${state.round}`, 6, 34);
  hudText(ctx, palette, `Run ${state.score}`, width - 6, 34, 'right');
  const banner = state.phase === 'demo' ? 'Watch' : state.phase === 'input' ? `Repeat ${state.cursor + 1} of ${count}`
    : state.phase === 'clear' ? `Kata clean. +${kataPayout(count)}` : 'Broken form. Start for a new kata.';
  hudText(ctx, palette, playing || state.phase === 'over' ? banner : 'Paused. Resume to continue.', Math.round(width / 2), CANVAS_HEIGHT - 8, 'center');
}

export function paintStackTower(ctx: CanvasRenderingContext2D, state: StackState, palette: Palette, playing: boolean): void {
  const width = state.width;
  fillBackdrop(ctx, width, palette);
  ctx.fillStyle = palette.D!;
  for (let i = 0; i < 26; i++) {
    const x = (i * 97) % Math.max(1, width - 3);
    const y = 6 + (i * 53) % 120;
    ctx.fillRect(x, y, 2, 2);
  }
  // The ledge and its watcher are fixed furniture on the left, so the camera lift never moves them.
  const ledge = stackLedgeWidth(state.size);
  ctx.fillStyle = palette.K!;
  ctx.fillRect(0, MINI_FLOOR_Y, ledge, CANVAS_HEIGHT - MINI_FLOOR_Y);
  ctx.fillStyle = palette.L!;
  ctx.fillRect(0, MINI_FLOOR_Y - 2, ledge, 2);
  const sprite = miniSpriteRect('stack', width, state.size);
  paintFrame(ctx, playing ? 'guard' : 'idleA', miniSpriteScale(state.size), sprite.x, sprite.y, palette);
  const lift = Math.max(0, state.tower.length * STACK_BLOCK_HEIGHT - 108);
  const rowY = (index: number): number => MINI_FLOOR_Y - (index + 1) * STACK_BLOCK_HEIGHT + lift;
  for (let i = 0; i < state.tower.length; i++) {
    const block = state.tower[i]!;
    const y = rowY(i);
    if (y > CANVAS_HEIGHT || y + STACK_BLOCK_HEIGHT < 0) continue;
    const x = Math.round(block.x);
    const w = Math.max(1, Math.round(block.width));
    // Same dojo crate wood as the arcade course: dark outline, warm body, banded top and bottom.
    ctx.fillStyle = palette.k!;
    ctx.fillRect(x, y, w, STACK_BLOCK_HEIGHT);
    ctx.fillStyle = palette.s!;
    ctx.fillRect(x + 1, y + 1, Math.max(1, w - 2), STACK_BLOCK_HEIGHT - 2);
    ctx.fillStyle = palette.S!;
    ctx.fillRect(x + 2, y + 2, Math.max(1, w - 4), 2);
    ctx.fillRect(x + 2, y + STACK_BLOCK_HEIGHT - 4, Math.max(1, w - 4), 2);
    ctx.fillStyle = palette.D!;
    ctx.fillRect(x + 2, y + 5, Math.max(1, w - 4), 1);
    for (let n = 2; n + 2 < w; n += 8) ctx.fillRect(x + n, y + 6, 2, 3);
  }
  const sliderY = Math.max(2, rowY(state.tower.length) - 6);
  const sliderX = Math.round(state.blockX);
  const sliderW = Math.max(1, Math.round(state.blockWidth));
  if (state.phase === 'playing') {
    ctx.fillStyle = palette.g!;
    ctx.fillRect(sliderX, sliderY, sliderW, STACK_BLOCK_HEIGHT);
    ctx.fillStyle = palette.G!;
    ctx.fillRect(sliderX, sliderY, sliderW, 2);
    ctx.fillRect(sliderX + Math.floor(sliderW / 2) - 1, sliderY + 4, 2, 5);
    // Drop guide: a dotted plumb line straight down from the crate center.
    const guideX = sliderX + Math.floor(sliderW / 2);
    for (let y = sliderY + STACK_BLOCK_HEIGHT + 2; y < rowY(state.tower.length - 1); y += 6) {
      ctx.fillRect(guideX, y, 1, 3);
    }
  }
  if (state.perfectMs > 0) {
    ctx.fillStyle = palette.G!;
    ctx.fillRect(0, rowY(state.tower.length - 1) - 2, width, 1);
  }
  hudText(ctx, palette, `Height ${state.height}`, ledge + 6, 18);
  hudText(ctx, palette, `Run ${state.score}`, Math.round(width / 2) + 30, 18, 'center');
  hudText(ctx, palette, `${Math.round(state.blockWidth)}px`, width - 6, 18, 'right');
  if (state.phase === 'over') {
    hudText(ctx, palette, `Tower down at ${state.height}. Start to rebuild.`, Math.round(width / 2), CANVAS_HEIGHT - 8, 'center');
  } else if (!playing) {
    hudText(ctx, palette, 'Paused. Resume to drop.', Math.round(width / 2), CANVAS_HEIGHT - 8, 'center');
  }
}

// ---------------------------------------------------------------------------------------------
// Shared DOM shell. One implementation, three specs.
// ---------------------------------------------------------------------------------------------

interface MiniButton { action: string; label: string; aria: string }

interface MiniGameSpec<S> {
  id: MiniGameDef['id'];
  name: string;
  blurb: string;
  ariaLabel: string;
  readyText: string;
  buttons: readonly MiniButton[];
  keyAction(event: KeyboardEvent): string | null;
  create(width: number, seed: number, size: MascotSize): S;
  resize(state: S, width: number): S;
  /** P-MINI.3 (ADR-0596): the live size switch, applied to a run in progress without restarting it. */
  withSize(state: S, size: MascotSize): S;
  step(state: S, elapsedMs: number): S;
  input(state: S, action: string): S;
  paint(ctx: CanvasRenderingContext2D, state: S, palette: Palette, playing: boolean): void;
  over(state: S): boolean;
  points(state: S): number;
  readout(state: S): string;
  overText(state: S): string;
}

let runCounter = 0;

function mountMiniGame<S>(host: HTMLElement, toolbar: MiniGameToolbar, scorePort: ArcadeScorePort | undefined, spec: MiniGameSpec<S>, initialSize: MascotSize = 'small'): MiniGameHandle {
  const root = document.createElement('section');
  root.className = `mini-game mini-game-${spec.id}`;
  root.setAttribute('aria-label', spec.name);
  root.innerHTML = `
    <canvas class="mini-game-canvas" tabindex="0" aria-label="${spec.ariaLabel}"></canvas>
    <div class="mini-game-controls" role="group" aria-label="${spec.name} controls">
      ${spec.buttons.map(button => `<button type="button" data-action="${button.action}" aria-label="${button.aria}">${button.label}</button>`).join('')}
      <span class="mini-game-status" role="status">Local only. Nothing leaves this machine.</span>
    </div>
    <p class="mini-game-help">${spec.blurb}</p>`;
  host.appendChild(root);

  const canvas = root.querySelector<HTMLCanvasElement>('canvas')!;
  const { start: startButton, score: scoreOutput, total: totalOutput } = toolbar;
  scoreOutput.setAttribute('aria-label', `${spec.name} run readout`);
  const status = root.querySelector<HTMLElement>('.mini-game-status')!;
  const controls = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-action]'));
  const context = canvas.getContext('2d');
  const events = new AbortController();
  const listenerOptions = { signal: events.signal };
  const palette = MASCOT_THEMES.lucid.palette;

  let width = MIN_WIDTH;
  let size = initialSize;
  let state = spec.create(width, 1, size);
  let playing = false;
  let started = false;
  let disposed = false;
  let awarded = false;
  let raf = 0;
  let resizeRaf = 0;
  let lastTime = 0;
  let dpr = 1;
  let sessionTotal = 0;
  let lastReadout = '';
  let lastTotal = -1;

  function measure(): number {
    const style = getComputedStyle(root);
    const padding = (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
    return clampWidth(root.clientWidth - padding);
  }

  function paint(): void {
    if (!context || disposed || root.hidden || host.hidden) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.imageSmoothingEnabled = false;
    spec.paint(context, state, palette, playing);
    const readout = spec.readout(state);
    if (readout !== lastReadout) {
      scoreOutput.textContent = readout;
      lastReadout = readout;
    }
    const total = scorePort ? scorePort.total() : sessionTotal;
    if (total !== lastTotal) {
      totalOutput.textContent = `Total ${total}`;
      lastTotal = total;
    }
  }

  function resize(): void {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = 0;
    if (disposed || root.hidden || host.hidden) return;
    const next = measure();
    dpr = Math.min(2, Math.max(1, Math.ceil(window.devicePixelRatio || 1)));
    const pixelWidth = next * dpr;
    const pixelHeight = CANVAS_HEIGHT * dpr;
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    if (next !== width) {
      width = next;
      state = spec.resize(state, width);
    }
    paint();
  }

  function halt(): void {
    playing = false;
    cancelAnimationFrame(raf);
    raf = 0;
    lastTime = 0;
    for (const button of controls) button.disabled = true;
  }

  function pause(): void {
    if (!playing) return;
    halt();
    startButton.textContent = 'Resume';
    status.textContent = 'Paused. Resume when ready.';
    paint();
  }

  function finish(): void {
    halt();
    if (!awarded) {
      awarded = true;
      const points = Math.max(0, Math.round(spec.points(state)));
      if (points > 0) {
        if (scorePort) scorePort.award(points);
        else sessionTotal += points;
      }
    }
    startButton.textContent = 'Restart';
    status.textContent = spec.overText(state);
    paint();
  }

  function tick(time: number): void {
    raf = 0;
    if (!playing || disposed || document.hidden || root.hidden || host.hidden) { pause(); return; }
    state = spec.step(state, lastTime ? time - lastTime : 0);
    lastTime = time;
    if (spec.over(state)) { finish(); return; }
    paint();
    raf = requestAnimationFrame(tick);
  }

  function begin(): void {
    if (disposed || !context || document.hidden) return;
    halt();
    width = measure();
    state = spec.create(width, (Math.imul(Date.now() >>> 0, 2246822519) + ++runCounter) >>> 0, size);
    started = true;
    awarded = false;
    playing = true;
    lastTime = 0;
    lastReadout = '';
    startButton.textContent = 'Pause';
    status.textContent = spec.readyText;
    for (const button of controls) button.disabled = false;
    canvas.focus({ preventScroll: true });
    resize();
    raf = requestAnimationFrame(tick);
  }

  function resume(): void {
    if (disposed || !context || document.hidden || playing) return;
    if (!started || spec.over(state)) { begin(); return; }
    playing = true;
    lastTime = 0;
    startButton.textContent = 'Pause';
    status.textContent = spec.readyText;
    for (const button of controls) button.disabled = false;
    canvas.focus({ preventScroll: true });
    raf = requestAnimationFrame(tick);
  }

  function act(action: string): void {
    if (!playing || disposed) return;
    state = spec.input(state, action);
    if (spec.over(state)) { finish(); return; }
    paint();
  }

  for (const button of controls) {
    button.addEventListener('click', () => {
      act(button.dataset.action ?? '');
      if (playing) canvas.focus({ preventScroll: true });
    }, listenerOptions);
  }
  canvas.addEventListener('keydown', event => {
    if (!playing || disposed || document.activeElement !== canvas) return;
    const action = spec.keyAction(event);
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    act(action);
  }, listenerOptions);
  toolbar.cabinet.addEventListener('focusout', event => {
    if (!(event.relatedTarget instanceof Node) || !toolbar.cabinet.contains(event.relatedTarget)) pause();
  }, listenerOptions);
  window.addEventListener('blur', pause, listenerOptions);
  document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); }, listenerOptions);
  const observer = new ResizeObserver(() => {
    if (!disposed && !root.hidden && !host.hidden && !resizeRaf) resizeRaf = requestAnimationFrame(resize);
  });
  observer.observe(root);
  if (!context) {
    startButton.disabled = true;
    status.textContent = 'Canvas is unavailable in this window.';
  }
  for (const button of controls) button.disabled = true;
  resize();

  return {
    start() { if (playing) pause(); else resume(); },
    stop() {
      if (disposed || !playing) return;
      pause();
    },
    setMascotSize(next) {
      if (disposed || next === size) return;
      size = next;
      state = spec.withSize(state, size);
      paint();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const active = document.activeElement;
      if (active instanceof HTMLElement && root.contains(active)) active.blur();
      halt();
      cancelAnimationFrame(resizeRaf);
      resizeRaf = 0;
      events.abort();
      observer.disconnect();
      root.remove();
    },
  };
}

const SHURIKEN_SPEC: MiniGameSpec<ShurikenState> = {
  id: 'shuriken',
  name: 'Shuriken range',
  blurb: 'Pick a lane with Up or Down, throw with Ctrl or Space, and keep the streak alive for sixty seconds; straw dummies cost a point.',
  ariaLabel: 'Shuriken range. Up and Down choose a lane, Control or Space throws. Sixty second run.',
  readyText: 'Sixty seconds. Chain hits for a bigger multiplier.',
  buttons: [
    { action: 'lane-up', label: 'Lane up', aria: 'Move aim one lane up' },
    { action: 'lane-down', label: 'Lane down', aria: 'Move aim one lane down' },
    { action: 'throw', label: 'Throw', aria: 'Throw a shuriken' },
  ],
  keyAction(event) {
    switch (event.key) {
      case 'ArrowUp': return 'lane-up';
      case 'ArrowDown': return 'lane-down';
      case 'Control': case ' ': case 'Spacebar': return 'throw';
      default: return null;
    }
  },
  create: createShurikenState,
  resize: (state, width) => ({ ...state, width: clampWidth(width) }),
  withSize: setShurikenMascotSize,
  step: stepShuriken,
  input: (state, action) => applyShurikenInput(state, action as ShurikenAction),
  paint: paintShurikenRange,
  over: state => state.phase === 'over',
  points: state => state.score,
  readout: state => `${Math.ceil(state.remainingMs / 1000)}s · Run ${state.score} · Streak ${state.combo}`,
  overText: state => `Range closed. Score ${state.score}, best streak ${state.bestCombo}.`,
};

const KATA_SPEC: MiniGameSpec<KataState> = {
  id: 'kata',
  name: 'Kata memory',
  blurb: 'Watch LUCID demonstrate the kata, then repeat it with the arrows or Ctrl; one wrong pose ends the run.',
  ariaLabel: 'Kata memory. Control punches, Right kicks, Down ducks, Up jumps. Repeat the demonstrated sequence.',
  readyText: 'Watch the kata, then repeat it exactly.',
  buttons: [
    { action: 'punch', label: 'Punch', aria: 'Repeat a punch' },
    { action: 'kick', label: 'Kick', aria: 'Repeat a kick' },
    { action: 'duck', label: 'Duck', aria: 'Repeat a duck' },
    { action: 'jump', label: 'Jump', aria: 'Repeat a jump' },
  ],
  keyAction(event) {
    switch (event.key) {
      case 'Control': case 'ArrowLeft': return 'punch';
      case 'ArrowRight': return 'kick';
      case 'ArrowDown': return 'duck';
      case 'ArrowUp': return 'jump';
      default: return null;
    }
  },
  create: createKataState,
  resize: (state, width) => ({ ...state, width: clampWidth(width) }),
  withSize: (state, size) => (state.size === size ? state : { ...state, size }),
  step: stepKata,
  input: (state, action) => (KATA_POSES.includes(action as KataPose) ? applyKataInput(state, action as KataPose) : state),
  paint: paintKataFloor,
  over: state => state.phase === 'over',
  points: state => state.score,
  readout: state => `Round ${state.round} · Run ${state.score} · Pose ${Math.min(state.cursor + 1, state.sequence.length)} of ${state.sequence.length}`,
  overText: state => `Broken form on round ${state.round}. Score ${state.score}.`,
};

const STACK_SPEC: MiniGameSpec<StackState> = {
  id: 'stack',
  name: 'Rooftop stack',
  blurb: 'Drop each dojo crate with Space or Ctrl; overhang is trimmed away for good, and a perfect center pays a bonus and hands some width back.',
  ariaLabel: 'Rooftop stack. Space or Control drops the sliding crate onto the tower.',
  readyText: 'Drop the crate when it lines up with the tower.',
  buttons: [{ action: 'drop', label: 'Drop', aria: 'Drop the sliding crate' }],
  keyAction(event) {
    switch (event.key) {
      case 'Control': case ' ': case 'Spacebar': case 'ArrowDown': return 'drop';
      default: return null;
    }
  },
  create: createStackState,
  resize: (state, width) => {
    const next = clampWidth(width);
    return { ...state, width: next, blockX: Math.max(0, Math.min(next - state.blockWidth, state.blockX)) };
  },
  withSize: (state, size) => (state.size === size ? state : { ...state, size }),
  step: stepStack,
  input: (state, action) => (action === 'drop' ? dropStackBlock(state) : state),
  paint: paintStackTower,
  over: state => state.phase === 'over',
  points: state => state.score,
  readout: state => `Height ${state.height} · Run ${state.score} · Width ${Math.round(state.blockWidth)}`,
  overText: state => `Tower down at height ${state.height}. Score ${state.score}.`,
};

export const MINI_GAMES: readonly MiniGameDef[] = [
  {
    id: SHURIKEN_SPEC.id, name: SHURIKEN_SPEC.name, blurb: SHURIKEN_SPEC.blurb,
    mount: (host, toolbar, scorePort, size) => mountMiniGame(host, toolbar, scorePort, SHURIKEN_SPEC, size),
  },
  {
    id: KATA_SPEC.id, name: KATA_SPEC.name, blurb: KATA_SPEC.blurb,
    mount: (host, toolbar, scorePort, size) => mountMiniGame(host, toolbar, scorePort, KATA_SPEC, size),
  },
  {
    id: STACK_SPEC.id, name: STACK_SPEC.name, blurb: STACK_SPEC.blurb,
    mount: (host, toolbar, scorePort, size) => mountMiniGame(host, toolbar, scorePort, STACK_SPEC, size),
  },
];
