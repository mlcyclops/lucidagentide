// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/agents_rail_art.ts - P-RAIL.AGENTS1: the Agents view's art, ported from the approved mockup
// (mockups/agents-rail/a-glass-brick.html, Direction A). Pure SVG markup strings, no DOM:
//   agentArt(state)  the Brick Brigade brick (54 x 40 units: bevel, recessed window, gloss band, glass streaks,
//                    specular dot, troop trim) made translucent in the Agent's color, a seated chibi Lucid in its
//                    window (meditating when idle, typing when working);
//   toggleArt()      the rail toggle's mini Lucid bust (brand palette, 24 x 24);
//   palettes         the six mascot themes from mascot.ts plus a custom hue.
// Every color comes from CSS variables (--K gi, --D gi shadow, --L gi highlight, --G accent, --g accent shade) set
// on the tile, so recoloring an Agent is a style write, never a re-render. Every class is `agr-` prefixed and
// styled by the one `.agr-*` block in styles.css (motion, states, reduced motion).

import { MASCOT_THEMES } from "./mascot.ts";
import { THEME_KEYS, type ThemeKey } from "./agents_store.ts";

export interface AgentPalette { name: string; K: string; D: string; L: string; G: string; g: string; hue: number }

/** The slider position each preset maps to (its accent's hue). */
export const THEME_HUES: Record<ThemeKey, number> = { lucid: 145, ember: 21, glacier: 191, orchid: 288, solar: 50, stealth: 150 };

export function themePalette(k: ThemeKey): AgentPalette {
  const t = MASCOT_THEMES[k];
  const p = t.palette;
  return { name: t.name, K: p.K!, D: p.D!, L: p.L!, G: p.G!, g: p.g!, hue: THEME_HUES[k] };
}

export function huePalette(h: number): AgentPalette {
  const hue = ((Math.round(h) % 360) + 360) % 360;
  return { name: `Custom ${hue}°`, K: `hsl(${hue} 30% 21%)`, D: `hsl(${hue} 30% 14%)`, L: `hsl(${hue} 28% 36%)`, G: `hsl(${hue} 100% 63%)`, g: `hsl(${hue} 64% 34%)`, hue };
}

export function paletteOf(a: { theme: ThemeKey | null; hue: number }): AgentPalette {
  return a.theme ? themePalette(a.theme) : huePalette(a.hue);
}

/** Inline style for a tile / module: the five palette variables. Values are our own constants or hsl() of a
 *  clamped integer, never user text. */
export function paletteStyle(p: AgentPalette): string {
  return `--K:${p.K};--D:${p.D};--L:${p.L};--G:${p.G};--g:${p.g}`;
}

export const PRESETS: readonly { key: ThemeKey; palette: AgentPalette }[] = THEME_KEYS.map((key) => ({ key, palette: themePalette(key) }));

export type ArtState = "idle" | "work";

/** The seated chibi ninja, figure units 40 x 40. */
function figure(st: ArtState): string {
  const work = st === "work";
  const legs = '<path class="agr-fK agr-sk" d="M8.6 35.2c0-3.6 2.8-5.6 7-5.8h8.8c4.2.2 7 2.2 7 5.8 0 1.5-1.1 2.3-2.6 2.3H11.2c-1.5 0-2.6-.8-2.6-2.3z"/>'
    + '<path class="agr-sD" d="M13 34.4c4.6 1.5 9.4 1.5 14 0"/><path class="agr-sL" d="M11.2 33.2c.6-1.2 1.6-1.9 3-2.2M28.8 33.2c-.6-1.2-1.6-1.9-3-2.2"/>';
  const kb = work
    ? '<g><rect class="agr-kb-b" x="10.6" y="31.4" width="18.8" height="2.6" rx="1"/><rect class="agr-kb-k agr-k1" x="13" y="32.1" width="2.4" height="1.1" rx=".3"/>'
      + '<rect class="agr-kb-k agr-k2" x="24.6" y="32.1" width="2.4" height="1.1" rx=".3"/><rect class="agr-kb-k" x="16.4" y="32.1" width="7.2" height="1.1" rx=".3" opacity=".45"/></g>'
    : "";
  const torso = '<path class="agr-fK agr-sk" d="M14.2 21.8h11.6c1.3 0 2.1.8 2.3 2l1 6.4H10.9l1-6.4c.2-1.2 1-2 2.3-2z"/>'
    + '<path class="agr-sD" d="M16.8 22.2l4.2 4.8M23.2 22.2l-2.4 2.8"/>'
    + '<rect class="agr-fG" x="11.2" y="27.9" width="17.6" height="2.1" rx=".5"/><rect class="agr-fg" x="19.1" y="27.6" width="1.8" height="2.7" rx=".5"/>';
  const arms = work
    ? '<path class="agr-fK agr-sk" d="M13.6 23.4c-2.4 1.2-3.4 3.2-3.4 5.4.1.9.8 1.4 1.7 1.3l2.6-1.4z"/><path class="agr-fK agr-sk" d="M26.4 23.4c2.4 1.2 3.4 3.2 3.4 5.4-.1.9-.8 1.4-1.7 1.3l-2.6-1.4z"/>'
    : '<path class="agr-fK agr-sk" d="M13.6 23.4c-2.8 1.8-3.4 4-3.2 6.2.4 1.2 1.6 1.4 2.6 1l3-1.4z"/><path class="agr-fK agr-sk" d="M26.4 23.4c2.8 1.8 3.4 4 3.2 6.2-.4 1.2-1.6 1.4-2.6 1l-3-1.4z"/>'
      + '<ellipse class="agr-fS agr-sk2" cx="20" cy="31.2" rx="2.9" ry="1.5"/>';
  const hands = work
    ? '<g class="agr-hl"><path class="agr-fK agr-sk" d="M11.2 29.2c1.3 1.2 2.6 1.6 3.8 1.3l.2-1.7c-1.2.1-2.4-.1-3.4-.6z"/><circle class="agr-fS agr-sk2" cx="15.7" cy="30.5" r="1.45"/></g>'
      + '<g class="agr-hr"><path class="agr-fK agr-sk" d="M28.8 29.2c-1.3 1.2-2.6 1.6-3.8 1.3l-.2-1.7c1.2.1 2.4-.1 3.4-.6z"/><circle class="agr-fS agr-sk2" cx="24.3" cy="30.5" r="1.45"/></g>'
      + '<rect class="agr-bit agr-b1" x="16.2" y="28.4" width="1.1" height="1.1"/><rect class="agr-bit agr-b2" x="22.6" y="28" width="1.1" height="1.1"/>'
    : "";
  const head = '<g class="agr-head">'
    + '<g class="agr-tail"><path class="agr-fG agr-sk3" d="M29.4 10.6c2.6-1.4 5-1.2 7.2.2l-.8 1.3c-2-.9-4-.9-6 .2z"/><path class="agr-fg agr-sk3" d="M29.4 12.3c2.4.2 4.3 1.3 5.6 3.2l-1.2.8c-1.1-1.5-2.6-2.4-4.4-2.6z"/></g>'
    + '<rect class="agr-fK agr-sk" x="9.4" y="3.4" width="21.2" height="19.4" rx="8.4"/>'
    + '<path class="agr-sL agr-sheen" d="M14 5.9c4-1.6 8-1.6 12 0"/>'
    + '<rect class="agr-fG" x="9.85" y="9" width="20.3" height="3.1"/><rect class="agr-fg" x="9.9" y="11.45" width="20.2" height=".65"/>'
    + '<rect class="agr-fg agr-sk3" x="28.2" y="9.3" width="2.6" height="2.5" rx=".7"/>'
    + '<rect class="agr-fS" x="11.9" y="12.8" width="16.2" height="5.6" rx="2.4"/><path class="agr-fs" d="M12.3 16.8h15.4v.3c0 .7-.5 1.3-1.2 1.3H13.5c-.7 0-1.2-.6-1.2-1.3z"/>'
    + '<g class="agr-eyes"><ellipse class="agr-fW" cx="16.4" cy="15.4" rx="2.15" ry="1.8"/><ellipse class="agr-fW" cx="23.6" cy="15.4" rx="2.15" ry="1.8"/>'
    + '<g class="agr-pup"><circle class="agr-fB" cx="16.4" cy="15.5" r="1.08"/><circle class="agr-fB" cx="23.6" cy="15.5" r="1.08"/><circle class="agr-fW" cx="16.8" cy="15.05" r=".36"/><circle class="agr-fW" cx="24" cy="15.05" r=".36"/></g></g>'
    + '<path class="agr-ec agr-sB" d="M14.5 15.5q1.9 1.4 3.8 0M21.7 15.5q1.9 1.4 3.8 0"/>'
    + "</g>";
  return legs + kb + '<g class="agr-upper">' + torso + arms + head + "</g>" + hands;
}

let uidSeq = 0;

/** The glass brick holding the Lucid. `delay` (seconds, negative) de-syncs the loops between Agents. */
export function agentArt(st: ArtState, delay: number, cls = ""): string {
  const u = `agr${++uidSeq}`;
  const dl = Number.isFinite(delay) ? delay.toFixed(2) : "0";
  return `<svg class="agr-art agr-lu agr-${st}${cls ? ` ${cls}` : ""}" viewBox="0 0 54 40" style="--dl:${dl}s" aria-hidden="true" focusable="false">`
    + `<defs><linearGradient id="${u}b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="agr-bkHi"/><stop offset=".45" class="agr-bkMid"/><stop offset="1" class="agr-bkSh"/></linearGradient>`
    + `<linearGradient id="${u}w" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#03060d"/><stop offset="1" stop-color="#101a30"/></linearGradient>`
    + `<radialGradient id="${u}g" cx=".5" cy=".62" r=".62"><stop offset="0" class="agr-glow0"/><stop offset="1" class="agr-glow1"/></radialGradient>`
    + `<linearGradient id="${u}s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".42"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>`
    + `<radialGradient id="${u}p" cx="8" cy="5" r="5" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff" stop-opacity=".95"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>`
    + `<clipPath id="${u}c"><rect x="5" y="5" width="44" height="30" rx="4"/></clipPath><clipPath id="${u}o"><rect x=".5" y=".5" width="53" height="39" rx="6"/></clipPath></defs>`
    + `<rect x=".5" y=".5" width="53" height="39" rx="6" fill="url(#${u}b)"/>`
    + '<path d="M2 34V6a4 4 0 0 1 4-4h42" fill="none" stroke="#fff" stroke-opacity=".55" stroke-width="1.2"/>'
    + '<path d="M52 6v28a4 4 0 0 1-4 4H6" fill="none" stroke="#000" stroke-opacity=".45" stroke-width="1.2"/>'
    + '<rect class="agr-bk-trim" x="3" y="3" width="48" height="34" rx="4.5"/>'
    + `<rect x="5" y="5" width="44" height="30" rx="4" fill="url(#${u}w)"/>`
    + `<rect class="agr-aura" x="5" y="5" width="44" height="30" rx="4" fill="url(#${u}g)"/>`
    + `<g clip-path="url(#${u}c)"><g transform="translate(10.2 3.75) scale(.84)">${figure(st)}</g></g>`
    + '<rect x="5" y="5" width="44" height="30" rx="4" fill="none" stroke="#000" stroke-opacity=".7"/>'
    + '<path d="M8 35.6h38" stroke="#fff" stroke-opacity=".28" stroke-width=".6"/>'
    + `<g clip-path="url(#${u}o)"><path d="M0 0h54v13.6Q27 20 0 15.2z" fill="url(#${u}s)"/>`
    + '<path d="M11 35 19 5h5l-8 30z" fill="#fff" fill-opacity=".14"/><path d="M22 35 30 5h2l-8 30z" fill="#fff" fill-opacity=".08"/>'
    + `<circle cx="8" cy="5" r="5" fill="url(#${u}p)"/></g>`
    + '<rect x=".5" y=".5" width="53" height="39" rx="6" fill="none" stroke="#000" stroke-opacity=".35" stroke-width=".8"/>'
    + "</svg>";
}

/** The dashed "+ Add agent" glyph, in the art slot. */
export function addArt(): string {
  return '<svg class="agr-art agr-add-art" viewBox="0 0 40 28" aria-hidden="true" focusable="false"><rect x="1" y="1" width="38" height="26" rx="5"/><path d="M20 9v10M15 14h10"/></svg>';
}

/** The rail toggle: a mini Lucid bust in the brand palette (24 x 24). Hover tilts the head, flutters the
 *  scarf, swaps to happy eyes and pops a spark (all CSS, `.agr-toggle`). */
export function toggleArt(): string {
  return '<svg class="agr-tb-fig" viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
    + '<path d="M5.2 23.5c0-4 2.8-5.6 6.8-5.6s6.8 1.6 6.8 5.6z" fill="#223140" stroke="#10161d" stroke-width=".7"/>'
    + '<path d="M9.6 18.2 12 21l2.4-2.8" fill="none" stroke="#18232e" stroke-width=".8"/>'
    + '<g class="agr-tb-head">'
    + '<g class="agr-tb-tail"><path d="M18.6 7.6c1.9-1 3.6-.9 5 .1l-.6 1c-1.4-.6-2.8-.6-4.2.1z" fill="#41ff8b" stroke="#10161d" stroke-width=".35"/><path d="M18.6 8.9c1.6.1 2.9.9 3.8 2.2l-.9.6c-.7-1-1.7-1.6-2.9-1.8z" fill="#1e8f52"/></g>'
    + '<rect x="4.2" y="2.4" width="15.6" height="15.4" rx="6.4" fill="#223140" stroke="#10161d" stroke-width=".7"/>'
    + '<path d="M7.6 4.3c3-1.2 5.8-1.2 8.8 0" fill="none" stroke="#3d5a73" stroke-width="1.1" stroke-linecap="round"/>'
    + '<rect x="4.55" y="6.6" width="14.9" height="2.5" fill="#41ff8b"/><rect x="4.6" y="8.5" width="14.8" height=".6" fill="#1e8f52"/>'
    + '<rect x="17.6" y="6.8" width="2" height="2" rx=".5" fill="#1e8f52" stroke="#10161d" stroke-width=".3"/>'
    + '<rect x="6.2" y="9.8" width="11.6" height="4.4" rx="1.9" fill="#eec39a"/>'
    + '<g class="agr-tb-eyes"><ellipse cx="9.3" cy="12" rx="1.6" ry="1.35" fill="#f4f7f5"/><ellipse cx="14.7" cy="12" rx="1.6" ry="1.35" fill="#f4f7f5"/><circle cx="9.3" cy="12.1" r=".82" fill="#0a0e12"/><circle cx="14.7" cy="12.1" r=".82" fill="#0a0e12"/><circle cx="9.6" cy="11.75" r=".28" fill="#fff"/><circle cx="15" cy="11.75" r=".28" fill="#fff"/></g>'
    + '<path class="agr-tb-happy" d="M8 12.6l1.3-1.3 1.3 1.3M13.4 12.6l1.3-1.3 1.3 1.3" fill="none" stroke="#0a0e12" stroke-width=".8" stroke-linecap="round" stroke-linejoin="round"/>'
    + "</g>"
    + '<path class="agr-tb-spark" d="M21 1.2l.55 1.45L23 3.2l-1.45.55L21 5.2l-.55-1.45L19 3.2l1.45-.55z" fill="#41ff8b"/>'
    + "</svg>";
}

/** Module icons (24 x 24 strokes, from the mockup). */
const ICON_PATHS = {
  pencil: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14 6l4 4"/>',
  play: '<path d="M8 5.5v13l10-6.5z"/>',
  chev: '<path d="M9 6l6 6-6 6"/>',
  chat: '<path d="M4 5.5h16v10a1.5 1.5 0 0 1-1.5 1.5H9l-4 3.2V17H5.5A1.5 1.5 0 0 1 4 15.5z"/>',
  fleet: '<path d="M4 4h7v7H4z"/><path d="M13 4h7v7h-7z"/><path d="M4 13h7v7H4z"/><path d="M13 13h7v7h-7z"/>',
  world: '<circle cx="12" cy="12" r="8"/><path d="M4 12h16"/><path d="M12 4c2.6 2.6 2.6 13.4 0 16"/><path d="M12 4c-2.6 2.6-2.6 13.4 0 16"/>',
  trash: '<path d="M5 7h14"/><path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7"/><path d="M6.6 7l.8 11.1A1.6 1.6 0 0 0 9 19.6h6a1.6 1.6 0 0 0 1.6-1.5L17.4 7"/>',
  up: '<path d="M7 14l5-5 5 5"/>',
  down: '<path d="M7 10l5 5 5-5"/>',
} as const;

export function agrIcon(name: keyof typeof ICON_PATHS, size: number, cls = ""): string {
  return `<svg${cls ? ` class="${cls}"` : ""} width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICON_PATHS[name]}</svg>`;
}
