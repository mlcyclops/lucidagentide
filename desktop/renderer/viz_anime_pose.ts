// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_anime_pose.ts - P-VIZ.3 (ADR-0624): the anime mini Lucid's poses, clips, emotions and timing.
//
// PURE (no three, no DOM), so every number the figure animates with is testable. The figure (viz_anime.ts) is a
// rig of nested joints; a pose is one flat vector (root position, then an Euler XYZ rotation per joint in JOINTS
// order). Poses come from the approved anime lab (stance, typing, powerup, kiblast, dash, meditate, portrait,
// victory, powerdown) plus the in-between keys the activities need (wind-ups, strikes, glances, a bow).
//
// A clip is a list of keyframes on a clock. Each key names a pose and the ease of the segment that ARRIVES at it:
// "smooth" (smootherstep) for flowing moves, "snap" (ease-out-back with a slight overshoot) for strikes, so a
// sharp move reads as anticipation key, snap key, then a smooth settle key. Emotion lives in the EYES: every key
// carries an emotion (the pose's own unless overridden) and a gaze; the figure redraws its eye canvas only when
// the emotion, the blink step or the gaze bucket changes (eyeKey).

import { parseHex, type MiniActivity, type MiniLook } from "./viz_mini_look.ts";

export type AnimeState = "idle" | "working" | "paused" | "ended" | "killed" | "failed";
export const ANIME_STATES: readonly AnimeState[] = ["idle", "working", "paused", "ended", "killed", "failed"];

// ------------------------------------------------------------------------------------------ emotions (eye shapes)

export type EyeShape = "open" | "happy" | "closed" | "strain" | "x";
export interface Emotion {
  readonly shape: EyeShape; readonly open: number; readonly slant: number; readonly lower: number;
  readonly pupil: number; readonly brow: number; readonly browY: number; readonly sweat: boolean;
}
const E = (shape: EyeShape, open: number, slant: number, lower: number, pupil: number, brow: number, browY: number, sweat = false): Emotion =>
  ({ shape, open, slant, lower, pupil, brow, browY, sweat });

export const EMOTIONS = {
  neutral: E("open", 0.86, 0.05, 0.1, 1.0, 0.1, 0),
  focused: E("open", 0.58, 0.18, 0.28, 0.82, 0.32, -0.05),
  determined: E("open", 0.6, 0.42, 0.3, 0.68, 0.62, -0.1),
  strain: E("strain", 1, 0.5, 0, 1, 0.75, -0.12, true),
  happy: E("happy", 1, 0, 0, 1, -0.12, 0.12),
  calm: E("closed", 1, 0, 0, 1, 0.0, 0.02),
  surprised: E("open", 1.12, 0, 0, 0.42, -0.25, 0.3),
  tired: E("open", 0.32, -0.2, 0.05, 1.0, -0.3, -0.04),
  pain: E("open", 0.28, 0.35, 0.35, 0.8, -0.45, 0.06, true),
  ko: E("x", 1, 0, 0, 1, -0.3, 0.05),
} satisfies Record<string, Emotion>;
export type EmotionName = keyof typeof EMOTIONS;
export const EMOTION_NAMES = Object.keys(EMOTIONS) as EmotionName[];
const EMOTION_INDEX = Object.fromEntries(EMOTION_NAMES.map((n, i) => [n, i])) as Record<EmotionName, number>;

// ------------------------------------------------------------------------------------------ the look

export interface AnimeLook { gi: string; giDark: string; accent: string; hair: string; skin: string; eye: string }
/** The lab's skin tone, shared by every persona. */
export const ANIME_SKIN = "#f3c9a1";

type Rgb = readonly [number, number, number];
const toHex = (c: Rgb): string => `#${c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("")}`;
const scale = (c: Rgb, k: number): Rgb => [c[0] * k, c[1] * k, c[2] * k];

/** The lab look from a mini look: the suit as is, hair very dark and tinted toward the gi, the iris the accent
 *  darkened slightly, the lab's skin. */
export function animeLook(l: MiniLook): AnimeLook {
  const gi = parseHex(l.gi) ?? [0x22, 0x32, 0x4a];
  const accent = parseHex(l.accent) ?? [0x41, 0xff, 0x8b];
  return {
    gi: toHex(gi),
    giDark: toHex(parseHex(l.giShadow) ?? scale(gi, 0.55)),
    accent: toHex(accent),
    hair: toHex(scale(gi, 0.65)),
    skin: ANIME_SKIN,
    eye: toHex(scale(accent, 0.85)),
  };
}

// ------------------------------------------------------------------------------------------ pose vectors

export const JOINTS = ["root", "hips", "spine", "chest", "neck", "head", "shL", "elL", "shR", "elR", "hipL", "kneeL", "hipR", "kneeR"] as const;
export type Joint = (typeof JOINTS)[number];
/** Root position x, y, z, then three Euler angles per joint. */
export const POSE_LEN = 3 + JOINTS.length * 3;
/** Index of a joint's x rotation in a pose vector (y and z follow). */
export function jointOffset(j: Joint): number {
  return 3 + JOINTS.indexOf(j) * 3;
}

type V3 = readonly [number, number, number];
export type PoseDef = { readonly emotion: EmotionName; readonly rootX?: number; readonly rootY?: number; readonly rootZ?: number } & { readonly [J in Joint]?: V3 };

// The hand that shades the eyes in `scan`: the upper arm raised up and out, the forearm folded back so the hand
// sits at the brow beside the eye band (solved for the lab's shoulder, arm lengths and head height).
const SHADE_SH: V3 = [-2.92, 0, 0.47];
const SHADE_EL: V3 = [0.66, 0, -0.82];
const KATA_LEGS = { hipL: [-0.4, 0, -0.25], kneeL: [0.6, 0, 0], hipR: [0.3, 0, 0.25], kneeR: [0.45, 0, 0] } as const;

export const POSES = {
  // ---- the approved lab poses
  stance: { emotion: "focused", root: [0, -0.35, 0], hips: [0, 0.3, 0], chest: [0.05, -0.2, 0], head: [0, -0.15, 0], shL: [-1.2, 0, 0.45], elL: [-1.9, 0, 0], shR: [-0.9, 0, -0.35], elR: [-2.1, 0, 0], hipL: [-0.35, 0, -0.25], kneeL: [0.5, 0, 0], hipR: [0.3, 0, 0.25], kneeR: [0.35, 0, 0], rootY: -0.06 },
  typing: { emotion: "focused", chest: [0.2, 0, 0], head: [0.35, 0, 0], shL: [-1.0, 0, 0.3], elL: [-1.15, 0, 0], shR: [-1.0, 0, -0.3], elR: [-1.15, 0, 0], hipL: [0, 0, -0.08], hipR: [0, 0, 0.08] },
  powerup: { emotion: "strain", chest: [-0.2, 0, 0], head: [-0.3, 0, 0], shL: [0.15, 0, -0.5], elL: [-0.35, 0, 0], shR: [0.15, 0, 0.5], elR: [-0.35, 0, 0], hipL: [0, 0, -0.3], kneeL: [0.25, 0, 0], hipR: [0, 0, 0.3], kneeR: [0.25, 0, 0], rootY: -0.04 },
  kiblast: { emotion: "determined", root: [0, -1.05, 0], chest: [0, 0.45, 0], head: [0, 0.35, 0], shL: [-1.45, 0, 0.18], elL: [-0.1, 0, 0], shR: [-1.45, 0, -0.18], elR: [-0.1, 0, 0], hipL: [-0.45, 0, -0.2], kneeL: [0.35, 0, 0], hipR: [0.4, 0, 0.2], kneeR: [0.15, 0, 0] },
  dash: { emotion: "determined", root: [1.05, 0, 0], rootY: 0.55, chest: [0.15, 0, 0], head: [-0.95, 0, 0], shL: [-0.2, 0, -0.35], elL: [-0.6, 0, 0], shR: [-2.6, 0, 0.1], elR: [-0.1, 0, 0], hipL: [0.25, 0, -0.1], kneeL: [0.9, 0, 0], hipR: [0.05, 0, 0.1], kneeR: [0.3, 0, 0] },
  meditate: { emotion: "calm", rootY: 0.05, hipL: [-1.5, -0.9, -0.2], kneeL: [2.55, 0, 0], hipR: [-1.5, 0.9, 0.2], kneeR: [2.55, 0, 0], shL: [0.1, 0, -0.35], elL: [-1.1, 0, 0], shR: [0.1, 0, 0.35], elR: [-1.1, 0, 0], head: [0.05, 0, 0] },
  portrait: { emotion: "neutral", shL: [0, 0, -0.18], shR: [0, 0, 0.18], hipL: [0, 0, -0.1], hipR: [0, 0, 0.1] },
  victory: { emotion: "happy", chest: [-0.1, 0.15, 0], head: [-0.2, 0, 0], shR: [-3.0, 0, 0.25], elR: [-0.15, 0, 0], shL: [0.1, 0, -0.35], elL: [-1.6, 0, 0], hipL: [0, 0, -0.18], hipR: [0, 0, 0.18] },
  powerdown: { emotion: "ko", rootY: -0.45, spine: [0.45, 0, 0], head: [0.5, 0, 0.2], shL: [0.35, 0, -0.25], elL: [-0.3, 0, 0], shR: [0.25, 0, 0.2], elR: [-0.4, 0, 0], hipL: [-1.5, 0, -0.35], kneeL: [0.4, 0, 0], hipR: [-1.5, 0, 0.35], kneeR: [0.6, 0, 0] },

  // ---- P-VIZ.3 in-between keys
  typingGlance: { emotion: "neutral", chest: [0.12, 0.05, 0], head: [0.02, 0.22, 0], shL: [-1.0, 0, 0.3], elL: [-1.15, 0, 0], shR: [-1.0, 0, -0.3], elR: [-1.15, 0, 0], hipL: [0, 0, -0.08], hipR: [0, 0, 0.08] },
  kiReady: { emotion: "determined", root: [0, -1.05, 0], chest: [0, 0.45, 0], head: [0, 0.35, 0], shL: [-1.0, 0, 0.4], elL: [-2.0, 0, 0], shR: [-1.0, 0, -0.4], elR: [-2.0, 0, 0], hipL: [-0.45, 0, -0.2], kneeL: [0.35, 0, 0], hipR: [0.4, 0, 0.2], kneeR: [0.15, 0, 0] },
  kiCharge: { emotion: "determined", rootY: -0.08, root: [0, -1.05, 0], spine: [0.05, 0, 0], chest: [0.1, -0.35, 0], neck: [0, 0.5, 0], head: [0, 0.65, 0], shL: [0.35, 0, 0.25], elL: [-1.5, 0, 0], shR: [0.35, 0, -0.25], elR: [-1.5, 0, 0], hipL: [-0.55, 0, -0.25], kneeL: [0.6, 0, 0], hipR: [0.45, 0, 0.25], kneeR: [0.35, 0, 0] },
  punchWind: { emotion: "determined", rootY: -0.08, root: [0, -0.35, 0], hips: [0, 0.3, 0], chest: [0.05, 0.15, 0], head: [0, -0.5, 0], shL: [-1.2, 0, 0.45], elL: [-1.9, 0, 0], shR: [-0.6, 0, -0.2], elR: [-2.3, 0, 0], ...KATA_LEGS },
  punchR: { emotion: "determined", rootY: -0.08, root: [0, -0.35, 0], hips: [0, 0.3, 0], chest: [0.08, -0.65, 0], head: [0, 0.3, 0], shL: [-1.0, 0, 0.5], elL: [-2.2, 0, 0], shR: [-1.55, 0, -0.1], elR: [-0.05, 0, 0], ...KATA_LEGS },
  punchWindL: { emotion: "determined", rootY: -0.08, root: [0, -0.35, 0], hips: [0, 0.3, 0], chest: [0.05, -0.45, 0], head: [0, 0.1, 0], shL: [-0.6, 0, 0.2], elL: [-2.3, 0, 0], shR: [-1.2, 0, -0.35], elR: [-1.9, 0, 0], ...KATA_LEGS },
  punchL: { emotion: "determined", rootY: -0.08, root: [0, -0.35, 0], hips: [0, 0.3, 0], chest: [0.08, 0.4, 0], head: [0, -0.75, 0], shL: [-1.55, 0, 0.1], elL: [-0.05, 0, 0], shR: [-1.0, 0, -0.5], elR: [-2.2, 0, 0], ...KATA_LEGS },
  kickChamber: { emotion: "determined", rootY: -0.02, root: [0, -0.35, 0], hips: [0, 0.3, 0], spine: [-0.08, 0, 0], chest: [0, -0.2, 0], head: [0.05, -0.15, 0], shL: [-1.2, 0, 0.45], elL: [-1.9, 0, 0], shR: [-0.9, 0, -0.35], elR: [-2.1, 0, 0], hipL: [0.05, 0, -0.12], kneeL: [0.2, 0, 0], hipR: [-1.5, 0, 0.1], kneeR: [2.1, 0, 0] },
  kick: { emotion: "determined", rootY: -0.02, root: [0, -0.35, 0], hips: [0, 0.3, 0], spine: [-0.25, 0, 0], chest: [-0.05, -0.2, 0], head: [0.2, -0.15, 0], shL: [-0.9, 0, 0.7], elL: [-1.7, 0, 0], shR: [-0.6, 0, -0.6], elR: [-1.9, 0, 0], hipL: [0.15, 0, -0.12], kneeL: [0.2, 0, 0], hipR: [-1.45, 0, 0.1], kneeR: [0.1, 0, 0] },
  meditateDeep: { emotion: "calm", rootY: 0.08, hipL: [-1.5, -0.9, -0.2], kneeL: [2.55, 0, 0], hipR: [-1.5, 0.9, 0.2], kneeR: [2.55, 0, 0], shL: [0.15, 0, -0.3], elL: [-1.1, 0, 0], shR: [0.15, 0, 0.3], elR: [-1.1, 0, 0], head: [0.15, 0, 0] },
  scanCenter: { emotion: "focused", spine: [0.05, 0, 0], chest: [0.05, 0, 0], head: [-0.05, 0, 0], shL: [0.1, 0, -0.25], elL: [-0.6, 0, 0], shR: SHADE_SH, elR: SHADE_EL, hipL: [0, 0, -0.12], hipR: [0, 0, 0.12] },
  scanRight: { emotion: "focused", spine: [0.05, 0, 0], chest: [0.05, 0.15, 0], head: [-0.05, 0.4, 0], shL: [0.1, 0, -0.25], elL: [-0.6, 0, 0], shR: SHADE_SH, elR: SHADE_EL, hipL: [0, 0, -0.12], hipR: [0, 0, 0.12] },
  scanLeft: { emotion: "focused", spine: [0.05, 0, 0], chest: [0.05, -0.15, 0], head: [-0.05, -0.4, 0], shL: [0.1, 0, -0.25], elL: [-0.6, 0, 0], shR: SHADE_SH, elR: SHADE_EL, hipL: [0, 0, -0.12], hipR: [0, 0, 0.12] },
  scanSpot: { emotion: "surprised", rootY: 0.02, spine: [-0.05, 0, 0], chest: [0, -0.1, 0], head: [-0.12, -0.15, 0], shL: [0.05, 0, -0.4], elL: [-0.4, 0, 0], shR: SHADE_SH, elR: SHADE_EL, hipL: [0, 0, -0.12], hipR: [0, 0, 0.12] },
  dashCrouch: { emotion: "determined", rootY: -0.1, root: [0.2, 0, 0], spine: [0.3, 0, 0], chest: [0.15, 0, 0], head: [-0.4, 0, 0], shL: [0.6, 0, -0.3], elL: [-0.4, 0, 0], shR: [0.6, 0, 0.3], elR: [-0.4, 0, 0], hipL: [-0.8, 0, -0.15], kneeL: [1.3, 0, 0], hipR: [-0.8, 0, 0.15], kneeR: [1.3, 0, 0] },
  dashBrake: { emotion: "focused", rootY: -0.04, root: [-0.12, 0, 0], spine: [-0.12, 0, 0], head: [0.1, 0, 0], shL: [-0.9, 0, -0.6], elL: [-0.6, 0, 0], shR: [-0.9, 0, 0.6], elR: [-0.6, 0, 0], hipL: [-0.5, 0, -0.2], kneeL: [0.45, 0, 0], hipR: [0.25, 0, 0.2], kneeR: [0.6, 0, 0] },
  powerupWind: { emotion: "strain", rootY: -0.08, chest: [0.25, 0, 0], head: [0.2, 0, 0], shL: [-0.4, 0, 0.2], elL: [-2.0, 0, 0], shR: [-0.4, 0, -0.2], elR: [-2.0, 0, 0], hipL: [-0.3, 0, -0.25], kneeL: [0.5, 0, 0], hipR: [-0.3, 0, 0.25], kneeR: [0.5, 0, 0] },
  victoryCrouch: { emotion: "happy", rootY: -0.08, spine: [0.15, 0, 0], shR: [0.3, 0, 0.2], elR: [-1.8, 0, 0], shL: [0.1, 0, -0.3], elL: [-1.2, 0, 0], hipL: [-0.35, 0, -0.15], kneeL: [0.6, 0, 0], hipR: [-0.35, 0, 0.15], kneeR: [0.6, 0, 0] },
  victoryHop: { emotion: "happy", rootY: 0.12, chest: [-0.1, 0.15, 0], head: [-0.2, 0, 0], shR: [-3.0, 0, 0.25], elR: [-0.15, 0, 0], shL: [0.1, 0, -0.35], elL: [-1.6, 0, 0], hipL: [-0.2, 0, -0.18], kneeL: [0.4, 0, 0], hipR: [0, 0, 0.18], kneeR: [0.1, 0, 0] },
  flinch: { emotion: "pain", rootY: -0.04, spine: [-0.3, 0, 0], head: [-0.25, 0, 0.15], shL: [-1.3, 0, 0.35], elL: [-1.9, 0, 0], shR: [-1.3, 0, -0.35], elR: [-1.9, 0, 0], hipL: [-0.15, 0, -0.12], kneeL: [0.3, 0, 0], hipR: [0.1, 0, 0.12], kneeR: [0.25, 0, 0] },
  bow: { emotion: "happy", spine: [0.6, 0, 0], head: [0.3, 0, 0], shL: [0, 0, -0.08], shR: [0, 0, 0.08], hipL: [0, 0, -0.08], hipR: [0, 0, 0.08] },
  jolt: { emotion: "surprised", spine: [-0.15, 0, 0], head: [-0.2, 0, 0], shL: [0, 0, -0.5], elL: [-0.3, 0, 0], shR: [0, 0, 0.5], elR: [-0.3, 0, 0], hipL: [0, 0, -0.1], hipR: [0, 0, 0.1] },
} as const satisfies Record<string, PoseDef>;
export type PoseName = keyof typeof POSES;
export const LAB_POSES: readonly PoseName[] = ["stance", "typing", "powerup", "kiblast", "dash", "meditate", "portrait", "victory", "powerdown"];

/** A pose definition as a flat vector (missing joints are 0, the lab's convention). */
export function poseVector(p: PoseDef): Float32Array {
  const v = new Float32Array(POSE_LEN);
  v[0] = p.rootX ?? 0;
  v[1] = p.rootY ?? 0;
  v[2] = p.rootZ ?? 0;
  for (let j = 0; j < JOINTS.length; j++) {
    const r = p[JOINTS[j]!];
    if (!r) continue;
    v[3 + j * 3] = r[0];
    v[4 + j * 3] = r[1];
    v[5 + j * 3] = r[2];
  }
  return v;
}

export const POSE_VECTORS = Object.fromEntries(Object.entries(POSES).map(([k, p]) => [k, poseVector(p)])) as Record<PoseName, Float32Array>;

// ------------------------------------------------------------------------------------------ easing

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
export function fract(x: number): number {
  return x - Math.floor(x);
}
/** Smootherstep: zero velocity and acceleration at both ends, the flowing ease. */
export function smoothEase(x: number): number {
  const t = clamp01(x);
  return t * t * t * (t * (t * 6 - 15) + 10);
}
function smooth01(x: number): number {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
}
/** How far a snap overshoots (ease-out-back strength): about 6 percent past the key, then settles on it. */
export const SNAP_BACK = 1.25;
export function easeOutBack(x: number, s = SNAP_BACK): number {
  const t = clamp01(x) - 1;
  return 1 + (s + 1) * t * t * t + s * t * t;
}
export type Ease = "smooth" | "snap" | "linear";
export function ease(kind: Ease, u: number): number {
  return kind === "snap" ? easeOutBack(u) : kind === "linear" ? clamp01(u) : smoothEase(u);
}
/** Smooth up over [a, b], hold, smooth down over [c, d]. */
export function bump(u: number, a: number, b: number, c: number, d: number): number {
  return smooth01((u - a) / (b - a)) * (1 - smooth01((u - c) / (d - c)));
}
/** One key press inside a tap cycle: a quick press and release in the first 38 percent, then rest. */
export function tapCurve(u: number): number {
  if (u < 0 || u >= 0.38) return 0;
  const s = Math.sin((Math.PI * u) / 0.38);
  return s * s;
}

// ------------------------------------------------------------------------------------------ clips

export interface Key { readonly at: number; readonly pose: PoseName; readonly ease: Ease; readonly emotion: EmotionName; readonly gaze: number }
export interface Clip { readonly len: number; readonly loop: boolean; readonly keys: readonly Key[] }
export type ShotName = "powerup" | "victory";
export type ClipName = MiniActivity | ShotName | "failed" | "ended" | "killed";

const K = (at: number, pose: PoseName, e: Ease = "smooth", o: { emotion?: EmotionName; gaze?: number } = {}): Key =>
  ({ at, pose, ease: e, emotion: o.emotion ?? POSES[pose].emotion, gaze: o.gaze ?? 0 });

export const CLIPS: Readonly<Record<ClipName, Clip>> = {
  // Focused typing at the holo keyboard (the taps are layered by the figure), an occasional glance up and aside.
  typing: { len: 4.4, loop: true, keys: [K(0, "typing"), K(2.2, "typing"), K(2.5, "typingGlance", "smooth", { gaze: 0.6 }), K(3.1, "typingGlance", "smooth", { gaze: 0.6 }), K(3.35, "typing")] },
  // Coil and charge with determined eyes while the ki ball grows, a snap thrust that fires it, a smooth reset.
  kiblast: { len: 3.2, loop: true, keys: [K(0, "kiReady"), K(0.35, "kiCharge"), K(1.5, "kiCharge"), K(1.62, "kiblast", "snap"), K(2.3, "kiblast"), K(2.85, "kiReady")] },
  // Guard, then three snaps with a wind-up each: right punch, left punch, a chambered front kick.
  kata: {
    len: 4.2, loop: true,
    keys: [K(0, "stance"), K(0.45, "punchWind"), K(0.58, "punchR", "snap"), K(0.85, "punchR"), K(1.25, "stance"), K(1.6, "punchWindL"), K(1.73, "punchL", "snap"), K(2.0, "punchL"), K(2.4, "kickChamber"), K(2.55, "kick", "snap"), K(2.9, "kick"), K(3.2, "kickChamber"), K(3.6, "stance")],
  },
  // Floating cross-legged with calm closed eyes; the figure layers the float and the breath.
  meditate: { len: 6, loop: true, keys: [K(0, "meditate"), K(3, "meditateDeep")] },
  // Hand shading the eyes: snap a look right, sweep left, a surprised beat on a find, back to center.
  scan: {
    len: 5.2, loop: true,
    keys: [K(0, "scanCenter"), K(0.45, "scanRight", "snap", { gaze: 1 }), K(1.6, "scanRight", "smooth", { gaze: 1 }), K(2.1, "scanLeft", "smooth", { gaze: -1 }), K(3.1, "scanLeft", "smooth", { gaze: -1 }), K(3.25, "scanSpot", "snap", { gaze: -0.5 }), K(3.9, "scanSpot", "smooth", { gaze: -0.5 }), K(4.5, "scanCenter")],
  },
  // Crouch, snap into a lean-in dash (speed streaks while it flies), snap to a brake, settle.
  dash: { len: 2.8, loop: true, keys: [K(0, "stance"), K(0.4, "dashCrouch"), K(0.52, "dash", "snap"), K(1.7, "dash"), K(1.85, "dashBrake", "snap"), K(2.4, "stance")] },
  // burst(): fists in, snap open into the aura with strain > < eyes, hold, then the figure blends back.
  powerup: { len: 1.4, loop: false, keys: [K(0, "powerupWind"), K(0.14, "powerup", "snap"), K(1.05, "powerup"), K(1.4, "powerup")] },
  // A working turn ends: crouch, snap up into a fist-raised hop with happy ^ ^ eyes, then stand easy.
  victory: { len: 2.2, loop: false, keys: [K(0, "victoryCrouch"), K(0.3, "victoryCrouch"), K(0.45, "victoryHop", "snap"), K(0.75, "victory"), K(1.7, "victory"), K(2.2, "portrait", "smooth", { emotion: "happy" })] },
  // A tool failure: a snap flinch with pain eyes and a sweat drop, then back into a guard.
  failed: { len: 1.0, loop: false, keys: [K(0, "flinch"), K(0.35, "flinch"), K(1.0, "stance", "smooth", { emotion: "pain" })] },
  // Calm first, then a happy bow, then he rests calm.
  ended: { len: 4, loop: false, keys: [K(0, "portrait", "smooth", { emotion: "calm" }), K(0.8, "portrait", "smooth", { emotion: "calm" }), K(1.4, "bow"), K(2.2, "bow"), K(2.8, "portrait", "smooth", { emotion: "happy" }), K(4, "portrait", "smooth", { emotion: "calm" })] },
  // A jolt, then the power-down slump with KO x x eyes.
  killed: { len: 2, loop: false, keys: [K(0, "portrait"), K(0.12, "jolt", "snap"), K(0.4, "jolt"), K(1.4, "powerdown"), K(2, "powerdown")] },
};

/** Representative clip times for motion=false (a readable still of each clip). */
export const STILL_T: Readonly<Record<ClipName, number>> = {
  typing: 0.5, kiblast: 1.66, kata: 0.7, meditate: 0, scan: 1.0, dash: 1.0, powerup: 0.8, victory: 1.0, failed: 0.2, ended: 4, killed: 2,
};

/** The sampled key data besides the pose (reused by the caller, never allocated per frame). */
export interface ClipSample { emotion: EmotionName; gaze: number }

/** Time inside the clip: wrapped for a loop, clamped for a one-shot (a non-finite time reads as 0). */
export function clipTime(clip: Clip, t: number): number {
  if (!Number.isFinite(t)) return 0;
  return clip.loop ? t - Math.floor(t / clip.len) * clip.len : Math.min(Math.max(t, 0), clip.len);
}

export function clipDone(clip: Clip, t: number): boolean {
  return !clip.loop && t >= clip.len;
}

/** Writes the clip's pose at `t` into `out` and its emotion and gaze into `info`. A loop's last key eases back
 *  into its first. The emotion switches halfway through a smooth segment and at once on a snap. */
export function sampleClip(clip: Clip, t: number, out: Float32Array, info: ClipSample): void {
  const keys = clip.keys;
  const n = keys.length;
  const tt = clipTime(clip, t);
  let i = n - 1;
  for (let k = 0; k < n - 1; k++) {
    if (tt < keys[k + 1]!.at) { i = k; break; }
  }
  const a = keys[i]!;
  const last = i === n - 1;
  const b = last ? (clip.loop ? keys[0]! : a) : keys[i + 1]!;
  const span = last ? clip.len - a.at : b.at - a.at;
  const u = span > 0 ? Math.min(1, (tt - a.at) / span) : 1;
  const w = ease(b.ease, u);
  const pa = POSE_VECTORS[a.pose];
  const pb = POSE_VECTORS[b.pose];
  for (let c = 0; c < POSE_LEN; c++) out[c] = pa[c]! + (pb[c]! - pa[c]!) * w;
  info.emotion = (b.ease === "snap" ? u > 0 : w >= 0.5) ? b.emotion : a.emotion;
  info.gaze = a.gaze + (b.gaze - a.gaze) * clamp01(w);
}

/** What the figure plays for a state: the state's own clip, or the current activity. */
export function clipFor(state: AnimeState, activity: MiniActivity): ClipName {
  return state === "killed" || state === "ended" || state === "failed" ? state : activity;
}

/** A one-shot fired by a state change: a working turn that ends plays the victory. */
export function transitionShot(prev: AnimeState, next: AnimeState): ShotName | null {
  return prev === "working" && next === "idle" ? "victory" : null;
}

/** The activity clock's speed: faster with the intensity while working, frozen while paused. */
export function tempoFor(state: AnimeState, k: number): number {
  const x = Number.isFinite(k) ? clamp01(k) : 0;
  return state === "working" ? 0.75 + 0.6 * x : state === "paused" ? 0 : state === "idle" ? 0.7 : 1;
}

/** States speak through the eyes over the clip: paused is tired, a failure hurts (pain with a sweat drop). */
export function stateEmotion(state: AnimeState, clipEmotion: EmotionName): EmotionName {
  return state === "paused" ? "tired" : state === "failed" ? "pain" : clipEmotion;
}

// ------------------------------------------------------------------------------------------ eyes: blink and gaze

export const BLINK_MIN_S = 2.5;
export const BLINK_MAX_S = 5;
export const BLINK_S = 0.16;
/** Lid closure per blink step (0 open, 1 half, 2 shut). */
export const BLINK_LEVELS: readonly number[] = [0, 0.55, 1];

/** Seconds to the next blink from a uniform random number in [0, 1). */
export function nextBlinkDelay(r: number): number {
  return BLINK_MIN_S + (BLINK_MAX_S - BLINK_MIN_S) * clamp01(Number.isFinite(r) ? r : 0.5);
}

/** The blink step `age` seconds into a blink: half, shut, half, open (0 outside the blink). */
export function blinkStep(age: number): number {
  if (!(age >= 0) || age >= BLINK_S) return 0;
  const v = Math.sin((Math.PI * age) / BLINK_S);
  return v > 0.75 ? 2 : v > 0.25 ? 1 : 0;
}

/** Gaze -1 (his right) .. 1 (his left) quantized to five buckets, -2..2. */
export function gazeBucket(g: number): number {
  const x = Number.isFinite(g) ? Math.min(1, Math.max(-1, g)) : 0;
  return Math.round(x * 2);
}
export function gazeOfBucket(b: number): number {
  return b / 2;
}

/** One number per distinct eye drawing: the eye canvas is redrawn only when this changes. */
export function eyeKey(emotion: EmotionName, blink: number, gaze: number): number {
  return EMOTION_INDEX[emotion] * 100 + blink * 10 + (gaze + 2);
}

// ------------------------------------------------------------------------------------------ effect timing

/** kiblast clip: the ball appears and grows from KI_CHARGE_S, is fully grown at KI_FULL_S, fires at KI_FIRE_S and
 *  flies for KI_FLY_S while it swells and fades. */
export const KI_CHARGE_S = 0.35;
export const KI_FULL_S = 1.5;
export const KI_FIRE_S = 1.62;
export const KI_FLY_S = 0.55;
export interface KiBall { scale: number; alpha: number; fly: number }

/** The ki ball at kiblast clip time `t`: fly is -1 while held (or hidden), else the flight progress 0..1. */
export function kiBallAt(t: number, out: KiBall): KiBall {
  if (t >= KI_CHARGE_S && t < KI_FIRE_S) {
    out.scale = 0.2 + 0.8 * smooth01((t - KI_CHARGE_S) / (KI_FULL_S - KI_CHARGE_S));
    out.alpha = 1;
    out.fly = -1;
  } else if (t >= KI_FIRE_S && t < KI_FIRE_S + KI_FLY_S) {
    const f = (t - KI_FIRE_S) / KI_FLY_S;
    out.fly = f;
    out.scale = 1 + 0.6 * f;
    out.alpha = 1 - smooth01(f);
  } else {
    out.scale = 0;
    out.alpha = 0;
    out.fly = -1;
  }
  return out;
}

/** dash clip: how fast he is flying (drives the speed streaks and the tails), 0 outside the dash. */
export function dashSpeed(t: number): number {
  return t < 0.5 || t > 1.85 ? 0 : bump(t, 0.5, 0.6, 1.7, 1.85);
}

/** powerup one-shot: the aura level over the shot. */
export function auraLevel(t: number): number {
  return t < 0 || t > 1.4 ? 0 : bump(t, 0, 0.12, 1.0, 1.4);
}

/** A short decaying shake at the start of a powerup or a failure. */
export function shakeLevel(t: number): number {
  return t < 0 || t >= 0.45 ? 0 : 1 - t / 0.45;
}
