// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/mascot_theme.ts - P-MINI.3 (ADR-0596): the ninja wears the app's color theme.
//
// The prompt-bar runner and the Ask Lucid header mascot used to paint the fixed brand palette, so a color
// theme left a neon-green ninja on an orange or rose app. Now his accent (headband, belt, scarf: G and its
// shade g) takes the theme's --accent and --accent-deep, and his gi takes a light tint of the accent. The
// Lucid themes (dark and light) keep the brand green: that IS their mascot. A live holiday costume is
// painted over this base by mascot_season.ts, so a season still wins.
//
// `mascotPaletteFor` is pure (unit-tested); `themedMascotPalette` reads the document and is cached per
// theme attribute, so a caller may ask every frame.

import { MASCOT_PALETTE } from "./mascot.ts";

/** Themes whose mascot is the brand palette as drawn. */
const BRAND_THEMES: Record<string, true> = { "lucid-dark": true, "lucid-light": true };
/** How far the gi moves toward the accent: enough to read as the theme, little enough to keep the figure. */
const GI_TINT = 0.22;

function parseHex(c: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(c.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function toHex(rgb: readonly number[]): string {
  return `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;
}
function mix(a: string, b: [number, number, number], w: number): string {
  const x = parseHex(a);
  return x ? toHex(x.map((v, i) => v + (b[i]! - v) * w)) : a;
}

/** PURE: the mascot palette for a theme id and its accent colors (hex). The brand themes, a missing theme or an
 *  accent that is not a #rrggbb color give `base` itself. */
export function mascotPaletteFor(themeId: string | undefined, accent: string, accentDeep: string, base: Record<string, string> = MASCOT_PALETTE): Record<string, string> {
  if (!themeId || BRAND_THEMES[themeId] === true) return base;
  const a = parseHex(accent);
  const d = parseHex(accentDeep);
  if (!a || !d) return base;
  return {
    ...base,
    G: toHex(a),
    g: toHex(d),
    K: mix(base.K!, d, GI_TINT),
    D: mix(base.D!, d, GI_TINT),
    L: mix(base.L!, a, GI_TINT),
  };
}

let cachedAttr: string | undefined | null = null;
let cachedPalette: Record<string, string> = MASCOT_PALETTE;

/** The current theme attribute; callers compare it per frame to notice a theme change cheaply. */
export function themeAttr(): string | undefined {
  return document.documentElement.dataset.theme;
}

/** The mascot palette for the document's current color theme (season costume NOT applied: callers lay
 *  `seasonPalette(season, this)` over it). Same object until the theme changes. */
export function themedMascotPalette(): Record<string, string> {
  const attr = themeAttr();
  if (attr === cachedAttr) return cachedPalette;
  cachedAttr = attr;
  let accent = "", deep = "";
  try {
    const cs = getComputedStyle(document.documentElement);
    accent = cs.getPropertyValue("--accent");
    deep = cs.getPropertyValue("--accent-deep");
  } catch { /* no computed style: the brand palette */ }
  cachedPalette = mascotPaletteFor(attr, accent, deep);
  return cachedPalette;
}
