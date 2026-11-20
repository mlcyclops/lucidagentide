// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_mini_look.ts - P-VIZ.2 (ADR-0623), P-VIZ.3 (ADR-0624): what each mini Lucid wears and does.
//
// PURE (no three, no DOM). The Visualize view gives every node its own anime mini Lucid (viz_anime.ts): the
// persona color becomes his accent (headband, belt, wraps) and the gi is tinted toward it but kept dark, so the
// accent always reads against the suit. Each persona has a repertoire of activities (a coder mostly types, a
// guard runs kata and dashes) and `activityAt` rotates through it every MINI_ACTIVITY_MS like mascot.ts
// `workActivity`, with a per-node seed so a fleet never moves in lockstep. An idle node meditates.

export type MiniActivity = "typing" | "kiblast" | "kata" | "meditate" | "scan" | "dash";
export const MINI_ACTIVITIES: readonly MiniActivity[] = ["typing", "kiblast", "kata", "meditate", "scan", "dash"];

/** CSS hex colors. accent = headband/belt/wraps glow; gi/giShadow/giHighlight = the suit. */
export interface MiniLook { accent: string; accentDeep: string; gi: string; giShadow: string; giHighlight: string }

export type MiniKind = "hub" | "agent" | "subagent";

/** One activity slot lasts this long (the same beat as mascot.ts ACTIVITY_MS). */
export const MINI_ACTIVITY_MS = 6500;
/** The brand accent (mascot.ts MASCOT_PALETTE.G): the fallback for a missing or invalid persona color. */
export const BRAND_ACCENT = "#41ff8b";
/** Accent vs gi contrast floor (WCAG AA for normal text): the glow must read against the suit. */
export const MIN_ACCENT_CONTRAST = 4.5;
/** The gi never gets brighter than this relative luminance: it is a dark suit in every color. */
export const GI_MAX_LUMINANCE = 0.05;

type Rgb = readonly [number, number, number];

const NAVY: Rgb = [0x22, 0x31, 0x40];
const INK: Rgb = [0x05, 0x08, 0x0b];
const WHITE: Rgb = [0xff, 0xff, 0xff];
const BLACK: Rgb = [0, 0, 0];

/** "#rgb" or "#rrggbb" (any case, surrounding whitespace ignored) to 0..255 channels; anything else is null. */
export function parseHex(color: string): Rgb | null {
  const s = typeof color === "string" ? color.trim() : "";
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(s);
  if (short) return [parseInt(short[1]! + short[1]!, 16), parseInt(short[2]! + short[2]!, 16), parseInt(short[3]! + short[3]!, 16)];
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(s);
  if (long) return [parseInt(long[1]!, 16), parseInt(long[2]!, 16), parseInt(long[3]!, 16)];
  return null;
}

function hex(c: Rgb): string {
  return `#${c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("")}`;
}

/** Rounded to whole channels, so every contrast check runs on exactly the color that is emitted. */
function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];
}

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function lum(c: Rgb): number {
  return 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
}

function ratio(a: Rgb, b: Rgb): number {
  const la = lum(a);
  const lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** WCAG relative luminance of a hex color (0 for an invalid one). */
export function relativeLuminance(color: string): number {
  const c = parseHex(color);
  return c ? lum(c) : 0;
}

/** WCAG contrast ratio of two hex colors (1 when either is invalid). */
export function contrastRatio(a: string, b: string): number {
  const ca = parseHex(a);
  const cb = parseHex(b);
  return ca && cb ? ratio(ca, cb) : 1;
}

/** A full suit from a persona color: accent = the persona color (lifted toward white only when it cannot
 *  reach MIN_ACCENT_CONTRAST against even the darkest gi), gi = brand navy tinted toward the accent and kept
 *  dark, plus a shadow, a highlight panel color and a deep accent for knots and key caps. */
export function lookFor(personaColor: string): MiniLook {
  let accent: Rgb = parseHex(personaColor) ?? parseHex(BRAND_ACCENT)!;
  let gi = mix(NAVY, accent, 0.1);
  for (let i = 0; i < 24 && lum(gi) > GI_MAX_LUMINANCE; i++) gi = mix(gi, INK, 0.2);
  for (let i = 0; i < 24 && ratio(accent, gi) < MIN_ACCENT_CONTRAST; i++) gi = mix(gi, INK, 0.2);
  for (let i = 0; i < 48 && (ratio(accent, gi) < MIN_ACCENT_CONTRAST || lum(accent) <= lum(gi)); i++) accent = mix(accent, WHITE, 0.1);
  return {
    accent: hex(accent),
    accentDeep: hex(mix(accent, INK, 0.5)),
    gi: hex(gi),
    giShadow: hex(mix(gi, BLACK, 0.4)),
    giHighlight: hex(mix(mix(gi, accent, 0.1), WHITE, 0.14)),
  };
}

// Repertoires never repeat an activity back to back (wrap-around included), so every slot boundary is a
// visible change.
const HUB: readonly MiniActivity[] = ["typing", "meditate", "typing", "kata", "typing", "scan"];
const REPERTOIRES: Readonly<Record<string, readonly MiniActivity[]>> = {
  coder: ["typing", "scan", "typing", "kata", "typing", "kiblast"],
  tester: ["kiblast", "scan", "kiblast", "typing", "scan", "kata"],
  guard: ["kata", "dash", "scan", "kata", "dash", "kiblast"],
  writer: ["typing", "meditate", "typing", "scan", "typing", "meditate"],
  researcher: ["scan", "typing", "scan", "meditate", "scan", "typing"],
  reviewer: ["scan", "typing", "kata", "scan", "typing", "meditate"],
  planner: ["meditate", "scan", "typing", "meditate", "scan", "kata"],
  lead: ["meditate", "kata", "scan", "kata", "meditate", "kiblast"],
  builder: ["typing", "kata", "typing", "kiblast", "typing", "dash"],
  scout: ["scan", "dash", "scan", "kiblast", "typing", "dash"],
};

/** The rotation a node works through. The hub is the coding seat (typing-heavy, with its lead's calm); an
 *  unknown persona works like a coder. */
export function activitiesFor(persona: string, kind: MiniKind): readonly MiniActivity[] {
  if (kind === "hub") return HUB;
  return Object.prototype.hasOwnProperty.call(REPERTOIRES, persona) ? REPERTOIRES[persona]! : REPERTOIRES.coder!;
}

function hash32(x: number): number {
  let h = (x + 0x9e3779b9) | 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** The activity at `tMs`: deterministic, one slot per MINI_ACTIVITY_MS, with the seed shifting both the
 *  starting slot and the moment of each switch. Not working means meditating. */
export function activityAt(persona: string, kind: MiniKind, seed: number, tMs: number, working: boolean): MiniActivity {
  if (!working) return "meditate";
  const list = activitiesFor(persona, kind);
  const h = hash32(Number.isFinite(seed) ? Math.floor(Math.abs(seed)) % 2147483647 : 0);
  const phase = ((h % 1009) / 1009) * MINI_ACTIVITY_MS;
  const start = (h >>> 12) % list.length;
  const t = Number.isFinite(tMs) ? Math.max(0, tMs) : 0;
  const slot = Math.floor((t + phase) / MINI_ACTIVITY_MS);
  return list[(start + slot) % list.length]!;
}
