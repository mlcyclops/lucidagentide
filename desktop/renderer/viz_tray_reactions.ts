// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_tray_reactions.ts - P-VIZ.TRAY2 (ADR-0690): the throw tray's reactions group, its pure rules.
//
// A chevron at the tray's left end folds out four reactions beside the throwables: Celebrate, Wave, Coffee break and
// Dance. A reaction is a BROADCAST: every agent and subagent plays it (the throwables are the aimed tool; a reaction
// is the team's, so it needs no target and works from the keyboard). Each figure plays it as a short hit layer over
// its activity (viz_anime_pose.HIT_CLIPS, viz_office_pose.OFFICE_HIT_CLIPS) that blends back by itself, so the
// figure's state signals (the cell's status color, its activity) are only covered for a few seconds; the scene adds a
// light effect per figure (confetti, a greeting ring, steam, a beat pulse) from its own particle pools.
// Reduced motion: no figure layer and no particles; the cell flashes the reaction's color instead (a color cue).
// Pure (no three, no DOM): the looks, the merge with a world's own reactions (the scene's allowlist), the cooldown,
// the fold-out pref, the stagger and how much effect a tier gets.

import type { PerfTier } from "./perf_tier.ts";
import { stormSchedule } from "./viz_throw_math.ts";
import type { WorldTrayReaction } from "./viz_world_api.ts";

/** The built-in reactions (viz_world_api.WorldTrayBase is the same set, frozen in the world contract). */
export type TrayReactionKind = "celebrate" | "wave" | "coffee" | "dance";
export const TRAY_REACTION_KINDS: readonly TrayReactionKind[] = ["celebrate", "wave", "coffee", "dance"];

export function isTrayReactionKind(kind: string): kind is TrayReactionKind {
  return (TRAY_REACTION_KINDS as readonly string[]).includes(kind);
}

/** One button in the reactions group. `kind`: what the figures hear (a built-in kind, or a world's own); `base`: the
 *  built-in reaction it stands in for (its slot, the scene's effect, a built-in figure's clip); `icon`: a world's SVG
 *  path data, null for the built-in icon of `base`. */
export interface TrayReactionLook { readonly kind: string; readonly base: TrayReactionKind; readonly label: string; readonly tip: string; readonly icon: string | null }

export const TRAY_REACTIONS: readonly TrayReactionLook[] = [
  { kind: "celebrate", base: "celebrate", label: "Celebrate", tip: "Confetti pops over the team and everyone cheers.", icon: null },
  { kind: "wave", base: "wave", label: "Wave", tip: "Everyone turns and waves at you, one after another.", icon: null },
  { kind: "coffee", base: "coffee", label: "Coffee break", tip: "A short break: a stretch and a sip, then back to work.", icon: null },
  { kind: "dance", base: "dance", label: "Dance", tip: "The whole team dances in sync for a few beats.", icon: null },
];

/** Each reaction at most once per this long; its own cooldown (the other three stay ready). */
export const TRAY_REACTION_COOLDOWN_MS = 4500;

/** How long a figure plays each reaction (ms), at least its longest clip in either family (viz_anime_pose.HIT_CLIPS,
 *  viz_office_pose.OFFICE_HIT_CLIPS). The scene reports a figure as playing it this long (the demo probe). */
export const TRAY_REACTION_MS: Readonly<Record<TrayReactionKind, number>> = { celebrate: 2600, wave: 2500, coffee: 4200, dance: 3200 };

/** Reduced motion: the cell flashes the reaction's color this long instead of the figure layer and the effect. */
export const TRAY_REACTION_CUE_MS = 1200;
export const TRAY_REACTION_CUE: Readonly<Record<TrayReactionKind, string>> = { celebrate: "#ffd166", wave: "#7dd3fc", coffee: "#d19a66", dance: "#f472b6" };

/** What the tray offers and the scene allows, in tray order: the four built-ins, each slot taken by the world's
 *  reaction with that base when it brings one (the first one wins). A world without `reactions` (every world built
 *  before ADR-0690) and the built-in styles get the built-ins. */
export function trayReactionsFor(world: { readonly reactions?: readonly WorldTrayReaction[] } | null): readonly TrayReactionLook[] {
  const own = world?.reactions;
  if (!own?.length) return TRAY_REACTIONS;
  return TRAY_REACTIONS.map((b) => {
    const w = own.find((r) => r.base === b.base);
    return w ? { kind: w.kind, base: b.base, label: w.label, tip: w.tip, icon: w.icon } : b;
  });
}

/** The reaction `kind` stands for in `list` (the scene's allowlist), or null when the tray does not offer it. */
export function trayReactionOf(list: readonly TrayReactionLook[], kind: string): TrayReactionLook | null {
  return list.find((r) => r.kind === kind) ?? null;
}

/** The fold-out pref (viz_view's prefs, `reactions`): open only when it was saved open; collapsed by default. */
export function parseReactionsOpen(v: unknown): boolean {
  return v === true;
}

// ------------------------------------------------------------------------------------------ the broadcast

/** Each reaction's stagger: at most `gap` ms between two figures (left to right on screen), the whole team within
 *  `spread`. Dance has none: the team dances in sync. */
const STAGGER: Readonly<Record<TrayReactionKind, { gap: number; spread: number }>> = {
  celebrate: { gap: 70, spread: 500 },
  wave: { gap: 140, spread: 1100 },
  coffee: { gap: 160, spread: 1300 },
  dance: { gap: 0, spread: 0 },
};

export interface ReactionCue { id: string; at: number }

/** When each figure starts the reaction (ms from the click): in the order a front sweeping along `dir` reaches them
 *  (Storm's order, viz_throw_math.stormSchedule: ties by id), staggered per reaction. Reduced motion: all at once. */
export function reactionSchedule(base: TrayReactionKind, points: readonly { id: string; x: number; z: number }[], dir: { x: number; z: number }, motion: boolean): ReactionCue[] {
  const order = stormSchedule(points, dir);
  const n = order.length, s = STAGGER[base];
  const gap = motion && n > 1 ? Math.min(s.gap, s.spread / (n - 1)) : 0;
  return order.map((h, i) => ({ id: h.id, at: Math.round(i * gap) }));
}

/** What one figure's reaction gets: the figure's layer and `particles` of effect with motion; under reduced motion
 *  neither, and the color cue instead. */
export interface ReactionFxPlan { readonly figure: boolean; readonly particles: number; readonly ring: boolean; readonly cue: boolean }

const PARTICLES: Readonly<Record<PerfTier, number>> = { minimal: 4, reduced: 8, full: 14, ultra: 20, cinematic: 20 };
const STILL: ReactionFxPlan = { figure: false, particles: 0, ring: false, cue: true };

export function reactionFx(tier: PerfTier, motion: boolean): ReactionFxPlan {
  return motion ? { figure: true, particles: PARTICLES[tier], ring: tier !== "minimal", cue: false } : STILL;
}
