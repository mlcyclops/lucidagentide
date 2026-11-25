// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_builtin_options.ts - P-VIZ.STYLEOPT1 (ADR-0688): the options of the two built-in Visualize
// styles (Anime, Professional), declared with the installed worlds' WorldOption union and stored the same way
// (viz_worlds.saveOption / loadOptions under lucid.worlds.options.v1, ids `builtin:anime` and `builtin:professional`),
// and the pure mapping from their values to what the scene draws (BuiltinLook): the backdrop (seven looks, stars,
// drift), the accent pair (backdrop glows, edges, name tags), the particle budget, the lighting tint, the name tag
// look, the Professional floor grid and desk floor, and the Anime floor plate. A saved value that no longer
// validates falls back to its default (mergeOptions). No DOM, no three.js: unit tested in viz_builtin_options.test.ts.

import type { BuiltinStyle, VizTierOpts } from "./viz_model.ts";
import type { VizTheme } from "./viz_scene.ts";
import type { WorldOption, WorldOptionValues } from "./viz_world_api.ts";
import { mergeOptions } from "./viz_worlds.ts";

/** A built-in style's option set, shaped like a world's (`id` keys its saved values). */
export interface BuiltinOptionsDef { readonly id: string; readonly label: string; readonly options: readonly WorldOption[] }

export type BuiltinBackground = "nebula" | "night" | "sunset" | "aurora" | "studio" | "deep" | "solid";
export type BuiltinLabels = "pill" | "plain" | "outline";
export type BuiltinLighting = "warm" | "neutral" | "cool";

/** The accent swatch that follows the app theme (its value only paints the swatch). */
export const THEME_ACCENT = "#c64bd6";
/** The floor plate swatch that follows the backdrop (the plate as it always was). */
export const BACKDROP_PLATE = "#10131c";

/** Each accent with the second color it pairs with (the cyan glow, the far end of an edge). */
const ACCENTS: readonly { value: string; label: string; pair: string | null }[] = [
  { value: THEME_ACCENT, label: "Theme", pair: null },
  { value: "#3b82f6", label: "Ocean", pair: "#22d3ee" },
  { value: "#14b8a6", label: "Teal", pair: "#a3e635" },
  { value: "#f59e0b", label: "Amber", pair: "#fb7185" },
  { value: "#f43f5e", label: "Rose", pair: "#fbbf24" },
  { value: "#8b5cf6", label: "Violet", pair: "#38bdf8" },
  { value: "#e2e8f0", label: "Silver", pair: "#94a3b8" },
];

const PLATES: readonly { value: string; label: string }[] = [
  { value: BACKDROP_PLATE, label: "Backdrop" },
  { value: "#2a2d35", label: "Graphite" },
  { value: "#334155", label: "Slate" },
  { value: "#1e1b4b", label: "Midnight" },
  { value: "#3b1d3a", label: "Plum" },
  { value: "#123b2f", label: "Pine" },
  { value: "#c9b79c", label: "Sand" },
  { value: "#e8ebf0", label: "Snow" },
];

function shared(background: BuiltinBackground): WorldOption[] {
  return [
    {
      key: "background", label: "Background", type: "select", default: background, choices: [
        { value: "nebula", label: "Nebula" }, { value: "night", label: "Night sky" }, { value: "sunset", label: "Sunset" },
        { value: "aurora", label: "Aurora" }, { value: "studio", label: "Studio" }, { value: "deep", label: "Deep space" },
        { value: "solid", label: "Solid color" },
      ],
    },
    { key: "bgColor", label: "Backdrop color (Solid)", type: "color", default: "#1b2130" },
    { key: "stars", label: "Stars", type: "select", default: "few", choices: [{ value: "none", label: "None" }, { value: "few", label: "Few" }, { value: "many", label: "Many" }] },
    { key: "drift", label: "Backdrop drift", type: "toggle", default: false },
    { key: "accent", label: "Accent", type: "swatch", default: THEME_ACCENT, swatches: ACCENTS.map(({ value, label }) => ({ value, label })) },
    { key: "particles", label: "Particles", type: "select", default: "full", choices: [{ value: "full", label: "Full" }, { value: "half", label: "Half" }, { value: "off", label: "Off" }] },
    { key: "lighting", label: "Lighting", type: "select", default: "neutral", choices: [{ value: "warm", label: "Warm" }, { value: "neutral", label: "Neutral" }, { value: "cool", label: "Cool" }] },
    { key: "labels", label: "Name tags", type: "select", default: "pill", choices: [{ value: "pill", label: "Pill" }, { value: "plain", label: "Plain" }, { value: "outline", label: "Outline" }] },
  ];
}

export const BUILTIN_OPTIONS: Readonly<Record<BuiltinStyle, BuiltinOptionsDef>> = Object.freeze({
  anime: {
    id: "builtin:anime", label: "Anime",
    options: [...shared("nebula"), { key: "plate", label: "Floor plate", type: "swatch", default: BACKDROP_PLATE, swatches: PLATES }],
  },
  professional: {
    id: "builtin:professional", label: "Professional",
    options: [
      ...shared("studio"),
      { key: "grid", label: "Floor grid", type: "toggle", default: false },
      { key: "desk", label: "Desk floor", type: "select", default: "tinted", choices: [{ value: "tinted", label: "Tinted" }, { value: "dark", label: "Dark" }] },
    ],
  },
});

/** What the backdrop paints (the scene's canvas texture). Colors are #rrggbb. */
export interface BackdropLook {
  background: BuiltinBackground;
  /** Light or dark; null follows the app theme. */
  light: boolean | null;
  /** The base fill for a dark and a light theme; null is the theme's own --bg-0. */
  base: { dark: string; light: string } | null;
  /** Vertical gradient stops, top to bottom, over the base (none: empty). */
  gradient: readonly string[];
  /** Soft aurora bands across the upper sky. */
  bands: readonly string[];
  /** Strength of the three accent and cyan glows (1 = the nebula). */
  glows: number;
  /** A darker rim (the studio's soft falloff). */
  vignette: boolean;
  /** Stars drawn (on a dark backdrop only), and the share of the height they cover from the top. */
  stars: number;
  starTop: number;
  drift: boolean;
}

export interface BuiltinLight { sky: string; ground: string; sun: string; rim: string; intensity: number }

export interface BuiltinLook {
  style: BuiltinStyle;
  backdrop: BackdropLook;
  /** The accent and its pair; null follows the app theme (and the edges keep their persona colors). */
  accent: string | null;
  cyan: string | null;
  /** Multiplier on the tier's particle budgets (1, 0.5, 0). */
  particles: number;
  lighting: BuiltinLighting;
  light: BuiltinLight;
  labels: BuiltinLabels;
  /** Professional only: the floor grid, and the desk floor's tone. */
  grid: boolean;
  desk: "tinted" | "dark";
  /** Anime only: the floor plate's color; null is the plate as it always was (the backdrop's tone). */
  plate: string | null;
}

const STAR_COUNT: Readonly<Record<string, number>> = { none: 0, few: 140, many: 420 };

/** The backdrop for a background, its star density, drift and solid color. Unknown values take the defaults. */
export function backdropLook(background: string, stars: string, drift: boolean, bgColor: string): BackdropLook {
  const n = STAR_COUNT[stars] ?? STAR_COUNT.few!;
  const look = (p: Partial<BackdropLook> & { background: BuiltinBackground }): BackdropLook => ({
    light: false, base: null, gradient: [], bands: [], glows: 0, vignette: false, stars: n, starTop: 1, drift, ...p,
  });
  switch (background) {
    case "night": return look({ background, base: { dark: "#070912", light: "#070912" }, gradient: ["#05070f", "#0c1224"] });
    case "sunset": return look({ background, base: { dark: "#3a1f45", light: "#3a1f45" }, gradient: ["#3a1f45", "#8a3350", "#d8653f", "#f6a94c"], glows: 0.35, stars: Math.round(n * 0.5), starTop: 0.45 });
    case "aurora": return look({ background, base: { dark: "#06121a", light: "#06121a" }, gradient: ["#03101a", "#071c26", "#0a1720"], bands: ["#2ee6a6", "#1fb5c9", "#7c6cff"], stars: Math.round(n * 0.7), starTop: 0.8 });
    case "studio": return look({ background, light: null, base: { dark: "#3a3f49", light: "#e6e8ec" }, glows: 0.2, vignette: true, stars: 0 });
    case "deep": return look({ background, base: { dark: "#020309", light: "#020309" }, glows: 0.45, stars: n * 3 });
    case "solid": {
      const c = /^#[0-9a-f]{6}$/i.test(bgColor) ? bgColor.toLowerCase() : "#1b2130";
      return look({ background, light: luminance(c) > 0.5, base: { dark: c, light: c } });
    }
    default: return look({ background: "nebula", light: null, glows: 1 });
  }
}

const LIGHTS: Readonly<Record<BuiltinLighting, BuiltinLight>> = {
  warm: { sky: "#ffe0c2", ground: "#2a1a12", sun: "#fff0dc", rim: "#ffc49a", intensity: 1.08 },
  neutral: { sky: "#c8d8ff", ground: "#1c1420", sun: "#ffffff", rim: "#a8c8ff", intensity: 1 },
  cool: { sky: "#b8d0ff", ground: "#0f1a2c", sun: "#e2eeff", rim: "#8cb4ff", intensity: 0.92 },
};

/** The look of `style` for its saved `values` (anything invalid or missing takes its default). */
export function builtinLook(style: BuiltinStyle, values: unknown): BuiltinLook {
  const def = BUILTIN_OPTIONS[style];
  const v: WorldOptionValues = mergeOptions(def.options, values);
  const str = (k: string): string => (typeof v[k] === "string" ? (v[k] as string) : "");
  const acc = ACCENTS.find((a) => a.value === str("accent"));
  const lighting: BuiltinLighting = str("lighting") === "warm" || str("lighting") === "cool" ? (str("lighting") as BuiltinLighting) : "neutral";
  const labels: BuiltinLabels = str("labels") === "plain" || str("labels") === "outline" ? (str("labels") as BuiltinLabels) : "pill";
  const plate = style === "anime" && str("plate") && str("plate") !== BACKDROP_PLATE ? str("plate") : null;
  return {
    style,
    backdrop: backdropLook(str("background"), str("stars"), v.drift === true, str("bgColor")),
    accent: acc?.pair ? acc.value : null,
    cyan: acc?.pair ?? null,
    particles: str("particles") === "off" ? 0 : str("particles") === "half" ? 0.5 : 1,
    lighting, light: LIGHTS[lighting], labels,
    grid: style === "professional" && v.grid === true,
    desk: style === "professional" && str("desk") === "dark" ? "dark" : "tinted",
    plate,
  };
}

/** The scene theme for a built-in look over the app's: the backdrop decides light and the base color (as a world's
 *  sky does), the accent swatch the accent pair. A change here is what remounts the scene. */
export function builtinTheme(t: VizTheme, look: BuiltinLook): VizTheme {
  const b = look.backdrop;
  const light = b.light ?? t.light;
  const bg = b.base ? (light ? b.base.light : b.base.dark) : t.bg;
  return {
    bg, light,
    txt: light === t.light ? t.txt : light ? "#1a1d26" : "#e8eaf2",
    accent: look.accent ?? t.accent,
    cyan: look.cyan ?? t.cyan,
  };
}

/** The tier's budgets with the look's particle multiplier (flow and effect particles alike). */
export function scaleParticles(o: VizTierOpts, k: number): VizTierOpts {
  if (k === 1) return o;
  return { ...o, particles: Math.round(o.particles * k), fx: Math.round(o.fx * k) };
}

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}
