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
//
// P-VIZ.4 (ADR-0628): the `supervise` clip (the hub watching his team, with a ticking holo checklist), the glare
// and angry eyes, and the reaction timeline (stare / outburst) the figure layers over its activity.
//
// P-VIZ.6 (ADR-0637): who a node is (seededGender, shared with the office cast so a node keeps its gender across
// styles), the hit reactions (planHit / sampleHit: a one-shot clip per hit, turned toward the throw, replaced
// cleanly by the next hit) and the charge a bolt, an energy ball or an energy drink leaves behind (Charge).
//
// P-VIZ.7 (ADR-0641): the variant weapons (weaponOf / weaponAt: katana, kunai, staff, chakram) and their moves,
// played on some loops of the kata, dash and kiblast slots (weaponTurn); the git commit's `commit` loop and its
// glowing `raiden` eyes.

import { mix32 } from "./viz_cast.ts"; // P-WORLDS.CAST1 (ADR-0649): moved there, unchanged
import { parseHex, type MiniActivity, type MiniLook } from "./viz_mini_look.ts";
import type { HitKind } from "./viz_throw_kinds.ts";
import { isTrayReactionKind, type TrayReactionKind } from "./viz_tray_reactions.ts";

export type AnimeState = "idle" | "working" | "paused" | "ended" | "killed" | "failed";
export const ANIME_STATES: readonly AnimeState[] = ["idle", "working", "paused", "ended", "killed", "failed"];

// ------------------------------------------------------------------------------------------ emotions (eye shapes)

/** P-VIZ.7 (ADR-0641): "glow" is the commit's blank, glowing white-blue eyes (no iris, light bleeding out). */
export type EyeShape = "open" | "happy" | "closed" | "strain" | "x" | "glow";
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
  // P-VIZ.4 (ADR-0628) reactions: the narrowed, annoyed stare at the camera and the outburst's sharp V brows
  glare: E("open", 0.42, 0.5, 0.42, 0.4, 0.85, -0.14),
  angry: E("open", 0.55, 0.7, 0.3, 0.36, 1.05, -0.2),
  // P-VIZ.6 (ADR-0637): the caught throwing star, heavy-lidded and pleased with himself
  smug: E("open", 0.42, -0.15, 0.4, 0.85, -0.25, 0.1),
  // P-VIZ.7 (ADR-0641): the git commit, channeling the storm: blank glowing eyes under hard, level brows
  raiden: E("glow", 0.62, 0.3, 0.3, 1, 0.6, -0.1),
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
// Folded arms in `supervise`: each upper arm swings forward and twists about its own axis so the elbow bend lays
// the forearm across the chest (horizontal for that swing); the right forearm rides a little higher, over the left.
const CROSSED = { shL: [-0.85, 1.4, 0], elL: [-1.38, 0, 0], shR: [-0.95, -1.4, 0], elR: [-1.34, 0, 0] } as const;
const WIDE_FEET = { hipL: [0, 0, -0.14], hipR: [0, 0, 0.14] } as const;

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

  // ---- P-VIZ.4 (ADR-0628): supervising his team (arms folded, chest out, looking over his agents) and the outburst
  supervise: { emotion: "focused", chest: [-0.04, 0, 0], head: [0.06, 0, 0], ...CROSSED, ...WIDE_FEET },
  superviseL: { emotion: "focused", chest: [-0.04, 0.12, 0], head: [0.04, 0.45, 0], ...CROSSED, ...WIDE_FEET },
  superviseR: { emotion: "focused", chest: [-0.04, -0.12, 0], head: [0.04, -0.45, 0], ...CROSSED, ...WIDE_FEET },
  superviseNodL: { emotion: "focused", chest: [-0.02, 0.12, 0], head: [0.3, 0.42, 0], ...CROSSED, ...WIDE_FEET },
  superviseNodR: { emotion: "focused", chest: [-0.02, -0.12, 0], head: [0.3, -0.42, 0], ...CROSSED, ...WIDE_FEET },
  // a quick look down at the holo checklist floating at his -X side
  superviseCheck: { emotion: "focused", chest: [0.06, -0.15, 0], head: [0.38, -0.4, 0], ...CROSSED, ...WIDE_FEET },
  // The outburst's upper body (layered over whatever he is doing): leaning in, both fists raised beside the face.
  outburst: { emotion: "angry", spine: [0.06, 0, 0], chest: [0.1, 0, 0], shL: [-1.45, 0, -0.4], elL: [-1.75, 0, 0], shR: [-1.45, 0, 0.4], elR: [-1.75, 0, 0] },

  // ---- P-VIZ.6 (ADR-0637): hit reactions (HIT_CLIPS, played by the figure's hit layer over the activity)
  // knocked back by something small: head snapped back, arms flung up and out
  hitRecoil: { emotion: "surprised", rootY: 0.02, spine: [-0.28, 0, 0], head: [-0.35, 0, 0.15], shL: [-0.35, 0, -0.45], elL: [-0.7, 0, 0], shR: [-0.35, 0, 0.45], elR: [-0.7, 0, 0], hipL: [0, 0, -0.12], hipR: [0, 0, 0.12] },
  // rubbing the sore spot: the right hand up at the brow (the scan's shading arm, folded further back)
  rubHead: { emotion: "glare", spine: [0.12, 0, 0], head: [0.28, 0, -0.12], shL: [0.1, 0, -0.25], elL: [-0.5, 0, 0], shR: [-3.0, 0, 0.42], elR: [0.78, 0, -0.95], hipL: [0, 0, -0.1], hipR: [0, 0, 0.1] },
  // throwing stars: a forearm up across the face on alternate sides (leaning out of the line), then one caught
  starBlockR: { emotion: "determined", rootY: -0.05, root: [0, 0.25, 0], spine: [-0.08, 0, -0.06], chest: [0, 0.3, 0], head: [0, -0.2, 0], shL: [-1.0, 0, 0.4], elL: [-1.9, 0, 0], shR: [-1.55, 0, -0.15], elR: [-1.95, 0, 0], ...KATA_LEGS },
  starBlockL: { emotion: "determined", rootY: -0.05, root: [0, -0.25, 0], spine: [-0.08, 0, 0.12], chest: [0, -0.3, 0], head: [0, 0.2, 0], shL: [-1.55, 0, 0.15], elL: [-1.95, 0, 0], shR: [-1.0, 0, -0.4], elR: [-1.9, 0, 0], ...KATA_LEGS },
  starCatch: { emotion: "smug", chest: [-0.05, 0.15, 0], head: [-0.05, 0.1, 0.08], shL: [0.15, 0, -0.55], elL: [-1.7, 0, 0], shR: [-2.0, 0, -0.25], elR: [-1.1, 0, 0], hipL: [0, 0, -0.15], hipR: [0, 0, 0.15] },
  // struck by lightning: rigid, arms thrown out, head back
  boltStruck: { emotion: "strain", rootY: 0.04, spine: [-0.3, 0, 0], chest: [-0.15, 0, 0], head: [-0.45, 0, 0], shL: [0.1, 0, -1.25], elL: [-0.25, 0, 0], shR: [0.1, 0, 1.25], elR: [-0.25, 0, 0], hipL: [0, 0, -0.22], hipR: [0, 0, 0.22] },
  // the energy ball: both hands out to take it, then drawn in to the chest
  orbReach: { emotion: "determined", spine: [0.1, 0, 0], chest: [0.08, 0, 0], head: [0.05, 0, 0], shL: [-1.4, 0, 0.32], elL: [-0.35, 0, 0], shR: [-1.4, 0, -0.32], elR: [-0.35, 0, 0], hipL: [-0.3, 0, -0.2], kneeL: [0.35, 0, 0], hipR: [0.2, 0, 0.2], kneeR: [0.2, 0, 0] },
  orbAbsorb: { emotion: "calm", spine: [-0.05, 0, 0], chest: [-0.12, 0, 0], head: [-0.12, 0, 0], shL: [-0.85, 0, 0.42], elL: [-2.2, 0, 0], shR: [-0.85, 0, -0.42], elR: [-2.2, 0, 0], hipL: [0, 0, -0.18], hipR: [0, 0, 0.18] },
  // Storm: a wide power-up stance, chest and face up to the sky, fists low and out
  stormSky: { emotion: "determined", rootY: -0.06, chest: [-0.28, 0, 0], neck: [-0.25, 0, 0], head: [-0.5, 0, 0], shL: [0.25, 0, -0.65], elL: [-0.55, 0, 0], shR: [0.25, 0, 0.65], elR: [-0.55, 0, 0], hipL: [-0.25, 0, -0.32], kneeL: [0.4, 0, 0], hipR: [-0.25, 0, 0.32], kneeR: [0.4, 0, 0] },

  // ---- P-VIZ.TRAY2 (ADR-0690): the tray reactions (HIT_CLIPS celebrate, wave, coffee, dance)
  // celebrate: a hop with both arms flung up in a V (between victoryCrouch landings)
  cheerHop: { emotion: "happy", rootY: 0.12, chest: [-0.1, 0, 0], head: [-0.2, 0, 0], shL: [-2.9, 0, -0.4], elL: [-0.15, 0, 0], shR: [-2.9, 0, 0.4], elR: [-0.15, 0, 0], hipL: [-0.2, 0, -0.18], kneeL: [0.4, 0, 0], hipR: [-0.2, 0, 0.18], kneeR: [0.4, 0, 0] },
  // wave: the right arm up, swinging out and in at the viewer, the left hand easy at the side
  waveOut: { emotion: "happy", chest: [-0.04, 0, 0], head: [-0.08, 0, 0.12], shL: [0.1, 0, -0.3], elL: [-0.4, 0, 0], shR: [-2.6, 0, 0.6], elR: [-0.35, 0, 0], hipL: [0, 0, -0.12], hipR: [0, 0, 0.12] },
  waveIn: { emotion: "happy", chest: [-0.04, 0, 0], head: [-0.08, 0, 0.08], shL: [0.1, 0, -0.3], elL: [-0.4, 0, 0], shR: [-2.6, 0, 0.15], elR: [-0.9, 0, 0], hipL: [0, 0, -0.12], hipR: [0, 0, 0.12] },
  // coffee break: a long stretch overhead with sleepy eyes, then a sip (right hand at the lips, left under it)
  stretchUp: { emotion: "tired", spine: [-0.2, 0, 0], chest: [-0.1, 0, 0], head: [-0.3, 0, 0], shL: [-3.0, 0, 0.2], elL: [-0.25, 0, 0], shR: [-3.0, 0, -0.2], elR: [-0.25, 0, 0], hipL: [0, 0, -0.12], hipR: [0, 0, 0.12] },
  sipTea: { emotion: "calm", head: [-0.15, 0, 0], shL: [-0.6, 0, 0.35], elL: [-1.7, 0, 0], shR: [-1.25, 0, -0.35], elR: [-2.25, 0, 0], hipL: [0, 0, -0.12], hipR: [0, 0, 0.12] },
  // dance: hips and shoulders swaying to one side and the other, the arm on that side pumping up
  danceL: { emotion: "happy", rootY: -0.05, root: [0, 0.3, 0], hips: [0, -0.15, 0], spine: [0, 0, 0.1], head: [0, 0, -0.12], shL: [-1.7, 0, -0.5], elL: [-1.4, 0, 0], shR: [-0.4, 0, 0.3], elR: [-1.6, 0, 0], hipL: [-0.1, 0, -0.2], kneeL: [0.35, 0, 0], hipR: [0.05, 0, 0.18], kneeR: [0.15, 0, 0] },
  danceR: { emotion: "happy", rootY: -0.05, root: [0, -0.3, 0], hips: [0, 0.15, 0], spine: [0, 0, -0.1], head: [0, 0, 0.12], shL: [-0.4, 0, -0.3], elL: [-1.6, 0, 0], shR: [-1.7, 0, 0.5], elR: [-1.4, 0, 0], hipL: [0.05, 0, -0.18], kneeL: [0.15, 0, 0], hipR: [-0.1, 0, 0.2], kneeR: [0.35, 0, 0] },

  // ---- P-VIZ.7 (ADR-0641): the variant weapons (always in the right hand; the figure shows the weapon in the hand
  // or on its mount from weaponAt) and the git commit
  // the right hand up behind the right shoulder, on the hilt of what rides the back (the katana, the staff)
  drawReach: { emotion: "focused", root: [0, -0.2, 0], hips: [0, 0.2, 0], chest: [0.02, 0.15, 0], head: [0, -0.25, 0], shL: [-1.2, 0, 0.45], elL: [-1.9, 0, 0], shR: [-2.7, 0, 0.3], elR: [-1.6, 0, 0], ...KATA_LEGS },
  // katana: raised back over the head, a snap cut down to the front, a wind to his left and a rising sweep out right
  slashHigh: { emotion: "determined", rootY: -0.04, root: [0, -0.2, 0], hips: [0, 0.2, 0], chest: [-0.1, 0.1, 0], head: [-0.1, -0.1, 0], shL: [-0.9, 0, 0.5], elL: [-1.6, 0, 0], shR: [-2.85, 0, 0.15], elR: [-0.6, 0, 0], ...KATA_LEGS },
  slashDown: { emotion: "determined", rootY: -0.1, root: [0, -0.2, 0], hips: [0, 0.2, 0], spine: [0.15, 0, 0], chest: [0.12, -0.2, 0], head: [-0.05, 0.1, 0], shL: [-0.5, 0, -0.35], elL: [-1.2, 0, 0], shR: [-0.6, 0, 0.05], elR: [-0.1, 0, 0], hipL: [-0.55, 0, -0.25], kneeL: [0.85, 0, 0], hipR: [0.4, 0, 0.25], kneeR: [0.4, 0, 0] },
  slashWind: { emotion: "determined", rootY: -0.06, root: [0, -0.35, 0], hips: [0, 0.2, 0], chest: [0.05, -0.5, 0], head: [0, 0.45, 0], shL: [-0.6, 0, -0.3], elL: [-1.4, 0, 0], shR: [-1.3, 0, -0.5], elR: [-1.4, 0, 0], ...KATA_LEGS },
  slashSweep: { emotion: "determined", rootY: -0.06, root: [0, 0.1, 0], hips: [0, 0.2, 0], chest: [0, 0.45, 0], head: [0, -0.4, 0], shL: [-0.4, 0, -0.55], elL: [-1.2, 0, 0], shR: [-1.75, 0, 0.6], elR: [-0.15, 0, 0], ...KATA_LEGS },
  // kunai pair: a crouch to the thigh pouches, both hands crossed up to the shoulders, flung out forward and wide
  kunaiDraw: { emotion: "focused", rootY: -0.08, spine: [0.12, 0, 0], head: [-0.1, 0, 0], shL: [0.05, 0, -0.22], elL: [-0.3, 0, 0], shR: [0.05, 0, 0.22], elR: [-0.3, 0, 0], hipL: [-0.4, 0, -0.2], kneeL: [0.6, 0, 0], hipR: [-0.4, 0, 0.2], kneeR: [0.6, 0, 0] },
  kunaiWind: { emotion: "determined", rootY: -0.06, chest: [0.12, 0, 0], head: [0.05, 0, 0], shL: [-1.5, 0, 0.6], elL: [-1.6, 0, 0], shR: [-1.5, 0, -0.6], elR: [-1.6, 0, 0], ...KATA_LEGS },
  kunaiThrow: { emotion: "determined", rootY: -0.06, spine: [0.05, 0, 0], chest: [-0.05, 0, 0], head: [-0.05, 0, 0], shL: [-1.35, 0, -0.55], elL: [-0.1, 0, 0], shR: [-1.35, 0, 0.55], elR: [-0.1, 0, 0], ...KATA_LEGS },
  // bo staff: spun before him in the right hand (the left in guard), then a lunging two-hand thrust
  staffSpin: { emotion: "determined", rootY: -0.05, root: [0, -0.15, 0], chest: [0, 0.15, 0], head: [0, -0.1, 0], shL: [-1.0, 0, 0.4], elL: [-1.7, 0, 0], shR: [-1.5, 0, 0.2], elR: [-0.25, 0, 0], ...KATA_LEGS },
  staffStrike: { emotion: "determined", rootY: -0.1, rootZ: 0.05, spine: [0.1, 0, 0], chest: [0.1, -0.1, 0], head: [-0.05, 0.05, 0], shL: [-1.45, 0, 0.15], elL: [-0.2, 0, 0], shR: [-1.55, 0, -0.05], elR: [-0.05, 0, 0], hipL: [-0.7, 0, -0.15], kneeL: [0.8, 0, 0], hipR: [0.45, 0, 0.2], kneeR: [0.2, 0, 0] },
  // chakram: off the back of the belt, a backhand wind across the chest, the throw out right, the catch on return
  discGrab: { emotion: "focused", root: [0, 0.15, 0], chest: [0.05, 0.25, 0], head: [0, -0.2, 0], shL: [-1.2, 0, 0.45], elL: [-1.9, 0, 0], shR: [0.45, 0, 0.3], elR: [-0.9, 0, 0], hipL: [0, 0, -0.12], hipR: [0, 0, 0.12] },
  discWind: { emotion: "determined", rootY: -0.06, root: [0, -0.2, 0], chest: [0.05, -0.55, 0], head: [0, 0.5, 0], shL: [-0.5, 0, -0.4], elL: [-1.3, 0, 0], shR: [-1.4, 0, -0.75], elR: [-1.3, 0, 0], ...KATA_LEGS },
  discThrow: { emotion: "determined", rootY: -0.06, root: [0, 0.2, 0], chest: [0, 0.4, 0], head: [0, -0.45, 0], shL: [-0.4, 0, -0.6], elL: [-1.0, 0, 0], shR: [-1.5, 0, 0.75], elR: [-0.05, 0, 0], ...KATA_LEGS },
  discCatchReady: { emotion: "focused", chest: [-0.05, 0.1, 0], head: [-0.1, -0.1, 0], shL: [-1.0, 0, 0.4], elL: [-1.7, 0, 0], shR: [-1.9, 0, 0.3], elR: [-0.4, 0, 0], hipL: [0, 0, -0.15], hipR: [0, 0, 0.15] },
  discCatch: { emotion: "smug", chest: [-0.05, 0.1, 0], head: [-0.05, -0.05, 0.06], shL: [-1.0, 0, 0.4], elL: [-1.7, 0, 0], shR: [-1.7, 0, 0.25], elR: [-0.9, 0, 0], hipL: [0, 0, -0.15], hipR: [0, 0, 0.15] },
  // the git commit: feet planted wide, the right arm straight up (the bolt leaves that hand), the left fist low and
  // out, chest and face up to the storm; commitStrain is the same stance pulled a little harder
  commitRaise: { emotion: "raiden", rootY: -0.05, chest: [-0.12, 0, 0], neck: [-0.1, 0, 0], head: [-0.3, 0.1, 0.05], shL: [0.2, 0, -0.55], elL: [-0.4, 0, 0], shR: [-3.05, 0, 0.12], elR: [-0.05, 0, 0], hipL: [-0.1, 0, -0.3], kneeL: [0.25, 0, 0], hipR: [-0.1, 0, 0.3], kneeR: [0.25, 0, 0] },
  commitStrain: { emotion: "raiden", rootY: -0.065, chest: [-0.17, 0, 0], neck: [-0.12, 0, 0], head: [-0.38, 0.1, 0.05], shL: [0.26, 0, -0.64], elL: [-0.5, 0, 0], shR: [-3.08, 0, 0.1], elR: [-0.02, 0, 0], hipL: [-0.12, 0, -0.32], kneeL: [0.3, 0, 0], hipR: [-0.12, 0, 0.32], kneeR: [0.3, 0, 0] },
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
/** P-VIZ.7 (ADR-0641): a variant's weapon move, played in a weapon slot (WEAPON_SLOTS) some loops of the activity. */
export type WeaponClip = "slash" | "kunaiThrow" | "staffSpin" | "discThrow";
/** `supervise` is named explicitly so the clip table type-checks whether or not MiniActivity carries it yet.
 *  P-VIZ.7: the weapon moves and the git commit (`commit`, a loop held while the commit runs) are figure-internal. */
export type ClipName = MiniActivity | "supervise" | ShotName | WeaponClip | "commit" | "failed" | "ended" | "killed";

const K = (at: number, pose: PoseName, e: Ease = "smooth", o: { emotion?: EmotionName; gaze?: number } = {}): Key =>
  ({ at, pose, ease: e, emotion: o.emotion ?? POSES[pose].emotion, gaze: o.gaze ?? 0 });

export const CLIPS: Readonly<Record<ClipName, Clip>> = {
  // Focused typing at the holo keyboard (the taps are layered by the figure), an occasional glance up and aside.
  typing: { len: 4.4, loop: true, keys: [K(0, "typing"), K(2.2, "typing"), K(2.5, "typingGlance", "smooth", { gaze: 0.6 }), K(3.1, "typingGlance", "smooth", { gaze: 0.6 }), K(3.35, "typing")] },
  // P-VIZ.4: the hub while his team works. Arms folded, he looks slowly over his agents one side then the other
  // with a nod each way; every half loop (SUPERVISE_TICK_AT) a quick snap glance down at the holo checklist.
  supervise: {
    len: 8.4, loop: true,
    keys: [
      K(0, "superviseCheck", "snap", { gaze: -0.5 }), K(0.55, "superviseCheck", "smooth", { gaze: -0.5 }), K(0.95, "supervise"),
      K(1.9, "superviseL", "smooth", { gaze: 1 }), K(2.7, "superviseL", "smooth", { gaze: 1 }), K(3.0, "superviseNodL", "smooth", { gaze: 1 }), K(3.3, "superviseL", "smooth", { gaze: 1 }), K(4.0, "supervise"),
      K(4.2, "superviseCheck", "snap", { gaze: -0.5 }), K(4.75, "superviseCheck", "smooth", { gaze: -0.5 }), K(5.15, "supervise"),
      K(6.1, "superviseR", "smooth", { gaze: -1 }), K(6.9, "superviseR", "smooth", { gaze: -1 }), K(7.2, "superviseNodR", "smooth", { gaze: -1 }), K(7.5, "superviseR", "smooth", { gaze: -1 }), K(8.2, "supervise"),
    ],
  },
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

  // ---- P-VIZ.7 (ADR-0641): the weapon moves (each loop starts and ends in the kata guard) and the commit
  // katana: draw from the back, raise, a snap downward cut, wind left, a snap rising sweep out right, sheathe
  slash: {
    len: 3.0, loop: true,
    keys: [K(0, "stance"), K(0.35, "drawReach"), K(0.55, "slashHigh", "snap"), K(0.8, "slashHigh"), K(0.94, "slashDown", "snap"), K(1.25, "slashDown"), K(1.5, "slashWind"), K(1.62, "slashSweep", "snap"), K(2.0, "slashSweep"), K(2.35, "drawReach"), K(2.7, "stance")],
  },
  // kunai: two volleys, a pair each (crouch to the thigh pouches, cross up, snap fling)
  kunaiThrow: {
    len: 3.1, loop: true,
    keys: [K(0, "stance"), K(0.38, "kunaiDraw"), K(0.65, "kunaiWind"), K(0.77, "kunaiThrow", "snap"), K(1.15, "kunaiThrow"), K(1.55, "kunaiDraw"), K(1.8, "kunaiWind"), K(1.92, "kunaiThrow", "snap"), K(2.3, "kunaiThrow"), K(2.7, "stance")],
  },
  // bo staff: off the back, spun before him (staffAngle), a snap lunging thrust, back on the back
  staffSpin: {
    len: 3.6, loop: true,
    keys: [K(0, "stance"), K(0.38, "drawReach"), K(0.65, "staffSpin"), K(1.95, "staffSpin"), K(2.07, "staffStrike", "snap"), K(2.5, "staffStrike"), K(2.88, "drawReach"), K(3.2, "stance")],
  },
  // chakram: off the belt, the backhand wind, the snap throw; it flies out and back (discFlight) to a snap catch
  discThrow: {
    len: 3.3, loop: true,
    keys: [K(0, "stance"), K(0.35, "discGrab"), K(0.62, "discWind"), K(0.74, "discThrow", "snap"), K(1.05, "discThrow"), K(1.55, "discCatchReady", "smooth", { gaze: -0.5 }), K(1.95, "discCatch", "snap"), K(2.3, "discCatch"), K(2.7, "discGrab"), K(3.0, "stance")],
  },
  // the git commit (held while it runs): the raised arm and planted stance, breathing between two strains
  commit: { len: 2.4, loop: true, keys: [K(0, "commitRaise"), K(1.2, "commitStrain")] },
};

/** Representative clip times for motion=false (a readable still of each clip). */
export const STILL_T: Readonly<Record<ClipName, number>> = {
  typing: 0.5, supervise: 2.2, kiblast: 1.66, kata: 0.7, meditate: 0, scan: 1.0, dash: 1.0, powerup: 0.8, victory: 1.0, failed: 0.2, ended: 4, killed: 2,
  slash: 1.1, kunaiThrow: 0.95, staffSpin: 2.2, discThrow: 0.9, commit: 0,
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

// ------------------------------------------------------------------------------------------ weapons (P-VIZ.7)
//
// P-VIZ.7 (ADR-0641): every node carries one weapon, picked by its variant (viz_brand's per-model variant, else
// the node seed): a katana on the back, a kunai pair in thigh pouches, a bo staff on the back or a chakram on the
// back of the belt. The weapon slots (kata, dash, kiblast) play the variant's weapon move instead of their own
// clip on some loops (weaponTurn: from the seed and the loop count, never the first loop), so a fleet keeps
// mixing moves without any two nodes in lockstep. weaponAt says, per clip time, whether the weapon is in the hand
// (else on its mount), how far a thrown one has flown, and the staff's spin.

export type AnimeWeapon = "katana" | "kunai" | "staff" | "disc";
export const WEAPONS: readonly AnimeWeapon[] = ["katana", "kunai", "staff", "disc"];
export const WEAPON_CLIP: Readonly<Record<AnimeWeapon, WeaponClip>> = { katana: "slash", kunai: "kunaiThrow", staff: "staffSpin", disc: "discThrow" };
export const WEAPON_CLIPS: readonly WeaponClip[] = ["slash", "kunaiThrow", "staffSpin", "discThrow"];
/** The activities whose loops can turn into a weapon move. */
export const WEAPON_SLOTS: readonly MiniActivity[] = ["kata", "dash", "kiblast"];
/** About this share of a weapon slot's loops (after the first) are the weapon move. */
export const WEAPON_SHARE = 0.45;
/** A thrown kunai flies this long; the chakram's out-and-back flight is its clip's window. */
export const KUNAI_FLY_S = 0.5;
/** Full turns of the staff spin. */
export const STAFF_TURNS = 5;

type Win = readonly (readonly [number, number])[];
/** Clip-time windows [from, to) with the weapon in the right hand. */
export const WEAPON_HAND: Readonly<Record<AnimeWeapon, Win>> = {
  katana: [[0.38, 2.38]],
  kunai: [[0.38, 0.77], [1.55, 1.92]],
  staff: [[0.38, 2.88]],
  disc: [[0.35, 0.74], [1.95, 2.7]],
};
/** Clip-time windows [from, to) with the weapon in flight. */
export const WEAPON_FLY: Readonly<Record<AnimeWeapon, Win>> = {
  katana: [],
  kunai: [[0.77, 0.77 + KUNAI_FLY_S], [1.92, 1.92 + KUNAI_FLY_S]],
  staff: [],
  disc: [[0.74, 1.95]],
};
const STAFF_UP: readonly [number, number] = [0.38, 0.65];
const STAFF_SPIN: readonly [number, number] = [0.65, 1.95];
const STAFF_DOWN: readonly [number, number] = [2.5, 2.88];

/** The weapon at a clip time: `hand` (in the right hand, else on its mount unless flying), `fly` (-1 when not in
 *  flight, else the flight progress 0..1), `spin` (the staff's angle about the hand, radians) and `blur` (0..1,
 *  how fast it spins). */
export interface WeaponSample { hand: boolean; fly: number; spin: number; blur: number }

export function newWeaponSample(): WeaponSample {
  return { hand: false, fly: -1, spin: 0, blur: 0 };
}

/** A variant 0..3: the brand's when it has one, else the node seed's. */
export function variantOf(variant: number | null | undefined, seed: number): number {
  if (typeof variant === "number" && Number.isFinite(variant)) return ((Math.floor(variant) % 4) + 4) % 4;
  return Number.isFinite(seed) ? Math.floor(Math.abs(seed)) % 4 : 0;
}

export function weaponOf(variant: number): AnimeWeapon {
  return WEAPONS[variantOf(variant, 0)]!;
}

/** Whether loop `cycle` (0 = the first loop since the activity began) of a weapon slot plays the weapon move. */
export function weaponTurn(activity: MiniActivity, seed: number, cycle: number): boolean {
  const slot = WEAPON_SLOTS.indexOf(activity);
  if (slot < 0 || !(cycle >= 1)) return false;
  const s = Number.isFinite(seed) ? Math.floor(Math.abs(seed)) % 4294967296 : 0;
  return mix32((Math.imul(s, 31) + Math.imul(Math.floor(cycle), 0x2545f491) + slot * 7919) | 0) / 4294967296 < WEAPON_SHARE;
}

function inWin(win: Win, t: number): number {
  for (const [a, b] of win) if (t >= a && t < b) return (t - a) / (b - a);
  return -1;
}

/** The weapon `w` at clip time `t` of its move (WEAPON_CLIP[w]), wrapped like the loop. */
export function weaponAt(w: AnimeWeapon, t: number, out: WeaponSample): WeaponSample {
  const tt = clipTime(CLIPS[WEAPON_CLIP[w]], t);
  out.hand = inWin(WEAPON_HAND[w], tt) >= 0;
  out.fly = inWin(WEAPON_FLY[w], tt);
  out.spin = 0;
  out.blur = 0;
  if (w === "staff") {
    // a quarter turn across as it comes off the back, the spin (eased in and out, whole turns), held across for
    // the thrust, a quarter turn back to go on the back
    const q = Math.PI / 2, full = Math.PI * 2 * STAFF_TURNS;
    if (tt < STAFF_UP[0]) out.spin = 0;
    else if (tt < STAFF_UP[1]) out.spin = q * smoothEase((tt - STAFF_UP[0]) / (STAFF_UP[1] - STAFF_UP[0]));
    else if (tt < STAFF_SPIN[1]) {
      const u = (tt - STAFF_SPIN[0]) / (STAFF_SPIN[1] - STAFF_SPIN[0]);
      out.spin = q + full * smoothEase(u);
      out.blur = clamp01(16 * u * u * (1 - u) * (1 - u));
    } else if (tt < STAFF_DOWN[0]) out.spin = q + full;
    else if (tt < STAFF_DOWN[1]) out.spin = full + q * (1 - smoothEase((tt - STAFF_DOWN[0]) / (STAFF_DOWN[1] - STAFF_DOWN[0])));
    else out.spin = full;
  }
  return out;
}

// ------------------------------------------------------------------------------------------ git commit (P-VIZ.7)
//
// P-VIZ.7 (ADR-0641): while a git commit or push runs (setCommit), the figure blends into the `commit` loop over
// COMMIT_IN_S: the raised arm shooting a jagged bolt up into a storm cloud (re-jittered BOLT_HZ times a second)
// with glowing raiden eyes. The cloud gathers over CLOUD_IN_S; when the commit ends the bolt cuts out, the cloud
// dissipates over CLOUD_OUT_S and the pose blends back over COMMIT_OUT_S.

export const COMMIT_IN_S = 0.4;
export const COMMIT_OUT_S = 0.5;
export const CLOUD_IN_S = 0.9;
export const CLOUD_OUT_S = 0.7;
export const BOLT_HZ = 14;
/** The bolt shows once the commit pose is this far in (the arm is up). */
export const BOLT_AT = 0.7;

// ------------------------------------------------------------------------------------------ supervise checklist

/** supervise clip times at which the glance lands on the holo checklist and a box ticks. */
export const SUPERVISE_TICK_AT: readonly number[] = [0.3, 4.5];
export const CHECK_ROWS = 3;

/** Boxes ticked on the holo checklist after `t` seconds of the supervise clock: one more per glance, and the
 *  glance after a full list starts a fresh one (0 .. CHECK_ROWS). */
export function checklistTicks(t: number): number {
  if (!Number.isFinite(t) || t < 0) return 0;
  const len = CLIPS.supervise.len;
  const loops = Math.floor(t / len);
  const ct = t - loops * len;
  let n = loops * SUPERVISE_TICK_AT.length;
  for (const a of SUPERVISE_TICK_AT) if (ct >= a) n++;
  return n % (CHECK_ROWS + 1);
}

// ------------------------------------------------------------------------------------------ reactions (P-VIZ.4)
//
// A tap on the figure is an interruption. `stare`: the eyes snap wide open (surprised), then narrow into an
// annoyed glare while the head and torso turn smoothly to the camera; he holds it with one slow suspicious blink,
// then turns back to his work more slowly than he turned in. `outburst` (a double tap): fists up and shaking,
// a stomp, strain eyes (the yell) then angry ones, an anger mark, steam and an aura flare, then a glare at the
// camera and back to work. A reaction is a LAYER: the activity clock keeps running underneath and the figure
// blends the turn (`turn`) and the raised fists (`rage`) over the activity pose by weight.

export type ReactionKind = "stare" | "outburst";
export const REACTION_KINDS: readonly ReactionKind[] = ["stare", "outburst"];
/** The turn to the camera: smooth, quicker for an outburst. */
export const STARE_TURN_IN_S = 0.35;
export const OUTBURST_TURN_IN_S = 0.18;
/** The slower turn back to the work. */
export const REACT_TURN_OUT_S = 0.65;
/** The eyes snap wide open for this long before they narrow into the glare. */
export const SURPRISE_S = 0.3;
export const STARE_HOLD_MIN_S = 1.6;
export const STARE_HOLD_MAX_S = 2.2;
/** The one slow suspicious blink in the stare: a normal blink slowed to this long, starting mid hold. */
export const SLOW_BLINK_S = 0.6;
export const OUTBURST_MIN_S = 1.5;
export const OUTBURST_MAX_S = 2.5;
/** The outburst opens with strain > < eyes (the yell) for this long, then angry V brows. */
export const YELL_S = 0.45;
/** The stomp: a decaying shake starting here. */
export const STOMP_AT_S = 0.15;
export const STOMP_S = 0.4;
/** After the outburst, the glare at the camera before he turns back. */
export const GLARE_S = 0.9;
/** The raised fists come up over RAGE_IN_S and drop over RAGE_OUT_S. */
export const RAGE_IN_S = 0.2;
export const RAGE_OUT_S = 0.3;

export interface Reaction {
  readonly kind: ReactionKind;
  readonly turnIn: number;
  /** stare: how long he holds the gaze after the turn in (0 for an outburst). */
  readonly hold: number;
  /** outburst: how long the outburst lasts before the glare (0 for a stare). */
  readonly rage: number;
  /** When he starts turning back to the work. */
  readonly face: number;
  readonly len: number;
  /** Layer weights already on when this reaction started: a reaction restarted mid-way blends from them. */
  readonly turnFrom: number;
  readonly rageFrom: number;
}

export interface ReactionSample {
  /** Weight of the turn toward the camera (0 = his own pose). */
  turn: number;
  /** Weight of the raised-fists outburst pose. */
  rage: number;
  /** The reaction's eyes, or null for the activity's own. */
  emotion: EmotionName | null;
  /** The blink step while the reaction owns the eyes (natural blinks are held off), -1 when it does not. */
  blink: number;
  stomp: number;
  /** Anger mark, steam puffs and aura flare levels (0..1). */
  mark: number;
  steam: number;
  aura: number;
  done: boolean;
}

/** Resets a sample to "no reaction" (also the initial sample). */
export function clearReaction(out: ReactionSample): ReactionSample {
  out.turn = 0; out.rage = 0; out.emotion = null; out.blink = -1; out.stomp = 0; out.mark = 0; out.steam = 0; out.aura = 0; out.done = true;
  return out;
}

export function newReactionSample(): ReactionSample {
  return clearReaction({ turn: 0, rage: 0, emotion: null, blink: -1, stomp: 0, mark: 0, steam: 0, aura: 0, done: true });
}

/** Plans a reaction from a uniform random number in [0, 1) (the stare's hold, the outburst's length) and the
 *  layer weights already on (`from`, the current sample when a reaction interrupts another). */
export function planReaction(kind: ReactionKind, r: number, from?: { readonly turn: number; readonly rage: number }): Reaction {
  const u = clamp01(Number.isFinite(r) ? r : 0.5);
  // clamp01 lets NaN through (both comparisons fail), so a NaN weight reads as 0 here
  const turnFrom = clamp01(from?.turn || 0), rageFrom = clamp01(from?.rage || 0);
  if (kind === "outburst") {
    const rage = OUTBURST_MIN_S + (OUTBURST_MAX_S - OUTBURST_MIN_S) * u;
    const face = rage + GLARE_S;
    return { kind, turnIn: OUTBURST_TURN_IN_S, hold: 0, rage, face, len: face + REACT_TURN_OUT_S, turnFrom, rageFrom };
  }
  const hold = STARE_HOLD_MIN_S + (STARE_HOLD_MAX_S - STARE_HOLD_MIN_S) * u;
  const face = STARE_TURN_IN_S + hold;
  return { kind: "stare", turnIn: STARE_TURN_IN_S, hold, rage: 0, face, len: face + REACT_TURN_OUT_S, turnFrom, rageFrom };
}

/** The reaction `t` seconds in (a non-finite time reads as 0). Past `len` it is cleared and `done`. */
export function sampleReaction(r: Reaction, t: number, out: ReactionSample): ReactionSample {
  const tt = Number.isFinite(t) ? Math.max(0, t) : 0;
  if (tt >= r.len) return clearReaction(out);
  out.done = false;
  out.turn = tt < r.turnIn ? r.turnFrom + (1 - r.turnFrom) * smoothEase(tt / r.turnIn) : tt < r.face ? 1 : 1 - smoothEase((tt - r.face) / REACT_TURN_OUT_S);
  const back = tt >= r.face + REACT_TURN_OUT_S * 0.5;
  if (r.kind === "outburst") {
    const down = r.rage - RAGE_OUT_S;
    out.rage = tt < RAGE_IN_S ? r.rageFrom + (1 - r.rageFrom) * smoothEase(tt / RAGE_IN_S) : tt < down ? 1 : 1 - smoothEase((tt - down) / RAGE_OUT_S);
    out.emotion = back ? null : tt < YELL_S ? "strain" : tt < r.rage ? "angry" : "glare";
    out.blink = back ? -1 : 0;
    out.stomp = tt >= STOMP_AT_S && tt < STOMP_AT_S + STOMP_S ? 1 - (tt - STOMP_AT_S) / STOMP_S : 0;
    out.mark = bump(tt, 0.08, 0.2, r.rage, r.rage + 0.35);
    out.steam = bump(tt, 0.25, 0.45, r.rage - 0.2, r.rage + 0.3);
    out.aura = 0.8 * bump(tt, 0, 0.15, r.rage - 0.4, r.rage);
  } else {
    out.rage = r.rageFrom * (1 - smoothEase(tt / RAGE_OUT_S));
    out.emotion = back ? null : tt < SURPRISE_S ? "surprised" : "glare";
    const age = tt - (r.turnIn + r.hold * 0.5);
    out.blink = back ? -1 : age >= 0 && age < SLOW_BLINK_S ? blinkStep((age * BLINK_S) / SLOW_BLINK_S) : 0;
    out.stomp = 0; out.mark = 0; out.steam = 0; out.aura = 0;
  }
  return out;
}

/** How the turn to the camera spreads over the body: shares of the yaw for spine, chest, neck and head, each
 *  capped; whatever they cannot cover turns the whole body (the root), so he faces a camera behind him too. */
const YAW_SHARE = [0.2, 0.25, 0.2, 0.35] as const;
const YAW_MAX = [0.35, 0.45, 0.4, 0.7] as const;

/** Writes [root, spine, chest, neck, head] yaw for a turn of `need` radians (wrapped to -PI..PI) into `out`. */
export function distributeYaw(need: number, out: Float32Array): Float32Array {
  const n = Number.isFinite(need) ? need - Math.round(need / (Math.PI * 2)) * Math.PI * 2 : 0;
  let rest = n;
  for (let i = 0; i < 4; i++) {
    const v = Math.min(YAW_MAX[i]!, Math.max(-YAW_MAX[i]!, n * YAW_SHARE[i]!));
    out[i + 1] = v;
    rest -= v;
  }
  out[0] = rest;
  return out;
}

// ------------------------------------------------------------------------------------------ who a node is (P-VIZ.6)

export type FigureGender = "male" | "female";

/** A node's gender from its seed (viz_scene's id hash): stable for the id, about half and half over a fleet, and
 *  the same in both styles (the office worker and the anime figure read it from the same seed). */
export function seededGender(seed: number): FigureGender {
  const s = Number.isFinite(seed) ? Math.floor(Math.abs(seed)) % 4294967296 : 0;
  return mix32((s ^ 0x5bd1e995) | 0) >>> 31 === 1 ? "female" : "male";
}

// ------------------------------------------------------------------------------------------ charge (P-VIZ.6)
//
// What a hit leaves behind: `boost` (a bolt, an energy drink, the anime Storm) falls linearly to 0 by the time the
// longest boost still running ends; `orbs` (energy balls absorbed, up to ORB_MAX) fall linearly to 0 over
// ORB_DECAY_S from the last one. The figure decays it on the wall clock in update(); `charge` is chargeLevel().

export const HIT_KINDS: readonly HitKind[] = ["paper", "band", "drink", "stars", "bolt", "orb", "storm"];
export const BOLT_CHARGE = 1;
export const BOLT_S = 15;
export const DRINK_CHARGE = 0.6;
export const DRINK_S = 12;
export const STORM_CHARGE = 0.5;
export const STORM_CHARGE_S = 6;
export const ORB_MAX = 3;
export const ORB_DECAY_S = 60;
/** Each absorbed energy ball grows the figure this much (3 stacks: +12 percent). */
export const ORB_GROW = 0.04;

export interface Charge { boost: number; boostRate: number; orbs: number; orbRate: number }

export function newCharge(): Charge {
  return { boost: 0, boostRate: 0, orbs: 0, orbRate: 0 };
}

/** A boost of `level` (0..1) lasting `dur` seconds: the level is the higher of the two, and it runs out when the
 *  longer of the two would have. */
export function addBoost(c: Charge, level: number, dur: number): Charge {
  const l = Number.isFinite(level) ? clamp01(level) : 0;
  if (l <= 0 || !(dur > 0)) return c;
  const left = c.boostRate > 0 ? c.boost / c.boostRate : 0;
  c.boost = Math.max(c.boost, l);
  c.boostRate = c.boost / Math.max(left, dur);
  return c;
}

/** One more energy ball (never more than ORB_MAX): the growth decays to 0 over ORB_DECAY_S from now. */
export function addOrb(c: Charge): Charge {
  c.orbs = Math.min(ORB_MAX, c.orbs + 1);
  c.orbRate = c.orbs / ORB_DECAY_S;
  return c;
}

export function decayCharge(c: Charge, dt: number): Charge {
  const d = Number.isFinite(dt) && dt > 0 ? dt : 0;
  c.boost = Math.max(0, c.boost - c.boostRate * d);
  if (c.boost === 0) c.boostRate = 0;
  c.orbs = Math.max(0, c.orbs - c.orbRate * d);
  if (c.orbs === 0) c.orbRate = 0;
  return c;
}

/** 0..1: the stronger of the boost and the absorbed balls (each ball a third). */
export function chargeLevel(c: Charge): number {
  return clamp01(Math.max(c.boost, c.orbs / ORB_MAX));
}

/** The figure's size factor from the absorbed balls: 1 .. 1 + ORB_MAX * ORB_GROW. */
export function orbScale(c: Charge): number {
  return 1 + ORB_GROW * Math.min(ORB_MAX, Math.max(0, c.orbs));
}

/** The activity clock's speed-up while energized: up to 1.8x at full charge. */
export function chargeTempo(level: number): number {
  return 1 + 0.8 * (Number.isFinite(level) ? clamp01(level) : 0);
}

/** The anime figure's charge from a hit: the bolt supercharges, an energy ball stacks, the Storm powers up a little.
 *  The office throwables are only a flinch here, so they leave no charge. */
export function animeHitCharge(c: Charge, kind: HitKind, strength: number): Charge {
  const s = Number.isFinite(strength) ? clamp01(strength) : 1;
  if (kind === "bolt") return addBoost(c, BOLT_CHARGE * s, BOLT_S);
  if (kind === "orb") return addOrb(c);
  if (kind === "storm") return addBoost(c, STORM_CHARGE * s, STORM_CHARGE_S);
  return c;
}

// ------------------------------------------------------------------------------------------ hits (P-VIZ.6)
//
// A hit is a one-shot clip the figure plays OVER its activity at full weight: it blends in over HIT_BLEND_S from
// the pose on screen when the hit landed (so a hit that replaces a stare, an outburst or another hit never pops),
// turns the body toward the throw over HIT_TURN_S, and hands back to the activity over the last HIT_OUT_S. The
// activity clock keeps running underneath, so the figure returns to whatever it was doing.
//   flinch: the office throwables (paper, band, drink) on the anime figure: recoil, rub the head, glare.
//   stars: the scene sends three ~0.15 s apart; each one within STAR_CHAIN_S of the last is the next in the chain:
//     block with the right forearm, block with the left (a dodge lean), catch the third, smug.
//   bolt: struck rigid, then the power-up stance (the charge runs ~15 s). orb: hands out, absorb it to the chest,
//   power up (and grow). storm: a power-up stance with the face to the sky (no turn).
// P-VIZ.TRAY2 (ADR-0690): the tray reactions ride the same layer, turned to the viewer (the scene sends them "from"
// the camera): celebrate, two hops with the arms up in a V and the victory pose; wave, the right arm swinging at the
// viewer; coffee, a long stretch and a sip (no turn: a break, not a performance); dance, a sway side to side on the
// beat (DANCE_BEAT_S, the same clock for every figure, so the team dances in sync). No charge, no shake.

export type AnimeHit = "flinch" | "starBlockR" | "starBlockL" | "starCatch" | "bolt" | "orb" | "storm" | TrayReactionKind;
/** dance: one sway every this long. */
export const DANCE_BEAT_S = 0.4;
export const HIT_BLEND_S = 0.12;
export const HIT_TURN_S = 0.3;
export const HIT_OUT_S = 0.45;
export const STAR_CHAIN_S = 0.7;
const STAR_CHAIN: readonly AnimeHit[] = ["starBlockR", "starBlockL", "starCatch"];

export const HIT_CLIPS: Readonly<Record<AnimeHit, Clip>> = {
  flinch: {
    len: 2.0, loop: false,
    keys: [K(0, "hitRecoil"), K(0.08, "hitRecoil", "snap"), K(0.4, "flinch"), K(0.9, "rubHead"), K(1.5, "rubHead"), K(2.0, "portrait", "smooth", { emotion: "glare" })],
  },
  starBlockR: { len: 0.9, loop: false, keys: [K(0, "stance"), K(0.1, "starBlockR", "snap"), K(0.9, "starBlockR")] },
  starBlockL: { len: 0.9, loop: false, keys: [K(0, "starBlockR"), K(0.1, "starBlockL", "snap"), K(0.9, "starBlockL")] },
  starCatch: { len: 2.2, loop: false, keys: [K(0, "starBlockL"), K(0.1, "starCatch", "snap", { emotion: "surprised" }), K(0.45, "starCatch"), K(2.2, "starCatch")] },
  bolt: {
    len: 2.4, loop: false,
    keys: [K(0, "boltStruck"), K(0.06, "boltStruck", "snap"), K(0.55, "boltStruck"), K(0.8, "powerupWind"), K(0.92, "powerup", "snap"), K(1.7, "powerup"), K(2.4, "stance", "smooth", { emotion: "determined" })],
  },
  orb: {
    len: 2.4, loop: false,
    keys: [K(0, "orbReach", "smooth", { emotion: "surprised" }), K(0.15, "orbReach", "snap"), K(0.7, "orbAbsorb"), K(1.35, "orbAbsorb"), K(1.55, "powerup", "snap", { emotion: "determined" }), K(2.4, "powerup", "smooth", { emotion: "determined" })],
  },
  storm: { len: 3.0, loop: false, keys: [K(0, "powerupWind"), K(0.3, "stormSky", "snap"), K(3.0, "stormSky")] },
  celebrate: {
    len: 2.6, loop: false,
    keys: [K(0, "victoryCrouch"), K(0.18, "cheerHop", "snap"), K(0.48, "victoryCrouch"), K(0.68, "cheerHop", "snap"), K(1.0, "victoryCrouch"), K(1.2, "victory", "snap"), K(2.6, "victory")],
  },
  wave: {
    len: 2.5, loop: false,
    keys: [K(0, "portrait", "smooth", { emotion: "happy" }), K(0.25, "waveOut", "snap"), K(0.5, "waveIn"), K(0.75, "waveOut"), K(1.0, "waveIn"), K(1.25, "waveOut"), K(1.5, "waveIn"), K(1.75, "waveOut"), K(2.5, "portrait", "smooth", { emotion: "happy" })],
  },
  coffee: {
    len: 4.0, loop: false,
    keys: [K(0, "portrait", "smooth", { emotion: "calm" }), K(0.5, "stretchUp"), K(1.4, "stretchUp"), K(1.9, "sipTea"), K(3.0, "sipTea"), K(3.5, "portrait", "smooth", { emotion: "happy" }), K(4.0, "portrait", "smooth", { emotion: "happy" })],
  },
  dance: {
    len: 3.2, loop: false,
    keys: [
      K(0, "portrait", "smooth", { emotion: "happy" }),
      ...Array.from({ length: 6 }, (_, i) => K(0.2 + i * DANCE_BEAT_S, i % 2 === 0 ? "danceL" : "danceR", "snap")),
      K(0.2 + 6 * DANCE_BEAT_S, "victory", "snap"), K(3.2, "victory"),
    ],
  },
};

export interface HitPlan {
  readonly kind: HitKind;
  readonly play: AnimeHit;
  /** stars: 0..2, the place in the chain; -1 for anything else. */
  readonly star: number;
  readonly len: number;
  /** Does it turn toward the throw (everything but the Storm)? */
  readonly turns: boolean;
  /** The turn weight already on when this hit landed (a replaced hit's): it eases on from there. */
  readonly turnFrom: number;
  readonly strength: number;
}

export interface HitSample {
  /** Weight of the hit pose over the activity: 1 from the start, out over the last HIT_OUT_S. */
  body: number;
  /** How far the hit pose has blended from the pose on screen when the hit landed (0..1). */
  blend: number;
  /** Weight of the turn toward the throw. */
  turn: number;
  /** The hit's eyes (the clip's), or null for the activity's own. */
  emotion: EmotionName | null;
  /** Aura flare, bolt crackle, the energy ball held between the hands (0..1) and a short shake. */
  aura: number;
  crackle: number;
  absorb: number;
  shake: number;
  done: boolean;
}

export function clearHit(out: HitSample): HitSample {
  out.body = 0; out.blend = 1; out.turn = 0; out.emotion = null; out.aura = 0; out.crackle = 0; out.absorb = 0; out.shake = 0; out.done = true;
  return out;
}

export function newHitSample(): HitSample {
  return clearHit({ body: 0, blend: 1, turn: 0, emotion: null, aura: 0, crackle: 0, absorb: 0, shake: 0, done: true });
}

/** Plans a hit. `prev` is the hit still playing (null when none) and `prevT` how far into it; `prevTurn` its
 *  current turn weight, so the new hit turns on without a jump. */
export function planHit(kind: HitKind, strength: number, prev: HitPlan | null, prevT: number, prevTurn: number): HitPlan {
  const s = Number.isFinite(strength) ? clamp01(strength) : 1;
  let play: AnimeHit, star = -1;
  if (kind === "stars") {
    star = prev && prev.kind === "stars" && prevT >= 0 && prevT < STAR_CHAIN_S ? (prev.star + 1) % STAR_CHAIN.length : 0;
    play = STAR_CHAIN[star]!;
  } else play = kind === "bolt" || kind === "orb" || kind === "storm" || isTrayReactionKind(kind) ? kind : "flinch";
  const turnFrom = clamp01(Number.isFinite(prevTurn) ? prevTurn : 0);
  return { kind, play, star, len: HIT_CLIPS[play].len, turns: play !== "storm" && play !== "coffee", turnFrom, strength: s };
}

const HIT_SCRATCH = new Float32Array(POSE_LEN);
const HIT_INFO: ClipSample = { emotion: "neutral", gaze: 0 };

/** The hit `t` seconds in: weights and effect levels into `out`, the hit clip's pose into `pose` (when given).
 *  Past `len` it is cleared and `done`. */
export function sampleHit(p: HitPlan, t: number, out: HitSample, pose?: Float32Array): HitSample {
  const tt = Number.isFinite(t) ? Math.max(0, t) : 0;
  if (tt >= p.len) return clearHit(out);
  out.done = false;
  const outAt = p.len - HIT_OUT_S;
  out.body = tt < outAt ? 1 : Math.max(0, 1 - smoothEase((tt - outAt) / HIT_OUT_S));
  out.blend = smoothEase(tt / HIT_BLEND_S);
  const tu = smoothEase(tt / HIT_TURN_S);
  // the turn hands back with the body: holding it at full weight to the end snapped the figure round at `len`
  out.turn = (p.turns ? p.turnFrom + (1 - p.turnFrom) * tu : p.turnFrom * (1 - tu)) * out.body;
  sampleClip(HIT_CLIPS[p.play], tt, pose ?? HIT_SCRATCH, HIT_INFO);
  out.emotion = tt < p.len - HIT_OUT_S * 0.5 ? HIT_INFO.emotion : null;
  const s = p.strength;
  out.aura = 0; out.crackle = 0; out.absorb = 0; out.shake = 0;
  switch (p.play) {
    case "bolt":
      out.crackle = s * bump(tt, 0, 0.04, 0.5, 0.8);
      out.aura = s * bump(tt, 0.75, 0.9, 1.7, 2.3);
      out.shake = tt < 0.5 ? s * (1 - tt / 0.5) : 0;
      break;
    case "orb":
      out.absorb = bump(tt, 0.05, 0.2, 1.3, 1.6);
      out.aura = s * bump(tt, 1.45, 1.6, 2.0, 2.4);
      break;
    case "storm":
      out.aura = s * bump(tt, 0.25, 0.45, 2.4, 3.0);
      break;
    case "flinch":
      out.shake = tt < 0.25 ? 0.6 * s * (1 - tt / 0.25) : 0;
      break;
    case "celebrate": case "wave": case "coffee": case "dance":
      break; // P-VIZ.TRAY2: a reaction, not an impact
    default:
      out.shake = tt < 0.12 ? 0.4 * s * (1 - tt / 0.12) : 0;
  }
  return out;
}
