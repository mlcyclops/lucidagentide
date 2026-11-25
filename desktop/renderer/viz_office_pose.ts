// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_office_pose.ts - P-VIZ.4 (ADR-0627): the professional office cast's poses, clips, emotions,
// reactions and effect timing.
//
// PURE (no three, no DOM), the office twin of viz_anime_pose.ts. The figure (viz_office.ts) is a SEATED rig of
// nested joints in the anime rig's order; a pose is one flat vector (root position, then an Euler XYZ rotation per
// joint). The root carries the office chair, so the root position is the chair rolling and the root's y rotation
// is the chair swiveling. Every pose sits: a joint a pose leaves out takes the seated default (SEAT), not zero.
//
// Two roles share the rig: the worker (types at a keyboard while reading the monitor at his right, slams Enter,
// stretches, squints at the screen, rolls the chair out to grab a printout) and the boss at the central desk
// (reads reports and flips pages, ticks boxes on a clipboard, supervises the team over the clipboard). Both drink
// coffee when idle for under IDLE_SLEEP_S and put their head down on the desk after that.
//
// Reactions layer over whatever plays: `stare` turns the head to the camera with annoyed eyes and holds it;
// `outburst` plays a body clip (both hands slam the desk twice, fists up, shouting) with a red face, steam,
// flying papers and sloshing coffee, then a glare at the camera. reactAt() is the whole timeline.
//
// P-VIZ.5 (ADR-0631): the boss is one of two managers on the same rig, a man or a woman, both with a full head of
// salt-and-pepper hair. Who is on duty is a seeded coin flip per Visualize open (a rebuild keeps the cast), and
// the managers hand over every MANAGER_SWAP_MIN_S to MANAGER_SWAP_MAX_S: the one at the desk stands, walks off
// to the side and dissolves, the other walks in and sits down (managerSwapAt()). Never mid-reaction.
//
// P-VIZ.6 (ADR-0637): the workers are a mixed cast. workerCast() gives each node a seeded gender (the same as its
// anime figure's, viz_anime_pose.seededGender), a hairstyle and a top (men: a short-sleeve shirt or a V-neck
// sweater with the persona tie; women: a blouse, a cardigan or a blazer with a persona necklace). Hits from the
// throw tray play as one-shot clips over the activity (planOfficeHit / sampleOfficeHit, the anime figure's hit
// rules): a paper ball, a rubber band, an energy drink (which leaves a charge), the Storm; the anime throwables
// are a generic flinch here.
//
// P-VIZ.7 (ADR-0641): the hands that touch props are SOLVED, not posed by angle (OFFICE_ARM_GOALS, a two-bone IK
// per build in officePoseTable: the shoulders' width and the brand's scale): the typing palms rest over the keys
// (applyTyping lays small alternating taps on them), the sip takes the mug off the desk coaster by its handle and
// brings its rim to the lips with the head tipped back (mugTilt), the phone's handset goes to the ear. A brand's
// variant (officeVariant) picks the worker's outfit (workerOutfit), the desk set (officeDeskSet) and its own
// actions on existing activity slots (activityClip: the phone, the headphones, the boss flicking through a
// report). The commit plays the copy clip standing at a copier (COPIER, COPY_HIPS): the start button, copies onto
// the tray (copiesStarted, copyProgress), a sip, and furtive looks around the office (commitLook).

import {
  addBoost, bump, clamp01, DRINK_CHARGE, DRINK_S, ease, fract, HIT_BLEND_S, HIT_OUT_S, HIT_TURN_S, seededGender, smoothEase, tapCurve,
  type AnimeState, type Charge, type Ease, type FigureGender,
} from "./viz_anime_pose.ts";
import { parseHex, type MiniActivity, type MiniLook } from "./viz_mini_look.ts";
import type { HitKind } from "./viz_throw_kinds.ts";

export type OfficeState = AnimeState;
export const OFFICE_STATES: readonly OfficeState[] = ["idle", "working", "paused", "ended", "killed", "failed"];
export type OfficeRole = "worker" | "boss";

// ------------------------------------------------------------------------------------------ emotions (face)

export type OfficeEyeShape = "open" | "happy" | "closed" | "strain" | "x";
export type MouthShape = "flat" | "smile" | "frown" | "o" | "shout" | "grit" | "wavy" | "smirk";
export interface OfficeEmotion {
  readonly shape: OfficeEyeShape; readonly open: number; readonly slant: number; readonly lower: number;
  readonly pupil: number; readonly brow: number; readonly browY: number; readonly sweat: boolean; readonly mouth: MouthShape;
}
const E = (shape: OfficeEyeShape, open: number, slant: number, lower: number, pupil: number, brow: number, browY: number, mouth: MouthShape, sweat = false): OfficeEmotion =>
  ({ shape, open, slant, lower, pupil, brow, browY, sweat, mouth });

export const OFFICE_EMOTIONS = {
  neutral: E("open", 0.9, 0.05, 0.1, 1.0, 0.1, 0, "flat"),
  focused: E("open", 0.65, 0.15, 0.2, 0.9, 0.3, -0.05, "flat"),
  determined: E("open", 0.62, 0.4, 0.25, 0.8, 0.6, -0.1, "grit"),
  strain: E("strain", 1, 0.5, 0, 1, 0.75, -0.12, "grit", true),
  happy: E("happy", 1, 0, 0, 1, -0.12, 0.12, "smile"),
  content: E("open", 0.5, -0.1, 0.3, 1, -0.1, 0.05, "smile"),
  calm: E("closed", 1, 0, 0, 1, 0, 0.02, "flat"),
  yawn: E("closed", 1, 0, 0, 1, -0.2, 0.1, "o"),
  asleep: E("closed", 1, -0.1, 0, 1, -0.15, -0.02, "wavy"),
  surprised: E("open", 1.15, 0, 0, 0.45, -0.25, 0.3, "o"),
  wide: E("open", 1.2, 0, 0, 0.35, -0.1, 0.25, "flat"),
  annoyed: E("open", 0.5, 0.35, 0.25, 0.55, 0.55, -0.1, "frown"),
  angry: E("open", 0.8, 0.6, 0.2, 0.45, 0.9, -0.15, "grit"),
  furious: E("open", 0.95, 0.7, 0.1, 0.35, 1.0, -0.18, "shout"),
  glare: E("open", 0.45, 0.55, 0.3, 0.5, 0.85, -0.15, "frown"),
  squint: E("open", 0.28, 0.15, 0.35, 0.8, 0.45, -0.1, "smirk"),
  skeptical: E("open", 0.55, 0.1, 0.3, 0.8, 0.2, 0.05, "smirk"),
  blank: E("open", 0.95, 0, 0, 0.3, 0, 0, "flat"),
  pain: E("strain", 1, 0.3, 0, 1, -0.45, 0.06, "frown", true),
  ko: E("x", 1, 0, 0, 1, -0.3, 0.05, "wavy"),
  // P-VIZ.6 (ADR-0637): wide awake after the energy drink
  energized: E("open", 1.05, 0.2, 0.05, 0.55, 0.45, 0.12, "smile"),
} satisfies Record<string, OfficeEmotion>;
export type OfficeEmotionName = keyof typeof OFFICE_EMOTIONS;
export const OFFICE_EMOTION_NAMES = Object.keys(OFFICE_EMOTIONS) as OfficeEmotionName[];
const EMOTION_INDEX = Object.fromEntries(OFFICE_EMOTION_NAMES.map((n, i) => [n, i])) as Record<OfficeEmotionName, number>;

/** One number per distinct face drawing: the face canvas is redrawn only when this changes. `blink` 0..2,
 *  `gaze` the bucket -2..2 (viz_anime_pose.gazeBucket; +2 looks toward +X, the monitor side). */
export function officeFaceKey(emotion: OfficeEmotionName, blink: number, gaze: number): number {
  return EMOTION_INDEX[emotion] * 100 + blink * 10 + (gaze + 2);
}

// ------------------------------------------------------------------------------------------ the look

/** The two managers who take turns at the boss's desk. */
export type ManagerVariant = "man" | "woman";
export const MANAGER_VARIANTS: readonly ManagerVariant[] = ["man", "woman"];

export interface OfficeLook {
  shirt: string; tie: string; slacks: string; jacket: string; shoe: string; skin: string;
  /** The hair's base color; `grey` the streaks through it (the managers' salt and pepper), null for plain hair. */
  hair: string; grey: string | null;
  glasses: boolean;
  /** The mouth line: ink for the men, a lip color for the women. */
  lip: string;
}

/** The workers' hairstyles (viz_office builds each per detail tier, shared and ref-counted). */
export type WorkerHair = "crop" | "swept" | "curly" | "buzz" | "bob" | "ponytail" | "bun" | "long";
export const MALE_HAIRS: readonly WorkerHair[] = ["crop", "swept", "curly", "buzz"];
export const FEMALE_HAIRS: readonly WorkerHair[] = ["bob", "ponytail", "bun", "long"];
/** What a worker wears over the slacks: the men a short-sleeve shirt or a V-neck sweater (both with the persona
 *  tie); the women a blouse, a cardigan or a blazer (with a persona necklace). */
export type WorkerTop = "shirt" | "sweater" | "blouse" | "cardigan" | "blazer";
const MALE_TOPS: readonly WorkerTop[] = ["shirt", "shirt", "sweater"];
const FEMALE_TOPS: readonly WorkerTop[] = ["blouse", "cardigan", "blazer"];
export interface WorkerCast { readonly gender: FigureGender; readonly hair: WorkerHair; readonly top: WorkerTop }

/** Long sleeves (the jacket rig) or short ones with bare forearms (P-VIZ.7: a hoodie is long; rolled-up sleeves
 *  and a vest over a short-sleeve shirt are not). */
export function longSleeves(top: WorkerOutfit): boolean {
  return top === "sweater" || top === "cardigan" || top === "blazer" || top === "hoodie";
}

type Rgb = readonly [number, number, number];
const toHex = (c: Rgb): string => `#${c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("")}`;
const mixRgb = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const WHITE: Rgb = [255, 255, 255];
const CHARCOAL: Rgb = [0x2b, 0x30, 0x3a];
export const OFFICE_SKINS: readonly string[] = ["#f3c9a1", "#e8b48a", "#c98c5e", "#8d5a3b", "#f6d6b8", "#a86c43", "#6b4028"];
export const OFFICE_HAIRS: readonly string[] = ["#2b2118", "#4a3020", "#7a5230", "#c99a4a", "#1c1c22", "#8a3b22", "#d8b878", "#b5672f"];
const LIPS: readonly string[] = ["#9c4552", "#b0505e", "#8a3e48", "#a85a4a"];
const INK_LINE = "#0a0a12";
const CREAM: Rgb = [0xf6, 0xf1, 0xe8];
const FEMALE_SLACKS: readonly string[] = ["#3c4250", "#2f2a33", "#5b5048", "#2c3446"];
/** The managers' salt and pepper: a dark base with grey streaks (denser at the temples, see viz_office). */
export const MANAGER_HAIR: Readonly<Record<ManagerVariant, { readonly base: string; readonly grey: string }>> = {
  man: { base: "#2f2924", grey: "#b8bcc2" },
  woman: { base: "#46362b", grey: "#c6c5c4" },
};
const NAVY: Rgb = [0x2a, 0x31, 0x45];
const HEATHER: Rgb = [0x6a, 0x6f, 0x7a];

function hash32(x: number): number {
  let h = (x + 0x9e3779b9) | 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** The office outfit from a mini look. The persona color is the tie (and tints the worker's shirt pastel);
 *  skin, hair and glasses vary by `seed` so a fleet is a cast, not clones. The boss is `variant`: the man wears
 *  a charcoal suit with a white shirt and the persona tie (reading glasses most of the time); the woman a navy
 *  blazer over a cream blouse with the persona scarf (glasses some of the time). Both have salt-and-pepper hair.
 *  A worker's top follows workerCast(seed): a shirt or blouse shows on its own as a persona pastel; a sweater,
 *  cardigan or blazer goes over a white shirt or cream blouse. P-VIZ.7: `outfit` (workerOutfit, the cast's own top
 *  by default) dresses a variant: a knit vest over the pastel shirt or blouse, rolled-up pastel sleeves, a heather
 *  persona hoodie. */
export function officeLook(l: MiniLook, seed: number, role: OfficeRole, variant: ManagerVariant = "man", outfit?: WorkerOutfit): OfficeLook {
  const accent = parseHex(l.accent) ?? [0x41, 0xff, 0x8b];
  const h = hash32(Number.isFinite(seed) ? Math.floor(Math.abs(seed)) % 2147483647 : 0);
  if (role !== "boss") {
    const cast = workerCast(seed);
    const female = cast.gender === "female";
    const top = outfit ?? cast.top;
    // the shirt or blouse is the light layer (a pastel of the persona when it shows on its own); the outer layer
    // is a muted persona sweater or cardigan, or a dark blazer
    const pastel = toHex(mixRgb(accent, WHITE, female ? 0.72 : 0.78));
    const shirt = top === "shirt" || top === "blouse" || top === "vest" || top === "rolled" ? pastel : toHex(female ? CREAM : WHITE);
    const jacket = top === "sweater" ? toHex(mixRgb(CHARCOAL, accent, 0.4))
      : top === "cardigan" ? toHex(mixRgb(accent, CHARCOAL, 0.35))
      : top === "blazer" ? toHex(mixRgb(NAVY, accent, 0.12))
      : top === "vest" ? toHex(mixRgb(CHARCOAL, accent, 0.25))
      : top === "hoodie" ? toHex(mixRgb(accent, HEATHER, 0.5))
      : toHex(mixRgb(CHARCOAL, accent, 0.1));
    return {
      shirt,
      tie: toHex(accent),
      slacks: female ? FEMALE_SLACKS[(h >>> 20) % FEMALE_SLACKS.length]! : "#3c4250",
      jacket,
      shoe: female ? "#2a1c1a" : "#1d1a19",
      skin: OFFICE_SKINS[h % OFFICE_SKINS.length]!,
      hair: OFFICE_HAIRS[(h >>> 8) % OFFICE_HAIRS.length]!,
      grey: null,
      glasses: ((h >>> 16) & 1) === 1,
      lip: female ? LIPS[(h >>> 24) % LIPS.length]! : INK_LINE,
    };
  }
  const woman = variant === "woman";
  const suit = toHex(mixRgb(woman ? NAVY : CHARCOAL, accent, woman ? 0.12 : 0.1));
  const hv = woman ? hash32(h) : h; // two different people, each stable for the hub
  return {
    shirt: woman ? "#f8f0e4" : "#f4f6fa",
    tie: toHex(accent),
    slacks: suit,
    jacket: suit,
    shoe: woman ? "#2a1c1a" : "#1d1a19",
    skin: OFFICE_SKINS[hv % OFFICE_SKINS.length]!,
    hair: MANAGER_HAIR[woman ? "woman" : "man"].base,
    grey: MANAGER_HAIR[woman ? "woman" : "man"].grey,
    glasses: woman ? ((hv >>> 18) & 3) === 0 : ((hv >>> 16) & 3) !== 0,
    lip: woman ? LIPS[0]! : INK_LINE,
  };
}

/** A worker's gender, hairstyle and top from the node's seed: stable for the node (rebuilds and style switches),
 *  the gender shared with its anime figure, about half and half over a fleet. */
export function workerCast(seed: number): WorkerCast {
  const gender = seededGender(seed);
  const h = hash32(((Number.isFinite(seed) ? Math.floor(Math.abs(seed)) % 2147483647 : 0) ^ 0x2f6b1d3) | 0);
  const hairs = gender === "female" ? FEMALE_HAIRS : MALE_HAIRS;
  const tops = gender === "female" ? FEMALE_TOPS : MALE_TOPS;
  return { gender, hair: hairs[h % hairs.length]!, top: tops[(h >>> 8) % tops.length]! };
}

// ------------------------------------------------------------------------------------------ pose vectors

export const OFFICE_JOINTS = ["root", "hips", "spine", "chest", "neck", "head", "shL", "elL", "shR", "elR", "hipL", "kneeL", "hipR", "kneeR"] as const;
export type OfficeJoint = (typeof OFFICE_JOINTS)[number];
/** Root position x, y, z, then three Euler angles per joint. */
export const OFFICE_POSE_LEN = 3 + OFFICE_JOINTS.length * 3;
export function officeJointOffset(j: OfficeJoint): number {
  return 3 + OFFICE_JOINTS.indexOf(j) * 3;
}

type V3 = readonly [number, number, number];
export type OfficePoseDef = { readonly emotion: OfficeEmotionName; readonly rootX?: number; readonly rootY?: number; readonly rootZ?: number } & { readonly [J in OfficeJoint]?: V3 };

/** Seated legs: thighs forward on the seat, shins down. Every pose starts from this. */
export const SEAT: Readonly<Partial<Record<OfficeJoint, V3>>> = { hipL: [-1.5, 0, -0.05], kneeL: [1.5, 0, 0], hipR: [-1.5, 0, 0.05], kneeR: [1.5, 0, 0] };

// ------------------------------------------------------------------------------------------ the rig (P-VIZ.7)
//
// P-VIZ.7 (ADR-0641): the rig's measures and the props' places live here so a hand can be SOLVED onto what it
// touches. A pose may name arm goals (OFFICE_ARM_GOALS: a palm on the keyboard, the desk mug, the mug's rim at the
// lips, the handset at the ear, the copier's button) and officePoseTable() solves each with a two-bone IK (the
// elbow from the law of cosines, in the plane of a pole direction) for one build: the shoulders' width and the
// brand's scale. viz_office builds the joints and places the props from the same numbers, so the solved hands
// land on the props; the tests check it with the forward kinematics (officeArmPoint, officeHeadPoint).

/** Rig measures (figure units, before the brand's scale), as viz_office builds the joints. */
export const OFFICE_RIG = {
  hipY: 0.41, chestY: 0.16, neckY: 0.17, headY: 0.05, skullY: 0.15, shoulderY: 0.14,
  upperArm: 0.2, foreArm: 0.19, palm: 0.035,
  /** The mouth (head frame): the face canvas's mouth row (y 292 of 380) on the face patch of the scaled skull. */
  mouth: [0, 0.0874, 0.143],
  /** The right ear (head frame); the left mirrors x. */
  ear: [0.153, 0.139, 0],
} as const;
/** The shoulders' half width per build (viz_office's arm()): a worker man or woman, the manager man or woman. */
export const SHOULDER_X = { man: 0.17, woman: 0.16, bossMan: 0.19, bossWoman: 0.18 } as const;
/** One build the hands are solved for: the shoulders' half width and the brand's scale (the person scales about
 *  the floor under the chair; the desk set does not). */
export interface RigFit { readonly shoulderX: number; readonly scale: number }
export const REF_FIT: RigFit = { shoulderX: SHOULDER_X.man, scale: 1 };
export interface Vec3 { x: number; y: number; z: number }

/** The desk top (both desks). */
export const OFFICE_DESK_Y = 0.5;
/** The desk mug's place (both desks) and the mug: the handle on its -X side, where the left hand holds it. */
export const DESK_MUG: V3 = [-0.27, OFFICE_DESK_Y, 0.3];
export const MUG_H = 0.075;
export const MUG_R = 0.035;
/** The palm's center on the mug (the mug's frame): at the handle, half way up. */
export const MUG_GRIP: V3 = [-0.06, 0.04, 0];
/** The rim's near edge (the mug's frame): the side that meets the lips. */
const MUG_LIP: V3 = [0, MUG_H, -MUG_R];
/** The mug's tilt toward the lips while sipping (about the facing's X axis). */
export const SIP_TIP = -0.9;
/** How far in front of the lips the rim's near edge stops (it touches, never clips). */
export const LIP_GAP = 0.01;
/** The worker's keyboard (desk frame: center, yaw, size); KEY_TOP its top face. */
export const KEYBOARD = { x: 0.03, y: OFFICE_DESK_Y + 0.01, z: 0.32, yaw: 0.15, w: 0.3, h: 0.02, d: 0.1 } as const;
export const KEY_TOP = KEYBOARD.y + KEYBOARD.h / 2;
/** The palm's center rests this high over the keys (the hand's half thickness and a hover a tap closes). */
export const PALM_REST = 0.04;
/** The desk phone (both desks, the left front corner) and its handset's center in the cradle. */
export const DESK_PHONE: V3 = [-0.42, OFFICE_DESK_Y, 0.24];
export const HANDSET_AT: V3 = [-0.42, OFFICE_DESK_Y + 0.045, 0.24];
/** The worker's headphone stand (back left, beside the TPS stack; the left hand takes them) and its height. */
export const HEADPHONE_STAND: V3 = [-0.2, OFFICE_DESK_Y, 0.44];
export const HEADPHONE_STAND_H = 0.19;

/** The copier that takes the desk's place during a commit (body frame): its base center, size, the control
 *  panel (on the lid's front edge, tilted toward the person at -X) and the start button on it. */
export const COPIER = { x: 0.415, z: 0.12, w: 0.33, d: 0.44, h: 0.6, lid: 0.035, panel: [-0.13, 0.65, -0.08], panelTilt: 0.3, button: [0, 0.016, -0.05] } as const;
/** The button's top (body frame). */
export const COPIER_BUTTON: V3 = [
  COPIER.x + COPIER.panel[0] - COPIER.button[1] * Math.sin(COPIER.panelTilt),
  COPIER.panel[1] + COPIER.button[1] * Math.cos(COPIER.panelTilt) + 0.004,
  COPIER.z + COPIER.panel[2] + COPIER.button[2],
];
/** The output tray on the copier's +Z side slopes down and away by this much. */
export const TRAY_TILT = 0.12;
/** How long the desk set and the copier take to trade places, either way (setCommit). */
export const COMMIT_BLEND_S = 0.6;
/** At the copier: the chair rolls back toward -X (the root), he steps out of it to stand (the hips' offset, root
 *  frame, so it scales with him) and turns to face the copier at +X. */
export const COPY_ROOT_X = -0.25;
export const COPY_TURN = Math.PI / 2;
const STAND_HIP_LIFT = 0.29;
export const COPY_HIPS: V3 = [0.3, OFFICE_RIG.hipY + STAND_HIP_LIFT, 0.12];

// forward kinematics: three's Euler XYZ (R = Rx Ry Rz) per joint, row-major 3x3, one uniform scale at the root
const FK = { m: new Float64Array(9), r: new Float64Array(9), t: new Float64Array(9), x: 0, y: 0, z: 0, s: 1 };
const IDENTITY = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
const JI = (j: OfficeJoint): number => OFFICE_JOINTS.indexOf(j);
const FJ_ROOT = JI("root"), FJ_HIPS = JI("hips"), FJ_SPINE = JI("spine"), FJ_CHEST = JI("chest"), FJ_NECK = JI("neck"), FJ_HEAD = JI("head");
const FJ_SHL = JI("shL"), FJ_ELL = JI("elL"), FJ_SHR = JI("shR"), FJ_ELR = JI("elR");

function eulerXYZ(x: number, y: number, z: number, m: Float64Array): void {
  const a = Math.cos(x), b = Math.sin(x), c = Math.cos(y), d = Math.sin(y), e = Math.cos(z), f = Math.sin(z);
  const ae = a * e, af = a * f, be = b * e, bf = b * f;
  m[0] = c * e; m[1] = -c * f; m[2] = d;
  m[3] = af + be * d; m[4] = ae - bf * d; m[5] = -b * c;
  m[6] = bf - ae * d; m[7] = be + af * d; m[8] = a * c;
}

function fkRot(pose: ArrayLike<number>, j: number): void {
  const i = 3 + j * 3;
  eulerXYZ(pose[i]!, pose[i + 1]!, pose[i + 2]!, FK.r);
  const a = FK.m, b = FK.r, t = FK.t;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) t[r * 3 + c] = a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!;
  }
  a.set(t);
}

function fkMove(x: number, y: number, z: number): void {
  const m = FK.m, s = FK.s;
  FK.x += s * (m[0]! * x + m[1]! * y + m[2]! * z);
  FK.y += s * (m[3]! * x + m[4]! * y + m[5]! * z);
  FK.z += s * (m[6]! * x + m[7]! * y + m[8]! * z);
}

/** Down to the chest: the root at the pose's position with the build's scale, the hips seated or at `hips`. */
function fkChest(pose: ArrayLike<number>, fit: RigFit, hips: V3 | null): void {
  FK.m.set(IDENTITY);
  FK.x = pose[0]!; FK.y = pose[1]!; FK.z = pose[2]!;
  FK.s = fit.scale;
  fkRot(pose, FJ_ROOT);
  if (hips) fkMove(hips[0], hips[1], hips[2]);
  else fkMove(0, OFFICE_RIG.hipY, 0);
  fkRot(pose, FJ_HIPS);
  fkRot(pose, FJ_SPINE);
  fkMove(0, OFFICE_RIG.chestY, 0);
  fkRot(pose, FJ_CHEST);
}

function fkOut(out: Vec3): Vec3 {
  out.x = FK.x; out.y = FK.y; out.z = FK.z;
  return out;
}

/** The palm's center, measured down the forearm from the elbow. */
export const PALM_ALONG = OFFICE_RIG.foreArm + OFFICE_RIG.palm;

/** A point on an arm in the body frame: `along` past the elbow down the forearm (0 is the elbow, PALM_ALONG the
 *  palm's center). `side` -1 is the left arm (-X). `hips` is the standing offset (COPY_HIPS), null seated. */
export function officeArmPoint(pose: ArrayLike<number>, fit: RigFit, side: -1 | 1, along: number, out: Vec3, hips: V3 | null = null): Vec3 {
  fkChest(pose, fit, hips);
  fkMove(side * fit.shoulderX, OFFICE_RIG.shoulderY, 0);
  fkRot(pose, side < 0 ? FJ_SHL : FJ_SHR);
  fkMove(0, -OFFICE_RIG.upperArm, 0);
  fkRot(pose, side < 0 ? FJ_ELL : FJ_ELR);
  fkMove(0, -along, 0);
  return fkOut(out);
}

/** A point of the head's frame (OFFICE_RIG.mouth, an ear) in the body frame. */
export function officeHeadPoint(pose: ArrayLike<number>, fit: RigFit, p: V3, out: Vec3, hips: V3 | null = null): Vec3 {
  fkChest(pose, fit, hips);
  fkMove(0, OFFICE_RIG.neckY, 0);
  fkRot(pose, FJ_NECK);
  fkMove(0, OFFICE_RIG.headY, 0);
  fkRot(pose, FJ_HEAD);
  fkMove(p[0], p[1], p[2]);
  return fkOut(out);
}

function chestPoint(pose: ArrayLike<number>, fit: RigFit, p: V3, out: Vec3, hips: V3 | null): Vec3 {
  fkChest(pose, fit, hips);
  fkMove(p[0], p[1], p[2]);
  return fkOut(out);
}

/** The way the person faces: the chair's swivel plus the hips' turn. A held mug is kept upright in this yaw. */
export function officeFacing(pose: ArrayLike<number>): number {
  return pose[3 + FJ_ROOT * 3 + 1]! + pose[3 + FJ_HIPS * 3 + 1]!;
}

/** Ry(yaw) Rx(tilt) p: a point of the held mug's frame in the body frame (three's Euler "YXZ", as viz_office
 *  orients the mug). */
export function mugFrame(yaw: number, tilt: number, p: V3, out: Vec3): Vec3 {
  const ct = Math.cos(tilt), st = Math.sin(tilt), cy = Math.cos(yaw), sy = Math.sin(yaw);
  const y = p[1] * ct - p[2] * st, z = p[1] * st + p[2] * ct;
  out.x = p[0] * cy + z * sy;
  out.y = y;
  out.z = -p[0] * sy + z * cy;
  return out;
}

const MUG_SCRATCH: Vec3 = { x: 0, y: 0, z: 0 };

/** The held mug's base center (body frame): the left palm less the grip, at tilt `tilt`. */
export function officeMugAt(pose: ArrayLike<number>, fit: RigFit, tilt: number, out: Vec3, hips: V3 | null = null): Vec3 {
  officeArmPoint(pose, fit, -1, PALM_ALONG, out, hips);
  mugFrame(officeFacing(pose), tilt, MUG_GRIP, MUG_SCRATCH);
  out.x -= MUG_SCRATCH.x; out.y -= MUG_SCRATCH.y; out.z -= MUG_SCRATCH.z;
  return out;
}

/** The near edge of the rim (the side at the lips) of a mug standing at `origin`. */
export function mugRimNear(yaw: number, tilt: number, origin: Vec3, out: Vec3): Vec3 {
  mugFrame(yaw, tilt, MUG_LIP, out);
  out.x += origin.x; out.y += origin.y; out.z += origin.z;
  return out;
}

/** A keyboard point (its local x across the keys, `lift` over the top face) in the body frame. */
export function keyboardPoint(lx: number, lift: number, out: Vec3): Vec3 {
  out.x = KEYBOARD.x + lx * Math.cos(KEYBOARD.yaw);
  out.y = KEY_TOP + lift;
  out.z = KEYBOARD.z - lx * Math.sin(KEYBOARD.yaw);
  return out;
}

/** A body point in the keyboard's frame (x across the keys, z front to back, y over the top face). */
export function keyboardLocal(p: Vec3, out: Vec3): Vec3 {
  const dx = p.x - KEYBOARD.x, dz = p.z - KEYBOARD.z, c = Math.cos(KEYBOARD.yaw), s = Math.sin(KEYBOARD.yaw);
  out.x = dx * c - dz * s;
  out.z = dx * s + dz * c;
  out.y = p.y - KEY_TOP;
  return out;
}

/** What a solved arm reaches for. Poles are [out, up, forward] in the chest frame (out mirrors per side).
 *  key: the palm over the keyboard at local x, the forearm level (no pole: solveArm's "level"); at: the palm at a
 *  body point; deskMug: the left hand's mug on the desk coaster (upright); carry: the mug upright at a chest-frame
 *  point; sip: the mug's rim at the lips, tipped SIP_TIP; ear: the palm at that side's ear (a handset, headphones). */
export type ArmGoal =
  | { readonly k: "key"; readonly x: number }
  | { readonly k: "at"; readonly p: V3; readonly pole: V3 }
  | { readonly k: "deskMug"; readonly pole: V3 }
  | { readonly k: "carry"; readonly p: V3; readonly pole: V3 }
  | { readonly k: "sip"; readonly pole: V3 }
  | { readonly k: "ear"; readonly pole: V3 };
export interface ArmGoals { readonly L?: ArmGoal; readonly R?: ArmGoal; readonly hips?: V3 }

const IK_T: Vec3 = { x: 0, y: 0, z: 0 };
const IK_G: Vec3 = { x: 0, y: 0, z: 0 };
const POLE_REACH: V3 = [0.6, -1, -0.3];
const POLE_SIP: V3 = [1, -1.4, 0.2];
const POLE_EAR: V3 = [1, -0.5, 0];
/** The handset at the ear: the palm just outside and below it, a little forward (head frame, right side). */
const EAR_HOLD: V3 = [OFFICE_RIG.ear[0] + 0.05, OFFICE_RIG.ear[1] - 0.035, 0.02];

/** "level": the elbow sits this far (local units) below the palm, so the forearm lies near level over the keys. */
const LEVEL_DROP = 0.012;

/** Solve one arm of `v` so the point `along` the forearm lands on `target` (body frame), the elbow toward `pole`,
 *  or with `pole` "level" the elbow at the palm's height (LEVEL_DROP under it; as near as the arm allows), out to
 *  the side and back: a typist's forearm. Out of reach, the arm points at it fully stretched. */
function solveArm(v: Float32Array, side: -1 | 1, fit: RigFit, target: Vec3, along: number, pole: V3 | "level", hips: V3 | null): void {
  fkChest(v, fit, hips);
  fkMove(side * fit.shoulderX, OFFICE_RIG.shoulderY, 0);
  const m = FK.m, s = FK.s;
  const wx = (target.x - FK.x) / s, wy = (target.y - FK.y) / s, wz = (target.z - FK.z) / s;
  // into the chest frame (a rotation: the transpose inverts it)
  const tx = m[0]! * wx + m[3]! * wy + m[6]! * wz;
  const ty = m[1]! * wx + m[4]! * wy + m[7]! * wz;
  const tz = m[2]! * wx + m[5]! * wy + m[8]! * wz;
  const U = OFFICE_RIG.upperArm, F = along;
  const len = Math.hypot(tx, ty, tz) || 1e-6;
  const dx = tx / len, dy = ty / len, dz = tz / len;
  const D = Math.min(U + F - 1e-4, Math.max(Math.abs(U - F) + 1e-4, len));
  const a = (U * U - F * F + D * D) / (2 * D), r = Math.sqrt(Math.max(0, U * U - a * a));
  // the pole, made perpendicular to the reach
  let px = 0, py = -1, pz = 0;
  if (pole !== "level") { px = pole[0] * side; py = pole[1]; pz = pole[2]; } else {
    // The elbow circle (center dn * a, radius r, square to dn) in the basis e1 (the body's up, square to the reach)
    // and e2 = dn x e1: its height over the shoulder is a (dn . up) + r cos(phi) |e1 . up|. Pick phi for the
    // palm's height less LEVEL_DROP, of its two sides the one further out and back.
    const ux0 = m[3]!, uy0 = m[4]!, uz0 = m[5]!; // the body's up in the chest frame
    const ud = ux0 * dx + uy0 * dy + uz0 * dz;
    let e1x = ux0 - dx * ud, e1y = uy0 - dy * ud, e1z = uz0 - dz * ud;
    const A = Math.hypot(e1x, e1y, e1z);
    if (A > 1e-6 && r > 1e-6) {
      e1x /= A; e1y /= A; e1z /= A;
      const e2x = dy * e1z - dz * e1y, e2y = dz * e1x - dx * e1z, e2z = dx * e1y - dy * e1x;
      const h = tx * ux0 + ty * uy0 + tz * uz0 - LEVEL_DROP;
      const c = Math.min(1, Math.max(-1, (h - a * ud) / (r * A)));
      const sn = Math.sqrt(1 - c * c);
      const out = side * e2x - 0.3 * e2z; // how far +e2 puts the elbow out to the side and back
      const k = out >= 0 ? sn : -sn;
      px = c * e1x + k * e2x; py = c * e1y + k * e2y; pz = c * e1z + k * e2z;
    }
  }
  const pd = px * dx + py * dy + pz * dz;
  px -= dx * pd; py -= dy * pd; pz -= dz * pd;
  let pl = Math.hypot(px, py, pz);
  if (pl < 1e-6) { px = 0; py = -dz; pz = dy; pl = Math.hypot(py, pz) || 1; }
  px /= pl; py /= pl; pz /= pl;
  // the elbow, the upper arm's and the forearm's directions
  const ex = dx * a + px * r, ey = dy * a + py * r, ez = dz * a + pz * r;
  const ux = ex / U, uy = ey / U, uz = ez / U;
  const fx = (dx * D - ex) / F, fy = (dy * D - ey) / F, fz = (dz * D - ez) / F;
  const fu = Math.min(1, Math.max(-1, fx * ux + fy * uy + fz * uz));
  // the shoulder's axes: Y back up the upper arm, Z toward the forearm's bend, X = Y x Z
  let zx = fx - ux * fu, zy = fy - uy * fu, zz = fz - uz * fu;
  const zl = Math.hypot(zx, zy, zz);
  if (zl < 1e-6) { zx = px; zy = py; zz = pz; } else { zx /= zl; zy /= zl; zz /= zl; }
  const yx = -ux, yy = -uy, yz = -uz;
  const xx = yy * zz - yz * zy, xy = yz * zx - yx * zz, xz = yx * zy - yy * zx;
  // the matrix [X Y Z] as Euler XYZ (three's Euler.setFromRotationMatrix)
  const m00 = xx, m01 = yx, m02 = zx, m11 = yy, m12 = zy, m21 = yz, m22 = zz;
  const ry = Math.asin(Math.min(1, Math.max(-1, m02)));
  let rx: number, rz: number;
  if (Math.abs(m02) < 0.9999999) { rx = Math.atan2(-m12, m22); rz = Math.atan2(-m01, m00); } else { rx = Math.atan2(m21, m11); rz = 0; }
  const o = 3 + (side < 0 ? FJ_SHL : FJ_SHR) * 3;
  v[o] = rx; v[o + 1] = ry; v[o + 2] = rz;
  // the elbow (the next joint) bends forward about its X
  v[o + 3] = -Math.acos(fu); v[o + 4] = 0; v[o + 5] = 0;
}

function solveGoal(v: Float32Array, side: -1 | 1, g: ArmGoal, fit: RigFit, hips: V3 | null): void {
  const t = IK_T;
  switch (g.k) {
    case "key":
      keyboardPoint(g.x, PALM_REST, t);
      break;
    case "at":
      t.x = g.p[0]; t.y = g.p[1]; t.z = g.p[2];
      break;
    case "deskMug":
    case "carry":
      if (g.k === "carry") chestPoint(v, fit, g.p, t, hips);
      else { t.x = DESK_MUG[0]; t.y = DESK_MUG[1]; t.z = DESK_MUG[2]; }
      mugFrame(officeFacing(v), 0, MUG_GRIP, IK_G);
      t.x += IK_G.x; t.y += IK_G.y; t.z += IK_G.z;
      break;
    case "sip": {
      const yaw = officeFacing(v);
      officeHeadPoint(v, fit, OFFICE_RIG.mouth, t, hips);
      t.x += Math.sin(yaw) * LIP_GAP; t.z += Math.cos(yaw) * LIP_GAP;
      // the mug's base where its rim's near edge meets the lips, then the palm on its handle
      mugFrame(yaw, SIP_TIP, MUG_LIP, IK_G);
      t.x -= IK_G.x; t.y -= IK_G.y; t.z -= IK_G.z;
      mugFrame(yaw, SIP_TIP, MUG_GRIP, IK_G);
      t.x += IK_G.x; t.y += IK_G.y; t.z += IK_G.z;
      break;
    }
    case "ear":
      officeHeadPoint(v, fit, side < 0 ? [-EAR_HOLD[0], EAR_HOLD[1], EAR_HOLD[2]] : EAR_HOLD, t, hips);
      break;
  }
  solveArm(v, side, fit, t, PALM_ALONG, g.k === "key" ? "level" : g.pole, hips);
}

// L is -X, R is +X (the anime rig's convention). Shoulder x < 0 raises the arm forward; z > 0 brings the L arm
// in (and the R arm out). The monitor stands at the worker's +X front, so looking at it is a positive head yaw.
// P-VIZ.7: the typing hands are solved onto the keyboard (OFFICE_ARM_GOALS), not posed by angle.
const STANDING = { hipL: [0, 0, -0.03], kneeL: [0, 0, 0], hipR: [0, 0, 0.03], kneeR: [0, 0, 0] } as const;
const AT_COPIER = { rootX: COPY_ROOT_X, hips: [0, COPY_TURN, 0], ...STANDING } as const;
const CLIP_ARMS = { shL: [-0.95, 0, 0.3], elL: [-1.45, 0, 0], shR: [-0.85, 0, -0.35], elR: [-1.5, 0, 0] } as const;
const LOW_CLIP_ARMS = { shL: [-0.8, 0, 0.3], elL: [-1.6, 0, 0], shR: [-0.6, 0, -0.3], elR: [-1.4, 0, 0] } as const;

export const OFFICE_POSES = {
  // ---- the worker at the keyboard
  type: { emotion: "focused", spine: [0.1, 0, 0], chest: [0.05, 0.1, 0], neck: [0, 0.1, 0], head: [0.12, 0.3, 0] },
  typeGlance: { emotion: "neutral", spine: [0.08, 0, 0], chest: [0.05, 0, 0], head: [0.05, 0.05, 0] },
  enterWind: { emotion: "determined", spine: [0.05, 0, 0], chest: [-0.05, 0.15, 0], head: [0, 0.4, 0], shR: [-2.6, 0, -0.15], elR: [-0.5, 0, 0] },
  enterSlam: { emotion: "determined", rootY: -0.01, spine: [0.22, 0, 0], chest: [0.1, 0.1, 0], head: [0.2, 0.35, 0] },
  stretchUp: { emotion: "yawn", spine: [-0.25, 0, 0], chest: [-0.1, 0, 0], head: [-0.35, 0, 0], shL: [-3.0, 0, 0.2], elL: [-0.25, 0, 0], shR: [-3.0, 0, -0.2], elR: [-0.25, 0, 0] },
  handsBehind: { emotion: "content", spine: [-0.3, 0, 0], chest: [-0.05, 0, 0], head: [-0.2, 0, 0], shL: [-2.7, 0, -0.75], elL: [-2.4, 0, 0], shR: [-2.7, 0, 0.75], elR: [-2.4, 0, 0] },
  squint: { emotion: "squint", spine: [0.35, 0.25, 0], chest: [0.1, 0.2, 0], neck: [0.1, 0.2, 0], head: [0.05, 0.35, 0.1] },
  squintNear: { emotion: "squint", spine: [0.45, 0.3, 0], chest: [0.12, 0.2, 0], neck: [0.1, 0.25, 0], head: [0.1, 0.4, 0.2] },
  squintAha: { emotion: "surprised", spine: [0.1, 0.1, 0], chest: [0, 0.15, 0], head: [-0.15, 0.3, 0], shR: [-1.5, 0, -0.3], elR: [-1.6, 0, 0] },
  rollPush: { emotion: "determined", rootX: -0.05, spine: [0.15, 0, 0], shL: [-0.7, 0, 0.1], elL: [-0.6, 0, 0], shR: [-0.7, 0, -0.1], elR: [-0.6, 0, 0] },
  rollReach: { emotion: "determined", rootX: -0.32, rootZ: -0.08, root: [0, -0.8, 0], spine: [0.1, -0.2, 0], head: [0, -0.3, 0], shL: [-1.6, 0, -0.35], elL: [-0.2, 0, 0], shR: [-0.3, 0, 0.2], elR: [-0.5, 0, 0], hipL: [-1.3, 0, -0.25], kneeL: [1.2, 0, 0], hipR: [-1.4, 0, 0.15], kneeR: [1.3, 0, 0] },
  rollBack: { emotion: "focused", rootX: -0.15, root: [0, -0.3, 0], spine: [0.05, 0, 0], head: [0.3, -0.1, 0], shL: [-1.1, 0, 0.35], elL: [-1.2, 0, 0], shR: [-0.45, 0, -0.12], elR: [-1.0, 0, 0] },
  readPaper: { emotion: "focused", spine: [0.05, 0, 0], head: [0.35, -0.15, 0], shL: [-1.0, 0, 0.35], elL: [-1.3, 0, 0], shR: [-0.6, 0, -0.28], elR: [-1.05, 0, 0] },
  frantic: { emotion: "strain", spine: [0.3, 0, 0], chest: [0.1, 0.1, 0], head: [0.25, 0.45, 0] },

  // ---- P-VIZ.7 (ADR-0641): the variants' own actions
  // the desk phone at his left: the handset off the cradle, to the ear, listening and answering
  // (a positive spine yaw brings the left shoulder forward, toward what the left hand reaches for)
  reachPhone: { emotion: "neutral", spine: [0.26, 0.16, 0], head: [0.15, -0.5, 0] },
  phoneEar: { emotion: "focused", spine: [0.02, -0.05, 0], chest: [0, -0.05, 0], head: [0.05, -0.15, 0.18] },
  phoneTalk: { emotion: "content", spine: [-0.04, 0, 0], head: [-0.05, 0.1, 0.14] },
  // the headphones off their stand, on, a stretch to the music, and back
  reachPhones: { emotion: "neutral", spine: [0.45, 0.16, 0], head: [0, -0.35, 0] },
  phonesOn: { emotion: "content", head: [-0.05, 0, 0] },

  // ---- the boss at the central desk
  reportsHold: { emotion: "focused", spine: [0.05, 0, 0], head: [0.3, 0, 0], shL: [-1.05, 0, 0.4], elL: [-1.25, 0, 0], shR: [-1.05, 0, -0.4], elR: [-1.25, 0, 0] },
  reportsFlip: { emotion: "skeptical", spine: [0.05, 0, 0], head: [0.3, -0.05, 0], shL: [-1.05, 0, 0.4], elL: [-1.25, 0, 0], shR: [-1.2, 0, -0.1], elR: [-1.35, 0, 0] },
  clipHold: { emotion: "focused", spine: [0.05, 0, 0], head: [0.35, 0.05, 0], ...CLIP_ARMS },
  clipLook: { emotion: "skeptical", spine: [0, 0, 0], head: [0, 0.15, 0], ...CLIP_ARMS },
  superviseL: { emotion: "skeptical", chest: [0, -0.15, 0], head: [0.05, -0.6, 0], ...LOW_CLIP_ARMS },
  superviseC: { emotion: "skeptical", head: [0.1, 0, 0], ...LOW_CLIP_ARMS },
  superviseR: { emotion: "skeptical", chest: [0, 0.15, 0], head: [0.05, 0.6, 0], ...LOW_CLIP_ARMS },
  // P-VIZ.7: a look up over the report between flicks through it
  reportsPeek: { emotion: "skeptical", spine: [0.02, 0, 0], head: [-0.05, 0, 0], shL: [-1.05, 0, 0.4], elL: [-1.25, 0, 0], shR: [-1.05, 0, -0.4], elR: [-1.25, 0, 0] },

  // ---- both: coffee, sleep, states
  // P-VIZ.7: the left hand is solved onto the mug on the desk coaster, then the rim onto the lips (head back)
  sitBack: { emotion: "neutral", spine: [-0.08, 0, 0], shL: [-0.45, 0, 0.12], elL: [-1.0, 0, 0], shR: [-0.45, 0, -0.12], elR: [-1.0, 0, 0] },
  reachMug: { emotion: "neutral", spine: [0.1, -0.1, 0], head: [0.15, -0.2, 0], shR: [-0.45, 0, -0.12], elR: [-1.0, 0, 0] },
  sipUp: { emotion: "calm", spine: [-0.06, 0, 0], neck: [-0.05, 0, 0], head: [-0.16, -0.05, 0], shR: [-0.45, 0, -0.12], elR: [-1.0, 0, 0] },
  sleep: { emotion: "asleep", spine: [0.75, 0, 0], chest: [0.2, 0, 0], neck: [0.1, 0, 0], head: [0.25, 0, 0.35], shL: [-2.1, 0, 0.55], elL: [-0.9, 0, 0], shR: [-2.1, 0, -0.55], elR: [-0.9, 0, 0] },
  sleepDeep: { emotion: "asleep", spine: [0.78, 0, 0], chest: [0.22, 0, 0], neck: [0.1, 0, 0], head: [0.27, 0, 0.38], shL: [-2.1, 0, 0.55], elL: [-0.9, 0, 0], shR: [-2.1, 0, -0.55], elR: [-0.9, 0, 0] },
  blank: { emotion: "blank", spine: [-0.05, 0, 0], head: [0.05, 0, 0], shL: [0.05, 0, -0.08], elL: [-0.35, 0, 0], shR: [0.05, 0, 0.08], elR: [-0.35, 0, 0] },
  blank2: { emotion: "blank", spine: [-0.05, 0, 0], head: [0.08, 0, 0.12], shL: [0.05, 0, -0.08], elL: [-0.35, 0, 0], shR: [0.05, 0, 0.08], elR: [-0.35, 0, 0] },
  facepalm: { emotion: "pain", spine: [0.25, 0, 0], chest: [0.1, 0, 0], head: [0.4, 0, 0], shL: [-0.5, 0, 0.2], elL: [-1.0, 0, 0], shR: [-1.55, 0, -0.55], elR: [-2.25, 0, 0] },
  jolt: { emotion: "surprised", spine: [-0.2, 0, 0], head: [-0.2, 0, 0], shL: [-0.3, 0, -0.5], elL: [-0.4, 0, 0], shR: [-0.3, 0, 0.5], elR: [-0.4, 0, 0] },
  slump: { emotion: "ko", rootY: -0.03, spine: [0.35, 0, 0.25], chest: [0.15, 0, 0.1], head: [0.5, 0, 0.45], shL: [0.2, 0, -0.1], elL: [-0.1, 0, 0], shR: [0.15, 0, 0.15], elR: [-0.15, 0, 0], hipL: [-1.35, 0, -0.2], kneeL: [1.2, 0, 0], hipR: [-1.35, 0, 0.2], kneeR: [1.3, 0, 0] },

  // ---- the outburst (reaction body clip)
  slamWind: { emotion: "angry", rootY: 0.02, spine: [-0.15, 0, 0], chest: [-0.1, 0, 0], head: [-0.15, 0, 0], shL: [-2.7, 0, -0.2], elL: [-0.6, 0, 0], shR: [-2.7, 0, 0.2], elR: [-0.6, 0, 0] },
  slamDown: { emotion: "furious", rootY: 0.03, spine: [0.4, 0, 0], chest: [0.15, 0, 0], head: [0.05, 0, 0], shL: [-1.5, 0, -0.25], elL: [-0.25, 0, 0], shR: [-1.5, 0, 0.25], elR: [-0.25, 0, 0] },
  shout: { emotion: "furious", rootY: 0.03, spine: [-0.2, 0, 0], chest: [-0.05, 0, 0], head: [-0.25, 0, 0], shL: [-1.9, 0, -0.45], elL: [-1.6, 0, 0], shR: [-1.9, 0, 0.45], elR: [-1.6, 0, 0] },

  // ---- P-VIZ.6 (ADR-0637): hit reactions (OFFICE_HIT_CLIPS)
  hitJolt: { emotion: "surprised", spine: [-0.18, 0, 0], head: [-0.22, 0, 0.18], shL: [-0.35, 0, -0.35], elL: [-0.7, 0, 0], shR: [-0.35, 0, 0.35], elR: [-0.7, 0, 0] },
  rubHead: { emotion: "annoyed", spine: [0.12, 0, 0], head: [0.28, 0, -0.12], shL: [-0.45, 0, 0.12], elL: [-1.0, 0, 0], shR: [-2.65, 0, 0.3], elR: [-1.9, 0, 0] },
  // the rubber band stung his neck: the left hand clapped to it, shoulders hunched, head cocked
  owClutch: { emotion: "pain", spine: [0.1, 0, 0], chest: [0.05, 0.2, 0], head: [0.05, 0.2, 0.28], shL: [-1.35, 0, 0.6], elL: [-2.2, 0, 0], shR: [-0.25, 0, 0.18], elR: [-0.6, 0, 0] },
  // the energy drink: caught one-handed overhead, chugged (the sip, mirrored), then a fist up
  catchCan: { emotion: "surprised", spine: [-0.08, 0, 0], head: [-0.2, 0, 0], shL: [-0.45, 0, 0.12], elL: [-1.0, 0, 0], shR: [-2.3, 0, -0.1], elR: [-0.35, 0, 0] },
  chug: { emotion: "calm", spine: [-0.15, 0, 0], head: [-0.45, 0, 0], shL: [-0.45, 0, 0.12], elL: [-1.0, 0, 0], shR: [-1.3, 0, -0.55], elR: [-2.0, 0, 0] },
  pumped: { emotion: "energized", spine: [-0.05, 0, 0], head: [-0.05, 0, 0], shL: [-0.6, 0, 0.28], elL: [-1.05, 0, 0], shR: [-1.5, 0, 0.35], elR: [-2.2, 0, 0] },
  // Storm: ducking low over the desk and holding on, then smoothing the hair and the tie back down
  duck: { emotion: "strain", rootY: -0.02, spine: [0.7, 0, 0], chest: [0.2, 0, 0], neck: [0.1, 0, 0], head: [0.1, 0, 0], shL: [-1.6, 0, 0.35], elL: [-0.6, 0, 0], shR: [-1.6, 0, -0.35], elR: [-0.6, 0, 0] },
  smoothHair: { emotion: "skeptical", spine: [0.02, 0, 0], head: [-0.05, 0, 0.1], shL: [-0.45, 0, 0.12], elL: [-1.0, 0, 0], shR: [-2.7, 0, 0.25], elR: [-1.6, 0, 0] },
  smoothTie: { emotion: "content", head: [0.3, 0, 0], shL: [-0.6, 0, 0.35], elL: [-1.9, 0, 0], shR: [-0.6, 0, -0.35], elR: [-1.9, 0, 0] },

  // ---- P-VIZ.7 (ADR-0641): the commit, standing at the copier (COPY_HIPS), the mug in the left hand
  copyIdle: { emotion: "skeptical", ...AT_COPIER, spine: [0.04, 0, 0], head: [0.15, 0, 0] },
  copyReach: { emotion: "neutral", ...AT_COPIER, spine: [0.1, 0, 0], chest: [0.05, 0.1, 0], head: [0.35, 0.1, 0] },
  copyPress: { emotion: "determined", ...AT_COPIER, spine: [0.12, 0, 0], chest: [0.05, 0.12, 0], head: [0.4, 0.1, 0] },
  copySip: { emotion: "calm", ...AT_COPIER, spine: [-0.04, 0, 0], neck: [-0.05, 0, 0], head: [-0.16, 0, 0] },
} as const satisfies Record<string, OfficePoseDef>;
export type OfficePoseName = keyof typeof OFFICE_POSES;

/** A pose definition as a flat vector; joints it leaves out take SEAT, then zero. */
export function officePoseVector(p: OfficePoseDef): Float32Array {
  const v = new Float32Array(OFFICE_POSE_LEN);
  v[0] = p.rootX ?? 0;
  v[1] = p.rootY ?? 0;
  v[2] = p.rootZ ?? 0;
  for (let j = 0; j < OFFICE_JOINTS.length; j++) {
    const name = OFFICE_JOINTS[j]!;
    const r = p[name] ?? SEAT[name];
    if (!r) continue;
    v[3 + j * 3] = r[0];
    v[4 + j * 3] = r[1];
    v[5 + j * 3] = r[2];
  }
  return v;
}

/** P-VIZ.7 (ADR-0641): the arms each pose solves onto a prop (the joints it leaves to them are not in its def). */
const KEYS_BOTH: ArmGoals = { L: { k: "key", x: -0.07 }, R: { k: "key", x: 0.07 } };
const KEYS_L: ArmGoal = { k: "key", x: -0.07 };
/** The right palm resting on the desk beside the keyboard (clear of it and of the monitor's foot). */
const DESK_REST_R: ArmGoal = { k: "at", p: [0.22, OFFICE_DESK_Y + 0.04, 0.26], pole: POLE_REACH };
/** On the copier's lid, clear of the panel. */
const LID_REST_R: ArmGoal = { k: "at", p: [0.33, COPIER.h + COPIER.lid + 0.035, -0.06], pole: POLE_REACH };
const CARRY_L: ArmGoal = { k: "carry", p: [-0.06, 0.02, 0.2], pole: POLE_REACH };
const ABOVE = (p: V3, dy: number): V3 => [p[0] - 0.035 * Math.sin(COPIER.panelTilt), p[1] + dy, p[2]];

export const OFFICE_ARM_GOALS: Readonly<Partial<Record<OfficePoseName, ArmGoals>>> = {
  type: KEYS_BOTH, typeGlance: KEYS_BOTH, frantic: KEYS_BOTH, squint: KEYS_BOTH, squintNear: KEYS_BOTH,
  enterWind: { L: KEYS_L },
  enterSlam: { L: KEYS_L, R: { k: "key", x: 0.125 } },
  squintAha: { L: KEYS_L },
  reachMug: { L: { k: "deskMug", pole: POLE_REACH } },
  sipUp: { L: { k: "sip", pole: POLE_SIP } },
  reachPhone: { L: { k: "at", p: HANDSET_AT, pole: POLE_REACH }, R: DESK_REST_R },
  phoneEar: { L: { k: "ear", pole: POLE_EAR }, R: DESK_REST_R },
  phoneTalk: { L: { k: "ear", pole: POLE_EAR }, R: DESK_REST_R },
  reachPhones: { L: { k: "at", p: [HEADPHONE_STAND[0], HEADPHONE_STAND[1] + HEADPHONE_STAND_H, HEADPHONE_STAND[2]], pole: POLE_REACH }, R: { k: "key", x: 0.07 } },
  phonesOn: { L: { k: "ear", pole: POLE_EAR }, R: { k: "ear", pole: POLE_EAR } },
  copyIdle: { hips: COPY_HIPS, L: CARRY_L, R: LID_REST_R },
  copyReach: { hips: COPY_HIPS, L: CARRY_L, R: { k: "at", p: ABOVE(COPIER_BUTTON, 0.085), pole: POLE_REACH } },
  copyPress: { hips: COPY_HIPS, L: CARRY_L, R: { k: "at", p: ABOVE(COPIER_BUTTON, 0.035), pole: POLE_REACH } },
  copySip: { hips: COPY_HIPS, L: { k: "sip", pole: POLE_SIP }, R: LID_REST_R },
};

/** Every pose as a vector for one build, the goal-bearing arms solved onto their props (built once per figure;
 *  OFFICE_POSE_VECTORS is the reference build's). */
export type OfficePoseTable = Readonly<Record<OfficePoseName, Float32Array>>;
export function officePoseTable(fit: RigFit): OfficePoseTable {
  const out = {} as Record<OfficePoseName, Float32Array>;
  for (const name of Object.keys(OFFICE_POSES) as OfficePoseName[]) {
    const v = officePoseVector(OFFICE_POSES[name]);
    const g = OFFICE_ARM_GOALS[name];
    if (g?.L) solveGoal(v, -1, g.L, fit, g.hips ?? null);
    if (g?.R) solveGoal(v, 1, g.R, fit, g.hips ?? null);
    out[name] = v;
  }
  return out;
}

/** The standing offset of the hips a pose was solved with (COPY_HIPS at the copier), null seated. */
export function officePoseHips(name: OfficePoseName): V3 | null {
  return OFFICE_ARM_GOALS[name]?.hips ?? null;
}

export const OFFICE_POSE_VECTORS = officePoseTable(REF_FIT) as Record<OfficePoseName, Float32Array>;

// ------------------------------------------------------------------------------------------ clips

export interface OfficeKey { readonly at: number; readonly pose: OfficePoseName; readonly ease: Ease; readonly emotion: OfficeEmotionName; readonly gaze: number }
export interface OfficeClip { readonly len: number; readonly loop: boolean; readonly keys: readonly OfficeKey[] }
export type OfficeClipName =
  | "type" | "enter" | "stretch" | "squint" | "roll" | "reports" | "clipboard" | "supervise" | "sip" | "sleep" | "blank"
  | "facepalm" | "relax" | "slump" | "frantic" | "done" | "outburst"
  // P-VIZ.7 (ADR-0641): the variants' actions and the commit at the copier
  | "phone" | "headphones" | "flip" | "copy";

const K = (at: number, pose: OfficePoseName, e: Ease = "smooth", o: { emotion?: OfficeEmotionName; gaze?: number } = {}): OfficeKey =>
  ({ at, pose, ease: e, emotion: o.emotion ?? OFFICE_POSES[pose].emotion, gaze: o.gaze ?? 0 });
const MON = { gaze: 1 } as const;

/** kiblast: the Enter key slam lands here (screen flash, keyboard bounce). */
export const ENTER_SLAM_S = 1.9;
/** sip: the hand closes on the desk mug at MUG_GRAB_S and sets it back down at MUG_DROP_S. */
export const MUG_GRAB_S = 0.7;
export const MUG_DROP_S = 3.2;
/** roll: the printout is in the hand between these clip times. */
export const PRINT_GRAB_S = 1.35;
export const PRINT_DROP_S = 3.85;
/** reports: a page turns at each of these clip times, over FLIP_S. */
export const PAGE_FLIPS: readonly number[] = [2.05, 4.45];
export const FLIP_S = 0.5;
/** outburst: both hands hit the desk at these reaction times. */
export const OUTBURST_SLAMS: readonly number[] = [0.32, 1.58];
/** phone: the handset is in the left hand between these clip times. */
export const PHONE_GRAB_S = 0.6;
export const PHONE_DROP_S = 5.2;
/** headphones: off the stand into the right hand, on the head, off into the hand, back on the stand. */
export const PHONES_GRAB_S = 0.6;
export const PHONES_ON_S = 1.2;
export const PHONES_OFF_S = 5.2;
export const PHONES_BACK_S = 5.8;
/** flip: the boss flicks a page at each of these clip times, over FLICK_S. */
export const FLICKS: readonly number[] = [0.3, 0.75, 1.2];
export const FLICK_S = 0.28;
/** copy (the commit): one loop presses the start button at COPY_PRESS_S, the copier puts out a copy at each of
 *  COPY_EJECTS (each slides out onto the tray over EJECT_S), and he sips over COPY_SIP. */
export const COPY_LEN = 3.6;
export const COPY_PRESS_S = 0.5;
export const COPY_EJECTS: readonly number[] = [0.8, 1.55];
export const EJECT_S = 0.7;
export const COPY_SIP: readonly [number, number] = [1.95, 2.75];

export const OFFICE_CLIPS: Readonly<Record<OfficeClipName, OfficeClip>> = {
  // Typing while reading the monitor at his right, an occasional glance down at the keys.
  type: { len: 4.4, loop: true, keys: [K(0, "type", "smooth", MON), K(2.2, "type", "smooth", MON), K(2.5, "typeGlance"), K(3.1, "typeGlance"), K(3.35, "type", "smooth", MON)] },
  // A rapid burst of typing (the figure speeds the taps up), the hand winds up and SLAMS Enter, a smug beat.
  enter: { len: 3.0, loop: true, keys: [K(0, "type", "smooth", MON), K(1.5, "type", "smooth", MON), K(1.72, "enterWind"), K(ENTER_SLAM_S, "enterSlam", "snap"), K(2.4, "enterSlam", "smooth", { emotion: "happy" }), K(2.75, "type", "smooth", MON)] },
  // Arms up with a yawn, then leaning back with the hands behind the head, back to the keys.
  stretch: { len: 5.0, loop: true, keys: [K(0, "type", "smooth", MON), K(0.6, "stretchUp"), K(1.6, "stretchUp"), K(2.2, "handsBehind"), K(3.8, "handsBehind"), K(4.4, "type", "smooth", MON)] },
  // Leaning in to squint at the screen, closer, then a finger-up "aha".
  squint: { len: 5.2, loop: true, keys: [K(0, "type", "smooth", MON), K(0.5, "squint", "smooth", MON), K(2.0, "squint", "smooth", MON), K(2.4, "squintNear", "smooth", MON), K(3.2, "squintNear", "smooth", MON), K(3.35, "squintAha", "snap", { gaze: 0.5 }), K(3.9, "squintAha", "smooth", { gaze: 0.5 }), K(4.6, "type", "smooth", MON)] },
  // Push off the desk, roll out to grab a printout, roll back reading it.
  roll: { len: 4.4, loop: true, keys: [K(0, "type", "smooth", MON), K(0.4, "rollPush"), K(1.0, "rollReach"), K(1.5, "rollReach"), K(2.3, "rollBack"), K(3.2, "readPaper", "smooth", { gaze: -0.5 }), K(3.7, "readPaper", "smooth", { gaze: -0.5 }), K(4.0, "type", "smooth", MON)] },
  // The boss reads a report and turns a page every couple of seconds.
  reports: { len: 6, loop: true, keys: [K(0, "reportsHold"), K(1.8, "reportsHold"), K(2.1, "reportsFlip"), K(2.5, "reportsHold"), K(4.2, "reportsHold"), K(4.5, "reportsFlip"), K(4.9, "reportsHold")] },
  // Ticking boxes on the clipboard (the pen ticks are layered by the figure), a skeptical look up.
  clipboard: { len: 4, loop: true, keys: [K(0, "clipHold"), K(1.6, "clipHold"), K(1.8, "clipLook", "smooth", { gaze: 0.3 }), K(2.4, "clipLook", "smooth", { gaze: 0.3 }), K(2.6, "clipHold")] },
  // Looking around the team over the clipboard: left, center, right.
  supervise: { len: 6.4, loop: true, keys: [K(0, "superviseL", "smooth", { gaze: -1 }), K(1.4, "superviseL", "smooth", { gaze: -1 }), K(2.2, "superviseC"), K(2.9, "superviseC"), K(3.7, "superviseR", "smooth", { gaze: 1 }), K(5.1, "superviseR", "smooth", { gaze: 1 })] },
  // A coffee: reach, lift and sip with closed eyes, set it down, sit back and look around.
  sip: { len: 6, loop: true, keys: [K(0, "sitBack"), K(MUG_GRAB_S, "reachMug"), K(1.3, "sipUp"), K(2.6, "sipUp"), K(MUG_DROP_S, "reachMug"), K(3.7, "sitBack"), K(5.0, "sitBack", "smooth", { gaze: -0.5 })] },
  // Head down on the desk, breathing slowly.
  sleep: { len: 5, loop: true, keys: [K(0, "sleep"), K(2.5, "sleepDeep")] },
  // Paused: a blank stare with a slow head tilt.
  blank: { len: 6, loop: true, keys: [K(0, "blank"), K(3, "blank2")] },
  // A tool failure: a facepalm.
  facepalm: { len: 1.0, loop: false, keys: [K(0, "facepalm"), K(1.0, "facepalm")] },
  // The session ended: leans back, hands behind the head.
  relax: { len: 3, loop: false, keys: [K(0, "sitBack", "smooth", { emotion: "calm" }), K(0.8, "handsBehind"), K(3, "handsBehind", "smooth", { emotion: "content" })] },
  // Killed: a jolt, then a slump with x x eyes.
  slump: { len: 2, loop: false, keys: [K(0, "sitBack"), K(0.12, "jolt", "snap"), K(0.4, "jolt"), K(1.4, "slump"), K(2, "slump")] },
  // burst(): frantic typing with sweat.
  frantic: { len: 1.5, loop: false, keys: [K(0, "frantic"), K(1.5, "frantic")] },
  // A working turn ends: a happy stretch, then sit back.
  done: { len: 2.2, loop: false, keys: [K(0, "type"), K(0.35, "stretchUp", "smooth", { emotion: "happy" }), K(1.3, "stretchUp", "smooth", { emotion: "happy" }), K(2.2, "sitBack", "smooth", { emotion: "content" })] },
  // react("outburst"): hands up, SLAM, fists up shouting, a second SLAM.
  outburst: { len: 2.0, loop: false, keys: [K(0, "slamWind"), K(0.22, "slamWind"), K(OUTBURST_SLAMS[0]!, "slamDown", "snap"), K(0.7, "slamDown"), K(0.85, "shout"), K(1.45, "shout"), K(OUTBURST_SLAMS[1]!, "slamDown", "snap"), K(2.0, "slamDown")] },
  // P-VIZ.7: the desk phone rings: the handset to the ear, listening, answering, nodding, hung up.
  phone: { len: 6.2, loop: true, keys: [K(0, "sitBack"), K(PHONE_GRAB_S, "reachPhone"), K(1.2, "phoneEar"), K(2.2, "phoneTalk", "smooth", { gaze: 0.5 }), K(3.2, "phoneEar"), K(4.2, "phoneTalk", "smooth", { gaze: -0.5 }), K(4.7, "phoneEar"), K(PHONE_DROP_S, "reachPhone"), K(5.7, "sitBack")] },
  // P-VIZ.7: the headphones off the stand and on, a stretch to the music, hands behind the head, back on the stand.
  headphones: { len: 6.6, loop: true, keys: [K(0, "type", "smooth", MON), K(PHONES_GRAB_S, "reachPhones"), K(PHONES_ON_S, "phonesOn"), K(1.5, "phonesOn"), K(2.1, "stretchUp", "smooth", { emotion: "happy" }), K(2.9, "stretchUp", "smooth", { emotion: "happy" }), K(3.5, "handsBehind"), K(4.7, "handsBehind"), K(PHONES_OFF_S, "phonesOn"), K(PHONES_BACK_S, "reachPhones"), K(6.3, "type", "smooth", MON)] },
  // P-VIZ.7: the boss flicks through a report, then looks over it at the team, left and right.
  flip: { len: 4, loop: true, keys: [K(0, "reportsHold"), K(FLICKS[0]!, "reportsFlip"), K(0.55, "reportsHold"), K(FLICKS[1]!, "reportsFlip"), K(1.0, "reportsHold"), K(FLICKS[2]!, "reportsFlip"), K(1.45, "reportsHold"), K(2.0, "reportsPeek", "smooth", { gaze: -1 }), K(2.7, "reportsPeek", "smooth", { gaze: 1 }), K(3.4, "reportsHold")] },
  // P-VIZ.7: the commit at the copier: press the button, wait for the copies, a sip, again (commitLook layers the
  // furtive looks around the office on top).
  copy: { len: COPY_LEN, loop: true, keys: [K(0, "copyIdle"), K(0.3, "copyReach"), K(COPY_PRESS_S, "copyPress", "snap"), K(0.75, "copyReach"), K(1.0, "copyIdle"), K(1.55, "copyIdle"), K(COPY_SIP[0], "copySip"), K(COPY_SIP[1], "copySip"), K(3.15, "copyIdle")] },
};
export const OFFICE_CLIP_NAMES = Object.keys(OFFICE_CLIPS) as OfficeClipName[];

/** Representative clip times for motion=false (a readable still of each clip). */
export const OFFICE_STILL_T: Readonly<Record<OfficeClipName, number>> = {
  type: 0.5, enter: 1.95, stretch: 3.0, squint: 2.8, roll: 1.4, reports: 1.0, clipboard: 1.0, supervise: 0.5, sip: 2.0, sleep: 0, blank: 0,
  facepalm: 0.5, relax: 3, slump: 2, frantic: 0.6, done: 1.0, outburst: 1.0,
  phone: 2.6, headphones: 3.0, flip: 2.2, copy: 2.3,
};

export interface OfficeClipSample { emotion: OfficeEmotionName; gaze: number }

export function officeClipTime(clip: OfficeClip, t: number): number {
  if (!Number.isFinite(t)) return 0;
  return clip.loop ? t - Math.floor(t / clip.len) * clip.len : Math.min(Math.max(t, 0), clip.len);
}

export function officeClipDone(clip: OfficeClip, t: number): boolean {
  return !clip.loop && t >= clip.len;
}

/** The clip's pose at `t` into `out`, its emotion and gaze into `info` (viz_anime_pose.sampleClip's rules: a loop
 *  eases its last key into its first; the emotion switches halfway through a smooth segment, at once on a snap).
 *  `poses` is the build's table (officePoseTable; P-VIZ.7), the reference build's by default. */
export function sampleOfficeClip(clip: OfficeClip, t: number, out: Float32Array, info: OfficeClipSample, poses: OfficePoseTable = OFFICE_POSE_VECTORS): void {
  const keys = clip.keys;
  const n = keys.length;
  const tt = officeClipTime(clip, t);
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
  const pa = poses[a.pose];
  const pb = poses[b.pose];
  for (let c = 0; c < OFFICE_POSE_LEN; c++) out[c] = pa[c]! + (pb[c]! - pa[c]!) * w;
  info.emotion = (b.ease === "snap" ? u > 0 : w >= 0.5) ? b.emotion : a.emotion;
  info.gaze = a.gaze + (b.gaze - a.gaze) * clamp01(w);
}

// ------------------------------------------------------------------------------------------ what plays

/** Idle this long (seconds) and the coffee turns into a head-down nap. */
export const IDLE_SLEEP_S = 60;

export function idleClip(idleSec: number): OfficeClipName {
  return Number.isFinite(idleSec) && idleSec >= IDLE_SLEEP_S ? "sleep" : "sip";
}

const WORKER_CLIPS: Readonly<Record<MiniActivity, OfficeClipName | null>> = {
  typing: "type", kiblast: "enter", kata: "stretch", scan: "squint", dash: "roll", supervise: "squint", meditate: null,
};
const BOSS_CLIPS: Readonly<Record<MiniActivity, OfficeClipName | null>> = {
  typing: "reports", kiblast: "clipboard", kata: "sip", scan: "supervise", dash: "reports", supervise: "supervise", meditate: null,
};

/** P-VIZ.7 (ADR-0641): a variant's own take on an activity slot, played with the prop its desk set has
 *  (officeDeskSet): a worker with a desk phone (3) answers it while scanning, one with headphones (1) stretches to
 *  music; the boss takes calls while scanning (0, 2) or flicks through a report while supervising (1, 3). */
function variantClip(role: OfficeRole, a: MiniActivity, v: number): OfficeClipName | null {
  if (role === "worker") {
    if (a === "scan" && v === 3) return "phone";
    if (a === "kata" && v === 1) return "headphones";
    return null;
  }
  if (a === "scan" && (v === 0 || v === 2)) return "phone";
  if (a === "supervise" && (v === 1 || v === 3)) return "flip";
  return null;
}

/** A working activity's clip for the role; null means the idle behavior (meditate is a coffee break). `variant`
 *  (0..3, -1 none: the lowest detail tier keeps the plain clips) swaps in the variant's own actions. */
export function activityClip(role: OfficeRole, a: MiniActivity, variant = -1): OfficeClipName | null {
  const map = role === "boss" ? BOSS_CLIPS : WORKER_CLIPS;
  if (!Object.prototype.hasOwnProperty.call(map, a)) return WORKER_CLIPS.typing;
  return variantClip(role, a, variant) ?? map[a];
}

/** What the figure plays: a power-down state's clip, else the activity (idle and meditate: coffee or a nap). */
export function officeClipFor(role: OfficeRole, state: OfficeState, a: MiniActivity, idleSec: number, variant = -1): OfficeClipName {
  switch (state) {
    case "killed": return "slump";
    case "ended": return "relax";
    case "failed": return "facepalm";
    case "paused": return "blank";
    // an idle node whose team works supervises (viz_mini_look.activityAt) instead of a coffee or a nap
    case "idle": return a === "supervise" ? activityClip(role, a, variant) ?? idleClip(idleSec) : idleClip(idleSec);
    default: return activityClip(role, a, variant) ?? idleClip(0);
  }
}

/** The variant 0..3 a figure is built as: the brand's (stable per model), else the node's seed. */
export function officeVariant(brandVariant: number | null | undefined, seed: number): number {
  const v = typeof brandVariant === "number" && Number.isFinite(brandVariant) ? Math.floor(brandVariant) : Number.isFinite(seed) ? Math.floor(seed) : 0;
  return ((v % 4) + 4) % 4;
}

/** What a worker wears per variant over the seeded cast: 0 the cast's own top, 1 a vest over the shirt or blouse,
 *  2 rolled-up shirt sleeves and a loosened tie (a woman: a cardigan), 3 a hoodie. */
export type WorkerOutfit = WorkerTop | "vest" | "rolled" | "hoodie";
export function workerOutfit(c: WorkerCast, variant: number): WorkerOutfit {
  switch (variant) {
    case 1: return "vest";
    case 2: return c.gender === "female" ? "cardigan" : "rolled";
    case 3: return "hoodie";
    default: return c.top;
  }
}

/** The extra things on a desk per variant (the pile, a stack of TPS reports with the stapler on it, and the mug are
 *  on every desk; the boss always has the phone). The lowest detail tier skips them. */
export type DeskItem = "plant" | "photo" | "headphones" | "nameplate" | "monitor2" | "lamp" | "phone";
// (the desk lamp goes to the boss: on a worker's desk its arm would cross the side monitor)
const WORKER_DESKS: readonly (readonly DeskItem[])[] = [["plant", "photo"], ["headphones", "nameplate"], ["monitor2", "plant"], ["phone", "photo"]];
const BOSS_DESKS: readonly (readonly DeskItem[])[] = [["phone", "plant", "photo"], ["phone", "headphones", "photo"], ["phone", "lamp", "plant"], ["phone", "lamp", "photo"]];
export function officeDeskSet(role: OfficeRole, variant: number): readonly DeskItem[] {
  return (role === "boss" ? BOSS_DESKS : WORKER_DESKS)[officeVariant(variant, 0)]!;
}

/** A one-shot fired by a state change: a working turn that ends plays the happy stretch. */
export function officeTransitionShot(prev: OfficeState, next: OfficeState): "done" | null {
  return prev === "working" && next === "idle" ? "done" : null;
}

/** The activity clock's speed: faster with the intensity while working, frozen while paused. */
export function officeTempo(state: OfficeState, k: number): number {
  const x = Number.isFinite(k) ? clamp01(k) : 0;
  return state === "working" ? 0.75 + 0.6 * x : state === "paused" ? 0 : 1;
}

/** Typing taps per second at intensity k (frantic: much faster). */
export function tapRate(k: number, frantic: boolean): number {
  const x = Number.isFinite(k) ? clamp01(k) : 0;
  return frantic ? 18 : 5 + 7 * x;
}

/** enter clip: the tap tempo multiplier, accelerating into the slam; 0 while the hand winds up and slams. */
export function enterTapBoost(t: number): number {
  if (t < 1.5) return 1 + 1.5 * clamp01(t / 1.5);
  return t < 2.75 ? 0 : 1;
}

export function mugHeld(clip: OfficeClipName, t: number): boolean {
  return clip === "sip" && t >= MUG_GRAB_S && t < MUG_DROP_S;
}

export function printHeld(clip: OfficeClipName, t: number): boolean {
  return clip === "roll" && t >= PRINT_GRAB_S && t < PRINT_DROP_S;
}

/** reports clip: the turning page's progress 0..1, or -1 when no page is turning. */
export function pageFlipAt(t: number): number {
  for (const s of PAGE_FLIPS) if (t >= s && t < s + FLIP_S) return (t - s) / FLIP_S;
  return -1;
}

// ---- P-VIZ.7 (ADR-0641): the new props' timing, the typing taps, the commit

/** flip clip: the flicked page's progress 0..1, or -1 when none is turning. */
export function flickAt(t: number): number {
  for (const s of FLICKS) if (t >= s && t < s + FLICK_S) return (t - s) / FLICK_S;
  return -1;
}

/** The held mug's tilt toward the lips (0 upright): full over the sip's hold, upright when it leaves and meets the
 *  desk coaster. */
export function mugTilt(clip: OfficeClipName, t: number): number {
  if (clip === "sip") return SIP_TIP * bump(t, 1.0, 1.3, 2.6, 2.9);
  if (clip === "copy") return SIP_TIP * bump(t, COPY_SIP[0] - 0.3, COPY_SIP[0], COPY_SIP[1], COPY_SIP[1] + 0.3);
  return 0;
}

export function handsetHeld(clip: OfficeClipName, t: number): boolean {
  return clip === "phone" && t >= PHONE_GRAB_S && t < PHONE_DROP_S;
}

/** Where the headphones are during the headphones clip (any other clip: on the stand). */
export type PhonesAt = "stand" | "hand" | "head";
export function phonesAt(clip: OfficeClipName, t: number): PhonesAt {
  if (clip !== "headphones" || t < PHONES_GRAB_S || t >= PHONES_BACK_S) return "stand";
  return t >= PHONES_ON_S && t < PHONES_OFF_S ? "head" : "hand";
}

/** headphones clip: how much the head nods to the music (0..1). */
export function phonesGroove(t: number): number {
  return bump(t, PHONES_ON_S, 1.5, PHONES_OFF_S - 0.4, PHONES_OFF_S);
}

/** Typing: a tap lowers the hand onto the keys (the elbow opens a little), the hands alternate, and each wanders
 *  slowly across its half of the keyboard. Small on purpose: the palms stay over the keys (the tests pin it). */
export const TAP_ELBOW = 0.045;
export const TAP_SHOULDER = 0.012;
export const TAP_DRIFT = 0.045;
const T_SHL = officeJointOffset("shL");
const T_ELL = officeJointOffset("elL");
const T_SHR = officeJointOffset("shR");
const T_ELR = officeJointOffset("elR");
/** Lay the typing taps over `pose` at tap phase `ph` (cycles; the right hand half a cycle after the left) by `w`. */
export function applyTyping(pose: Float32Array, ph: number, w: number): void {
  if (!(w > 0)) return;
  const tl = tapCurve(fract(ph)) * w, tr = tapCurve(fract(ph + 0.5)) * w;
  pose[T_ELL] = pose[T_ELL]! + TAP_ELBOW * tl;
  pose[T_SHL] = pose[T_SHL]! + TAP_SHOULDER * tl;
  pose[T_ELR] = pose[T_ELR]! + TAP_ELBOW * tr;
  pose[T_SHR] = pose[T_SHR]! + TAP_SHOULDER * tr;
  pose[T_SHL + 2] = pose[T_SHL + 2]! + TAP_DRIFT * w * Math.sin(ph * 0.37);
  pose[T_SHR + 2] = pose[T_SHR + 2]! + TAP_DRIFT * w * Math.sin(ph * 0.29 + 1.7);
}

/** commit: the furtive look around the office, a yaw for the head (positive toward the back wall, negative over
 *  the left shoulder toward the room, the big one a full glance over the shoulder), quiet while he sips.
 *  `t` is the commit's running time, `clipT` the copy clip's. */
export const LOOK_AROUND_S = 7.2;
export function commitLook(t: number, clipT: number): number {
  if (!Number.isFinite(t)) return 0;
  const u = t - Math.floor(t / LOOK_AROUND_S) * LOOK_AROUND_S;
  const yaw = 0.7 * bump(u, 0.9, 1.4, 2.1, 2.6) - 0.55 * bump(u, 2.6, 3.1, 3.7, 4.2) - 1.35 * bump(u, 4.6, 5.2, 6.2, 6.8);
  return yaw * (1 - bump(clipT, COPY_SIP[0] - 0.35, COPY_SIP[0], COPY_SIP[1], COPY_SIP[1] + 0.35));
}

/** commit: how many copies have started out of the copier `t` seconds in (the copy clip's unwrapped time). */
export function copiesStarted(t: number): number {
  if (!(t >= 0)) return 0;
  const n = Math.floor(t / COPY_LEN), r = t - n * COPY_LEN;
  let c = n * COPY_EJECTS.length;
  for (const s of COPY_EJECTS) if (r >= s - 1e-9) c++; // (copyStartAt's sums land within rounding of s)
  return c;
}

/** commit: when copy `j` (0-based) starts out of the copier. */
export function copyStartAt(j: number): number {
  const per = COPY_EJECTS.length;
  return Math.floor(j / per) * COPY_LEN + COPY_EJECTS[j % per]!;
}

/** commit: copy `j`'s slide out onto the tray at `t`, 0 (in the slot) .. 1 (landed). */
export function copyProgress(j: number, t: number): number {
  return clamp01((t - copyStartAt(j)) / EJECT_S);
}

/** commit: the start button's travel 0..1 (pressed) around COPY_PRESS_S. */
export function buttonPress(clipT: number): number {
  return bump(clipT, COPY_PRESS_S - 0.08, COPY_PRESS_S, COPY_PRESS_S + 0.06, COPY_PRESS_S + 0.2);
}

// ------------------------------------------------------------------------------------------ reactions

export type ReactKind = "stare" | "outburst";
export const STARE_MIN_S = 1.6;
export const STARE_MAX_S = 2.2;
/** The outburst body clip runs this long, then the glare at the camera holds GLARE_S. */
export const OUTBURST_S = 2.0;
export const GLARE_S = 1.2;
const LOOK_IN_S = 0.12;
const LOOK_OUT_S = 0.35;
const GLARE_AT = OUTBURST_S - 0.1;
/** Flying papers stay airborne this long after the first slam. */
export const PAPER_S = 1.4;

/** How long a stare holds the gaze, from a uniform random number in [0, 1). */
export function stareHold(r: number): number {
  return STARE_MIN_S + (STARE_MAX_S - STARE_MIN_S) * clamp01(Number.isFinite(r) ? r : 0.5);
}

export function reactLength(kind: ReactKind, hold: number): number {
  return kind === "stare" ? hold + LOOK_OUT_S : GLARE_AT + GLARE_S + LOOK_OUT_S;
}

/** One frame of a reaction: `body` blends the outburst clip over the pose, `look` turns the head to the camera,
 *  `lift` raises a slumped torso to look, `emotion` overrides the face (null = the clip's own). */
export interface ReactSample {
  body: number; look: number; lift: number; emotion: OfficeEmotionName | null;
  red: number; steam: number; shake: number; papers: number; slosh: number; done: boolean;
}

function lookCurve(t: number, start: number, end: number): number {
  if (t < start || t >= end + LOOK_OUT_S) return 0;
  if (t < start + LOOK_IN_S) return 1 - (1 - (t - start) / LOOK_IN_S) ** 3;
  if (t < end) return 1;
  const u = (t - end) / LOOK_OUT_S;
  return 1 - u * u * (3 - 2 * u);
}

function impact(t: number, decay: number): number {
  let m = 0;
  for (const s of OUTBURST_SLAMS) if (t >= s && t < s + decay) m = Math.max(m, 1 - (t - s) / decay);
  return m;
}

export function reactAt(kind: ReactKind, t: number, hold: number, out: ReactSample): ReactSample {
  const tt = Number.isFinite(t) ? t : 0;
  out.done = tt >= reactLength(kind, hold);
  if (kind === "stare") {
    out.body = 0;
    out.look = lookCurve(tt, 0, hold);
    out.lift = out.look;
    out.emotion = tt < 0 || out.done ? null : tt < 0.3 ? "wide" : tt < hold + 0.15 ? "annoyed" : null;
    out.red = out.steam = out.shake = out.slosh = 0;
    out.papers = -1;
    return out;
  }
  out.body = tt < 0 ? 0 : bump(tt, 0, 0.1, GLARE_AT, OUTBURST_S + 0.2);
  out.look = Math.max(0.6 * bump(tt, 0.8, 0.95, 1.45, 1.6), lookCurve(tt, GLARE_AT, GLARE_AT + GLARE_S));
  out.lift = out.look;
  out.emotion = tt < 0 || out.done ? null : tt < OUTBURST_SLAMS[0]! ? "angry" : tt < GLARE_AT ? "furious" : tt < GLARE_AT + GLARE_S + 0.15 ? "glare" : null;
  out.red = bump(tt, 0.1, 0.4, 2.6, 3.4);
  out.steam = bump(tt, 0.35, 0.55, 2.1, 2.7);
  out.shake = impact(tt, 0.35);
  out.slosh = impact(tt, 0.8);
  const p = tt - OUTBURST_SLAMS[0]!;
  out.papers = p >= 0 && p < PAPER_S ? p / PAPER_S : -1;
  return out;
}

/** Head angles toward a target at (dx, dy, dz) from the head, in the figure's frame (+Z forward): yaw turns the
 *  face toward +X, pitch < 0 lifts the face. Clamped to what a neck can do. */
export const LOOK_YAW_MAX = 1.5;
export const LOOK_PITCH_MAX = 0.7;
export interface LookAngles { yaw: number; pitch: number }
export function lookAngles(dx: number, dy: number, dz: number, out: LookAngles): LookAngles {
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(dz)) { out.yaw = 0; out.pitch = 0; return out; }
  const yaw = Math.atan2(dx, dz);
  const pitch = -Math.atan2(dy, Math.hypot(dx, dz));
  out.yaw = Math.max(-LOOK_YAW_MAX, Math.min(LOOK_YAW_MAX, yaw));
  out.pitch = Math.max(-LOOK_PITCH_MAX, Math.min(LOOK_PITCH_MAX, pitch));
  return out;
}

// ------------------------------------------------------------------------------------------ hits (P-VIZ.6)
//
// The anime figure's hit rules (viz_anime_pose: full weight over the activity from the start, blended in from the
// pose on screen over HIT_BLEND_S, turned toward the throw over HIT_TURN_S, handed back over the last HIT_OUT_S).
//   paper: a jolt, rub the head, look round for who threw it with annoyed eyes, back to work.
//   band: a sharp "ow", the hand clapped to the neck, a glare toward the thrower.
//   drink: caught overhead, chugged, a fist up; the charge (DRINK_CHARGE over DRINK_S) speeds the work up.
//   storm: papers fly off the pile, he ducks and holds the desk, then smooths the hair and the tie (no turn).
//   flinch: the anime throwables (stars, bolt, orb) here: a jolt and an annoyed look.

export type OfficeHit = "paper" | "band" | "drink" | "storm" | "flinch";
/** drink: the can is in the hand between these hit times; the chug tilts it over CHUG_AT..CHUG_END. */
export const CAN_GRAB_S = 0.12;
export const CAN_DROP_S = 2.1;
const CHUG_AT = 0.7;
const CHUG_END = 1.55;
/** storm: the papers leave the pile at this hit time. */
export const STORM_PAPERS_AT = 0.1;

export const OFFICE_HIT_CLIPS: Readonly<Record<OfficeHit, OfficeClip>> = {
  paper: {
    len: 2.0, loop: false,
    keys: [K(0, "hitJolt"), K(0.08, "hitJolt", "snap"), K(0.45, "rubHead"), K(1.1, "rubHead"), K(1.35, "sitBack", "smooth", { emotion: "annoyed" }), K(2.0, "sitBack", "smooth", { emotion: "annoyed" })],
  },
  band: { len: 1.8, loop: false, keys: [K(0, "hitJolt"), K(0.06, "owClutch", "snap"), K(0.7, "owClutch"), K(1.0, "owClutch", "smooth", { emotion: "glare" }), K(1.8, "owClutch", "smooth", { emotion: "glare" })] },
  drink: {
    len: 2.4, loop: false,
    keys: [K(0, "sitBack"), K(CAN_GRAB_S, "catchCan", "snap"), K(0.5, "catchCan", "smooth", { emotion: "happy" }), K(CHUG_AT, "chug"), K(CHUG_END, "chug"), K(1.7, "pumped", "snap"), K(2.4, "pumped")],
  },
  storm: {
    len: 3.0, loop: false,
    keys: [K(0, "hitJolt"), K(0.12, "duck", "snap"), K(1.4, "duck"), K(1.8, "smoothHair"), K(2.3, "smoothTie"), K(3.0, "smoothTie")],
  },
  flinch: { len: 1.6, loop: false, keys: [K(0, "hitJolt"), K(0.08, "hitJolt", "snap"), K(0.6, "sitBack", "smooth", { emotion: "annoyed" }), K(1.6, "sitBack", "smooth", { emotion: "annoyed" })] },
};

export interface OfficeHitPlan {
  readonly kind: HitKind;
  readonly play: OfficeHit;
  readonly len: number;
  readonly turns: boolean;
  readonly turnFrom: number;
  readonly strength: number;
}

export interface OfficeHitSample {
  body: number; blend: number; turn: number;
  emotion: OfficeEmotionName | null;
  /** drink: the can is in the hand, and how far it is tipped up to drink (0..1). */
  can: boolean; tilt: number;
  /** storm: the flying papers' progress 0..1 (paperFlight), -1 when none fly. */
  papers: number;
  shake: number;
  done: boolean;
}

export function clearOfficeHit(out: OfficeHitSample): OfficeHitSample {
  out.body = 0; out.blend = 1; out.turn = 0; out.emotion = null; out.can = false; out.tilt = 0; out.papers = -1; out.shake = 0; out.done = true;
  return out;
}

export function newOfficeHitSample(): OfficeHitSample {
  return clearOfficeHit({ body: 0, blend: 1, turn: 0, emotion: null, can: false, tilt: 0, papers: -1, shake: 0, done: true });
}

export function officeHitPlay(kind: HitKind): OfficeHit {
  return kind === "paper" || kind === "band" || kind === "drink" || kind === "storm" ? kind : "flinch";
}

/** Plans a hit; `prevTurn` is the turn weight of a hit still playing (0 when none), so the new one turns on
 *  without a jump. */
export function planOfficeHit(kind: HitKind, strength: number, prevTurn: number): OfficeHitPlan {
  const play = officeHitPlay(kind);
  const s = Number.isFinite(strength) ? clamp01(strength) : 1;
  const turnFrom = clamp01(Number.isFinite(prevTurn) ? prevTurn : 0);
  return { kind, play, len: OFFICE_HIT_CLIPS[play].len, turns: play !== "storm", turnFrom, strength: s };
}

/** The office figure's charge from a hit: only the energy drink leaves one. */
export function officeHitCharge(c: Charge, kind: HitKind, strength: number): Charge {
  const s = Number.isFinite(strength) ? clamp01(strength) : 1;
  return kind === "drink" ? addBoost(c, DRINK_CHARGE * s, DRINK_S) : c;
}

const HIT_SCRATCH = new Float32Array(OFFICE_POSE_LEN);
const HIT_INFO: OfficeClipSample = { emotion: "neutral", gaze: 0 };

/** The hit `t` seconds in: weights and effects into `out`, the clip's pose into `pose` (when given). Past `len`
 *  it is cleared and `done`. */
export function sampleOfficeHit(p: OfficeHitPlan, t: number, out: OfficeHitSample, pose?: Float32Array): OfficeHitSample {
  const tt = Number.isFinite(t) ? Math.max(0, t) : 0;
  if (tt >= p.len) return clearOfficeHit(out);
  out.done = false;
  const outAt = p.len - HIT_OUT_S;
  out.body = tt < outAt ? 1 : Math.max(0, 1 - smoothEase((tt - outAt) / HIT_OUT_S));
  out.blend = smoothEase(tt / HIT_BLEND_S);
  const tu = smoothEase(tt / HIT_TURN_S);
  // the turn hands back with the body: holding it at full weight to the end snapped the figure round at `len`
  out.turn = (p.turns ? p.turnFrom + (1 - p.turnFrom) * tu : p.turnFrom * (1 - tu)) * out.body;
  sampleOfficeClip(OFFICE_HIT_CLIPS[p.play], tt, pose ?? HIT_SCRATCH, HIT_INFO);
  out.emotion = tt < p.len - HIT_OUT_S * 0.5 ? HIT_INFO.emotion : null;
  out.can = p.play === "drink" && tt >= CAN_GRAB_S && tt < CAN_DROP_S;
  out.tilt = p.play === "drink" ? bump(tt, CHUG_AT, CHUG_AT + 0.2, CHUG_END - 0.15, CHUG_END) : 0;
  const pp = tt - STORM_PAPERS_AT;
  out.papers = p.play === "storm" && pp >= 0 && pp < PAPER_S ? pp / PAPER_S : -1;
  const kick = p.play === "storm" ? 0.3 : p.play === "drink" ? 0.15 : 0.25;
  out.shake = tt < kick ? (p.play === "drink" ? 0.3 : 0.7) * p.strength * (1 - tt / kick) : 0;
  return out;
}

// ------------------------------------------------------------------------------------------ effect timing

/** The CRT power-off over CRT_S: the picture collapses to a bright line, the line to a dot, the dot fades. */
export const CRT_S = 0.45;
export interface Crt { sx: number; sy: number; a: number }
export function crtOff(t: number, out: Crt): Crt {
  if (!(t >= 0) || t >= CRT_S) { out.sx = 0; out.sy = 0; out.a = 0; return out; }
  if (t < 0.18) { const u = t / 0.18; out.sx = 1; out.sy = 1 - 0.98 * u; out.a = 0.6 + 0.4 * u; }
  else if (t < 0.38) { const u = (t - 0.18) / 0.2; out.sx = 1 - 0.97 * u; out.sy = 0.02; out.a = 1; }
  else { out.sx = 0.03; out.sy = 0.02; out.a = 1 - (t - 0.38) / (CRT_S - 0.38); }
  return out;
}

/** A flying paper `i` of `n` at progress u (0..1 of PAPER_S) from the desk pile: up and out, fluttering down to
 *  no lower than `floor` below the desk top. Deterministic per paper. */
export interface Paper { x: number; y: number; z: number; rx: number; rz: number }
export function paperFlight(i: number, n: number, u: number, floor: number, out: Paper): Paper {
  const h = hash32(i * 7919 + 13);
  const r1 = (h & 1023) / 1023, r2 = ((h >>> 10) & 1023) / 1023;
  const a = (n > 1 ? i / (n - 1) : 0.5) * Math.PI * 0.9 - Math.PI * 0.45 + (r1 - 0.5) * 0.4; // a fan, front-facing
  const s = clamp01(Number.isFinite(u) ? u : 0) * PAPER_S;
  const vh = 0.35 + 0.25 * r2, vy = 1.5 + 0.5 * r1, g = 3.4;
  const reach = vh * (1 - Math.exp(-s * 2.2)); // air drag: the paper drifts out and stops
  out.x = Math.sin(a) * reach + 0.04 * Math.sin(s * 7 + i);
  out.z = Math.cos(a) * reach;
  out.y = Math.max(-floor, vy * s - 0.5 * g * s * s);
  out.rx = s * (3 + 2 * r1);
  out.rz = s * (2 - 4 * r2);
  return out;
}

/** The sleeping "z" `i` of `n` at time t: rising from the head, swaying, growing, fading. */
export interface Zed { x: number; y: number; s: number; a: number }
export function zedAt(i: number, n: number, t: number, out: Zed): Zed {
  const ph = fract((Number.isFinite(t) ? t : 0) / 2.4 + (n > 0 ? i / n : 0));
  out.y = ph * 0.35;
  out.x = 0.06 * ph + 0.035 * Math.sin(ph * Math.PI * 2);
  out.s = 0.04 + 0.05 * ph;
  out.a = bump(ph, 0, 0.2, 0.7, 1);
  return out;
}

// ------------------------------------------------------------------------------------------ the manager on duty

/** The managers hand over every MANAGER_SWAP_MIN_S to MANAGER_SWAP_MAX_S seconds (a seeded draw per handover). */
export const MANAGER_SWAP_MIN_S = 8 * 60;
export const MANAGER_SWAP_MAX_S = 15 * 60;
/** A boss built within this many seconds of the last one going away is a rebuild (a style, 2D/3D or detail
 *  switch), not a new open of Visualize: it keeps the cast instead of flipping a new coin. */
export const MANAGER_REBUILD_S = 10;

export function otherManager(v: ManagerVariant): ManagerVariant {
  return v === "man" ? "woman" : "man";
}

/** Draw `k` of the uniform stream for `seed`, in [0, 1). Pure: the same seed and draw give the same number. */
export function seededUnit(seed: number, k: number): number {
  const s = Number.isFinite(seed) ? Math.floor(Math.abs(seed)) % 4294967296 : 0;
  const i = Number.isFinite(k) ? Math.floor(Math.abs(k)) : 0;
  return hash32((s ^ Math.imul(i + 1, 0x9e3779b1)) | 0) / 4294967296;
}

/** Who is at the boss's desk, and when the next handover is due (seconds on the caller's clock). */
export interface ManagerCast { readonly variant: ManagerVariant; readonly seed: number; readonly swaps: number; readonly nextAt: number }
/** The cast the last boss left with, and when he or she went away. */
export interface ManagerMemo { readonly cast: ManagerCast; readonly goneAt: number }

/** Seconds until handover `k` (draw 0 is the opening coin flip, the delays use the odd draws). */
export function managerSwapDelay(seed: number, k: number): number {
  return MANAGER_SWAP_MIN_S + (MANAGER_SWAP_MAX_S - MANAGER_SWAP_MIN_S) * seededUnit(seed, 2 * k + 1);
}

/** The cast for a boss built at `now`: the remembered one when the last boss went away under MANAGER_REBUILD_S
 *  ago (a rebuild), else a coin flip for who opens, with the first handover a seeded delay away. */
export function openManagerCast(seed: number, now: number, memo: ManagerMemo | null): ManagerCast {
  const t = Number.isFinite(now) ? now : 0;
  if (memo && t >= memo.goneAt && t - memo.goneAt <= MANAGER_REBUILD_S) return memo.cast;
  return { variant: seededUnit(seed, 0) < 0.5 ? "man" : "woman", seed, swaps: 0, nextAt: t + managerSwapDelay(seed, 0) };
}

/** The cast once `variant` takes the desk at `now` (a handover or a pinned choice): the next one a fresh delay away. */
export function recastManager(c: ManagerCast, variant: ManagerVariant, now: number): ManagerCast {
  const swaps = c.swaps + 1;
  return { variant, seed: c.seed, swaps, nextAt: (Number.isFinite(now) ? now : 0) + managerSwapDelay(c.seed, swaps) };
}

export function managerSwapDue(c: ManagerCast, now: number): boolean {
  return Number.isFinite(now) && now >= c.nextAt;
}

/** A handover waits for a quiet moment: at the desk (idle or working; a paused, ended, killed or failed hub keeps
 *  its manager), no reaction and no one-shot (the done stretch, a frantic burst) playing. */
export function managerSwapReady(state: OfficeState, reacting: boolean, oneShot: boolean): boolean {
  return (state === "idle" || state === "working") && !reacting && !oneShot;
}

/** The handover: the manager on duty stands (pushing the chair back) over SWAP_RISE_S, turns and walks off toward
 *  +X over SWAP_WALK_S while dissolving; at SWAP_AT_S the other takes over out of sight and plays it in reverse
 *  (walks in, turns to the desk, sits down). */
export const SWAP_RISE_S = 0.6;
export const SWAP_WALK_S = 1.1;
export const SWAP_AT_S = SWAP_RISE_S + SWAP_WALK_S;
export const MANAGER_SWAP_S = 2 * SWAP_AT_S;
/** How far the walk goes (figure units, toward +X); how high the hips rise to stand, and how far they step
 *  forward of the pushed-back chair. */
export const SWAP_WALK_X = 0.62;
export const STAND_LIFT = STAND_HIP_LIFT;
export const STAND_FORWARD = 0.22;
const SWAP_TURN = 1.25;
const STEP_HZ = 1.7;

export interface SwapSample {
  /** 0 seated .. 1 standing: the weight of the standing pose. */
  stand: number;
  /** The hips' offset from their seated place (figure units). */
  x: number; lift: number; z: number;
  /** The body's turn toward the walk (positive faces +X). */
  turn: number;
  /** The stride's weight 0..1 and its phase in stride cycles. */
  gait: number; phase: number;
  /** The figure's opacity (the dissolve). */
  alpha: number;
  /** The second half: the incoming manager is the one on screen. */
  incoming: boolean;
  done: boolean;
}

export function managerSwapAt(t: number, out: SwapSample): SwapSample {
  const tt = Number.isFinite(t) ? Math.max(0, t) : 0;
  out.done = tt >= MANAGER_SWAP_S;
  out.incoming = tt >= SWAP_AT_S;
  const u = out.incoming ? Math.max(0, MANAGER_SWAP_S - tt) : tt; // the incoming half is the outgoing one in reverse
  const w = clamp01((u - SWAP_RISE_S) / SWAP_WALK_S);
  out.stand = ease("smooth", u / SWAP_RISE_S);
  out.gait = ease("smooth", (u - SWAP_RISE_S + 0.1) / 0.25);
  out.phase = tt * STEP_HZ;
  out.x = SWAP_WALK_X * w * w * (3 - 2 * w);
  out.z = STAND_FORWARD * out.stand;
  out.lift = STAND_LIFT * out.stand + 0.012 * out.gait * Math.abs(Math.cos(out.phase * Math.PI * 2));
  out.turn = SWAP_TURN * ease("smooth", (u - SWAP_RISE_S * 0.6) / (SWAP_RISE_S * 0.6)) * (out.incoming ? -1 : 1);
  out.alpha = 1 - ease("smooth", (w - 0.3) / 0.7);
  return out;
}

/** Standing beside the pushed-back chair: legs straight, arms loose. */
export const STAND_POSE = officePoseVector({
  emotion: "content", rootZ: -0.3, spine: [0.04, 0, 0], head: [0.05, 0, 0],
  shL: [0.05, 0, -0.1], elL: [-0.2, 0, 0], shR: [0.05, 0, 0.1], elR: [-0.2, 0, 0],
  hipL: [0, 0, -0.03], kneeL: [0, 0, 0], hipR: [0, 0, 0.03], kneeR: [0, 0, 0],
});
const W_HIPS = officeJointOffset("hips");
const W_HIPL = officeJointOffset("hipL");
const W_KNEEL = officeJointOffset("kneeL");
const W_HIPR = officeJointOffset("hipR");
const W_KNEER = officeJointOffset("kneeR");
const W_SHL = officeJointOffset("shL");
const W_SHR = officeJointOffset("shR");

/** Blend `pose` toward STAND_POSE by s.stand, walk on top of it (alternating legs, counter-swinging arms) and
 *  turn the body by s.turn. The hips' offset (x, lift, z) is the figure's to apply: it is not a pose joint. */
export function applyManagerSwap(pose: Float32Array, s: SwapSample): void {
  const k = clamp01(s.stand);
  if (k > 0) for (let i = 0; i < OFFICE_POSE_LEN; i++) pose[i] = pose[i]! + (STAND_POSE[i]! - pose[i]!) * k;
  const sw = Math.sin(s.phase * Math.PI * 2) * clamp01(s.gait);
  if (sw !== 0) {
    pose[W_HIPL] = pose[W_HIPL]! - 0.5 * sw;
    pose[W_HIPR] = pose[W_HIPR]! + 0.5 * sw;
    pose[W_KNEEL] = pose[W_KNEEL]! + 0.6 * Math.max(0, sw);
    pose[W_KNEER] = pose[W_KNEER]! + 0.6 * Math.max(0, -sw);
    pose[W_SHL] = pose[W_SHL]! + 0.35 * sw;
    pose[W_SHR] = pose[W_SHR]! - 0.35 * sw;
  }
  pose[W_HIPS + 1] = pose[W_HIPS + 1]! + s.turn;
}
