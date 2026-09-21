// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { MASCOT_H, MASCOT_RUN_FRAMES, MASCOT_THEMES, MASCOT_W, paintFrame } from './mascot.ts';
import { MINI_GAMES, type MiniGameHandle } from './mascot_minigames.ts';

export type ArcadeAction = 'left' | 'right' | 'duck' | 'jump' | 'punch' | 'kick' | 'aim-up';
export interface ArcadeDebris { x: number; y: number; vx: number; vy: number; lifeMs: number; color: 'pot' | 'leaf' }
export interface ArcadeBonus {
  remainingMs: number;
  aimX: number;
  aimY: number;
  flyX: number;
  flyY: number;
  caught: number;
  pinchMs: number;
  cooldownMs: number;
  up: boolean;
}
export interface ArcadeObstacle {
  id: number;
  kind: 'crate' | 'beam' | 'target' | 'star' | 'pot';
  x: number;
  width: number;
  height: number;
  bottom: number;
  handled: boolean;
}
export interface ArcadeState {
  phase: 'playing' | 'lost';
  width: number;
  elapsedMs: number;
  score: number;
  level: number;
  hearts: number;
  x: number;
  jumpY: number;
  velocityY: number;
  /** The surface the feet are standing on: 0 is the floor, otherwise the top of the crate underfoot.
   *  Crates are solid, so a jump that clears one lands ON it instead of falling through. */
  groundY: number;
  invulnerableMs: number;
  attack: 'punch' | 'kick' | null;
  attackMs: number;
  cooldownMs: number;
  held: { left: boolean; right: boolean; duck: boolean };
  obstacles: ArcadeObstacle[];
  spawnMs: number;
  seed: number;
  nextId: number;
  mode: 'runner' | 'flycatch';
  clears: number;
  nextBonusAt: number;
  bonus: ArcadeBonus | null;
  debris: ArcadeDebris[];
}

/** Pure engine: distances are CSS pixels, vertical coordinates rise from the floor. */
export function createArcadeState(width = 640, seed = 1): ArcadeState {
  return {
    phase: 'playing', width: Math.max(260, Number.isFinite(width) ? width : 640),
    elapsedMs: 0, score: 0, level: 1, hearts: 3, x: 40, jumpY: 0, velocityY: 0, groundY: 0,
    invulnerableMs: 0, attack: null, attackMs: 0, cooldownMs: 0,
    held: { left: false, right: false, duck: false }, obstacles: [],
    spawnMs: 700, seed: seed >>> 0, nextId: 0,
    mode: 'runner', clears: 0, nextBonusAt: 5, bonus: null, debris: [],
  };
}

/** Returns a new state only when input changes it. Jump and attacks are edge-triggered. */
export function applyArcadeInput(state: ArcadeState, action: ArcadeAction, pressed: boolean): ArcadeState {
  if (state.phase !== 'playing') return state;
  if (state.mode === 'flycatch' && state.bonus) {
    if (action === 'aim-up') return { ...state, bonus: { ...state.bonus, up: pressed } };
    if (pressed && (action === 'punch' || action === 'kick' || action === 'jump') && state.bonus.cooldownMs === 0) {
      const bonus = { ...state.bonus, pinchMs: 230, cooldownMs: 400 };
      const caught = Math.hypot(bonus.aimX - bonus.flyX, bonus.aimY - bonus.flyY) <= 25;
      if (caught) {
        bonus.caught++;
        bonus.flyX = 40 + ((state.seed + bonus.caught * 137) % Math.max(1, state.width - 80));
        bonus.flyY = 36 + ((state.seed + bonus.caught * 53) % 80);
      }
      return { ...state, bonus, score: state.score + (caught ? 50 : 0) };
    }
  }
  if (action === 'aim-up') return state;
  if (action === 'left' || action === 'right' || action === 'duck') {
    return state.held[action] === pressed ? state : { ...state, held: { ...state.held, [action]: pressed } };
  }
  if (!pressed || state.mode === 'flycatch') return state;
  if (action === 'jump') {
    // Grounded means standing on whatever is underfoot, floor or crate - not only y === 0.
    const grounded = state.velocityY === 0 && state.jumpY <= (state.groundY ?? 0);
    return grounded && !state.held.duck ? { ...state, velocityY: 350, jumpY: state.jumpY + 0.01 } : state;
  }
  if (state.cooldownMs > 0) return state;
  return { ...state, attack: action, attackMs: action === 'kick' ? 330 : 230, cooldownMs: 480 };
}

export function arcadeSpeed(level: number): number {
  return Math.min(250, 110 + Math.max(0, level - 1) * 14);
}

const OBSTACLE_KINDS = ['crate', 'beam', 'pot', 'star', 'target'] as const;

/** Seconds that must separate two hazards ARRIVING at the runner. Distinct reactions (a duck, then a
 *  jump, then a strike) need about this long apiece; below it the course stops being readable. */
const MIN_ARRIVAL_GAP_S = 0.95;

export function arcadeScale(width: number): number {
  return width >= 560 ? 2 : 1;
}

// Mutates only the private copy made by stepArcade, not a caller-owned state.
function advance(next: ArcadeState, dtMs: number): void {
  const dt = dtMs / 1000;
  next.elapsedMs += dtMs;
  if (next.mode === 'flycatch' && next.bonus) {
    const bonus = next.bonus;
    bonus.remainingMs = Math.max(0, bonus.remainingMs - dtMs);
    bonus.pinchMs = Math.max(0, bonus.pinchMs - dtMs);
    bonus.cooldownMs = Math.max(0, bonus.cooldownMs - dtMs);
    bonus.aimX = Math.max(22, Math.min(next.width - 22, bonus.aimX + (Number(next.held.right) - Number(next.held.left)) * 210 * dt));
    bonus.aimY = Math.max(24, Math.min(150, bonus.aimY + (Number(next.held.duck) - Number(bonus.up)) * 160 * dt));
    bonus.flyX = Math.max(24, Math.min(next.width - 24, bonus.flyX + Math.sin(next.elapsedMs / 470 + next.seed % 9) * 95 * dt));
    bonus.flyY = Math.max(28, Math.min(145, bonus.flyY + Math.cos(next.elapsedMs / 310 + bonus.caught) * 72 * dt));
    next.level = 1 + Math.floor(next.score / 100);
    if (!bonus.remainingMs) {
      next.mode = 'runner';
      next.bonus = null;
      next.obstacles = [];
      next.spawnMs = 1100;
      next.invulnerableMs = 1100;
      next.held = { left: false, right: false, duck: false };
    }
    return;
  }
  const scale = arcadeScale(next.width);
  for (const chip of next.debris) {
    chip.lifeMs -= dtMs;
    chip.x += chip.vx * dt;
    chip.y += chip.vy * dt;
    chip.vy -= 550 * dt;
  }
  next.invulnerableMs = Math.max(0, next.invulnerableMs - dtMs);
  next.attackMs = Math.max(0, next.attackMs - dtMs);
  next.cooldownMs = Math.max(0, next.cooldownMs - dtMs);
  next.spawnMs -= dtMs;
  if (!next.attackMs) next.attack = null;
  next.x = Math.max(8, Math.min(Math.min(next.width * 0.45, next.width - 150),
    next.x + (Number(next.held.right) - Number(next.held.left)) * 150 * dt));
  // Hazards move BEFORE the vertical solve, so the crate a falling runner lands on is the crate that
  // is actually under his feet this substep rather than the one from the previous frame.
  const speed = arcadeSpeed(next.level);
  const movement = speed * dt;
  for (const obstacle of next.obstacles) obstacle.x -= movement * (obstacle.kind === 'star' ? 1.7 : 1);
  const left = next.x + 10 * scale;
  const right = next.x + 30 * scale;
  // Crates are solid ground from above. Support counts only crates the feet were already at or above,
  // so walking INTO a crate's side is still a hit and never a free teleport onto its lid.
  const previousBottom = next.jumpY;
  let support = 0;
  for (const obstacle of next.obstacles) {
    if (obstacle.kind !== 'crate' || obstacle.x >= right || obstacle.x + obstacle.width <= left) continue;
    const lid = obstacle.bottom + obstacle.height;
    if (previousBottom >= lid - 1 && lid > support) support = lid;
  }
  if (next.jumpY > support || next.velocityY !== 0) {
    next.jumpY = next.jumpY + next.velocityY * dt - 550 * dt * dt;
    next.velocityY -= 1100 * dt;
    // A descent that crosses the lid lands on it: the crossing test needs no fudge factor, so a fast
    // fall cannot tunnel through and a slow one cannot snap up from below.
    if (next.velocityY <= 0 && next.jumpY <= support && previousBottom >= support) {
      next.jumpY = support;
      next.velocityY = 0;
    }
    if (next.jumpY <= 0) { next.jumpY = 0; next.velocityY = 0; }
  }
  next.groundY = support;
  const bottom = next.jumpY;
  const grounded = next.velocityY === 0 && bottom <= support;
  const top = bottom + (next.held.duck && grounded ? 24 : 44) * scale;
  if (next.spawnMs <= 0) {
    // The roll is PREVIEWED, not committed: a deferred hazard keeps its kind and simply launches
    // later. Re-rolling on every deferral would quietly starve the star, which is deferred most
    // often precisely because it flies fastest.
    const rolled = (Math.imul(next.seed, 1664525) + 1013904223) >>> 0;
    const kind = next.nextId === 0 ? 'crate' : OBSTACLE_KINDS[rolled % OBSTACLE_KINDS.length]!;
    // Stars fly 1.7x faster, so spawn SPACING is not arrival spacing: a star launched a full interval
    // behind a crate used to catch it and demand a duck and a jump in the same instant, which is not a
    // reaction a human has. Space hazards by when they ARRIVE, and defer the roll when they would clash.
    const eta = (x: number, k: string) => (x - right) / (speed * (k === 'star' ? 1.7 : 1));
    const arrival = eta(next.width + 24, kind);
    // A beam or a star has to be ducked, and ducking only works from the floor. Riding a crate out
    // from under you plus the drop back down costs this long, so a crate followed too closely by a
    // duck hazard is not hard, it is unsurvivable. Crates are solid now, so the course owes that time.
    const recovery = (46 * scale) / speed + 0.3;
    // Waiting shifts every hazard already in flight one-for-one closer, so the shortfall against the
    // tightest neighbour IS the wait this hazard owes. No search, no re-roll, no bias.
    let deficit = 0;
    for (const obstacle of next.obstacles) {
      if (obstacle.handled) continue;
      const gap = arrival - eta(obstacle.x, obstacle.kind);
      const first = gap >= 0 ? obstacle.kind : kind;
      const second = gap >= 0 ? kind : obstacle.kind;
      const need = MIN_ARRIVAL_GAP_S + (first === 'crate' && (second === 'beam' || second === 'star') ? recovery : 0);
      if (Math.abs(gap) < need) deficit = Math.max(deficit, need - gap);
    }
    if (deficit > 0) {
      next.spawnMs += deficit * 1000 + 1;
    } else {
      next.seed = rolled;
      next.obstacles.push({
        id: next.nextId++, kind, x: next.width + 24,
        width: (kind === 'beam' ? 46 : kind === 'star' ? 18 : 26) * scale,
        height: (kind === 'beam' ? 12 : kind === 'star' ? 18 : kind === 'crate' ? 16 : 32) * scale,
        bottom: (kind === 'beam' || kind === 'star' ? 29 : 0) * scale, handled: false,
      });
      // At maximum speed this still gives over 1.7 seconds between hazards.
      next.spawnMs += 1700 + next.seed % 401;
    }
  }
  for (const obstacle of next.obstacles) {
    if (obstacle.handled) continue;
    const vertical = top > obstacle.bottom && bottom < obstacle.bottom + obstacle.height;
    const reach = (next.attack === 'kick' ? 30 : 20) * scale;
    if ((obstacle.kind === 'target' || obstacle.kind === 'pot') && next.attack && vertical && obstacle.x >= left && obstacle.x <= right + reach) {
      obstacle.handled = true;
      next.score += obstacle.kind === 'pot' ? 40 : 30;
      next.clears++;
      for (let n = 0; n < 10; n++) {
        next.debris.push({ x: obstacle.x + obstacle.width / 2, y: obstacle.height / 2,
          vx: (n - 4.5) * 28, vy: 110 + n % 4 * 32, lifeMs: 650 + n % 3 * 100,
          color: obstacle.kind === 'pot' && n % 3 === 0 ? 'leaf' : 'pot' });
      }
      continue;
    }
    if (vertical && obstacle.x < right && obstacle.x + obstacle.width > left) {
      obstacle.handled = true;
      if (next.invulnerableMs === 0) {
        next.hearts = Math.max(0, next.hearts - 1);
        next.invulnerableMs = 1100;
      }
    } else if (obstacle.x + obstacle.width < left) {
      obstacle.handled = true;
      next.score += obstacle.kind === 'star' ? 35 : 20;
      next.clears++;
    }
  }
  next.level = 1 + Math.floor(next.score / 100);
  if (next.hearts && next.clears >= next.nextBonusAt) {
    next.mode = 'flycatch';
    next.nextBonusAt += 5;
    next.bonus = { remainingMs: 12000, aimX: next.width / 2, aimY: 85,
      flyX: next.width / 2 + 55, flyY: 72, caught: 0, pinchMs: 0, cooldownMs: 0, up: false };
    next.held = { left: false, right: false, duck: false };
    next.jumpY = 0;
    next.velocityY = 0;
    next.attack = null;
    next.attackMs = 0;
    next.obstacles = [];
    next.debris = [];
  }
  if (!next.hearts) {
    next.phase = 'lost';
    next.held = { left: false, right: false, duck: false };
  }
}

/** Pure, deterministic transition. Clamp stalled clocks and substep to prevent tunnelling. */
export function stepArcade(state: ArcadeState, elapsedMs: number): ArcadeState {
  if (state.phase !== 'playing' || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return state;
  let remaining = Math.min(100, elapsedMs);
  const next = { ...state, obstacles: state.obstacles.map(obstacle => ({ ...obstacle })),
    bonus: state.bonus ? { ...state.bonus } : null, debris: state.debris.map(chip => ({ ...chip })) };
  while (remaining > 0 && next.phase === 'playing') {
    const slice = Math.min(16, remaining);
    advance(next, slice);
    remaining -= slice;
  }
  for (let i = next.obstacles.length - 1; i >= 0; i--) {
    const obstacle = next.obstacles[i]!;
    if (obstacle.x + obstacle.width <= -8) next.obstacles.splice(i, 1);
  }
  for (let i = next.debris.length - 1; i >= 0; i--) {
    if (next.debris[i]!.lifeMs <= 0) next.debris.splice(i, 1);
  }
  return next;
}

export interface ArcadeScorePort { total(): number; award(points: number): void }

export interface AgentArcadeHandle {
  /** Eligibility is the LUCID Agent role alone. It used to also require a live turn, which meant the
   *  Arcade chip only existed mid-reply: an idle agent session showed no game at all. */
  update(agentMode: boolean): void;
  /** Whether the game panel is showing, which is when the Arcade sprite owns the screen. */
  isOpen(): boolean;
  dispose(): void;
}

type ThemeId = keyof typeof MASCOT_THEMES;
const PUNCH_FRAMES = ['punchA', 'punchB', 'punchC', 'punchD'] as const;
const KICK_FRAMES = ['kickA', 'kickB', 'kickC', 'kickD'] as const;
const FLOOR_Y = 172;
const CANVAS_HEIGHT = 180;

/** Pure painter for one hazard, in the same family as drawArcadeBonus: no state, no input, no score.
 *  `time` is the run clock, which is what spins the shuriken and shimmers the target. */
export function paintObstacle(ctx: CanvasRenderingContext2D, obstacle: ArcadeObstacle, palette: Record<string, string>, time: number): void {
  const scale = obstacle.kind === 'beam' ? obstacle.width / 46 : obstacle.kind === 'star' ? obstacle.width / 18 : obstacle.width / 26;
  ctx.save();
  ctx.translate(Math.round(obstacle.x), Math.round(FLOOR_Y - obstacle.bottom - obstacle.height));
  ctx.scale(scale, scale);
  if (obstacle.kind === 'pot') {
    ctx.fillStyle = palette.g!;
    ctx.fillRect(12, 4, 2, 14);
    ctx.fillRect(6, 7, 7, 3);
    ctx.fillRect(14, 10, 7, 3);
    ctx.fillStyle = palette.G!;
    ctx.fillRect(4, 5, 6, 3);
    ctx.fillRect(18, 8, 5, 3);
    ctx.fillStyle = palette.W!;
    ctx.fillRect(9, 1, 7, 4);
    ctx.fillRect(7, 3, 11, 3);
    ctx.fillStyle = palette.S!;
    ctx.fillRect(11, 3, 3, 3);
    ctx.fillStyle = palette.k!;
    ctx.fillRect(3, 16, 20, 5);
    ctx.fillRect(5, 20, 16, 10);
    ctx.fillRect(7, 29, 12, 3);
    ctx.fillStyle = palette.s!;
    ctx.fillRect(4, 17, 18, 3);
    ctx.fillRect(6, 21, 14, 7);
    ctx.fillRect(8, 28, 10, 2);
    ctx.fillStyle = palette.S!;
    ctx.fillRect(6, 17, 14, 1);
    ctx.fillRect(7, 21, 3, 6);
    ctx.fillStyle = palette.D!;
    ctx.fillRect(11, 23, 7, 1);
    ctx.fillRect(14, 24, 1, 3);
  } else if (obstacle.kind === 'star') {
    // A thrown shuriken: four tapered blades around a hub, spun by alternating an upright cross with
    // a diagonal X. Axis-aligned fillRects only - rotating the context would blur the pixels, which
    // is the one thing this art style cannot survive. The trail sits BEHIND it (it flies leftward).
    const diagonal = Math.floor(time / 55) % 2 === 1;
    ctx.fillStyle = palette.L!;
    ctx.fillRect(17, 7, 7, 4);
    ctx.fillRect(24, 8, 6, 2);
    ctx.fillRect(31, 9, 5, 1);
    ctx.fillStyle = palette.k!;
    if (diagonal) {
      for (let n = 0; n < 8; n++) {
        const w = 2 + Math.floor(n / 3);
        ctx.fillRect(n, n, w, w);
        ctx.fillRect(18 - n - w, n, w, w);
        ctx.fillRect(n, 18 - n - w, w, w);
        ctx.fillRect(18 - n - w, 18 - n - w, w, w);
      }
    } else {
      for (let n = 0; n < 8; n++) {
        const half = 1 + Math.floor(n / 2);
        ctx.fillRect(9 - half, n, half * 2, 1);
        ctx.fillRect(9 - half, 17 - n, half * 2, 1);
        ctx.fillRect(n, 9 - half, 1, half * 2);
        ctx.fillRect(17 - n, 9 - half, 1, half * 2);
      }
    }
    ctx.fillStyle = palette.M!;
    if (diagonal) {
      for (let n = 1; n < 7; n++) {
        const w = 1 + Math.floor(n / 3);
        ctx.fillRect(n + 1, n + 1, w, w);
        ctx.fillRect(16 - n - w, n + 1, w, w);
        ctx.fillRect(n + 1, 16 - n - w, w, w);
        ctx.fillRect(16 - n - w, 16 - n - w, w, w);
      }
    } else {
      for (let n = 1; n < 7; n++) {
        const half = Math.floor(n / 2);
        if (!half) continue;
        ctx.fillRect(9 - half, n, half * 2, 1);
        ctx.fillRect(9 - half, 17 - n, half * 2, 1);
        ctx.fillRect(n, 9 - half, 1, half * 2);
        ctx.fillRect(17 - n, 9 - half, 1, half * 2);
      }
    }
    ctx.fillStyle = palette.W!; // honed edge: one bright pixel per blade
    if (diagonal) { ctx.fillRect(2, 2, 2, 1); ctx.fillRect(14, 2, 2, 1); }
    else { ctx.fillRect(8, 1, 2, 1); ctx.fillRect(1, 8, 1, 2); }
    ctx.fillStyle = palette.M!; // hub
    ctx.fillRect(6, 6, 6, 6);
    ctx.fillStyle = palette.k!;
    ctx.fillRect(5, 5, 8, 1);
    ctx.fillRect(5, 12, 8, 1);
    ctx.fillRect(5, 6, 1, 6);
    ctx.fillRect(12, 6, 1, 6);
    ctx.fillRect(8, 8, 2, 2); // the hole you hold it by
  } else if (obstacle.kind === 'crate') {
    ctx.fillStyle = palette.k!;
    ctx.fillRect(0, 0, 26, 16);
    ctx.fillStyle = palette.s!;
    ctx.fillRect(1, 1, 24, 14);
    ctx.fillStyle = palette.S!;
    ctx.fillRect(2, 2, 22, 2);
    ctx.fillRect(2, 12, 22, 2);
    ctx.fillStyle = palette.D!;
    ctx.fillRect(2, 5, 22, 1);
    ctx.fillRect(2, 10, 22, 1);
    for (let n = 0; n < 10; n++) {
      ctx.fillStyle = palette.k!;
      ctx.fillRect(4 + n * 2, 3 + n, 2, 2);
      ctx.fillStyle = palette.S!;
      ctx.fillRect(20 - n * 2, 3 + n, 2, 2);
    }
    ctx.fillStyle = palette.M!;
    ctx.fillRect(2, 2, 2, 2);
    ctx.fillRect(22, 12, 2, 2);
  } else if (obstacle.kind === 'target') {
    ctx.fillStyle = palette.k!;
    ctx.fillRect(10, 3, 7, 29);
    ctx.fillRect(1, 9, 24, 14);
    ctx.fillStyle = palette.L!;
    ctx.fillRect(11, 4, 5, 28);
    ctx.fillStyle = palette.G!;
    ctx.fillRect(3, 11, 20, 10);
    ctx.fillStyle = palette.g!;
    ctx.fillRect(6, 13, 14, 6);
    ctx.fillStyle = palette.W!;
    ctx.fillRect(11, 14, 4, 4);
    ctx.fillStyle = palette.M!;
    ctx.fillRect(6, 29, 17, 3);
  } else {
    ctx.fillStyle = palette.k!;
    ctx.fillRect(0, 0, 46, 12);
    ctx.fillStyle = palette.M!;
    ctx.fillRect(1, 1, 44, 10);
    ctx.fillStyle = palette.W!;
    ctx.fillRect(2, 1, 42, 2);
    ctx.fillStyle = palette.G!;
    ctx.fillRect(2, 4, 42, 5);
    ctx.fillStyle = palette.D!;
    for (let n = 4; n < 43; n += 8) {
      ctx.fillRect(n, 4, 4, 2);
      ctx.fillRect(n + 2, 6, 4, 3);
    }
  }
  ctx.restore();
}

/** Renders the earned bonus scene without changing state, input or score. */
export function drawArcadeBonus(ctx: CanvasRenderingContext2D, state: ArcadeState, palette: Record<string, string>): void {
  if (state.mode !== 'flycatch' || !state.bonus) return;
  const bonus = state.bonus;
  const flyX = Math.round(bonus.flyX);
  const flyY = Math.round(bonus.flyY);
  const aimX = Math.round(bonus.aimX);
  const aimY = Math.round(bonus.aimY);
  const wing = Math.floor(state.elapsedMs / 60) % 2 ? 3 : 0;
  ctx.fillStyle = palette.M!;
  ctx.fillRect(flyX - 9, flyY - 7 - wing, 7, 5);
  ctx.fillRect(flyX + 2, flyY - 7 - wing, 7, 5);
  ctx.fillStyle = palette.k!;
  ctx.fillRect(flyX - 4, flyY - 4, 8, 11);
  ctx.fillStyle = palette.G!;
  ctx.fillRect(flyX - 3, flyY - 3, 6, 3);
  ctx.fillStyle = palette.W!;
  ctx.fillRect(flyX - 3, flyY - 5, 2, 2);
  ctx.fillRect(flyX + 1, flyY - 5, 2, 2);
  ctx.strokeStyle = palette.G!;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(aimX, aimY, 25, 0, Math.PI * 2);
  ctx.stroke();
  const spread = bonus.pinchMs ? 2 : 15;
  for (let n = 0; n < 42; n++) {
    ctx.fillStyle = palette.s!;
    ctx.fillRect(aimX + n, aimY - spread - Math.floor(n / 3), 3, 3);
    ctx.fillRect(aimX + n, aimY + spread + Math.floor(n / 3), 3, 3);
    ctx.fillStyle = palette.S!;
    ctx.fillRect(aimX + n, aimY - spread - Math.floor(n / 3), 2, 1);
    ctx.fillRect(aimX + n, aimY + spread + Math.floor(n / 3), 2, 1);
  }
  ctx.fillStyle = palette.W!;
  ctx.font = '12px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(`FLYCATCH · ${Math.ceil(bonus.remainingMs / 1000)}s · ${bonus.caught} caught · +${bonus.caught * 50}`, Math.round(state.width / 2), 16);
  if (bonus.pinchMs) ctx.fillText('PINCH', aimX, Math.max(32, aimY - 32));
}

export interface ArcadeOptions {
  /** Fires synchronously when the panel opens or closes, so the host can yield the mascot to it. */
  onLayout?: (open: boolean) => void;
}

/** Local, opt-in diversion. The caller alone decides whether an actual agent run is active. */
export function mountAgentArcade(host: HTMLElement, scorePort?: ArcadeScorePort, options: ArcadeOptions = {}): AgentArcadeHandle {
  const root = document.createElement('section');
  root.className = 'agent-arcade';
  root.hidden = true;
  root.setAttribute('aria-label', 'LUCID run arcade');
  root.innerHTML = `
    <button type="button" class="agent-arcade-reveal" aria-expanded="false" data-tip="Arcade|A local ninja obstacle course. Nothing leaves this machine; play while you think or while the agent works.">Arcade</button>
    <div class="agent-arcade-panel" hidden>
      <div class="agent-arcade-toolbar">
        <label class="agent-arcade-game">Game <select aria-label="Arcade game" data-game-select></select></label>
        <label class="agent-arcade-character">Ninja <select aria-label="Arcade character"></select></label>
        <output class="agent-arcade-score" aria-label="Arcade score">Level 1 · Run 0 · Hearts 3</output>
        <output class="agent-arcade-total" aria-label="Combined arcade and trivia score">Total 0</output>
        <span class="agent-arcade-actions">
          <button type="button" class="agent-arcade-start">Start</button>
          <button type="button" class="agent-arcade-exit">Exit</button>
        </span>
      </div>
      <canvas class="agent-arcade-canvas" tabindex="0" aria-label="Ninja obstacle course. Arrow keys move, Up or Alt jumps, Down ducks, Control punches, Down plus Control kicks."></canvas>
      <div class="agent-arcade-controls" role="group" aria-label="Arcade controls">
        <button type="button" data-action="left" aria-label="Move left">Left</button>
        <button type="button" data-action="right" aria-label="Move right">Right</button>
        <button type="button" data-action="jump">Jump</button>
        <button type="button" data-action="duck" aria-pressed="false">Duck</button>
        <button type="button" data-action="punch">Punch</button>
        <button type="button" data-action="kick">Kick</button>
        <span class="agent-arcade-status" role="status">Local only. Play any time, including while the agent works.</span>
      </div>
      <p class="agent-arcade-help">Arrows move · Up / Alt jump · Down duck · Ctrl punch · Down + Ctrl kick. Crate lids are solid: land on one and jump again. Duck bars and stars, smash flower pots. Five clears unlock Flycatch.</p>
      <div class="agent-arcade-alt" hidden></div>
    </div>`;
  host.appendChild(root);
  host.hidden = true;
  const reveal = root.querySelector<HTMLButtonElement>('.agent-arcade-reveal')!;
  const panel = root.querySelector<HTMLDivElement>('.agent-arcade-panel')!;
  const chooser = root.querySelector<HTMLSelectElement>('.agent-arcade-character select')!;
  const gameSelect = root.querySelector<HTMLSelectElement>('[data-game-select]')!;
  const altHost = root.querySelector<HTMLDivElement>('.agent-arcade-alt')!;
  const start = root.querySelector<HTMLButtonElement>('.agent-arcade-start')!;
  const exit = root.querySelector<HTMLButtonElement>('.agent-arcade-exit')!;
  const canvas = root.querySelector<HTMLCanvasElement>('canvas')!;
  const score = root.querySelector<HTMLOutputElement>('.agent-arcade-score')!;
  const totalOutput = root.querySelector<HTMLOutputElement>('.agent-arcade-total')!;
  const help = root.querySelector<HTMLElement>('.agent-arcade-help')!;
  const jumpButton = root.querySelector<HTMLButtonElement>('[data-action="jump"]')!;
  const punchButton = root.querySelector<HTMLButtonElement>('[data-action="punch"]')!;
  const kickButton = root.querySelector<HTMLButtonElement>('[data-action="kick"]')!;
  const status = root.querySelector<HTMLElement>('.agent-arcade-status')!;
  const controls = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-action]'));
  const duckButton = root.querySelector<HTMLButtonElement>('[data-action="duck"]')!;
  const context = canvas.getContext('2d');
  const events = new AbortController();
  const listenerOptions = { signal: events.signal };
  for (const [id, theme] of Object.entries(MASCOT_THEMES)) chooser.add(new Option(theme.name, id));
  let state = createArcadeState();
  let theme: ThemeId = 'lucid';
  let eligible = false;
  let disposed = false;
  let playing = false;
  let started = false;
  let raf = 0;
  let resizeRaf = 0;
  let lastTime = 0;
  let dpr = 1;
  let lastScore = -1;
  let lastHearts = -1;
  let sessionTotal = 0;
  let lastTotal = -1;
  let lastMode: ArcadeState['mode'] | null = null;
  const keys = new Set<string>();
  const pulses = new Map<'left' | 'right' | 'duck' | 'aim-up', number>();
  // P-MASCOT.5: the panel is a cabinet of games now. 'course' is the built-in obstacle run; every
  // other id mounts a MINI_GAMES def into altHost and hides the course surfaces in place.
  let activeGame = 'course';
  let miniHandle: MiniGameHandle | null = null;
  const controlsRow = root.querySelector<HTMLDivElement>('.agent-arcade-controls')!;
  const characterLabel = root.querySelector<HTMLElement>('.agent-arcade-character')!;
  const courseHelp = help.textContent!;
  /** Same points sink as the course. `lastTotal` is invalidated so the arcade's own Total repaints
   *  when the player switches back to it. */
  const miniPort: ArcadeScorePort = {
    total: () => (scorePort ? scorePort.total() : sessionTotal),
    award: (points) => {
      if (points <= 0) return;
      if (scorePort) scorePort.award(points);
      else sessionTotal += points;
      lastTotal = -1;
    },
  };

  function switchGame(id: string): void {
    if (miniHandle) { miniHandle.dispose(); miniHandle = null; }
    altHost.hidden = true;
    altHost.replaceChildren();
    activeGame = id;
    const course = id === 'course';
    canvas.hidden = !course;
    controlsRow.hidden = !course;
    characterLabel.hidden = !course;
    // Every game shares the ONE toolbar row (picker, score, total, Start, Exit), so the controls
    // never stack across two toolbars.
    help.hidden = !course;
    start.textContent = 'Start';
    stop();
    if (course) {
      started = false;
      state = createArcadeState(state.width);
      lastMode = null; lastScore = -1; lastHearts = -1; lastTotal = -1;
      score.setAttribute('aria-label', 'Arcade score');
      help.textContent = courseHelp;
      resize();
    } else {
      const def = MINI_GAMES.find((g) => g.id === id)!;
      miniHandle = def.mount(altHost, { start, score, total: totalOutput, cabinet: panel }, miniPort);
      altHost.hidden = false;
    }
    totalOutput.textContent = `Total ${miniPort.total()}`;
  }

  function acceptState(next: ArcadeState): void {
    const earned = Math.max(0, next.score - state.score);
    state = next;
    if (earned) {
      if (scorePort) scorePort.award(earned);
      else sessionTotal += earned;
    }
  }

  function clearInput(): void {
    keys.clear();
    pulses.clear();
    state = { ...state, held: { left: false, right: false, duck: false },
      bonus: state.bonus ? { ...state.bonus, up: false } : null };
    duckButton.setAttribute('aria-pressed', 'false');
  }

  function stop(): void {
    playing = false;
    cancelAnimationFrame(raf);
    cancelAnimationFrame(resizeRaf);
    raf = 0;
    resizeRaf = 0;
    lastTime = 0;
    clearInput();
    for (const button of controls) button.disabled = true;
  }

  function paint(): void {
    if (!context || panel.hidden || root.hidden) return;
    const ctx = context;
    const palette = MASCOT_THEMES[theme].palette;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = palette.B!;
    ctx.fillRect(0, 0, state.width, CANVAS_HEIGHT);
    // Quiet parallax layers: dojo roofs, bamboo, fence and a stone garden path.
    ctx.fillStyle = palette.D!;
    for (let x = -Math.floor(state.elapsedMs * 0.007) % 190; x < state.width; x += 190) {
      ctx.fillRect(x + 30, 76, 90, 67);
      ctx.fillRect(x + 20, 69, 110, 7);
      ctx.fillRect(x + 30, 63, 90, 6);
      ctx.fillRect(x + 42, 57, 66, 6);
      ctx.fillRect(x + 54, 51, 42, 6);
      ctx.fillStyle = palette.L!;
      ctx.fillRect(x + 49, 84, 3, 45);
      ctx.fillRect(x + 96, 84, 3, 45);
      ctx.fillStyle = palette.D!;
    }
    for (let x = -Math.floor(state.elapsedMs * 0.016) % 120; x < state.width; x += 120) {
      ctx.fillStyle = palette.g!;
      ctx.fillRect(x + 14, 42, 4, 112);
      ctx.fillRect(x + 25, 59, 3, 95);
      for (let y = 55; y < 150; y += 24) {
        ctx.fillStyle = palette.G!;
        ctx.fillRect(x + 14, y, 4, 2);
        ctx.fillStyle = palette.g!;
        ctx.fillRect(x + 7, y + 5, 9, 3);
        ctx.fillRect(x + 18, y - 5, 12, 3);
      }
      ctx.fillStyle = palette.s!;
      ctx.fillRect(x + 75, 79, 12, 17);
      ctx.fillStyle = palette.S!;
      ctx.fillRect(x + 79, 81, 4, 12);
      ctx.fillStyle = palette.k!;
      ctx.fillRect(x + 74, 77, 14, 3);
      ctx.fillRect(x + 74, 94, 14, 3);
      ctx.fillRect(x + 80, 69, 2, 8);
    }
    ctx.fillStyle = palette.L!;
    ctx.fillRect(0, 148, state.width, 3);
    ctx.fillRect(0, 163, state.width, 3);
    for (let x = -Math.floor(state.elapsedMs * 0.03) % 24; x < state.width; x += 24) ctx.fillRect(x, 143, 3, 29);
    ctx.fillStyle = palette.g!;
    ctx.fillRect(0, FLOOR_Y, state.width, 2);
    ctx.fillStyle = palette.D!;
    for (let x = -Math.floor(state.elapsedMs * 0.055) % 38; x < state.width; x += 38) ctx.fillRect(x, FLOOR_Y + 4, 28, 3);
    for (const obstacle of state.obstacles) {
      if (obstacle.handled && (obstacle.kind === 'target' || obstacle.kind === 'pot')) continue;
      paintObstacle(ctx, obstacle, palette, state.elapsedMs);
    }
    for (const chip of state.debris) {
      ctx.fillStyle = chip.color === 'leaf' ? palette.G! : palette.s!;
      ctx.fillRect(Math.round(chip.x), Math.round(FLOOR_Y - chip.y), 4, 3);
    }
    const spriteScale = arcadeScale(state.width);
    if (!state.invulnerableMs || Math.floor(state.invulnerableMs / 90) % 2 === 0) {
      let frame: string = MASCOT_RUN_FRAMES[Math.floor(state.elapsedMs / 80) % MASCOT_RUN_FRAMES.length]!;
      if (!playing || state.mode === 'flycatch') frame = 'guard';
      if (state.attack) {
        const duration = state.attack === 'kick' ? 330 : 230;
        const frames = state.attack === 'kick' ? KICK_FRAMES : PUNCH_FRAMES;
        frame = frames[Math.min(3, Math.floor((duration - state.attackMs) / duration * 4))]!;
      }
      // Airborne means above whatever is underfoot: standing on a crate lid is running, not falling.
      if (state.jumpY > state.groundY && !state.attack) frame = 'kickA';
      // Crop the tucked pose, never fractionally scale the original character pixels.
      const ducking = state.held.duck && state.velocityY === 0 && state.jumpY <= state.groundY;
      ctx.save();
      if (ducking) {
        ctx.beginPath();
        ctx.rect(state.x, FLOOR_Y - 24 * spriteScale, MASCOT_W * spriteScale, 24 * spriteScale);
        ctx.clip();
        frame = 'kickA';
      }
      paintFrame(ctx, frame, spriteScale, Math.round(state.x), Math.round(FLOOR_Y - MASCOT_H * spriteScale - state.jumpY + (ducking ? 22 * spriteScale : 0)), palette);
      ctx.restore();
    }
    drawArcadeBonus(ctx, state, palette);
    if (!playing) {
      ctx.fillStyle = palette.W!;
      ctx.font = '12px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(state.phase === 'lost' ? 'Course over. Restart for another run.' : started ? 'Paused. Choose Resume to continue.' : 'Choose your ninja, then Start.', Math.round(state.width / 2), state.mode === 'flycatch' ? 34 : 20);
    }
    if (lastScore !== state.score || lastHearts !== state.hearts) {
      score.textContent = `Level ${state.level} · Run ${state.score} · Hearts ${state.hearts}`;
      lastScore = state.score;
      lastHearts = state.hearts;
    }
    const total = scorePort ? scorePort.total() : sessionTotal;
    if (lastTotal !== total) {
      totalOutput.textContent = `Total ${total}`;
      lastTotal = total;
    }
    if (lastMode !== state.mode) {
      const bonus = state.mode === 'flycatch';
      lastMode = state.mode;
      jumpButton.textContent = bonus ? 'Aim up' : 'Jump';
      duckButton.textContent = bonus ? 'Aim down' : 'Duck';
      punchButton.textContent = bonus ? 'Pinch' : 'Punch';
      kickButton.textContent = bonus ? 'Pinch' : 'Kick';
      help.textContent = bonus
        ? 'Flycatch bonus: arrows aim the chopsticks. Ctrl / Alt pinch when the fly is inside the ring. 50 points per catch. No damage. 12 seconds.'
        : 'Arrows move · Up / Alt jump · Down duck · Ctrl punch · Down + Ctrl kick. Crate lids are solid: land on one and jump again. Duck bars and stars, smash flower pots. Five clears unlock Flycatch.';
      if (playing) status.textContent = bonus ? 'Five clears! Flycatch bonus unlocked.' : 'Course resumed. Keep your earned bonus points.';
      canvas.setAttribute('aria-label', bonus ? 'Flycatch bonus. Arrow keys aim, Control or Alt pinches. Fifty points per catch. Twelve seconds, no damage.' : 'Ninja obstacle course. Arrow keys move, Up or Alt jumps, Down ducks, Control punches, Down plus Control kicks.');
    }
  }

  function resize(): void {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = 0;
    if (disposed || !eligible || panel.hidden || root.hidden || activeGame !== 'course') return;
    const style = getComputedStyle(panel);
    const padding = (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
    const width = Math.max(260, Math.floor(panel.clientWidth - padding));
    dpr = Math.min(2, Math.max(1, Math.ceil(window.devicePixelRatio || 1)));
    const pixelWidth = width * dpr;
    const pixelHeight = CANVAS_HEIGHT * dpr;
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    if (state.width !== width) state = { ...state, width, x: Math.min(state.x, width * 0.45, width - 150) };
    paint();
  }

  function pause(): void {
    if (!playing) return;
    stop();
    start.textContent = 'Resume';
    status.textContent = 'Paused. Resume when ready.';
    paint();
  }

  function tick(time: number): void {
    raf = 0;
    if (!playing || !eligible || disposed || document.hidden) { pause(); return; }
    const previousMode = state.mode;
    acceptState(stepArcade(state, lastTime ? time - lastTime : 0));
    if (previousMode !== state.mode) clearInput();
    lastTime = time;
    for (const [action, until] of pulses) {
      if (state.elapsedMs >= until) {
        pulses.delete(action);
        const key = action === 'left' ? 'ArrowLeft' : action === 'right' ? 'ArrowRight' : action === 'aim-up' ? 'ArrowUp' : 'ArrowDown';
        state = applyArcadeInput(state, action, keys.has(key));
        if (action === 'duck') duckButton.setAttribute('aria-pressed', String(state.held.duck));
      }
    }
    if (state.phase === 'lost') {
      stop();
      start.textContent = 'Restart';
      status.textContent = `Course over. Score ${state.score}. Restart or exit.`;
    }
    paint();
    if (playing) raf = requestAnimationFrame(tick);
  }

  function begin(): void {
    if (!eligible || document.hidden || disposed) return;
    if (activeGame !== 'course') { miniHandle?.start(); return; } // the mini game labels Start itself
    if (!context) return;
    if (playing) { pause(); return; }
    if (!started || state.phase === 'lost') state = createArcadeState(state.width);
    started = true;
    playing = true;
    lastTime = 0;
    start.textContent = 'Pause';
    status.textContent = 'Jump crates. Duck bars. Strike targets.';
    for (const button of controls) button.disabled = false;
    canvas.focus({ preventScroll: true });
    raf = requestAnimationFrame(tick);
  }

  function close(): void {
    stop();
    if (activeGame !== 'course') { gameSelect.value = 'course'; switchGame('course'); }
    started = false;
    const wasOpen = !panel.hidden;
    panel.hidden = true;
    reveal.hidden = false;
    reveal.setAttribute('aria-expanded', 'false');
    start.textContent = 'Start';
    state = createArcadeState(state.width);
    if (wasOpen) options.onLayout?.(false);
  }

  reveal.addEventListener('click', () => {
    if (!eligible) return;
    panel.hidden = false;
    reveal.hidden = true;
    reveal.setAttribute('aria-expanded', 'true');
    options.onLayout?.(true);
    status.textContent = context ? 'Local only. Play any time, including while the agent works.' : 'Canvas is unavailable in this window.';
    start.disabled = !context;
    for (const button of controls) button.disabled = true;
    resize();
    start.focus({ preventScroll: true });
  }, listenerOptions);
  start.addEventListener('click', begin, listenerOptions);
  exit.addEventListener('click', () => { close(); reveal.focus({ preventScroll: true }); }, listenerOptions);
  chooser.addEventListener('change', () => { theme = chooser.value as ThemeId; paint(); }, listenerOptions);
  gameSelect.add(new Option('Obstacle course', 'course'));
  for (const def of MINI_GAMES) gameSelect.add(new Option(def.name, def.id));
  gameSelect.addEventListener('change', () => switchGame(gameSelect.value), listenerOptions);
  for (const button of controls) {
    button.addEventListener('click', () => {
      if (!playing || !eligible) return;
      let action = button.dataset.action as ArcadeAction;
      if (state.mode === 'flycatch' && action === 'jump') action = 'aim-up';
      acceptState(applyArcadeInput(state, action, true));
      if (action === 'left' || action === 'right' || action === 'duck' || action === 'aim-up') {
        pulses.set(action, state.elapsedMs + (action === 'duck' && state.mode === 'runner' ? 800 : 180));
      }
      duckButton.setAttribute('aria-pressed', String(state.held.duck));
      canvas.focus({ preventScroll: true });
      paint();
    }, listenerOptions);
  }

  const keyAction = (event: KeyboardEvent): ArcadeAction | null => {
    switch (event.key) {
      case 'ArrowLeft': return 'left';
      case 'ArrowRight': return 'right';
      case 'ArrowDown': return 'duck';
      case 'ArrowUp': return state.mode === 'flycatch' ? 'aim-up' : 'jump';
      case 'Alt': return 'jump';
      case 'Control': return keys.has('ArrowDown') ? 'kick' : 'punch';
      default: return null;
    }
  };
  canvas.addEventListener('keydown', event => {
    if (!playing || !eligible || document.activeElement !== canvas) return;
    const action = keyAction(event);
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    keys.add(event.key);
    acceptState(applyArcadeInput(state, action, true));
    duckButton.setAttribute('aria-pressed', String(state.held.duck));
  }, listenerOptions);
  canvas.addEventListener('keyup', event => {
    if (!playing || !eligible || document.activeElement !== canvas) return;
    const action = keyAction(event);
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    keys.delete(event.key);
    state = applyArcadeInput(state, action, false);
    duckButton.setAttribute('aria-pressed', String(state.held.duck));
  }, listenerOptions);
  root.addEventListener('focusout', event => {
    if (!(event.relatedTarget instanceof Node) || !root.contains(event.relatedTarget)) pause();
    else if (event.target === canvas) clearInput();
  }, listenerOptions);
  window.addEventListener('blur', pause, listenerOptions);
  document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); }, listenerOptions);
  const observer = new ResizeObserver(() => {
    if (!disposed && eligible && !panel.hidden && !resizeRaf) resizeRaf = requestAnimationFrame(resize);
  });
  observer.observe(host);

  return {
    update(agentMode) {
      if (disposed) return;
      if (eligible === agentMode) return;
      eligible = agentMode;
      if (!eligible) {
        const active = document.activeElement;
        if (active instanceof HTMLElement && root.contains(active)) active.blur();
        close();
      }
      root.hidden = !eligible;
      host.hidden = !eligible;
    },
    isOpen() { return !disposed && !panel.hidden; },
    dispose() {
      if (disposed) return;
      disposed = true;
      const active = document.activeElement;
      if (active instanceof HTMLElement && root.contains(active)) active.blur();
      stop();
      if (!panel.hidden) options.onLayout?.(false);
      if (miniHandle) { miniHandle.dispose(); miniHandle = null; }
      events.abort();
      observer.disconnect();
      root.remove();
      host.hidden = true;
    },
  };
}
