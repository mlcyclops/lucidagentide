// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_throw_math.ts - P-VIZ.6 (ADR-0636): the pure math behind throwing things at agents in
// Visualize (viz_throw.ts draws it, viz_scene.ts runs it). No three.js, no DOM, so every rule is tested:
//   - the flight: a lifted arc from the launch point to the node (its apex and duration per kind);
//   - the volley: one projectile, or the anime throwing stars' stream of three, STAR_GAP_MS apart;
//   - Storm: the order and stagger in which every figure is hit as the storm front sweeps the scene, which
//     nodes a lightning strike lands on, and how much VFX each perf tier gets (none under reduced motion);
//   - the limits: concurrent projectiles (THROW_CAP) and Storm's cooldown;
//   - the tray's armed state (pick a throwable, click a node to throw, Esc or a second click puts it down, a
//     style switch puts it down).

import type { PerfTier } from "./perf_tier.ts";
import { isBuiltinStyle, type VizStyle } from "./viz_model.ts";
import { THROWS, type ThrowKind } from "./viz_throw_kinds.ts";

/** A point in world space (THREE.Vector3 satisfies it). */
export interface V3 { x: number; y: number; z: number }

/** Projectiles in flight (or still bouncing off) at most; a throw past it is dropped. */
export const THROW_CAP = 24;
/** The anime throwing stars: three of them, this far apart. */
export const STAR_COUNT = 3;
export const STAR_GAP_MS = 150;
/** The lightning bolt has no flight: it strikes from above and lands this soon after. */
export const BOLT_LEAD_MS = 90;
/** Storm at most once per this long. */
export const STORM_COOLDOWN_MS = 4000;
/** Storm: the sky turns (or the gust starts) this long before the first figure is hit. */
export const STORM_LEAD_MS = 260;
/** Storm: at most this long between two figures' hits, and every figure hit within STORM_SPREAD_MS. */
export const STORM_GAP_MS = 180;
export const STORM_SPREAD_MS = 1400;
/** A press on a tray button that travels this far (CSS px) is a drag, not a click. */
export const DRAG_PX = 6;

// ------------------------------------------------------------------------------------------ flight

/** How high the arc lifts over the straight line at its middle (world units): a lob for the paper ball and the
 *  can, a flatter line for the band, the stars and the orb, none for the bolt (it strikes from above). */
export function arcApex(kind: ThrowKind, dist: number): number {
  if (kind === "bolt") return 0;
  const k = kind === "stars" || kind === "band" ? 0.06 : kind === "orb" ? 0.12 : 0.22;
  return Math.min(2.5, Math.max(0.05, Math.max(0, dist) * k));
}

/** Milliseconds from launch to arrival over `dist` world units. */
export function flightMs(kind: ThrowKind, dist: number): number {
  if (kind === "bolt") return BOLT_LEAD_MS;
  const base = kind === "stars" ? 240 : kind === "band" ? 280 : kind === "orb" ? 520 : 420;
  const per = kind === "stars" ? 20 : kind === "band" ? 24 : 45;
  return Math.round(Math.min(base * 2.4, base + Math.max(0, dist) * per));
}

/** The arc at `u` (0 launch, 1 arrival, clamped): the straight line lifted by a parabola that peaks at `apex`
 *  halfway. Writes into `out` and returns it (the frame loop calls this per projectile per frame). */
export function arcPoint<T extends V3>(from: V3, to: V3, apex: number, u: number, out: T): T {
  const c = u < 0 ? 0 : u > 1 ? 1 : u;
  const lift = 4 * apex * c * (1 - c);
  out.x = from.x + (to.x - from.x) * c;
  out.y = from.y + (to.y - from.y) * c + lift;
  out.z = from.z + (to.z - from.z) * c;
  return out;
}

const SINGLE: readonly number[] = Object.freeze([0]);
const STARS: readonly number[] = Object.freeze(Array.from({ length: STAR_COUNT }, (_, i) => i * STAR_GAP_MS));

/** Each projectile's launch delay (ms) for one throw: the stars are a stream, everything else is one. */
export function volley(kind: ThrowKind): readonly number[] { return kind === "stars" ? STARS : SINGLE; }

/** Where a throw starts on the stage when it was not dragged (stage px): the viewer's side, bottom center, the
 *  stars of a stream a little apart so the stream reads as three throws. */
export function launchPx(w: number, h: number, index: number, count: number): { x: number; y: number } {
  const spread = count > 1 ? (index - (count - 1) / 2) * w * 0.05 : 0;
  return { x: w / 2 + spread, y: h * 0.97 };
}

/** How many of `want` projectiles may launch with `active` already in flight. */
export function launchRoom(active: number, want: number, cap = THROW_CAP): number {
  return Math.max(0, Math.min(want, cap - active));
}

// ------------------------------------------------------------------------------------------ storm

/** Storm VFX per tier: lightning strikes (anime), flying papers (professional), sparks per strike. */
export interface StormFx { strikes: number; papers: number; sparks: number }

const STORM_FX: Readonly<Record<PerfTier, StormFx>> = {
  full: { strikes: 6, papers: 36, sparks: 30 },
  reduced: { strikes: 3, papers: 16, sparks: 12 },
  minimal: { strikes: 1, papers: 6, sparks: 0 },
  ultra: { strikes: 8, papers: 48, sparks: 44 }, // P-VIZ.GPU1 (ADR-0651)
  cinematic: { strikes: 8, papers: 48, sparks: 44 },
};
const STORM_NONE: StormFx = { strikes: 0, papers: 0, sparks: 0 };

/** The tier's Storm VFX; none at all without motion (the figures are still hit, at once). */
export function stormFx(tier: PerfTier, motion: boolean): StormFx { return motion ? STORM_FX[tier] : STORM_NONE; }

export interface StormHit { id: string; at: number }

/** When each figure is hit (ms after Storm starts): in the order the storm front reaches them sweeping along
 *  `dir` (ties by id, so it is stable), evenly staggered so the whole team is hit within STORM_SPREAD_MS. */
export function stormSchedule(points: readonly { id: string; x: number; z: number }[], dir: { x: number; z: number }): StormHit[] {
  const along = (p: { x: number; z: number }): number => p.x * dir.x + p.z * dir.z;
  const order = [...points].sort((a, b) => along(a) - along(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const n = order.length;
  const gap = n > 1 ? Math.min(STORM_GAP_MS, STORM_SPREAD_MS / (n - 1)) : 0;
  return order.map((p, i) => ({ id: p.id, at: STORM_LEAD_MS + Math.round(i * gap) }));
}

/** Which of `n` scheduled figures a lightning strike lands on: `count` of them (at most n), spread evenly over
 *  the schedule so the strikes walk across the scene with the front. Indices, ascending, distinct. */
export function strikeTargets(n: number, count: number): number[] {
  const k = Math.max(0, Math.min(Math.floor(count), Math.floor(n)));
  if (k === 0) return [];
  if (k === 1) return [Math.floor((n - 1) / 2)];
  return Array.from({ length: k }, (_, i) => Math.round((i * (n - 1)) / (k - 1)));
}

// ------------------------------------------------------------------------------------------ rate limit

export interface RateLimit { last: number; readonly ms: number }

export function createRateLimit(ms: number): RateLimit { return { last: -Infinity, ms }; }

/** Take the limit at `now`: true (and the cooldown restarts) when it has been at least `ms` since the last take. */
export function rateTake(r: RateLimit, now: number): boolean {
  if (now - r.last < r.ms) return false;
  r.last = now;
  return true;
}

/** Milliseconds until the limit can be taken again (0 when it can now). */
export function rateLeft(r: RateLimit, now: number): number { return Math.max(0, r.ms - (now - r.last)); }

// ------------------------------------------------------------------------------------------ armed state

/** P-WORLDS.1 (ADR-0648): a world style's kinds are its own strings; the tray only ever offers the world's three. */
export interface ArmState { readonly style: VizStyle; readonly armed: string | null }
export type ArmAction =
  | { type: "arm"; kind: string }
  | { type: "disarm" }
  | { type: "style"; style: VizStyle }
  /** A click (or a drag release) on the stage; `onNode` when it landed on an agent or subagent. */
  | { type: "release"; onNode: boolean };

export function armState(style: VizStyle): ArmState { return { style, armed: null }; }

/** The tray's state machine. Arming a kind the style does not offer is ignored; arming the armed kind again puts
 *  it down; a release on a node throws (and stays armed, so you can keep throwing), on empty space nothing; a
 *  style switch puts it down (the other style offers other things). `fire`: what to throw now, if anything. */
export function armStep(s: ArmState, a: ArmAction): { state: ArmState; fire: string | null } {
  switch (a.type) {
    case "arm":
      if (!a.kind || (isBuiltinStyle(s.style) && !THROWS[s.style].some((t) => t.kind === a.kind))) return { state: s, fire: null };
      return { state: { style: s.style, armed: s.armed === a.kind ? null : a.kind }, fire: null };
    case "disarm":
      return { state: s.armed ? { style: s.style, armed: null } : s, fire: null };
    case "style":
      return { state: a.style === s.style ? s : { style: a.style, armed: null }, fire: null };
    case "release":
      return { state: s, fire: a.onNode ? s.armed : null };
  }
}
