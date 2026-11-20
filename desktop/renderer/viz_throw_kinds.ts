// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_throw_kinds.ts
//
// P-VIZ.6 (ADR-0636, ADR-0637): the things a user can throw at an agent or subagent in Visualize, and Storm.
// Shared by the scene (projectiles, VFX, the tray in viz_throw.ts) and both figure families (viz_anime.ts,
// viz_office.ts), which play the hit reaction. Pure data, no three.js.

import type { VizStyle } from "./viz_model.ts";

/** Professional: paper ball, rubber band, energy drink. Anime: a stream of three throwing stars, a lightning
 *  bolt that supercharges, an energy ball the figure absorbs and grows stronger from. */
export type ThrowKind = "paper" | "band" | "drink" | "stars" | "bolt" | "orb";

/** What a figure is told when something reaches it: a throwable, or Storm (every figure at once). */
export type HitKind = ThrowKind | "storm";

export interface ThrowLook { kind: ThrowKind; label: string; tip: string }

export const THROWS: Readonly<Record<VizStyle, readonly ThrowLook[]>> = {
  professional: [
    { kind: "paper", label: "Paper ball", tip: "A crumpled paper ball. They flinch and look round for who threw it." },
    { kind: "band", label: "Rubber band", tip: "A snapped rubber band. Ow." },
    { kind: "drink", label: "Energy drink", tip: "An energy drink. They catch it, drink it and work faster for a while." },
  ],
  anime: [
    { kind: "stars", label: "Throwing stars", tip: "A stream of three throwing stars. They block or dodge." },
    { kind: "bolt", label: "Lightning bolt", tip: "A lightning bolt that supercharges them for a while." },
    { kind: "orb", label: "Energy ball", tip: "An energy ball they absorb and grow stronger from." },
  ],
};

export const STORM_TIP: Readonly<Record<VizStyle, string>> = {
  professional: "Storm: papers fly through the office and everyone reacts.",
  anime: "Storm: a lightning storm rolls over the team and everyone powers up.",
};

/** The throwables a style offers, in tray order. */
export function throwsFor(style: VizStyle): readonly ThrowLook[] { return THROWS[style]; }
