// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_mini3d.ts - P-VIZ.2 (ADR-0623): mini Lucid in 3D.
//
// The pixel ninja of mascot.ts / mascot_mini.ts rebuilt procedurally in three.js: chibi proportions (the head
// is about 40% of his height), navy gi with lighter highlight panels and a dark shadow, a neon accent headband
// with two long trailing tails, an accent belt with its knot, an accent scarf, a hood that covers everything but
// the eye band, two stylized glossy eyes that blink, mitten hands and split-toe tabi. NO face beyond the eyes
// (two realistic 3D faces were rejected; see the mascot-stage skill).
//
// He is a rig of nested Groups (root, hips, spine, chest, neck, head, shoulders, elbows, wrists, fingers, hips,
// knees, ankles) driven by procedural animation only: each activity writes a pose (a flat channel array) from its
// own clock, poses blend over BLEND_S on every activity or state change, and fast accents (strike curves with
// anticipation, an ease-out-back overshoot and a smooth settle) ride on top of smooth loops. The headband tails
// and the scarf are verlet chains rendered as ribbons. Geometry is shared per detail tier (ref-counted cache);
// materials, ribbons and textures-free props are per instance and freed by dispose().

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { MINI_ACTIVITIES, type MiniActivity, type MiniLook } from "./viz_mini_look.ts";

export type { MiniActivity, MiniLook } from "./viz_mini_look.ts";
export type MiniState = "idle" | "working" | "paused" | "ended" | "killed" | "failed";
export type MiniDetail = "full" | "reduced" | "minimal";

export interface Mini3D {
  /** Feet at the origin, about 1.0 world unit tall, facing +Z. Add it to any parent. */
  readonly group: THREE.Group;
  setActivity(a: MiniActivity): void;
  setIntensity(x: number): void;
  setState(s: MiniState): void;
  burst(): void;
  setLook(l: MiniLook): void;
  update(tSec: number, dt: number, motion: boolean): void;
  dispose(): void;
}

// ------------------------------------------------------------------------------------------ proportions

const HIP_Y = 0.3;
const SPINE_Y = 0.012;
const CHEST_Y = 0.14;
const NECK_Y = 0.125;
const HEAD_PIVOT = 0.03;
/** Head center above the head pivot; with HR the crown lands at about 0.97. */
const HEAD_C = 0.17;
const HR = 0.205;
const SHOULDER_X = 0.122;
const SHOULDER_Y = 0.098;
const UPPER = 0.1;
const FORE = 0.088;
const HIP_X = 0.058;
const HIP_JY = -0.022;
const THIGH = 0.11;
const SHIN = 0.1;
const LEG_LEN = THIGH + SHIN;
/** Root drop for the seated cross-legged pose (typing, meditate, the end-of-run rest). */
const SEAT_DROP = -0.16;

const BLEND_S = 0.25;
const BURST_S = 0.45;
const CLOTH_H = 1 / 60;
const TAU = Math.PI * 2;

// ------------------------------------------------------------------------------------------ pose channels

const RX = 0, RY = 1, RZ = 2, RYAW = 3, RPIT = 4, RROL = 5, SQ = 6;
const HIPP = 7, HIPY = 8, HIPR = 9;
const SPP = 10, SPY = 11, SPR = 12;
const CHP = 13, CHY = 14, CHR = 15;
const HDP = 16, HDY = 17, HDR = 18;
/** Arms: side 0 is his left (+X), side 1 his right (-X). Channels are anatomical (pitch forward +, abduct out +). */
const ARM0 = 19, ARM_N = 7;
const A_P = 0, A_A = 1, A_T = 2, A_E = 3, A_WP = 4, A_WR = 5, A_F = 6;
const LEG0 = ARM0 + 2 * ARM_N, LEG_N = 5;
const L_P = 0, L_A = 1, L_T = 2, L_K = 3, L_AN = 4;
const EYE = LEG0 + 2 * LEG_N, LKX = EYE + 1, LKY = EYE + 2;
const NCH = EYE + 3;

type Pose = Float32Array;

// ------------------------------------------------------------------------------------------ easing

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
function fract(x: number): number {
  return x - Math.floor(x);
}
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
function smooth(x: number): number {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
}
/** Normalized progress of u through [a, b]. */
function win(u: number, a: number, b: number): number {
  if (b <= a) return u >= b ? 1 : 0;
  return clamp01((u - a) / (b - a));
}
function rise(u: number, a: number, b: number): number {
  return smooth(win(u, a, b));
}
function easeOutCubic(x: number): number {
  const t = 1 - clamp01(x);
  return 1 - t * t * t;
}
/** Fast out with an overshoot past 1 (s controls how far), then back to exactly 1. */
function easeOutBack(x: number, s = 1.70158): number {
  const t = clamp01(x) - 1;
  return 1 + (s + 1) * t * t * t + s * t * t;
}
/** Smooth up over [a, b], hold, smooth down over [c, d]. */
function bump(u: number, a: number, b: number, c: number, d: number): number {
  return rise(u, a, b) * (1 - rise(u, c, d));
}
/** A rapid move inside a loop: anticipation down to -ant over [a0, a1], a snap with overshoot to 1 over
 *  [a1, s1], a hold until h1, a smooth settle back to 0 by r1. Negative values are the wind-up. */
function strike(u: number, a0: number, a1: number, s1: number, h1: number, r1: number, ant: number): number {
  if (u < a0 || u >= r1) return 0;
  if (u < a1) return -ant * smooth(win(u, a0, a1));
  if (u < s1) return lerp(-ant, 1, easeOutBack(win(u, a1, s1)));
  if (u < h1) return 1;
  return 1 - smooth(win(u, h1, r1));
}
/** One key press inside a tap cycle: a quick press and release in the first 38%, then rest. */
function tapCurve(u: number): number {
  if (u >= 0.38) return 0;
  const s = Math.sin((Math.PI * u) / 0.38);
  return s * s;
}
function catmull(p0: number, p1: number, p2: number, p3: number, u: number): number {
  return 0.5 * (2 * p1 + (p2 - p0) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u + (3 * p1 - p0 - 3 * p2 + p3) * u * u * u);
}

// The bo staff's angular speed over one cycle (piecewise linear): ease in, cruise, a rapid twirl, a stop that
// lands horizontal for the thrust. Its integral, normalized, is the spin progress.
const STAFF_U = [0, 0.06, 0.46, 0.52, 0.66, 0.72, 1] as const;
const STAFF_V = [0, 1, 1, 5, 5, 0, 0] as const;
function staffArea(u: number): number {
  let acc = 0;
  for (let i = 0; i < STAFF_U.length - 1; i++) {
    const a = STAFF_U[i]!;
    const b = STAFF_U[i + 1]!;
    if (u <= a) break;
    const va = STAFF_V[i]!;
    const x = Math.min(u, b) - a;
    acc += va * x + (0.5 * (STAFF_V[i + 1]! - va) * x * x) / (b - a);
  }
  return acc;
}
const STAFF_TOTAL = staffArea(1);

const SCAN_YAW = [-0.55, 0.18, 0.62, -0.12, 0.45, -0.35] as const;
const SCAN_PITCH = [0.05, -0.08, 0.12, 0, -0.05, 0.1] as const;
const GLYPH_LEN = [0.15, 0.12, 0.155, 0.1] as const;

/** Representative activity-clock times for motion=false (a readable, characteristic still). */
const STILL_T: Record<MiniActivity, number> = {
  typing: 0.05, shuriken: 1.12, kata: 1.0, meditate: 0, scan: 0.4, staff: 2.75, scroll: 0.6, dash: 0.45,
};

// ------------------------------------------------------------------------------------------ pose builders

function setArm(p: Pose, side: number, pitch: number, abduct: number, twist: number, elbow: number, wristP = 0, finger = 0.25, wristR = 0): void {
  const o = ARM0 + side * ARM_N;
  p[o + A_P] = pitch;
  p[o + A_A] = abduct;
  p[o + A_T] = twist;
  p[o + A_E] = elbow;
  p[o + A_WP] = wristP;
  p[o + A_WR] = wristR;
  p[o + A_F] = finger;
}

/** The ankle defaults to keeping the sole level with the ground. */
function setLeg(p: Pose, side: number, pitch: number, abduct: number, twist: number, knee: number, ankle = pitch - knee): void {
  const o = LEG0 + side * LEG_N;
  p[o + L_P] = pitch;
  p[o + L_A] = abduct;
  p[o + L_T] = twist;
  p[o + L_K] = knee;
  p[o + L_AN] = ankle;
}

function neutral(p: Pose): void {
  p.fill(0);
  p[EYE] = 1;
  setArm(p, 0, 0.05, 0.14, 0, 0.2, 0, 0.3);
  setArm(p, 1, 0.05, 0.14, 0, 0.2, 0, 0.3);
  setLeg(p, 0, 0, 0.05, 0.1, 0);
  setLeg(p, 1, 0, 0.05, 0.1, 0);
}

/** Drops the root so the longest leg's sole touches the ground. */
function plant(p: Pose): void {
  let reach = 0;
  for (let s = 0; s < 2; s++) {
    const o = LEG0 + s * LEG_N;
    const r = Math.cos(p[o + L_A]!) * (THIGH * Math.cos(p[o + L_P]!) + SHIN * Math.cos(p[o + L_P]! - p[o + L_K]!));
    if (r > reach) reach = r;
  }
  p[RY] = reach - LEG_LEN;
}

function stance(p: Pose, width: number, crouch: number): void {
  setLeg(p, 0, crouch, width, 0.3, crouch * 2);
  setLeg(p, 1, crouch, width, 0.3, crouch * 2);
  p[HIPP] = 0.15 * crouch;
  plant(p);
}

/** Cross-legged (the mascot_mini seat): thighs forward and out, twisted so the shins fold across. */
function seatCross(p: Pose, lift: number): void {
  setLeg(p, 0, 1.3, 0.5, 1.15, 2.4, 0.35);
  setLeg(p, 1, 1.3, 0.5, 1.15, 2.4, 0.35);
  p[RY] = SEAT_DROP + lift;
  p[HIPP] = -0.08;
}

function handsOnKnees(p: Pose): void {
  setArm(p, 0, 0.55, 0.42, 0.2, 0.55, -0.2, 0.3);
  setArm(p, 1, 0.55, 0.42, 0.2, 0.55, -0.2, 0.3);
}

// ------------------------------------------------------------------------------------------ detail tiers

interface Tier {
  sphW: number; sphH: number; // the head
  midW: number; midH: number; // unit ball: pelvis, palms, feet, knots
  lowW: number; lowH: number; // tiny ball: toes, catchlights
  lathe: number; prof: number; // lathe radial segments and torso profile samples
  capR: number; capC: number; // limb capsules
  torT: number; torR: number; // torus tube and ring segments
  chain: number; sub: number; // cloth points per chain (0 = static tails) and ribbon subdivision
  clothScale: number;
  keyCols: number; keyRows: number;
  ghosts: number;
  extras: boolean; // crown panel, lapels, catchlights, split toes, mitten fingers, bevels
}

const TIERS: Record<MiniDetail, Tier> = {
  full: { sphW: 36, sphH: 26, midW: 18, midH: 13, lowW: 10, lowH: 7, lathe: 36, prof: 16, capR: 16, capC: 6, torT: 8, torR: 32, chain: 9, sub: 3, clothScale: 1, keyCols: 10, keyRows: 3, ghosts: 4, extras: true },
  reduced: { sphW: 18, sphH: 12, midW: 10, midH: 7, lowW: 6, lowH: 4, lathe: 16, prof: 9, capR: 10, capC: 3, torT: 5, torR: 16, chain: 6, sub: 2, clothScale: 0.8, keyCols: 8, keyRows: 3, ghosts: 3, extras: true },
  minimal: { sphW: 10, sphH: 7, midW: 7, midH: 5, lowW: 5, lowH: 4, lathe: 9, prof: 5, capR: 6, capC: 1, torT: 3, torR: 9, chain: 0, sub: 1, clothScale: 0.7, keyCols: 5, keyRows: 2, ghosts: 2, extras: false },
};

/** Torso radius (before the 0.86 depth squash) at height y above the spine origin: a soft barrel that domes
 *  into the neck under the scarf. */
function torsoR(y: number): number {
  if (y <= 0.19) return 0.104 + 0.016 * Math.sin((Math.PI * Math.max(0, y)) / 0.34);
  const k = (y - 0.19) / 0.085;
  return (0.104 + 0.016 * Math.sin((Math.PI * 0.19) / 0.34)) * Math.sqrt(Math.max(0, 1 - k * k));
}

function skullR(y: number): number {
  return HR * Math.sqrt(Math.max(0, 1 - (y / HR) * (y / HR)));
}

/** A closed lathe profile for a band hugging a surface of revolution between y0 and y1: outer side up, a
 *  rounded top, inner side down, a rounded bottom (counter-clockwise, so lathe normals face out). */
function bandProfile(radiusAt: (y: number) => number, y0: number, y1: number, thick: number, m: number): THREE.Vector2[] {
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= m; i++) {
    const y = lerp(y0, y1, i / m);
    pts.push(new THREE.Vector2(radiusAt(y) + thick, y));
  }
  pts.push(new THREE.Vector2(radiusAt(y1) + thick * 0.5, y1 + thick * 0.3));
  for (let i = m; i >= 0; i--) {
    const y = lerp(y0, y1, i / m);
    pts.push(new THREE.Vector2(radiusAt(y) + 0.0015, y));
  }
  pts.push(new THREE.Vector2(radiusAt(y0) + thick * 0.5, y0 - thick * 0.3));
  pts.push(pts[0]!.clone());
  return pts;
}

/** A capsule hanging down from its top joint (its upper cap is centered on the joint). */
function limb(r: number, len: number, t: Tier, radial = t.capR, caps = t.capC): THREE.BufferGeometry {
  const g = new THREE.CapsuleGeometry(r, len, caps, radial);
  g.translate(0, -len / 2, 0);
  return g;
}

function starGeometry(t: Tier): THREE.BufferGeometry {
  const s = new THREE.Shape();
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4 + Math.PI / 2;
    const r = i % 2 === 0 ? 0.034 : 0.011;
    if (i === 0) s.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    else s.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  s.closePath();
  const hole = new THREE.Path();
  hole.absarc(0, 0, 0.0055, 0, TAU, true);
  s.holes.push(hole);
  const g = new THREE.ExtrudeGeometry(s, {
    depth: 0.004, bevelEnabled: t.extras, bevelThickness: 0.0018, bevelSize: 0.0016, bevelSegments: 2, curveSegments: t.extras ? 10 : 5,
  });
  g.center();
  return g;
}

interface GeoSet {
  refs: number;
  ball: THREE.BufferGeometry;
  ballLow: THREE.BufferGeometry;
  head: THREE.BufferGeometry;
  crown: THREE.BufferGeometry | null;
  eyeBand: THREE.BufferGeometry;
  headband: THREE.BufferGeometry;
  torso: THREE.BufferGeometry;
  belt: THREE.BufferGeometry;
  collar: THREE.BufferGeometry;
  lapel: THREE.BufferGeometry | null;
  beltTail: THREE.BufferGeometry;
  upperArm: THREE.BufferGeometry;
  foreArm: THREE.BufferGeometry;
  cuff: THREE.BufferGeometry;
  finger: THREE.BufferGeometry | null;
  thumb: THREE.BufferGeometry | null;
  thigh: THREE.BufferGeometry;
  shin: THREE.BufferGeometry;
  sclera: THREE.BufferGeometry;
  pupil: THREE.BufferGeometry;
  tailStatic: THREE.BufferGeometry | null;
  kbBase: THREE.BufferGeometry;
  kbKey: THREE.BufferGeometry;
  kbGlow: THREE.BufferGeometry;
  star: THREE.BufferGeometry;
  staff: THREE.BufferGeometry;
  staffCap: THREE.BufferGeometry;
  paper: THREE.BufferGeometry;
  roller: THREE.BufferGeometry;
  glyph: THREE.BufferGeometry;
  brushHandle: THREE.BufferGeometry;
  brushTip: THREE.BufferGeometry;
  visor: THREE.BufferGeometry;
  beam: THREE.BufferGeometry;
  ring: THREE.BufferGeometry;
  ghostBody: THREE.BufferGeometry;
}

function buildGeo(t: Tier): GeoSet {
  const torsoPts: THREE.Vector2[] = [new THREE.Vector2(0.0005, -0.026), new THREE.Vector2(0.07, -0.02)];
  const n = Math.max(3, t.prof - 2);
  for (let i = 0; i < n; i++) {
    const y = (0.275 * i) / (n - 1);
    torsoPts.push(new THREE.Vector2(Math.max(0.0005, torsoR(y)), y));
  }
  const m = Math.max(1, Math.floor(t.prof / 4));
  const eyeR = Math.max(6, t.capR - 2);
  const eyeC = Math.max(1, t.capC - 2);
  const small = Math.max(6, t.capR - 6);

  const paper = new THREE.PlaneGeometry(0.2, 0.13, t.extras ? 10 : 3, 1);
  const pp = paper.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < pp.count; i++) {
    const x = pp.getX(i) / 0.1;
    pp.setZ(i, 0.012 * x * x);
  }
  paper.computeVertexNormals();
  const glyph = new THREE.BoxGeometry(1, 0.008, 0.002);
  glyph.translate(0.5, 0, 0);
  const staff = new THREE.CylinderGeometry(0.011, 0.011, 0.62, Math.max(6, t.capR - 4), 1);
  staff.rotateZ(Math.PI / 2);
  const staffCap = new THREE.CylinderGeometry(0.0145, 0.0145, 0.05, Math.max(6, t.capR - 4), 1);
  staffCap.rotateZ(Math.PI / 2);
  const brushHandle = new THREE.CylinderGeometry(0.0055, 0.0065, 0.11, small, 1);
  brushHandle.translate(0, -0.02, 0);
  const brushTip = new THREE.ConeGeometry(0.009, 0.03, small, 1);
  brushTip.rotateX(Math.PI);
  brushTip.translate(0, -0.09, 0);
  const tail = t.chain === 0 ? limb(0.013, 0.13, t, 6, 1) : null;
  if (tail) tail.scale(1.6, 1, 0.5);

  return {
    refs: 0,
    ball: new THREE.SphereGeometry(1, t.midW, t.midH),
    ballLow: new THREE.SphereGeometry(1, t.lowW, t.lowH),
    head: new THREE.SphereGeometry(HR, t.sphW, t.sphH),
    crown: t.extras ? new THREE.SphereGeometry(HR * 1.005, t.sphW, Math.max(2, Math.round(t.sphH * 0.3)), 0, TAU, 0, 0.72) : null,
    eyeBand: new THREE.SphereGeometry(HR * 1.004, Math.max(5, Math.round(t.sphW / 2)), Math.max(2, Math.round(t.sphH / 6)), Math.PI / 2 - 0.85, 1.7, Math.PI / 2 - 0.2, 0.46),
    headband: new THREE.LatheGeometry(bandProfile(skullR, HR * 0.2, HR * 0.45, 0.013, m), t.lathe),
    torso: new THREE.LatheGeometry(torsoPts, t.lathe),
    belt: new THREE.LatheGeometry(bandProfile(torsoR, -0.004, 0.042, 0.014, m), t.lathe),
    collar: new THREE.TorusGeometry(0.085, 0.026, t.torT, t.torR),
    lapel: t.extras ? new THREE.CapsuleGeometry(0.011, 0.15, Math.max(2, t.capC - 3), small) : null,
    beltTail: limb(0.011, 0.05, t, small, Math.max(1, t.capC - 3)),
    upperArm: limb(0.04, UPPER, t),
    foreArm: limb(0.035, FORE, t),
    cuff: new THREE.TorusGeometry(0.04, 0.0095, t.torT, Math.max(5, t.torR / 2)),
    finger: t.extras ? limb(0.026, 0.012, t, Math.max(8, t.capR - 4), Math.max(2, t.capC - 2)) : null,
    thumb: t.extras ? limb(0.012, 0.016, t, small, Math.max(2, t.capC - 3)) : null,
    thigh: limb(0.047, THIGH, t),
    shin: limb(0.041, SHIN, t),
    sclera: new THREE.CapsuleGeometry(0.019, 0.014, eyeC, eyeR),
    pupil: new THREE.CapsuleGeometry(0.012, 0.01, eyeC, eyeR),
    tailStatic: tail,
    kbBase: t.extras ? new RoundedBoxGeometry(0.34, 0.014, 0.13, 2, 0.006) : new THREE.BoxGeometry(0.34, 0.014, 0.13),
    kbKey: new THREE.BoxGeometry(0.3 / t.keyCols - 0.006, 0.008, 0.1 / t.keyRows - 0.006),
    kbGlow: new THREE.PlaneGeometry(0.4, 0.17),
    star: starGeometry(t),
    staff,
    staffCap,
    paper,
    roller: new THREE.CylinderGeometry(0.011, 0.011, 0.15, Math.max(6, t.capR - 4), 1),
    glyph,
    brushHandle,
    brushTip,
    visor: new THREE.SphereGeometry(HR * 1.08, Math.max(5, Math.round(t.sphW / 2)), Math.max(2, Math.round(t.sphH / 6)), Math.PI / 2 - 0.95, 1.9, Math.PI / 2 - 0.24, 0.44),
    beam: new THREE.CircleGeometry(0.6, t.extras ? 16 : 6, Math.PI / 2 - 0.3, 0.6),
    ring: new THREE.TorusGeometry(0.28, 0.006, t.torT, Math.round(t.torR * 1.5)),
    ghostBody: new THREE.CapsuleGeometry(0.1, 0.1, Math.max(1, t.capC - 3), Math.max(6, t.capR - 4)),
  };
}

const GEO_CACHE = new Map<MiniDetail, GeoSet>();

function acquireGeo(detail: MiniDetail): GeoSet {
  let set = GEO_CACHE.get(detail);
  if (!set) {
    set = buildGeo(TIERS[detail]);
    GEO_CACHE.set(detail, set);
  }
  set.refs++;
  return set;
}

function releaseGeo(detail: MiniDetail): void {
  const set = GEO_CACHE.get(detail);
  if (!set || --set.refs > 0) return;
  for (const v of Object.values(set)) if (v instanceof THREE.BufferGeometry) v.dispose();
  GEO_CACHE.delete(detail);
}

/** Triangles drawn for `root` right now: visible meshes only (an invisible ancestor hides its subtree),
 *  instanced meshes counted per instance. The perf budgets are stated in these units. */
export function miniTriangles(root: THREE.Object3D): number {
  if (!root.visible) return 0;
  let n = 0;
  if (root instanceof THREE.Mesh) {
    const g = root.geometry as THREE.BufferGeometry;
    const per = g.index ? g.index.count / 3 : (g.getAttribute("position")?.count ?? 0) / 3;
    n += per * (root instanceof THREE.InstancedMesh ? root.count : 1);
  }
  for (const c of root.children) n += miniTriangles(c);
  return n;
}

// ------------------------------------------------------------------------------------------ colors

const SKIN = new THREE.Color("#eec39a");
const EYE_WHITE = new THREE.Color("#f4f7f5");
const PUPIL = new THREE.Color("#0a0e12");
const TABI = new THREE.Color("#141b23");
const STEEL = new THREE.Color("#c2d1dc");
const WOOD = new THREE.Color("#6b4a2f");
const PAPER = new THREE.Color("#efe4c6");
const INK = new THREE.Color("#10161d");
const DEAD_ACCENT = new THREE.Color("#3a4048");
const DEAD_EYE = new THREE.Color("#1d232a");

/** out = base desaturated by `des`, then pulled toward `deadColor` by `dead`. */
function tint(out: THREE.Color, base: THREE.Color, des: number, dead: number, deadColor: THREE.Color): THREE.Color {
  out.copy(base);
  const l = 0.2126 * out.r + 0.7152 * out.g + 0.0722 * out.b;
  out.r += (l - out.r) * des;
  out.g += (l - out.g) * des;
  out.b += (l - out.b) * des;
  return dead > 0 ? out.lerp(deadColor, dead) : out;
}

// ------------------------------------------------------------------------------------------ cloth

interface Chain {
  n: number;
  seg: number;
  width: number;
  pos: Float32Array;
  prev: Float32Array;
  row: Float32Array;
  rows: number;
  anchor: THREE.Object3D;
  /** Rest direction in the figure frame (yaw 0), normalized. */
  rx: number; ry: number; rz: number;
  /** Anchor this frame and last frame, group-local. */
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
  posAttr: THREE.BufferAttribute;
  nrmAttr: THREE.BufferAttribute;
  geo: THREE.BufferGeometry;
}

function ribbonGeometry(rows: number): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const idx: number[] = [];
  for (let r = 0; r < rows - 1; r++) {
    const a = r * 2;
    idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  g.setIndex(idx);
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(rows * 6), 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(rows * 6), 3).setUsage(THREE.DynamicDrawUsage));
  return g;
}

// ------------------------------------------------------------------------------------------ the figure

const ACT_INDEX: Record<MiniActivity, number> = { typing: 0, shuriken: 1, kata: 2, meditate: 3, scan: 4, staff: 5, scroll: 6, dash: 7 };
const STATES: readonly MiniState[] = ["idle", "working", "paused", "ended", "killed", "failed"];
let instanceSeed = 1;

interface Ghost { g: THREE.Group; mat: THREE.MeshBasicMaterial; age: number }

class MiniFigure implements Mini3D {
  readonly group = new THREE.Group();
  private readonly detail: MiniDetail;
  private readonly tier: Tier;
  private readonly geo: GeoSet;
  private readonly mats: THREE.Material[] = [];
  private disposed = false;

  // look
  private readonly cAccent = new THREE.Color();
  private readonly cAccentDeep = new THREE.Color();
  private readonly cGi = new THREE.Color();
  private readonly cGiShadow = new THREE.Color();
  private readonly cGiHi = new THREE.Color();
  private readonly cAccNow = new THREE.Color();
  private readonly cDeepNow = new THREE.Color();
  private readonly cKeyBase = new THREE.Color();
  private readonly cKeyHot = new THREE.Color();
  private readonly tc = new THREE.Color();

  // materials
  private readonly mGi: THREE.MeshPhysicalMaterial;
  private readonly mGiShadow: THREE.MeshPhysicalMaterial;
  private readonly mGiHi: THREE.MeshPhysicalMaterial;
  private readonly mAccent: THREE.MeshPhysicalMaterial;
  private readonly mCloth: THREE.MeshPhysicalMaterial;
  private readonly mDeep: THREE.MeshPhysicalMaterial;
  private readonly mEye: THREE.MeshPhysicalMaterial;
  private readonly mHolo: THREE.MeshPhysicalMaterial;
  private readonly mVisor: THREE.MeshPhysicalMaterial;
  private readonly mThrown: THREE.MeshPhysicalMaterial;
  private readonly mKbGlow: THREE.MeshBasicMaterial;
  private readonly mGlyph: THREE.MeshBasicMaterial;
  private readonly mBeam: THREE.MeshBasicMaterial;
  private readonly mAuraA: THREE.MeshBasicMaterial;
  private readonly mAuraB: THREE.MeshBasicMaterial;

  // rig
  private readonly root = new THREE.Group();
  private readonly hips = new THREE.Group();
  private readonly spine = new THREE.Group();
  private readonly chest = new THREE.Group();
  private readonly neck = new THREE.Group();
  private readonly head = new THREE.Group();
  private readonly skull = new THREE.Group();
  private readonly shoulder: THREE.Group[] = [];
  private readonly elbow: THREE.Group[] = [];
  private readonly wrist: THREE.Group[] = [];
  private readonly finger: (THREE.Group | null)[] = [];
  private readonly thumb: (THREE.Group | null)[] = [];
  private readonly hip: THREE.Group[] = [];
  private readonly knee: THREE.Group[] = [];
  private readonly ankle: THREE.Group[] = [];
  private readonly eyes: THREE.Group[] = [];
  private readonly pupils: THREE.Mesh[] = [];
  private readonly beltTails: THREE.Mesh[] = [];
  private readonly tailPivots: THREE.Object3D[] = [];
  private readonly tailRest: THREE.Quaternion[] = [];

  // props
  private readonly keyboard = new THREE.Group();
  private readonly keys: THREE.InstancedMesh;
  private readonly keyGlow: Float32Array;
  private readonly heldStar: THREE.Mesh;
  private readonly thrown: THREE.Mesh;
  private readonly staffSpin = new THREE.Group();
  private readonly scroll = new THREE.Group();
  private readonly glyphs: THREE.Mesh[] = [];
  private readonly brush = new THREE.Group();
  private readonly visor: THREE.Mesh;
  private readonly beamPivot = new THREE.Group();
  private readonly aura = new THREE.Group();
  private readonly auraA: THREE.Mesh;
  private readonly auraB: THREE.Mesh;
  private readonly ghosts: Ghost[] = [];
  private readonly chains: Chain[] = [];

  // animation state
  private activity: MiniActivity = "typing";
  private state: MiniState = "working";
  private k = 0.5;
  private kS = 0.5;
  private life = 0;
  private actT = 0;
  private stateT = 0;
  private blendT = BLEND_S;
  private burstT = BURST_S;
  private burstV = 2;
  private burstSide = 1;
  private readonly from: Pose = new Float32Array(NCH);
  private readonly cur: Pose = new Float32Array(NCH);
  private readonly tgt: Pose = new Float32Array(NCH);
  private readonly out: Pose = new Float32Array(NCH);
  private readonly tmp: Pose = new Float32Array(NCH);
  private readonly weights = new Float32Array(MINI_ACTIVITIES.length);
  private glow = 0.6;
  private des = 0;
  private dead = 0;
  private flash = 0;
  private blinkIn = 2;
  private blinkAge = 1;
  private rng: number;

  // per-activity effect state
  private tapL = NaN;
  private tapR = NaN;
  private tapF = NaN;
  private slamLit = false;
  private lastU = 1;
  private launch = false;
  private heldScale = 1;
  private thrownAge = -1;
  private readonly thrownPos = new THREE.Vector3();
  private readonly thrownVel = new THREE.Vector3();
  private staffAngle = 0;
  private beamYaw = 0;
  private visorPulse = 0;
  private auraBreath = 0.5;
  private auraFlash = 0;
  private glyphLine = 0;
  private glyphFill = 0;
  private ghostClock = 0;
  private ghostNext = 0;
  private lastRX = 0;
  private lastRY = 0;
  private lastRZ = 0;
  private clothReady = false;
  private clothAcc = 0;

  private readonly v1 = new THREE.Vector3();
  private readonly inv = new THREE.Matrix4();

  constructor(look: MiniLook, detail: MiniDetail) {
    this.detail = Object.prototype.hasOwnProperty.call(TIERS, detail) ? detail : "full";
    this.tier = TIERS[this.detail];
    this.geo = acquireGeo(this.detail);
    this.rng = (instanceSeed++ * 2654435761) >>> 0 || 1;
    this.group.name = "mini-lucid";

    // Cloth reads dark and matte (the navy gi of the pixel mascot): low sheen and a dimmed environment, or the
    // bright room reflection lifts the suit to a chalky gray and the accent has nothing to pop against.
    const cloth = { roughness: 0.82, sheen: 0.35, sheenRoughness: 0.6, envMapIntensity: 0.4 };
    this.mGi = this.phys(cloth);
    this.mGiShadow = this.phys({ roughness: 0.86, sheen: 0.25, sheenRoughness: 0.6, envMapIntensity: 0.35 });
    this.mGiHi = this.phys({ roughness: 0.7, sheen: 0.4, sheenRoughness: 0.55, envMapIntensity: 0.45 });
    // The neon (headband, belt, tails, scarf) skips tone mapping: ACES pulls bright saturated colors toward white,
    // which turned every persona's accent pastel. Untoned, it stays the persona's own neon, like the pixel mascot.
    this.mAccent = this.phys({ roughness: 0.32, clearcoat: 0.5, clearcoatRoughness: 0.18, sheen: 0.2, envMapIntensity: 0.5, toneMapped: false });
    this.mCloth = this.phys({ roughness: 0.45, sheen: 0.8, sheenRoughness: 0.35, side: THREE.DoubleSide, toneMapped: false });
    this.mDeep = this.phys({ roughness: 0.5, sheen: 0.4 });
    this.mEye = this.phys({ color: EYE_WHITE, roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.08 });
    this.mHolo = this.phys({ roughness: 0.2, clearcoat: 1, transparent: true, opacity: 0.5, depthWrite: false });
    this.mVisor = this.phys({ roughness: 0.1, clearcoat: 1, transparent: true, opacity: 0.55, depthWrite: false });
    this.mThrown = this.phys({ color: STEEL, metalness: 0.9, roughness: 0.22, transparent: true });
    this.mKbGlow = this.basic({ transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    this.mGlyph = this.basic({});
    this.mBeam = this.basic({ transparent: true, opacity: 0.14, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    this.mAuraA = this.basic({ transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false });
    this.mAuraB = this.basic({ transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false });
    const mSkin = this.phys({ color: SKIN, roughness: 0.62, sheen: 0.25 });
    const mPupil = this.phys({ color: PUPIL, roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.05 });
    const mCatch = this.basic({ color: 0xffffff });
    const mTabi = this.phys({ color: TABI, roughness: 0.75, sheen: 0.5 });
    const mSteel = this.phys({ color: STEEL, metalness: 0.9, roughness: 0.22, clearcoat: 0.5 });
    const mWood = this.phys({ color: WOOD, roughness: 0.55, clearcoat: 0.4 });
    const mPaper = this.phys({ color: PAPER, roughness: 0.9, side: THREE.DoubleSide });
    const mInk = this.phys({ color: INK, roughness: 0.4 });
    const mKeys = this.basic({});

    this.setLook(look);
    const g = this.geo;
    const t = this.tier;

    // ---- body
    this.group.add(this.root);
    this.root.position.y = HIP_Y;
    for (const o of [this.root, this.spine, this.chest, this.neck, this.head]) o.rotation.order = "YXZ";
    this.root.add(this.hips);
    this.add(g.ball, this.mGi, this.hips, 0, -0.012, 0, 0.108, 0.072, 0.09);
    this.root.add(this.spine);
    this.spine.position.y = SPINE_Y;
    const torso = this.node(this.spine);
    torso.scale.set(1, 1, 0.86);
    this.add(g.torso, this.mGi, torso);
    this.add(g.belt, this.mAccent, torso);
    const knotZ = torsoR(0.02) + 0.012;
    this.add(g.ball, this.mAccent, torso, 0, 0.02, knotZ, 0.022, 0.018, 0.016);
    for (const sg of [1, -1]) {
      const tl = this.add(g.beltTail, this.mDeep, torso, sg * 0.006, 0.012, knotZ + 0.004);
      tl.rotation.set(-0.12, 0, sg * 0.22);
      tl.scale.set(1.5, 1, 0.55);
      this.beltTails.push(tl);
      if (g.lapel) {
        const lp = this.add(g.lapel, this.mGiHi, torso, sg * 0.0375, 0.15, 0.118, 1, 1, 0.45);
        lp.rotation.z = -sg * 0.464;
      }
    }
    const collar = this.add(g.collar, this.mAccent, torso, 0, 0.248, 0);
    collar.rotation.x = Math.PI / 2;
    const scarfAnchor = this.node(torso, 0.02, 0.25, -0.1);

    this.spine.add(this.chest);
    this.chest.position.y = CHEST_Y;
    this.chest.add(this.neck);
    this.neck.position.y = NECK_Y;
    this.neck.add(this.head);
    this.head.position.y = HEAD_PIVOT;
    this.head.add(this.skull);
    this.skull.position.y = HEAD_C;
    this.skull.scale.set(1.17, 1.06, 1.1); // chibi: the head carries about 40% of his height, like the pixel mascot
    this.add(g.head, this.mGi, this.skull);
    if (g.crown) this.add(g.crown, this.mGiHi, this.skull);
    this.add(g.eyeBand, mSkin, this.skull);
    this.add(g.headband, this.mAccent, this.skull);
    this.add(g.ball, this.mAccent, this.skull, 0, HR * 0.32, -HR * 0.97, 0.03, 0.026, 0.02);
    const tailA = this.node(this.skull, 0.012, HR * 0.3, -HR * 1.04);
    const tailB = this.node(this.skull, -0.012, HR * 0.3, -HR * 1.04);
    const zAxis = new THREE.Vector3(0, 0, 1);
    for (const sg of [1, -1]) {
      const dir = new THREE.Vector3(sg * 0.34, -0.06, 0.938).normalize();
      const eg = this.node(this.skull, dir.x * HR * 0.99, dir.y * HR * 0.99, dir.z * HR * 0.99);
      eg.quaternion.setFromUnitVectors(zAxis, dir);
      this.add(g.sclera, this.mEye, eg, 0, 0, 0, 1, 1, 0.45);
      const pupil = this.add(g.pupil, mPupil, eg, 0, 0, 0.007, 1, 1, 0.5);
      if (t.extras) this.add(g.ballLow, mCatch, pupil, -0.0045, 0.01, 0.012, 0.0045);
      this.eyes.push(eg);
      this.pupils.push(pupil);
    }
    this.visor = this.add(g.visor, this.mVisor, this.skull);
    this.visor.castShadow = false;
    this.head.add(this.beamPivot);
    this.beamPivot.position.y = HEAD_C - 0.012;
    const beam = this.add(g.beam, this.mBeam, this.beamPivot);
    beam.rotation.x = Math.PI / 2 + 0.12;
    beam.castShadow = false;

    for (let side = 0; side < 2; side++) {
      const sg = side === 0 ? 1 : -1;
      const sh = this.node(this.chest, sg * SHOULDER_X, SHOULDER_Y, 0);
      sh.rotation.order = "XZY";
      this.add(g.upperArm, this.mGi, sh);
      const el = this.node(sh, 0, -UPPER, 0);
      this.add(g.foreArm, this.mGi, el);
      const cuff = this.add(g.cuff, this.mGiShadow, el, 0, -FORE + 0.008, 0, 0.92);
      cuff.rotation.x = Math.PI / 2;
      const wr = this.node(el, 0, -FORE, 0);
      this.add(g.ball, mSkin, wr, 0, -0.03, 0, 0.034, 0.036, 0.03);
      let fg: THREE.Group | null = null;
      let th: THREE.Group | null = null;
      if (g.finger && g.thumb) {
        fg = this.node(wr, 0, -0.046, 0);
        this.add(g.finger, mSkin, fg, 0, 0, 0, 1, 1, 0.8);
        th = this.node(wr, -sg * 0.028, -0.026, 0.008);
        this.add(g.thumb, mSkin, th);
      }
      this.shoulder.push(sh);
      this.elbow.push(el);
      this.wrist.push(wr);
      this.finger.push(fg);
      this.thumb.push(th);

      const hp = this.node(this.hips, sg * HIP_X, HIP_JY, 0);
      hp.rotation.order = "XZY";
      this.add(g.thigh, this.mGi, hp);
      const kn = this.node(hp, 0, -THIGH, 0);
      this.add(g.shin, this.mGi, kn);
      const wrap = this.add(g.cuff, this.mGiShadow, kn, 0, -SHIN * 0.62, 0, 1.08);
      wrap.rotation.x = Math.PI / 2;
      const an = this.node(kn, 0, -SHIN, 0);
      this.add(g.ball, mTabi, an, sg * 0.004, -0.036, 0.02, 0.04, 0.032, 0.06);
      if (t.extras) this.add(g.ballLow, mTabi, an, -sg * 0.022, -0.046, 0.066, 0.015, 0.018, 0.02);
      this.hip.push(hp);
      this.knee.push(kn);
      this.ankle.push(an);
    }

    // ---- props
    this.root.add(this.keyboard);
    this.keyboard.position.set(0, 0.085, 0.175);
    this.keyboard.rotation.x = -0.28;
    this.add(g.kbBase, this.mHolo, this.keyboard).castShadow = false;
    const nKeys = t.keyCols * t.keyRows;
    this.keys = new THREE.InstancedMesh(g.kbKey, mKeys, nKeys);
    this.keys.position.y = 0.011;
    this.keyGlow = new Float32Array(nKeys);
    const km = new THREE.Matrix4();
    for (let r = 0; r < t.keyRows; r++) {
      for (let c = 0; c < t.keyCols; c++) {
        const i = r * t.keyCols + c;
        this.keys.setMatrixAt(i, km.makeTranslation(-0.15 + ((c + 0.5) * 0.3) / t.keyCols, 0, -0.05 + ((r + 0.5) * 0.1) / t.keyRows));
        this.keys.setColorAt(i, this.cKeyBase);
      }
    }
    this.keyboard.add(this.keys);
    const kbGlow = this.add(g.kbGlow, this.mKbGlow, this.keyboard, 0, -0.012, 0);
    kbGlow.rotation.x = -Math.PI / 2;
    kbGlow.castShadow = false;

    const handR = this.wrist[1]!;
    this.heldStar = this.add(g.star, mSteel, handR, 0, -0.06, 0.02);
    this.thrown = this.add(g.star, this.mThrown, this.group);
    this.thrown.rotation.order = "YXZ";
    this.thrown.visible = false;

    handR.add(this.staffSpin);
    this.staffSpin.position.y = -0.034;
    this.add(g.staff, mWood, this.staffSpin);
    this.add(g.staffCap, this.mAccent, this.staffSpin, 0.29, 0, 0);
    this.add(g.staffCap, this.mAccent, this.staffSpin, -0.29, 0, 0);

    this.chest.add(this.scroll);
    this.scroll.position.set(0, -0.03, 0.19);
    this.scroll.rotation.set(0.9, Math.PI, 0);
    this.add(g.paper, mPaper, this.scroll);
    this.add(g.roller, mWood, this.scroll, 0.106, 0, 0.004);
    this.add(g.roller, mWood, this.scroll, -0.106, 0, 0.004);
    for (let i = 0; i < GLYPH_LEN.length; i++) this.glyphs.push(this.add(g.glyph, this.mGlyph, this.scroll, -0.08, 0.04 - i * 0.025, 0.014, 0.0001, 1, 1));
    handR.add(this.brush);
    this.brush.position.set(0, -0.04, 0.004);
    this.brush.rotation.x = 0.5;
    this.add(g.brushHandle, mWood, this.brush);
    this.add(g.brushTip, mInk, this.brush);

    this.group.add(this.aura);
    this.aura.position.y = 0.004;
    this.auraA = this.add(g.ring, this.mAuraA, this.aura);
    this.auraB = this.add(g.ring, this.mAuraB, this.aura);
    this.auraA.rotation.x = Math.PI / 2;
    this.auraB.rotation.x = Math.PI / 2;
    this.auraA.castShadow = false;
    this.auraB.castShadow = false;

    for (let i = 0; i < t.ghosts; i++) {
      const mat = this.basic({ transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
      const gg = this.node(this.group);
      this.add(g.ball, mat, gg, 0, HEAD_C + HEAD_PIVOT + NECK_Y + CHEST_Y + SPINE_Y, 0, HR * 1.04, HR * 0.97, HR).castShadow = false;
      this.add(g.ghostBody, mat, gg, 0, 0.13, 0, 1, 1, 0.86).castShadow = false;
      gg.visible = false;
      this.ghosts.push({ g: gg, mat, age: 1 });
    }

    // ---- cloth: two headband tails and the scarf tail
    const specs: [THREE.Object3D, number, number, number, number, number][] = [
      [tailA, 0.45, -0.2, -0.87, 0.34, 0.034],
      [tailB, 0.25, -0.38, -0.89, 0.3, 0.03],
      [scarfAnchor, -0.2, -0.55, -0.8, 0.2, 0.05],
    ];
    const down = new THREE.Vector3(0, -1, 0);
    for (const [anchor, x, y, z, len, width] of specs) {
      const l = Math.hypot(x, y, z);
      if (t.chain === 0) {
        if (!g.tailStatic) continue;
        this.add(g.tailStatic, this.mCloth, anchor, 0, 0, 0, 1, len / 0.17, 1).castShadow = false;
        anchor.quaternion.setFromUnitVectors(down, this.v1.set(x / l, y / l, z / l));
        this.tailPivots.push(anchor);
        this.tailRest.push(anchor.quaternion.clone());
        continue;
      }
      const n = t.chain;
      const rows = (n - 1) * t.sub + 1;
      const geo = ribbonGeometry(rows);
      const mesh = new THREE.Mesh(geo, this.mCloth);
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      this.group.add(mesh);
      this.chains.push({
        n, seg: (len * t.clothScale) / (n - 1), width, pos: new Float32Array(n * 3), prev: new Float32Array(n * 3), row: new Float32Array(rows * 3), rows,
        anchor, rx: x / l, ry: y / l, rz: z / l, ax: 0, ay: 0, az: 0, bx: 0, by: 0, bz: 0,
        posAttr: geo.getAttribute("position") as THREE.BufferAttribute, nrmAttr: geo.getAttribute("normal") as THREE.BufferAttribute, geo,
      });
    }

    this.update(0, 0, false);
  }

  // ------------------------------------------------------------------------------------------ API

  setActivity(a: MiniActivity): void {
    if (a === this.activity || !Object.prototype.hasOwnProperty.call(ACT_INDEX, a)) return;
    this.snapshot();
    this.activity = a;
    this.actT = 0;
    this.tapL = this.tapR = this.tapF = NaN;
    this.slamLit = false;
    this.lastU = 1;
    this.launch = false;
    this.heldScale = 1;
  }

  setIntensity(x: number): void {
    this.k = Number.isFinite(x) ? clamp01(x) : 0;
  }

  setState(s: MiniState): void {
    if (s === this.state || !STATES.includes(s)) return;
    this.snapshot();
    this.state = s;
    this.stateT = 0;
    if (s === "failed") this.flash = 1;
  }

  burst(): void {
    if (this.state === "paused" || this.state === "ended" || this.state === "killed") return;
    if (this.burstT < 0.3) return;
    this.burstT = 0;
    this.burstV = (this.burstV + 1) % 3;
    this.burstSide = -this.burstSide;
    this.flash = Math.max(this.flash, 0.8);
  }

  setLook(l: MiniLook): void {
    this.cAccent.set(l.accent);
    this.cAccentDeep.set(l.accentDeep);
    this.cGi.set(l.gi);
    this.cGiShadow.set(l.giShadow);
    this.cGiHi.set(l.giHighlight);
  }

  update(_tSec: number, dt: number, motion: boolean): void {
    if (this.disposed) return;
    const d = motion && Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.1) : 0;
    this.life += d;
    this.stateT += d;
    this.blendT += d;
    this.burstT += d;
    this.kS = motion ? this.kS + (this.k - this.kS) * (1 - Math.exp(-d * 3)) : this.k;
    const st = this.state;
    const stateTempo = st === "working" ? 1 : st === "idle" ? 0.6 : st === "failed" ? 0.5 : 0;
    this.actT += d * stateTempo * (0.55 + this.kS);

    const tgt = this.tgt;
    if (!motion) {
      if (st === "ended") this.endedPose(tgt, 2.5);
      else if (st === "killed") this.killedPose(tgt, 2.5);
      else this.activityPose(tgt, this.activity, STILL_T[this.activity], false);
      this.cur.set(tgt);
      this.blendT = BLEND_S;
      this.burstT = BURST_S;
    } else {
      if (st === "ended") this.endedPose(tgt, this.stateT);
      else if (st === "killed") this.killedPose(tgt, this.stateT);
      else {
        this.activityPose(tgt, this.activity, this.actT, true);
        if (st === "paused") {
          const b = Math.sin((this.life * TAU) / 4.8);
          tgt[SQ] = tgt[SQ]! + 0.012 * b;
          tgt[CHP] = tgt[CHP]! - 0.025 * b;
        } else if (st === "failed") this.flinch(tgt, this.stateT);
      }
      if (this.blendT >= BLEND_S) this.cur.set(tgt);
      else {
        const w = smooth(this.blendT / BLEND_S);
        for (let i = 0; i < NCH; i++) this.cur[i] = this.from[i]! + (tgt[i]! - this.from[i]!) * w;
      }
    }
    this.out.set(this.cur);
    if (motion && this.burstT < BURST_S) this.burstOverlay(this.out);
    this.blink(d, motion);
    this.apply(this.out);

    this.group.updateMatrixWorld(true);
    this.inv.copy(this.group.matrixWorld).invert();
    this.updateProps(d, motion);
    this.updateGhosts(d, motion);
    this.updateCloth(d, motion);
    this.applyColors(d, motion);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.group.removeFromParent();
    for (const m of this.mats) m.dispose();
    for (const c of this.chains) c.geo.dispose();
    this.keys.dispose();
    releaseGeo(this.detail);
  }

  // ------------------------------------------------------------------------------------------ building

  private phys(p: THREE.MeshPhysicalMaterialParameters): THREE.MeshPhysicalMaterial {
    const m = new THREE.MeshPhysicalMaterial(p);
    this.mats.push(m);
    return m;
  }

  private basic(p: THREE.MeshBasicMaterialParameters): THREE.MeshBasicMaterial {
    const m = new THREE.MeshBasicMaterial(p);
    this.mats.push(m);
    return m;
  }

  private add(geo: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Object3D, x = 0, y = 0, z = 0, sx = 1, sy = sx, sz = sx): THREE.Mesh {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.scale.set(sx, sy, sz);
    m.castShadow = true;
    parent.add(m);
    return m;
  }

  private node(parent: THREE.Object3D, x = 0, y = 0, z = 0): THREE.Group {
    const n = new THREE.Group();
    n.position.set(x, y, z);
    parent.add(n);
    return n;
  }

  private snapshot(): void {
    this.from.set(this.cur);
    this.blendT = 0;
  }

  private random(): number {
    let x = this.rng;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rng = x >>> 0;
    return this.rng / 4294967296;
  }

  // ------------------------------------------------------------------------------------------ activities

  private activityPose(p: Pose, a: MiniActivity, t: number, live: boolean): void {
    neutral(p);
    switch (a) {
      case "typing": this.typing(p, t, live); break;
      case "shuriken": this.shuriken(p, t, live); break;
      case "kata": this.kata(p, t); break;
      case "meditate": this.meditate(p, t); break;
      case "scan": this.scan(p, t); break;
      case "staff": this.staff(p, t); break;
      case "scroll": this.scrollPose(p, t); break;
      case "dash": this.dash(p, t); break;
    }
  }

  /** Seated cross-legged at the floating holo keyboard (the mascot_mini scene): hands alternate fast, a
   *  periodic flurry triples the rate, an Enter slam winds up and snaps down, and he glances up now and then. */
  private typing(p: Pose, t: number, live: boolean): void {
    seatCross(p, 0.012 * Math.sin(t * 1.7));
    p[SPP] = 0.14;
    p[CHP] = 0.05;
    const phL = t * 6;
    const phR = phL + 0.5;
    const fast = t * 19;
    const u = fract(t / 4.2);
    const fl = bump(u, 0.6, 0.64, 0.78, 0.82);
    const dL = Math.max(tapCurve(fract(phL)) * (1 - fl), tapCurve(fract(fast)) * fl);
    const dR = Math.max(tapCurve(fract(phR)) * (1 - fl), tapCurve(fract(fast + 0.5)) * fl);
    const slam = strike(u, 0.86, 0.9, 0.915, 0.95, 1, 1);
    const up = Math.max(0, -slam);
    const hit = Math.max(0, slam);
    setArm(p, 0, 0.42 + 0.06 * dL, -0.14 + 0.07 * Math.sin(t * 1.3), 0.15, 0.95 - 0.1 * dL, 0.12 + 0.4 * dL, 0.2 + 0.8 * dL);
    setArm(p, 1, 0.42 + 0.06 * dR + 0.75 * up - 0.05 * hit, -0.14 + 0.07 * Math.sin(t * 1.1 + 1.7), 0.15, 0.95 - 0.1 * dR + 0.5 * up, 0.12 + 0.4 * dR + 0.5 * hit, 0.2 + 0.8 * dR);
    p[CHY] = -0.06 * up + 0.04 * Math.sin(t * 0.9);
    p[SQ] = -0.02 * hit;
    const glance = strike(fract(t / 3.1 + 0.37), 0.7, 0.7, 0.73, 0.82, 0.92, 0);
    p[HDP] = 0.36 - 0.42 * glance;
    p[HDY] = 0.1 * Math.sin(t * 0.7) + 0.12 * glance;
    p[LKY] = -0.55 + 0.75 * glance;
    if (!live) {
      for (let i = 0; i < this.keyGlow.length; i++) this.keyGlow[i] = i % 7 === 2 ? 1 : 0;
      return;
    }
    const nL = Math.floor(phL);
    const nR = Math.floor(phR);
    const nF = Math.floor(fast);
    if (nL !== this.tapL) {
      if (fl < 0.5 && !Number.isNaN(this.tapL)) this.lightKey(nL, 0);
      this.tapL = nL;
    }
    if (nR !== this.tapR) {
      if (fl < 0.5 && !Number.isNaN(this.tapR)) this.lightKey(nR, 1);
      this.tapR = nR;
    }
    if (nF !== this.tapF) {
      if (fl >= 0.5) this.lightKey(nF, nF & 1);
      this.tapF = nF;
    }
    const slamOn = u >= 0.9 && u < 0.95;
    if (slamOn && !this.slamLit) {
      this.keyGlow[Math.min(this.tier.keyRows - 1, 1) * this.tier.keyCols + this.tier.keyCols - 1] = 1;
      for (let i = 0; i < this.keyGlow.length; i++) this.keyGlow[i] = Math.max(this.keyGlow[i]!, 0.35);
      this.flash = Math.max(this.flash, 0.5);
    }
    this.slamLit = slamOn;
  }

  private lightKey(n: number, half: number): void {
    const cols = this.tier.keyCols;
    const halfC = cols >> 1;
    const h = Math.imul(n + 1, 2654435761) >>> 0;
    const col = half === 0 ? h % halfC : halfC + (h % (cols - halfC));
    const row = (h >>> 8) % this.tier.keyRows;
    this.keyGlow[row * cols + col] = 1;
  }

  /** Side-on guard, a slow overhead wind-up, a rapid throw with overshoot; the star spins off and fades. */
  private shuriken(p: Pose, t: number, live: boolean): void {
    const u = fract(t / 1.7);
    stance(p, 0.38, 0.22);
    p[RYAW] = -0.32;
    const wind = rise(u, 0.28, 0.58) * (1 - easeOutCubic(win(u, 0.58, 0.64)));
    const thr = easeOutBack(win(u, 0.58, 0.64), 2.2) * (1 - rise(u, 0.78, 1));
    setArm(p, 0, 0.9 - 0.35 * thr, 0.25, 0.3, 1.6 - 0.4 * thr, 0, 0.9);
    setArm(p, 1, 0.5 + 2.1 * wind + 0.6 * thr, 0.2 + 0.15 * wind, -0.2, 1.5 + 0.4 * wind - 1.4 * thr, -0.3 * wind + 0.4 * thr, 0.5);
    p[CHY] = -0.45 * wind + 0.5 * thr;
    p[SPP] = -0.1 * wind + 0.22 * thr;
    p[HDY] = -0.7 * p[CHY]!;
    p[HDP] = 0.04;
    p[SQ] = 0.03 * wind - 0.035 * thr;
    p[EYE] = 1 - 0.3 * thr;
    this.heldScale = u < 0.615 ? 1 : rise(u, 0.86, 0.96);
    if (!live) return;
    if (this.lastU < 0.615 && u >= 0.615) this.launch = true;
    this.lastU = u;
  }

  /** Flowing horse-stance kata with sharp snaps: right punch, left punch, a chambered front kick. */
  private kata(p: Pose, t: number): void {
    const u = fract(t / 4);
    const kick = strike(u, 0.62, 0.68, 0.705, 0.76, 0.86, 1);
    const kNeg = Math.max(0, -kick);
    const kPos = Math.max(0, kick);
    const lift = u >= 0.68 && u < 0.76 ? 1 : Math.max(kNeg, kPos);
    const c = 0.3 - 0.14 * lift + 0.03 * Math.sin(TAU * u);
    const w = 0.42 - 0.24 * lift;
    setLeg(p, 1, c, w, 0.3, 2 * c);
    const kp = c + 1.15 * lift + 0.25 * kPos;
    const kk = Math.max(-0.05, 2 * c + 1.6 * lift - 2.0 * kPos);
    setLeg(p, 0, kp, w * (1 - lift) + 0.1 * lift, 0.3 * (1 - lift), kk, (kp - kk) * (1 - lift) + 0.5 * kPos);
    p[HIPP] = 0.15 * c;
    plant(p);
    const pR = strike(u, 0.14, 0.2, 0.225, 0.3, 0.4, 0.6);
    const pL = strike(u, 0.38, 0.44, 0.465, 0.53, 0.62, 0.6);
    const rp = Math.max(0, pR), ra = Math.max(0, -pR);
    const lp = Math.max(0, pL), la = Math.max(0, -pL);
    setArm(p, 0, -0.25 + 1.8 * lp - 0.2 * la + 1.15 * lift, 0.18, 0.2, 1.9 - 1.85 * lp + 0.2 * la - 0.5 * lift, 0, 1);
    setArm(p, 1, -0.25 + 1.8 * rp - 0.2 * ra + 1.15 * lift, 0.18, 0.2, 1.9 - 1.85 * rp + 0.2 * ra - 0.5 * lift, 0, 1);
    p[CHY] = 0.42 * rp - 0.22 * ra - 0.42 * lp + 0.22 * la;
    p[RYAW] = 0.32 * Math.sin((TAU * t) / 8);
    p[SPP] = 0.04 - 0.16 * kPos;
    p[HDY] = -0.6 * p[CHY]!;
    p[HDP] = 0.02;
    p[SQ] = -0.02 * Math.min(1, rp + lp + kPos);
    p[EYE] = 0.88;
  }

  /** Floating cross-legged, slow breath, eyes closed; a quick mudra snap opens his eyes and flares the aura. */
  private meditate(p: Pose, t: number): void {
    const br = Math.sin((TAU * t) / 4.2);
    seatCross(p, 0.09 + 0.02 * Math.sin((TAU * t) / 3.6));
    const mp = Math.max(0, strike(fract(t / 5.5), 0.78, 0.8, 0.82, 0.92, 0.99, 0.3));
    for (let s = 0; s < 2; s++) setArm(p, s, lerp(0.55, 1.15, mp), lerp(0.42, -0.28, mp), 0.2, lerp(0.55, 1.95, mp), -0.2, 0.3 - 0.2 * mp);
    p[CHP] = -0.04 * br;
    p[SQ] = 0.012 * br;
    p[HDP] = 0.1 + 0.03 * br;
    p[EYE] = 0.07 + 0.93 * Math.min(1, mp);
    this.auraBreath = 0.5 + 0.5 * br;
    this.auraFlash = Math.max(this.auraFlash, Math.min(1, mp));
  }

  /** Hand at the glowing visor, the beam sweeping; the head holds on a target, then snaps to the next. */
  private scan(p: Pose, t: number): void {
    stance(p, 0.22, 0.14);
    const seg = t / 1.05;
    const i = Math.floor(seg);
    const f = seg - i;
    const a = SCAN_YAW[i % 6]!;
    const b = SCAN_YAW[(i + 1) % 6]!;
    const s = easeOutBack(win(f, 0.78, 0.86), 2);
    const yaw = lerp(a, b, s) + 0.03 * Math.sin(t * 2.3);
    p[HDY] = yaw;
    p[HDP] = lerp(SCAN_PITCH[i % 6]!, SCAN_PITCH[(i + 1) % 6]!, s);
    p[CHY] = 0.3 * lerp(a, b, rise(f, 0.75, 1));
    p[LKX] = Math.max(-1, Math.min(1, yaw * 1.4));
    p[SPP] = 0.05;
    setArm(p, 1, 1.05, 0.95, -0.4, 2.35, 0.2, 0.1);
    setArm(p, 0, 0.35, 0.2, 0, 1.3, 0, 0.6);
    this.beamYaw = 0.35 * Math.sin(t * 3.1);
    this.visorPulse = bump(f, 0.78, 0.82, 0.86, 1);
  }

  /** One-hand bo twirl in the frontal plane: cruise, a rapid twirl, a stop that lands horizontal, a thrust. */
  private staff(p: Pose, t: number): void {
    stance(p, 0.36, 0.26);
    const u = fract(t / 3.2);
    this.staffAngle = (Math.PI * 6 * staffArea(u)) / STAFF_TOTAL;
    const th = strike(u, 0.72, 0.78, 0.805, 0.88, 0.98, 0.5);
    const tp = Math.max(0, th), ta = Math.max(0, -th);
    const tw = bump(u, 0.46, 0.52, 0.66, 0.72);
    setArm(p, 1, 1.0 + 0.4 * tp - 0.15 * ta, -0.35, 0, 0.6 - 0.5 * tp + 0.35 * ta, 0, 0.9, 0.3 * tw * Math.sin(t * 25));
    setArm(p, 0, 0.75 + 0.25 * tw, 0.35, 0.3, 1.5, 0.1, 0.1);
    p[RZ] = 0.05 * tp - 0.02 * ta;
    p[RY] = p[RY]! + 0.012 * tw * Math.abs(Math.sin(t * 14));
    p[SPP] = 0.06 + 0.16 * tp - 0.08 * ta;
    p[CHY] = 0.25 * tp - 0.1 * ta + 0.08 * tw * Math.sin(t * 12);
    p[SQ] = 0.02 * tw * Math.sin(t * 28) - 0.02 * tp;
    p[HDP] = 0.05;
    p[HDY] = -0.4 * p[CHY]!;
  }

  /** Reads a scroll line by line and writes with a brush; at each line end a quick flick and a head snap back. */
  private scrollPose(p: Pose, t: number): void {
    stance(p, 0.2, 0.12);
    const line = t / 1.6;
    const f = fract(line);
    const read = f < 0.82 ? f / 0.82 : 1 - easeOutBack(win(f, 0.82, 0.9), 1.4);
    p[HDY] = lerp(-0.14, 0.14, read);
    p[HDP] = 0.42;
    p[SPP] = 0.06;
    p[CHP] = 0.06;
    p[LKY] = -0.4;
    p[LKX] = read * 0.6 - 0.3;
    const fl = strike(f, 0.8, 0.83, 0.85, 0.88, 0.97, 0.4);
    const fp = Math.max(0, fl), fa = Math.max(0, -fl);
    const across = f < 0.82 ? f / 0.82 : 1 - easeOutCubic(win(f, 0.82, 0.95));
    setArm(p, 0, 1.0, 0.2, 0.4, 1.4, 0.1, 0.6);
    setArm(p, 1, 0.95 + 0.04 * Math.sin(t * 7) + 0.25 * fp, -0.2 + 0.2 * across, -0.2, 1.4 - 0.5 * fp + 0.15 * fa, 0.15 + 0.08 * Math.sin(t * 13) - 0.7 * fp, 0.5, 0.35 * fp);
    this.glyphLine = Math.floor(line) % GLYPH_LEN.length;
    this.glyphFill = Math.min(1, f / 0.82);
  }

  /** Ready stance, a crouch, an afterimage dash to one side, a ninja pose, a dash back; sides alternate. */
  private dash(p: Pose, t: number): void {
    const n = Math.floor(t / 2.4);
    const u = t / 2.4 - n;
    const side = n % 2 === 0 ? 1 : -1;
    const pre = bump(u, 0.16, 0.3, 0.34, 0.4);
    const out = easeOutBack(win(u, 0.34, 0.41), 2) - easeOutBack(win(u, 0.66, 0.73), 1.4);
    const env = bump(u, 0.34, 0.38, 0.62, 0.7);
    const lean = bump(u, 0.34, 0.37, 0.4, 0.5) - bump(u, 0.66, 0.69, 0.72, 0.82);
    const trail = Math.abs(lean);
    const hold = env * (1 - trail);
    stance(p, 0.42 + 0.1 * env, 0.28 + 0.12 * pre);
    p[RX] = 0.32 * side * out;
    p[RY] = p[RY]! - 0.025 * pre;
    p[RROL] = -side * 0.3 * lean;
    p[RYAW] = 0.25 * side * env;
    const lead = side > 0 ? 0 : 1;
    setArm(p, lead, 0.6 + 0.8 * hold - 1.2 * trail, 0.3 + 0.5 * hold, 0, 1.3 - 1.0 * hold, 0, 0.1);
    setArm(p, 1 - lead, 0.6 - 0.9 * trail - 0.4 * hold, 0.2, 0, 1.3 + 0.4 * hold, 0, 0.8);
    p[HDY] = 0.35 * side * env;
    p[SQ] = 0.04 * trail - 0.03 * pre;
    p[EYE] = 1 - 0.3 * trail;
  }

  // ------------------------------------------------------------------------------------------ states

  /** A bow with hands at his sides, then he sits cross-legged with his eyes resting. */
  private endedPose(p: Pose, se: number): void {
    neutral(p);
    setLeg(p, 0, 0, 0.03, 0.1, 0);
    setLeg(p, 1, 0, 0.03, 0.1, 0);
    setArm(p, 0, 0, 0.06, 0, 0.12, 0, 0.3);
    setArm(p, 1, 0, 0.06, 0, 0.12, 0, 0.3);
    const bow = bump(se, 0.1, 0.45, 0.75, 1.05);
    p[SPP] = 0.7 * bow;
    p[HIPP] = 0.15 * bow;
    p[HDP] = 0.3 * bow;
    p[EYE] = 1 - 0.85 * bow;
    plant(p);
    const s = rise(se, 1.05, 1.75);
    if (s <= 0) return;
    const q = this.tmp;
    neutral(q);
    seatCross(q, 0);
    handsOnKnees(q);
    q[EYE] = 0.12;
    q[HDP] = 0.12;
    q[SQ] = 0.008 * Math.sin(this.life * 1.4);
    for (let i = 0; i < NCH; i++) p[i] = lerp(p[i]!, q[i]!, s);
  }

  /** Knees buckle, he slumps and topples gently onto his side; eyes off. */
  private killedPose(p: Pose, se: number): void {
    neutral(p);
    const slump = rise(se, 0, 0.6);
    const fall = easeOutBack(win(se, 0.5, 1.5), 0.6);
    setLeg(p, 0, 0.6 * slump, 0.08, 0.1, 1.2 * slump);
    setLeg(p, 1, 0.6 * slump, 0.08, 0.1, 1.2 * slump);
    setArm(p, 0, 0.1, 0.1 + 0.2 * fall, 0, 0.2, 0, 0.1);
    setArm(p, 1, 0.1, 0.1 + 0.2 * fall, 0, 0.2, 0, 0.1);
    p[SPP] = 0.45 * slump - 0.2 * fall;
    p[HDP] = 0.5 * slump - 0.2 * fall;
    plant(p);
    p[RY] = lerp(p[RY]!, -0.19, clamp01(fall));
    p[RROL] = 1.38 * fall;
    p[EYE] = 0.1;
  }

  /** Failed: a rapid recoil (guard up, eyes squeezed, a shake), then a smooth recovery into the activity. */
  private flinch(p: Pose, se: number): void {
    const h = easeOutBack(win(se, 0, 0.07), 2.2) * (1 - rise(se, 0.35, 1.1));
    if (h === 0) return;
    const hc = Math.min(1, h);
    p[RZ] = p[RZ]! - 0.07 * h;
    p[RX] = p[RX]! + 0.012 * Math.sin(se * 70) * h;
    p[SPP] = p[SPP]! - 0.32 * h;
    p[HDP] = p[HDP]! - 0.25 * h;
    p[HDR] = p[HDR]! + 0.15 * h;
    p[SQ] = p[SQ]! - 0.04 * h;
    for (let s = 0; s < 2; s++) {
      const o = ARM0 + s * ARM_N;
      p[o + A_P] = lerp(p[o + A_P]!, 1.3, hc);
      p[o + A_A] = lerp(p[o + A_A]!, 0.35, hc);
      p[o + A_E] = lerp(p[o + A_E]!, 1.9, hc);
      p[o + A_F] = lerp(p[o + A_F]!, 1, hc);
    }
    p[EYE] = lerp(p[EYE]!, 0.25, hc);
  }

  /** burst(): one rapid move on top of whatever he is doing (dash, spin strike, punch flurry), back to 0. */
  private burstOverlay(p: Pose): void {
    const b = this.burstT;
    const side = this.burstSide;
    if (this.burstV === 0) {
      const out = easeOutBack(win(b, 0.05, 0.14), 2) - easeOutCubic(win(b, 0.26, 0.42));
      const pre = bump(b, 0, 0.04, 0.05, 0.1);
      p[RX] = p[RX]! + 0.26 * side * out;
      p[RY] = p[RY]! - 0.02 * pre;
      p[SQ] = p[SQ]! - 0.03 * pre;
      p[RROL] = p[RROL]! - side * 0.28 * (bump(b, 0.05, 0.08, 0.1, 0.2) - bump(b, 0.26, 0.29, 0.32, 0.42));
    } else if (this.burstV === 1) {
      p[RYAW] = p[RYAW]! - 0.35 * rise(b, 0, 0.07) + (TAU + 0.35) * easeOutCubic(win(b, 0.07, 0.4));
      const e = bump(b, 0.05, 0.1, 0.32, 0.42);
      for (let s = 0; s < 2; s++) {
        const o = ARM0 + s * ARM_N;
        p[o + A_A] = lerp(p[o + A_A]!, 1.3, e);
        p[o + A_E] = lerp(p[o + A_E]!, 0.15, e);
      }
      p[SQ] = p[SQ]! + 0.05 * e;
    } else {
      const e = bump(b, 0, 0.05, 0.34, 0.44);
      const w = b * TAU * 11;
      for (let s = 0; s < 2; s++) {
        const o = ARM0 + s * ARM_N;
        const punch = e * Math.max(0, Math.sin(w + s * Math.PI));
        p[o + A_P] = lerp(p[o + A_P]!, 1.45, punch);
        p[o + A_E] = lerp(p[o + A_E]!, 0.1, punch);
        p[o + A_F] = lerp(p[o + A_F]!, 1, e);
      }
      p[CHY] = p[CHY]! + 0.2 * e * Math.sin(w);
    }
  }

  // ------------------------------------------------------------------------------------------ per frame

  private blink(d: number, motion: boolean): void {
    if (!motion) {
      this.blinkAge = 1;
      return;
    }
    this.blinkIn -= d;
    this.blinkAge += d;
    if (this.blinkIn <= 0) {
      this.blinkAge = 0;
      this.blinkIn = this.random() < 0.2 ? 0.3 : 2.4 + 2.6 * this.random();
    }
  }

  private apply(p: Pose): void {
    const sq = p[SQ]!;
    this.root.position.set(p[RX]!, HIP_Y + p[RY]!, p[RZ]!);
    this.root.rotation.set(p[RPIT]!, p[RYAW]!, p[RROL]!);
    this.root.scale.set(1 - sq * 0.5, 1 + sq, 1 - sq * 0.5);
    this.hips.rotation.set(p[HIPP]!, p[HIPY]!, p[HIPR]!);
    this.spine.rotation.set(p[SPP]!, p[SPY]!, p[SPR]!);
    this.chest.rotation.set(p[CHP]!, p[CHY]!, p[CHR]!);
    this.neck.rotation.set(p[HDP]! * 0.35, p[HDY]! * 0.35, p[HDR]! * 0.35);
    this.head.rotation.set(p[HDP]! * 0.65, p[HDY]! * 0.65, p[HDR]! * 0.65);
    for (let s = 0; s < 2; s++) {
      const sg = s === 0 ? 1 : -1;
      const a = ARM0 + s * ARM_N;
      this.shoulder[s]!.rotation.set(-p[a + A_P]!, sg * p[a + A_T]!, sg * p[a + A_A]!);
      this.elbow[s]!.rotation.set(-Math.max(0, p[a + A_E]!), 0, 0);
      this.wrist[s]!.rotation.set(p[a + A_WP]!, 0, sg * p[a + A_WR]!);
      const f = p[a + A_F]!;
      this.finger[s]?.rotation.set(0.2 + 1.2 * f, 0, 0);
      this.thumb[s]?.rotation.set(0.2 * f, 0, -sg * (0.5 + 0.5 * f));
      const l = LEG0 + s * LEG_N;
      this.hip[s]!.rotation.set(-p[l + L_P]!, sg * p[l + L_T]!, sg * p[l + L_A]!);
      this.knee[s]!.rotation.set(Math.max(-0.05, p[l + L_K]!), 0, 0);
      this.ankle[s]!.rotation.set(p[l + L_AN]!, 0, 0);
    }
    const b = this.blinkAge < 0.15 ? 1 - 0.95 * Math.sin((Math.PI * this.blinkAge) / 0.15) : 1;
    const open = Math.max(0.07, clamp01(p[EYE]!) * b);
    const on = this.dead < 0.5;
    for (let s = 0; s < 2; s++) {
      this.eyes[s]!.scale.set(1, open, 1);
      const pu = this.pupils[s]!;
      pu.visible = on;
      pu.position.set(clamp01((p[LKX]! + 1) / 2) * 0.012 - 0.006, clamp01((p[LKY]! + 1) / 2) * 0.012 - 0.006, 0.007);
    }
  }

  private updateProps(d: number, motion: boolean): void {
    const w = this.weights;
    const propsOn = this.state !== "ended" && this.state !== "killed";
    const cur = ACT_INDEX[this.activity];
    for (let i = 0; i < w.length; i++) {
      const target = propsOn && i === cur ? 1 : 0;
      const step = d / BLEND_S;
      w[i] = motion ? (w[i]! < target ? Math.min(target, w[i]! + step) : Math.max(target, w[i]! - step)) : target;
    }
    const fx = motion ? 1 : 0;

    // holo keyboard
    const wk = smooth(w[ACT_INDEX.typing]!);
    this.keyboard.visible = wk > 0.01;
    if (this.keyboard.visible) {
      this.keyboard.scale.setScalar(easeOutBack(wk, 1.2));
      const decay = motion ? Math.exp(-d * 7) : 1;
      for (let i = 0; i < this.keyGlow.length; i++) {
        const gl = (this.keyGlow[i] = this.keyGlow[i]! * decay);
        this.keys.setColorAt(i, this.tc.copy(this.cKeyBase).lerp(this.cKeyHot, gl));
      }
      if (this.keys.instanceColor) this.keys.instanceColor.needsUpdate = true;
      this.mKbGlow.opacity = 0.25 * wk * (1 + 0.4 * this.flash);
    }

    // shuriken
    const ws = smooth(w[ACT_INDEX.shuriken]!);
    const held = ws * this.heldScale;
    this.heldStar.visible = held > 0.01;
    this.heldStar.scale.setScalar(Math.max(0.001, held));
    this.heldStar.rotation.z += d * 3;
    if (this.launch) {
      this.launch = false;
      const yaw = this.root.rotation.y;
      this.thrownPos.setFromMatrixPosition(this.heldStar.matrixWorld).applyMatrix4(this.inv);
      this.thrownVel.set(Math.sin(yaw) * 2.6, 0.35, Math.cos(yaw) * 2.6);
      this.thrown.rotation.set(-1.2, yaw, 0);
      this.thrownAge = 0;
    }
    if (this.thrownAge >= 0 && motion) {
      this.thrownAge += d;
      if (this.thrownAge > 0.6 || ws < 0.01) this.thrownAge = -1;
      else {
        this.thrownPos.addScaledVector(this.thrownVel, d);
        this.thrown.position.copy(this.thrownPos);
        this.thrown.rotation.z += 40 * d;
        this.mThrown.opacity = 1 - smooth(this.thrownAge / 0.6);
      }
    }
    this.thrown.visible = this.thrownAge >= 0 && motion;

    // bo staff
    const wst = smooth(w[ACT_INDEX.staff]!);
    this.staffSpin.visible = wst > 0.01;
    this.staffSpin.scale.setScalar(Math.max(0.001, wst));
    this.staffSpin.rotation.y = this.staffAngle;

    // scroll and brush
    const wsc = smooth(w[ACT_INDEX.scroll]!);
    this.scroll.visible = this.brush.visible = wsc > 0.01;
    this.scroll.scale.setScalar(Math.max(0.001, wsc));
    this.brush.scale.setScalar(Math.max(0.001, wsc));
    for (let i = 0; i < this.glyphs.length; i++) {
      const full = GLYPH_LEN[i]!;
      const len = i < this.glyphLine ? full : i === this.glyphLine ? full * this.glyphFill : 0;
      this.glyphs[i]!.scale.x = Math.max(0.0001, len);
    }

    // scanner visor and beam
    const wv = smooth(w[ACT_INDEX.scan]!);
    this.visor.visible = this.beamPivot.visible = wv > 0.01;
    this.visor.scale.set(1, Math.max(0.001, wv), 1);
    this.beamPivot.rotation.y = this.beamYaw;
    this.mBeam.opacity = 0.14 * wv * (0.8 + 0.2 * Math.sin(this.life * 30) * fx) * (1 + this.visorPulse);
    this.mVisor.emissiveIntensity = (0.8 + 1.4 * this.visorPulse) * (0.4 + this.glow * 0.6);

    // meditation aura
    const wa = smooth(w[ACT_INDEX.meditate]!);
    this.aura.visible = wa > 0.01;
    this.aura.position.x = this.root.position.x;
    this.aura.position.z = this.root.position.z;
    this.auraFlash *= motion ? Math.exp(-d * 3) : 0;
    this.auraA.scale.setScalar(1 + 0.08 * this.auraBreath + 0.15 * this.auraFlash);
    this.mAuraA.opacity = (0.22 + 0.18 * this.auraBreath + 0.4 * this.auraFlash) * wa;
    const ph = fract(this.life / 2.1);
    this.auraB.scale.setScalar(1 + 1.4 * ph);
    this.mAuraB.opacity = 0.3 * (1 - ph) * wa * fx;
  }

  /** Afterimages: any fast root move (dash, burst dash) or a burst spin leaves fading accent silhouettes. */
  private updateGhosts(d: number, motion: boolean): void {
    const rp = this.root.position;
    let speed = 0;
    if (d > 0) {
      const dx = rp.x - this.lastRX, dy = rp.y - this.lastRY, dz = rp.z - this.lastRZ;
      speed = Math.sqrt(dx * dx + dy * dy + dz * dz) / d;
    }
    this.lastRX = rp.x;
    this.lastRY = rp.y;
    this.lastRZ = rp.z;
    this.ghostClock += d;
    const spinning = this.burstV === 1 && this.burstT > 0.07 && this.burstT < 0.4;
    if (motion && (speed > 1.3 || spinning) && this.ghostClock > 0.035 && this.ghosts.length > 0) {
      this.ghostClock = 0;
      const gh = this.ghosts[this.ghostNext]!;
      this.ghostNext = (this.ghostNext + 1) % this.ghosts.length;
      gh.g.position.copy(rp);
      gh.g.rotation.set(0, this.root.rotation.y, this.root.rotation.z);
      gh.g.scale.copy(this.root.scale);
      gh.age = 0;
    }
    for (const gh of this.ghosts) {
      gh.age += d;
      const live = motion && gh.age < 0.26;
      gh.g.visible = live;
      if (live) gh.mat.opacity = 0.42 * (1 - gh.age / 0.26);
    }
  }

  private updateCloth(d: number, motion: boolean): void {
    if (this.chains.length === 0) {
      for (let i = 0; i < this.tailPivots.length; i++) {
        const pv = this.tailPivots[i]!;
        pv.quaternion.copy(this.tailRest[i]!);
        if (motion) pv.rotateZ(0.14 * Math.sin(this.life * 3.2 + i * 1.7));
      }
      return;
    }
    const v = this.v1;
    v.setFromMatrixPosition(this.skull.matrixWorld).applyMatrix4(this.inv);
    const hx = v.x, hy = v.y, hz = v.z;
    const yaw = this.root.rotation.y;
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    let steps = 0;
    if (motion && this.clothReady) {
      this.clothAcc += d;
      steps = Math.floor(this.clothAcc / CLOTH_H);
      if (steps > 4) {
        steps = 4;
        this.clothAcc = 0;
      } else this.clothAcc -= steps * CLOTH_H;
    }
    const pull = this.state === "killed" ? 0.006 : 0.045;
    const coll = HR * 1.04;
    for (let ci = 0; ci < this.chains.length; ci++) {
      const c = this.chains[ci]!;
      v.setFromMatrixPosition(c.anchor.matrixWorld).applyMatrix4(this.inv);
      c.bx = c.ax; c.by = c.ay; c.bz = c.az;
      c.ax = v.x; c.ay = v.y; c.az = v.z;
      const dx = c.rx * cy + c.rz * sy, dy = c.ry, dz = -c.rx * sy + c.rz * cy;
      const P = c.pos, Q = c.prev;
      if (!motion || !this.clothReady) {
        for (let i = 0; i < c.n; i++) {
          const o = i * 3;
          const sag = 0.25 * c.seg * i * (i / c.n);
          P[o] = Q[o] = c.ax + dx * c.seg * i;
          P[o + 1] = Q[o + 1] = c.ay + dy * c.seg * i - sag;
          P[o + 2] = Q[o + 2] = c.az + dz * c.seg * i;
        }
        c.bx = c.ax; c.by = c.ay; c.bz = c.az;
      }
      for (let s = 0; s < steps; s++) {
        const f = (s + 1) / steps;
        const ax = lerp(c.bx, c.ax, f), ay = lerp(c.by, c.ay, f), az = lerp(c.bz, c.az, f);
        P[0] = Q[0] = ax;
        P[1] = Q[1] = ay;
        P[2] = Q[2] = az;
        const h2 = CLOTH_H * CLOTH_H;
        for (let i = 1; i < c.n; i++) {
          const o = i * 3;
          const flutter = Math.sin(this.life * 9 + i * 0.9 + ci * 2.1) * 0.6 * (i / c.n);
          let x = P[o]!, y = P[o + 1]!, z = P[o + 2]!;
          const vx = (x - Q[o]!) * 0.9, vy = (y - Q[o + 1]!) * 0.9, vz = (z - Q[o + 2]!) * 0.9;
          Q[o] = x; Q[o + 1] = y; Q[o + 2] = z;
          x += vx + dx * 0.8 * h2;
          y += vy + (dy * 0.8 - 1.2 + flutter) * h2;
          z += vz + dz * 0.8 * h2;
          x += (ax + dx * c.seg * i - x) * pull;
          y += (ay + dy * c.seg * i - y) * pull;
          z += (az + dz * c.seg * i - z) * pull;
          P[o] = x; P[o + 1] = y; P[o + 2] = z;
        }
        for (let i = 1; i < c.n; i++) {
          const o = i * 3, q = o - 3;
          let ex = P[o]! - P[q]!, ey = P[o + 1]! - P[q + 1]!, ez = P[o + 2]! - P[q + 2]!;
          const len = Math.sqrt(ex * ex + ey * ey + ez * ez);
          if (len > 1e-6) {
            const k = c.seg / len;
            P[o] = P[q]! + ex * k;
            P[o + 1] = P[q + 1]! + ey * k;
            P[o + 2] = P[q + 2]! + ez * k;
          }
          ex = P[o]! - hx; ey = P[o + 1]! - hy; ez = P[o + 2]! - hz;
          const dist = Math.sqrt(ex * ex + ey * ey + ez * ez);
          if (dist < coll && dist > 1e-6) {
            const k = coll / dist;
            P[o] = hx + ex * k;
            P[o + 1] = hy + ey * k;
            P[o + 2] = hz + ez * k;
          }
        }
      }
      P[0] = c.ax; P[1] = c.ay; P[2] = c.az;
      this.writeRibbon(c, cy, sy);
    }
    this.clothReady = true;
  }

  /** Catmull-Rom through the chain, then a strip whose width leans vertical when the tail streams out and
   *  sideways when it hangs, so it reads from the front either way. */
  private writeRibbon(c: Chain, cy: number, sy: number): void {
    const P = c.pos, R = c.row, n = c.n, sub = this.tier.sub, rows = c.rows;
    for (let r = 0; r < rows; r++) {
      let j = Math.floor(r / sub);
      let u = (r - j * sub) / sub;
      if (j >= n - 1) { j = n - 2; u = 1; }
      const i0 = Math.max(j - 1, 0) * 3, i1 = j * 3, i2 = (j + 1) * 3, i3 = Math.min(j + 2, n - 1) * 3;
      for (let k = 0; k < 3; k++) R[r * 3 + k] = catmull(P[i0 + k]!, P[i1 + k]!, P[i2 + k]!, P[i3 + k]!, u);
    }
    const pos = c.posAttr.array as Float32Array;
    const nrm = c.nrmAttr.array as Float32Array;
    const rx = cy, rz = -sy;
    for (let r = 0; r < rows; r++) {
      const a = Math.max(r - 1, 0) * 3, b = Math.min(r + 1, rows - 1) * 3;
      let tx = R[b]! - R[a]!, ty = R[b + 1]! - R[a + 1]!, tz = R[b + 2]! - R[a + 2]!;
      let tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
      if (tl < 1e-6) { tx = 0; ty = -1; tz = 0; tl = 1; }
      tx /= tl; ty /= tl; tz /= tl;
      const ay = Math.abs(ty);
      let sx = rx * ay, sv = 1 - ay, sz = rz * ay;
      const dot = sx * tx + sv * ty + sz * tz;
      sx -= tx * dot; sv -= ty * dot; sz -= tz * dot;
      let sl = Math.sqrt(sx * sx + sv * sv + sz * sz);
      if (sl < 1e-6) { sx = rx; sv = 0; sz = rz; sl = 1; }
      sx /= sl; sv /= sl; sz /= sl;
      const nx = ty * sz - tz * sv, ny = tz * sx - tx * sz, nz = tx * sv - ty * sx;
      const half = c.width * (1 - 0.55 * (r / (rows - 1))) * 0.5;
      const o = r * 6, p = r * 3;
      pos[o] = R[p]! + sx * half; pos[o + 1] = R[p + 1]! + sv * half; pos[o + 2] = R[p + 2]! + sz * half;
      pos[o + 3] = R[p]! - sx * half; pos[o + 4] = R[p + 1]! - sv * half; pos[o + 5] = R[p + 2]! - sz * half;
      nrm[o] = nrm[o + 3] = nx; nrm[o + 1] = nrm[o + 4] = ny; nrm[o + 2] = nrm[o + 5] = nz;
    }
    c.posAttr.needsUpdate = true;
    c.nrmAttr.needsUpdate = true;
  }

  private applyColors(d: number, motion: boolean): void {
    const st = this.state;
    // Kept under about 1: color plus a stronger emissive saturates to white under ACES and the neon turns pastel.
    const glowT = st === "killed" ? 0 : st === "ended" ? 0.05 : st === "paused" ? 0.1 : st === "idle" ? 0.15 : 0.18 + 0.32 * this.kS;
    const desT = st === "paused" ? 0.45 : st === "ended" ? 0.2 : 0;
    const deadT = st === "killed" ? 1 : 0;
    const r = motion ? 1 - Math.exp(-d * 4) : 1;
    this.glow += (glowT - this.glow) * r;
    this.des += (desT - this.des) * r;
    this.dead += (deadT - this.dead) * r;
    this.flash = motion ? this.flash * Math.exp(-d * 5) : 0;
    const glow = this.glow + this.flash * (1 - this.dead) * 1.2;
    const des = this.des, dead = this.dead;

    tint(this.mGi.color, this.cGi, des, dead * 0.3, DEAD_ACCENT);
    tint(this.mGi.sheenColor, this.cGiHi, des, dead * 0.3, DEAD_ACCENT);
    tint(this.mGiShadow.color, this.cGiShadow, des, dead * 0.3, DEAD_ACCENT);
    this.mGiShadow.sheenColor.copy(this.mGi.color);
    tint(this.mGiHi.color, this.cGiHi, des, dead * 0.3, DEAD_ACCENT);
    this.mGiHi.sheenColor.copy(this.mGiHi.color);

    tint(this.cAccNow, this.cAccent, des, dead, DEAD_ACCENT);
    tint(this.cDeepNow, this.cAccentDeep, des, dead, DEAD_ACCENT);
    this.mAccent.color.copy(this.cAccNow);
    this.mAccent.emissive.copy(this.cAccNow);
    this.mAccent.sheenColor.copy(this.cAccNow);
    this.mCloth.color.copy(this.cAccNow);
    this.mCloth.emissive.copy(this.cAccNow);
    this.mCloth.sheenColor.copy(this.cAccNow);
    this.mAccent.emissiveIntensity = glow;
    this.mCloth.emissiveIntensity = glow * 0.8;
    this.mDeep.color.copy(this.cDeepNow);
    this.mDeep.emissive.copy(this.cAccNow);
    this.mDeep.emissiveIntensity = glow * 0.25;
    this.cKeyBase.copy(this.cDeepNow).multiplyScalar(0.5);
    this.cKeyHot.copy(this.cAccNow).multiplyScalar(1.3 + glow);
    this.mHolo.color.copy(this.cDeepNow);
    this.mHolo.emissive.copy(this.cAccNow);
    this.mHolo.emissiveIntensity = 0.25 * glow;
    this.mVisor.color.copy(this.cAccNow);
    this.mVisor.emissive.copy(this.cAccNow);
    this.mThrown.emissive.copy(this.cAccNow);
    this.mThrown.emissiveIntensity = 0.3 * glow;
    this.mKbGlow.color.copy(this.cAccNow);
    this.mBeam.color.copy(this.cAccNow);
    this.mAuraA.color.copy(this.cAccNow);
    this.mAuraB.color.copy(this.cAccNow);
    this.mGlyph.color.copy(this.cAccNow).multiplyScalar(0.7);
    for (const gh of this.ghosts) gh.mat.color.copy(this.cAccNow);
    this.mEye.color.copy(EYE_WHITE).lerp(DEAD_EYE, dead);
    for (const t of this.beltTails) t.rotation.z = (t.position.x > 0 ? 1 : -1) * 0.22 + 0.06 * Math.sin(this.life * 2.6) * (motion ? 1 : 0);
  }
}

export function createMini3D(o: { look: MiniLook; detail: MiniDetail }): Mini3D {
  return new MiniFigure(o.look, o.detail);
}
