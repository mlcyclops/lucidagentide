// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_world_character.ts - P-WORLDS.KIT2 (ADR-0654): WorldKit.character, the shared character kit for
// the template biped every world pack forked from soccer (store repo worlds/soccer/src/figures: player.ts, rig.ts,
// face.ts, core.ts). Built at the template's units (BUILD_H 1.1, head sphere 0.112 with hair at 0.1175, shoulders 0.15
// out and 0.225 up the spine, arm capsules 0.042 x 0.11 and 0.038 x 0.115 hanging from their joints), so a pack keeps
// its rig and only swaps parts:
//   bodyShape: proportions for feminine, masculine and neutral in four builds, plus the rig spec that goes with them.
//   hair:      the 16 shared styles (viz_cast.HAIR_STYLES ids) at minimal, reduced and full detail, strand cards from
//              ultra, and a capSafe variant that keeps everything above the brim inside a hat and shows the rest.
//   sleeve:    THE SLEEVE FIX. Soccer's short sleeve ran from y +0.02 to -0.08 while the arm capsule's round top
//              reaches +0.042, so a skin dome showed above every sleeve in all 29 packs. A capsule's round end is a
//              hemisphere of its radius centered ON the joint; a flat shirt-material lens riding the shoulder joint
//              holds it (and the ink hull) at every shoulder angle without rising above it, and the sleeve tube
//              tapers out of the lens.
//   torso:     soccer's shirt lathe (same ring heights, seam and uv) reshaped for chest, waist, hips and shoulders,
//              with a shoulder yoke that carries the shirt out to the sleeve caps.
//   face:      lashes, brows, lip tint, blush, freckles and glasses by presentation and face variant, painted around
//              the world's own eyes and mouth on the template's 256 x 168 face canvas. Beards only when asked.
// Pure geometry and canvas calls: no scene, no per-frame work. Everything returned is owned by the caller.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type {
  WorldAppearance, WorldBipedSpec, WorldBodyShape, WorldCharacterKit, WorldFaceFeatures, WorldFaceOptions, WorldFacePainter,
  WorldFaceState, WorldHair, WorldHairOptions, WorldHairStyle, WorldSleeve, WorldSleeveOptions, WorldTier, WorldTorsoOptions,
} from "./viz_world_api.ts";

type G = THREE.BufferGeometry;
type V3 = THREE.Vector3;
type Presentation = WorldAppearance["presentation"];
type Build = WorldAppearance["body"];

const TAU = Math.PI * 2;
/** The template head sphere and the hair shell over it (soccer player.ts HEAD_R, the short hair's crown). */
export const HEAD_R = 0.112;
export const HAIR_R = 0.1175;
/** The brim line (radians from the top of the head) and the radius capSafe hair keeps inside above it. Soccer's keeper
 *  cap is a 0.121 shell down to 1.2. */
export const CAP_LINE = 1.15;
export const CAP_R = 0.119;
/** Half the face opening a hair band leaves around +Z (soccer's band leaves 2.1 rad open). */
const FACE_OPEN = 1.05;
/** The face cap starts 0.9 rad below the top of the head (soccer core.ts FACE_TH0); with a margin. */
const FACE_TOP = 0.85;

export const HAIR_IDS: readonly WorldHairStyle[] = Object.freeze([
  "short", "buzz", "curls", "coils", "afro", "puffs", "locs", "braids", "long", "wavy", "bob", "pixie", "bun", "ponytail", "headscarf", "hijab",
] as const);

/** Soccer's shirt lathe (player.ts TORSO): ring heights in spine space and the template radii. */
export const TORSO_HEIGHTS: readonly number[] = Object.freeze([-0.1, -0.06, -0.02, 0.02, 0.06, 0.1, 0.14, 0.18, 0.21, 0.235, 0.255, 0.27]);
const TORSO_RADII: readonly number[] = [0.104, 0.106, 0.108, 0.112, 0.118, 0.124, 0.13, 0.134, 0.132, 0.118, 0.088, 0.05];
const TEMPLATE = { shoulder: 0.15, chest: 0.134, waist: 0.108, hip: 0.113, neck: 0.044 } as const;
/** The template arm capsules: radius and straight length, upper arm (from the shoulder) and forearm (from the elbow). */
export const ARM = Object.freeze({ upperR: 0.042, upperLen: 0.11, foreR: 0.038, foreLen: 0.115 });
/** The template's widest ink hull (core.ts INK_FLAT; INK_3D is 0.0065). */
const INK_FLAT = 0.012;

const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

// ------------------------------------------------------------------------------------------ tiers

const SEGS: Readonly<Record<WorldTier, number>> = { minimal: 9, reduced: 14, full: 22, ultra: 28, cinematic: 34 };
function tierOf(t: WorldTier | undefined): WorldTier {
  return t !== undefined && Object.prototype.hasOwnProperty.call(SEGS, t) ? t : "full";
}
/** Radial segments: soccer's tierFor (22 / 14 / 9), more above full, at most 12 in the 2D map. */
function segOf(t: WorldTier | undefined, flat: boolean | undefined): number {
  const s = SEGS[tierOf(t)];
  return flat ? Math.min(s, 12) : s;
}
/** 0 minimal, 1 reduced, 2 full and above: how many extras a hair gets. */
function levelOf(t: WorldTier | undefined): 0 | 1 | 2 {
  const k = tierOf(t);
  return k === "minimal" ? 0 : k === "reduced" ? 1 : 2;
}
/** Strand card density: 1 at ultra, 2 at cinematic, none below or in the 2D map. */
function cardMulOf(t: WorldTier | undefined, flat: boolean | undefined): number {
  if (flat) return 0;
  const k = tierOf(t);
  return k === "cinematic" ? 2 : k === "ultra" ? 1 : 0;
}

/** mulberry32 (the kit's random). */
function random(seed: number): () => number {
  let a = (seed >>> 0) || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------------------------------ bodies

interface Preset { shoulder: number; chest: number; waist: number; hip: number; hipX: number; depth: number; bust: number; height: number; limb: number; neck: number; jaw: number }

/** Average build per presentation. Masculine sits close to soccer's player, feminine narrows the shoulders and waist
 *  and widens the hips, neutral sits between. */
const PRESETS: Readonly<Record<Presentation, Preset>> = {
  feminine: { shoulder: 0.138, chest: 0.124, waist: 0.094, hip: 0.12, hipX: 0.07, depth: 0.8, bust: 0.6, height: 0.96, limb: 0.9, neck: 0.038, jaw: 0.9 },
  masculine: { shoulder: 0.156, chest: 0.138, waist: 0.112, hip: 0.11, hipX: 0.065, depth: 0.78, bust: 0, height: 1.02, limb: 1.05, neck: 0.047, jaw: 1.06 },
  neutral: { shoulder: 0.147, chest: 0.13, waist: 0.104, hip: 0.114, hipX: 0.067, depth: 0.79, bust: 0.15, height: 0.99, limb: 0.97, neck: 0.043, jaw: 0.97 },
};
/** Builds 0 to 3, slight to broad: width, waist, limb and neck multipliers and a small height nudge. */
const BUILDS: readonly { w: number; waist: number; limb: number; neck: number; h: number }[] = [
  { w: 0.92, waist: 0.88, limb: 0.88, neck: 0.93, h: 0.99 },
  { w: 1, waist: 1, limb: 1, neck: 1, h: 1 },
  { w: 1.07, waist: 1.04, limb: 1.1, neck: 1.07, h: 1.01 },
  { w: 1.13, waist: 1.2, limb: 1.16, neck: 1.12, h: 1 },
];

/** Soccer's BipedSpec at height `h` (1: hipY 0.5, thigh 0.22, shin 0.21, spineUp 0.07, shY 0.225, upper 0.16, fore 0.15,
 *  headY 0.265). The 0.07 under the ankle (boot and sole) and the head keep their size. */
function specFor(h: number, shX: number, hipX: number): WorldBipedSpec {
  return { hipY: 0.07 + 0.43 * h, hipX, thigh: 0.22 * h, shin: 0.21 * h, spineUp: 0.07 * h, shY: 0.225 * h, shX, upper: 0.16 * h, fore: 0.15 * h, headY: 0.265 * h };
}

export function bodyShape(a?: Pick<WorldAppearance, "presentation" | "body"> | null): WorldBodyShape {
  const pr = a?.presentation;
  const presentation: Presentation = pr === "feminine" || pr === "masculine" ? pr : "neutral";
  const raw = a ? Math.round(Number(a.body)) : 1;
  const body = (raw >= 0 && raw <= 3 ? raw : 1) as Build;
  const p = PRESETS[presentation], b = BUILDS[body]!;
  const height = p.height * b.h;
  const shoulder = p.shoulder * b.w;
  return {
    presentation, body, shoulder,
    chest: p.chest * b.w,
    waist: p.waist * b.waist,
    hip: p.hip * (b.w + b.waist) / 2,
    depth: p.depth,
    bust: p.bust,
    height,
    limb: p.limb * b.limb,
    neck: p.neck * b.neck,
    jaw: p.jaw * (body === 3 ? 1.04 : body === 0 ? 0.97 : 1),
    spec: specFor(height, shoulder, p.hipX * (1 + b.w) / 2),
  };
}

// ------------------------------------------------------------------------------------------ geometry helpers

/** Parts merged into one non-indexed geometry with position, normal and uv (zeros where a part has none); consumes
 *  the parts. */
function mergeParts(parts: G[]): G {
  const plain = parts.map((g0) => {
    const g = g0.index ? g0.toNonIndexed() : g0;
    if (!g.getAttribute("normal")) g.computeVertexNormals();
    const out = new THREE.BufferGeometry();
    const pos = g.getAttribute("position");
    out.setAttribute("position", pos);
    out.setAttribute("normal", g.getAttribute("normal"));
    const uv: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined = g.getAttribute("uv");
    out.setAttribute("uv", uv ?? new THREE.Float32BufferAttribute(new Float32Array(pos.count * 2), 2));
    if (g !== g0) g0.dispose();
    g.dispose();
    return out;
  });
  const merged = mergeGeometries(plain, false);
  for (const g of plain) g.dispose();
  if (!merged) throw new Error("character kit: parts failed to merge");
  return merged;
}

/** A patch of a sphere in SphereGeometry terms (phi = PI/2 is +Z, theta from the top), segments by its size. */
function shell(r: number, phi0: number, phiLen: number, th0: number, thLen: number, s: number): G {
  const w = Math.max(4, Math.round((s * phiLen) / TAU));
  const h = Math.max(3, Math.round((s * thLen) / Math.PI));
  return new THREE.SphereGeometry(r, w, h, phi0, phiLen, th0, thLen);
}
const crown = (r: number, th: number, s: number): G => shell(r, 0, TAU, 0, th, s);
/** The sides and back below the crown, open over the face. */
const band = (r: number, th0: number, len: number, s: number, open = FACE_OPEN): G => shell(r, Math.PI / 2 + open, TAU - 2 * open, th0, len, s);

function ball(r: number, s: number, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1): G {
  return new THREE.SphereGeometry(r, Math.max(6, s >> 1), Math.max(4, s >> 2)).scale(sx, sy, sz).translate(x, y, z);
}

/** A point on a sphere in SphereGeometry terms. */
function sph(r: number, phi: number, th: number): V3 {
  return new THREE.Vector3(-r * Math.cos(phi) * Math.sin(th), r * Math.cos(th), r * Math.sin(phi) * Math.sin(th));
}

/** phi's angle from the face direction (+Z), -PI..PI. */
function fromFront(phi: number): number {
  let d = (phi - Math.PI / 2) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}
function inFace(phi: number, th: number, open: number, top = FACE_TOP): boolean {
  return th > top && Math.abs(fromFront(phi)) < open;
}

/** Point i of n spread evenly (golden angle) over the band of theta from a to b: [phi, theta]. */
function fibPoint(i: number, n: number, a: number, b: number): [number, number] {
  const ca = Math.cos(a), cb = Math.cos(b);
  return [i * 2.399963229728653, Math.acos(ca + (cb - ca) * ((i + 0.5) / n))];
}

/** A torus of radius `r` (tube `tube`) centered at `at`, its axis along `axis`. */
function ring(r: number, tube: number, s: number, at: V3, axis: V3): G {
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis.clone().normalize());
  return new THREE.TorusGeometry(r, tube, Math.max(4, s >> 2), Math.max(8, s)).applyQuaternion(q).translate(at.x, at.y, at.z);
}

/** A tapered limb (r0 at the top, r1 at the far end) from y = 0 down to y = -len with round ends (soccer core.taper). */
function taper(r0: number, r1: number, len: number, s: number): G {
  const pts: THREE.Vector2[] = [];
  const caps = Math.max(3, s >> 2);
  for (let i = 0; i <= caps; i++) {
    const a = (i / caps) * (Math.PI / 2);
    pts.push(new THREE.Vector2(Math.max(1e-4, Math.sin(a) * r1), -len - Math.cos(a) * r1));
  }
  for (let i = caps; i >= 0; i--) {
    const a = (i / caps) * (Math.PI / 2);
    pts.push(new THREE.Vector2(Math.max(1e-4, Math.sin(a) * r0), Math.cos(a) * r0));
  }
  return new THREE.LatheGeometry(pts, Math.max(6, s >> 1));
}

function tube(pts: V3[], r: number, tubular: number, radial: number, closed = false): G {
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, closed), tubular, r, radial, closed);
}

/** The inside of an open shell: the same surface shrunk by `k` toward the origin, faces turned inward, so looking
 *  through a face opening never shows the background through the far wall. */
function lining(g: G, k: number): G {
  const n = g.clone().scale(k, k, k);
  const flat = n.index ? n.toNonIndexed() : n;
  if (flat !== n) n.dispose();
  for (const name of ["position", "normal", "uv"]) {
    const a = flat.getAttribute(name) as THREE.BufferAttribute | undefined;
    if (!a) continue;
    const arr = a.array, size = a.itemSize;
    for (let i = 0; i + 2 < a.count; i += 3) {
      for (let c = 0; c < size; c++) {
        const p = (i + 1) * size + c, q = (i + 2) * size + c;
        const t = arr[p]!;
        arr[p] = arr[q]!;
        arr[q] = t;
      }
    }
  }
  const nor = flat.getAttribute("normal");
  for (let i = 0; i < nor.count; i++) nor.setXYZ(i, -nor.getX(i), -nor.getY(i), -nor.getZ(i));
  return flat;
}

/** After computeVertexNormals on a surface of revolution: the seam's coincident vertex pairs share one normal again. */
function joinNormals(g: G, pairs: readonly (readonly [number, number])[]): void {
  const nor = g.getAttribute("normal");
  for (const [a, b] of pairs) {
    const x = nor.getX(a) + nor.getX(b), y = nor.getY(a) + nor.getY(b), z = nor.getZ(a) + nor.getZ(b);
    const l = Math.hypot(x, y, z) || 1;
    nor.setXYZ(a, x / l, y / l, z / l);
    nor.setXYZ(b, x / l, y / l, z / l);
  }
}

/** Hair below the jaw sweeps behind the shoulders: narrower and further back the lower it hangs, the more so at the
 *  sides (in place). */
function sweep(v: V3): V3 {
  const t = clamp01((-0.05 - v.y) / 0.15);
  if (t <= 0) return v;
  const side = Math.abs(v.x) / (Math.hypot(v.x, v.z) || 1);
  v.x *= 1 - 0.25 * t;
  v.z -= 0.09 * t * side;
  return v;
}

// ------------------------------------------------------------------------------------------ hair

/** Where strand cards grow: a sphere cap around `c` (theta up to thMax), skipping the face window `open` wide. */
interface Zone { c: V3; r: number; thMax: number; open: number }
/** A strand guide for long hair: points root to tip and the outward normal at each. */
interface Fall { pts: V3[]; nor: V3[] }
interface HairBuild { parts: G[]; zones: Zone[]; falls: Fall[]; cloth: boolean; cardMul: number }
type HairBuilder = (b: HairBuild, lv: 0 | 1 | 2, s: number, safe: boolean, rnd: () => number) => void;

const zone = (r: number, thMax: number, c: V3 = new THREE.Vector3(), open = FACE_OPEN): Zone => ({ c, r, thMax, open });

/** The crown and the band every style starts from (soccer's short hair). Inside CAP_R, so capSafe keeps it. */
function base(b: HairBuild, s: number, r = HAIR_R, crownTh = 0.95, bandLen = 1.05): void {
  b.parts.push(crown(r, crownTh, s), band(r, 0.9, bandLen, s));
}

/** Long hair: the curtain's outer profile (radius, height) in head-center space; the lathe runs round the back. */
const LONG_OPEN = 1.0;
function waveAt(y: number, phiL: number, wave: number): number {
  return wave * 0.05 * clamp01(-y / 0.08) * Math.sin(y * 55 + phiL * 4);
}
/** A point of the curtain surface at radius r, height y and lathe angle phiL (x = r sin, z = r cos). */
function fallAt(r: number, y: number, phiL: number, wave: number): V3 {
  const rr = r * (1 + waveAt(y, phiL, wave));
  return sweep(new THREE.Vector3(rr * Math.sin(phiL), y, rr * Math.cos(phiL)));
}
function profileR(outer: readonly (readonly [number, number])[], y: number): number {
  for (let i = 1; i < outer.length; i++) {
    const [r0, y0] = outer[i - 1]!, [r1, y1] = outer[i]!;
    if (y <= y0 && y >= y1) return lerp(r0, r1, (y0 - y) / (y0 - y1 || 1));
  }
  return y > outer[0]![1] ? outer[0]![0] : outer[outer.length - 1]![0];
}
function curtain(outer: readonly (readonly [number, number])[], thick: number, s: number, wave: number): G {
  // inner wall going down (faces the head), across the bottom, outer wall going up (faces out)
  const prof: THREE.Vector2[] = [];
  for (const [r, y] of outer) prof.push(new THREE.Vector2(r - thick, y));
  for (let i = outer.length - 1; i >= 0; i--) prof.push(new THREE.Vector2(outer[i]![0], outer[i]![1]));
  const g = new THREE.LatheGeometry(prof, Math.max(6, Math.round((s * (TAU - 2 * LONG_OPEN)) / TAU)), LONG_OPEN, TAU - 2 * LONG_OPEN);
  const pos = g.getAttribute("position");
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const v = fallAt(Math.hypot(x, z), y, Math.atan2(x, z), wave);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

function hairFall(b: HairBuild, lv: 0 | 1 | 2, s: number, safe: boolean, rnd: () => number, wavy: boolean): void {
  base(b, s);
  const end = wavy ? -0.23 : -0.21;
  const outer: [number, number][] = [[0.121, 0.02], [0.125, -0.04], [0.128, -0.1], [0.132, -0.16], [wavy ? 0.142 : 0.134, end]];
  const wave = wavy ? (lv ? 1 : 0.6) : 0;
  b.parts.push(curtain(outer, 0.011, s, wave));
  if (lv >= 1) {
    // two locks framing the face, falling in front of the shoulders
    for (const side of [1, -1]) {
      const d = side * (FACE_OPEN + 0.03);
      const pts = [sph(0.12, Math.PI / 2 + d, safe ? 1.34 : 1.0), sph(0.125, Math.PI / 2 + d, 1.75), new THREE.Vector3(side * 0.1, -0.08, 0.05), new THREE.Vector3(side * 0.098, -0.11, 0.045)];
      if (wavy) pts[2]!.x += side * 0.01;
      b.parts.push(tube(pts, 0.016, lv > 1 ? 12 : 8, lv > 1 ? 7 : 5));
    }
  }
  const strand = (phiL: number, lift: number, steps: number): Fall => {
    const pts: V3[] = [], nor: V3[] = [];
    for (let k = 0; k <= steps; k++) {
      const y = lerp(0.0, end + 0.01, k / steps);
      const v = fallAt(profileR(outer, y) + lift, y, phiL, wave);
      pts.push(v);
      nor.push(new THREE.Vector3(v.x, 0, v.z).normalize());
    }
    return { pts, nor };
  };
  if (lv >= 2) {
    // clumps down the back of the curtain
    for (let i = 0; i < 6; i++) {
      const phiL = Math.PI + ((i + 0.5) / 6 - 0.5) * 2.6 + (rnd() - 0.5) * 0.12;
      b.parts.push(tube(strand(phiL, 0.004, 8).pts, 0.009, 12, 5));
    }
  }
  const nf = Math.round(20 * b.cardMul);
  for (let i = 0; i < nf; i++) b.falls.push(strand(LONG_OPEN + 0.05 + (TAU - 2 * LONG_OPEN - 0.1) * ((i + rnd()) / nf), 0.006, 6));
  b.zones.push(zone(HAIR_R, 1.3));
}

const STYLES: Readonly<Record<WorldHairStyle, HairBuilder>> = {
  short(b, lv, s, safe) {
    base(b, s);
    if (lv >= 1 && !safe) {
      for (const k of [-1, 0, 1]) {
        const p = sph(0.104, Math.PI / 2 + k * 0.34, 0.5);
        b.parts.push(ball(0.03, s, p.x, p.y, p.z, 1.5, 0.55, 1.1));
      }
    }
    b.zones.push(zone(HAIR_R, 1.6));
  },

  buzz(b, _lv, s) {
    b.parts.push(crown(0.1142, 1.0, s), band(0.1142, 0.9, 0.95, s));
  },

  curls(b, lv, s, safe) {
    base(b, s, 0.1142, 1.0, 0.9);
    const n = [6, 8, 12][lv]!;
    if (!safe) {
      for (let i = 0; i < n; i++) {
        const p = sph(0.112, (i / n) * TAU, 0.62);
        b.parts.push(ball(0.034, s, p.x, p.y + 0.012, p.z));
      }
      const top: readonly (readonly [number, number])[] = [[0, 0], [0.035, 0.02], [-0.035, -0.02], [0.02, -0.04], [-0.02, 0.04]];
      for (const [x, z] of top.slice(0, [1, 3, 5][lv]!)) b.parts.push(ball(0.036, s, x, 0.122, z));
    } else {
      // a ring of curls springing out under the brim
      const open = FACE_OPEN + 0.2;
      for (let i = 0; i < n; i++) {
        const p = sph(0.112, Math.PI / 2 + open + (TAU - 2 * open) * ((i + 0.5) / n), 1.5);
        b.parts.push(ball(0.03, s, p.x, p.y, p.z));
      }
    }
    b.zones.push(zone(HAIR_R, 1.6));
  },

  coils(b, lv, s, safe) {
    if (!safe) {
      b.parts.push(crown(0.122, 1.05, s), band(0.12, 0.9, 1.0, s));
      const n = [0, 18, 40][lv]!;
      for (let i = 0, k = 0; k < n && i < n * 2; i++) {
        const [phi, th] = fibPoint(i, n * 2, 0, 1.6);
        if (inFace(phi, th, FACE_OPEN, 0.8)) continue;
        const p = sph(0.124, phi, th);
        b.parts.push(ball(0.019, s, p.x, p.y, p.z));
        k++;
      }
      b.zones.push(zone(0.124, 1.55));
    } else {
      base(b, s, HAIR_R, 1.0, 1.0);
      const n = [6, 12, 22][lv]!;
      for (let i = 0, k = 0; k < n && i < n * 3; i++) {
        const [phi, th] = fibPoint(i, n * 3, 1.35, 1.75);
        if (inFace(phi, th, FACE_OPEN + 0.1, 0)) continue;
        const p = sph(0.122, phi, th);
        b.parts.push(ball(0.019, s, p.x, p.y, p.z));
        k++;
      }
      b.zones.push(zone(0.122, 1.8));
    }
  },

  afro(b, lv, s, safe) {
    base(b, s);
    const open = 1.15;
    const c = safe ? new THREE.Vector3(0, 0, -0.01) : new THREE.Vector3(0, 0.022, -0.012);
    const R = safe ? 0.15 : 0.158;
    const sides = safe ? band(R, 1.25, 0.75, s, open) : band(R, 0.85, 1.15, s, open);
    const shells = safe ? [sides] : [shell(R, 0, TAU, 0, 0.85, s), sides];
    for (const g of shells) b.parts.push(g.translate(c.x, c.y, c.z));
    b.parts.push(lining(sides.clone().translate(-c.x, -c.y, -c.z), 0.97).translate(c.x, c.y, c.z));
    const n = safe ? [0, 8, 14][lv]! : [0, 12, 24][lv]!;
    for (let i = 0, k = 0; k < n && i < n * 3; i++) {
      const [phi, th] = safe ? fibPoint(i, n * 3, 1.5, 1.9) : fibPoint(i, n * 3, 0, 1.9);
      if (inFace(phi, th, open + 0.1, safe ? 0 : 0.75)) continue;
      const p = sph(safe ? 0.142 : 0.148, phi, th).add(c);
      b.parts.push(ball(safe ? 0.035 : 0.042, s, p.x, p.y, p.z));
      k++;
    }
    b.zones.push(zone(R, 1.95, c, open));
  },

  puffs(b, lv, s, safe) {
    base(b, s, 0.1142, 1.0, 0.95);
    const r = safe ? 0.045 : 0.052;
    for (const side of [1, -1]) {
      const dir = (safe ? new THREE.Vector3(side * 0.085, -0.035, -0.06) : new THREE.Vector3(side * 0.072, 0.09, -0.025)).normalize();
      const c = dir.clone().multiplyScalar(safe ? 0.13 : 0.152);
      b.parts.push(ball(r, s, c.x, c.y, c.z));
      if (lv >= 1) b.parts.push(ring(r * 0.6, 0.007, s, dir.clone().multiplyScalar(safe ? 0.1 : 0.112), dir));
      if (lv >= 2) {
        for (let i = 0; i < 6; i++) {
          const [phi, th] = fibPoint(i, 6, 0, 2.2);
          const p = sph(r * 0.92, phi, th);
          if (p.dot(dir) < 0) continue; // the side facing the head stays smooth
          p.add(c);
          b.parts.push(ball(0.02, s, p.x, p.y, p.z));
        }
      }
      b.zones.push(zone(r, Math.PI, c, 0));
    }
    if (!safe) b.zones.push(zone(0.1142, 1.0));
  },

  locs(b, lv, s, safe, rnd) {
    base(b, s);
    const n = [8, 14, 22][lv]!, radial = [4, 5, 7][lv]!, tubular = [6, 10, 16][lv]!;
    const open = FACE_OPEN + 0.2, span = TAU - 2 * open;
    for (let i = 0; i < n; i++) {
      const phi = Math.PI / 2 + open + (span * (i + 0.3 + rnd() * 0.4)) / n;
      const th0 = safe ? 1.3 : 0.75 + rnd() * 0.25;
      const yEnd = -0.15 - rnd() * 0.07;
      const exit = sph(0.124, phi, 1.75);
      const pts = [sph(0.121, phi, th0), sph(0.122, phi, (th0 + 1.75) / 2), exit,
        sweep(new THREE.Vector3(exit.x * 1.06, -0.07, exit.z * 1.06)), sweep(new THREE.Vector3(exit.x * 1.1, yEnd, exit.z * 1.1))];
      b.parts.push(tube(pts, 0.0135, tubular, radial));
      if (lv >= 1) { const e = pts[4]!; b.parts.push(ball(0.0145, s, e.x, e.y, e.z)); }
    }
  },

  braids(b, lv, s, safe, rnd) {
    base(b, s, 0.1142, 1.0, 0.95);
    if (!safe && lv >= 1) {
      // cornrows from the hairline over the crown to the nape
      const rows = [0, 5, 7][lv]!;
      const z = new THREE.Vector3(0, 0, 1);
      for (let j = 0; j < rows; j++) {
        const a = (j / (rows - 1) - 0.5) * 1.1;
        const pts: V3[] = [];
        for (let k = 0; k <= 6; k++) {
          const u = lerp(-0.8, 1.5, k / 6);
          pts.push(new THREE.Vector3(0, Math.cos(u), -Math.sin(u)).multiplyScalar(0.1172).applyAxisAngle(z, a));
        }
        b.parts.push(tube(pts, 0.0065, 16, 5));
      }
    }
    const n = [2, 6, 10][lv]!;
    for (let i = 0; i < n; i++) {
      const phi = -Math.PI / 2 + (i / (n - 1) - 0.5) * 2.4 + (rnd() - 0.5) * 0.08;
      const exit = sph(0.118, phi, 1.65);
      const yEnd = -0.19 - rnd() * 0.04;
      const curve = new THREE.CatmullRomCurve3([exit, sweep(new THREE.Vector3(exit.x * 1.08, -0.07, exit.z * 1.08)), sweep(new THREE.Vector3(exit.x * 1.1, yEnd, exit.z * 1.12))]);
      b.parts.push(new THREE.TubeGeometry(curve, lv ? 10 : 6, lv ? 0.011 : 0.016, lv ? 6 : 5, false));
      const m = [0, 6, 9][lv]!;
      for (let k = 0; k < m; k++) {
        const p = curve.getPoint((k + 0.5) / m);
        b.parts.push(ball(0.0145, s, p.x, p.y, p.z, 1, 1.25, 1));
      }
      const e = curve.getPoint(1);
      b.parts.push(ball(0.017, s, e.x, e.y, e.z));
    }
  },

  long(b, lv, s, safe, rnd) { hairFall(b, lv, s, safe, rnd, false); },
  wavy(b, lv, s, safe, rnd) { hairFall(b, lv, s, safe, rnd, true); },

  bob(b, lv, s, safe) {
    const r = 0.1235;
    if (safe) base(b, s, HAIR_R, 0.95, 0.3);
    else b.parts.push(crown(r, 0.95, s));
    const th0 = safe ? CAP_LINE + 0.03 : 0.9;
    const sides = band(r, th0, 2.05 - th0, s);
    // the chin-length ends flare out a little
    const pos = sides.getAttribute("position");
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const th = Math.acos(Math.max(-1, Math.min(1, y / (Math.hypot(x, y, z) || 1))));
      const f = 1 + 0.08 * clamp01((th - 1.6) / 0.45);
      pos.setXYZ(i, x * f, y, z * f);
    }
    sides.computeVertexNormals();
    b.parts.push(sides, lining(sides, 0.965));
    if (lv >= 1 && !safe) b.parts.push(shell(r + 0.004, Math.PI / 2 - 0.95, 1.9, 0.4, 0.68, s));
    b.zones.push(zone(r, 2.0));
  },

  pixie(b, lv, s, safe) {
    b.parts.push(crown(HAIR_R, 0.95, s), band(HAIR_R, 0.9, 0.8, s));
    if (!safe) {
      b.parts.push(ball(0.034, s, 0, 0, 0, 1.9, 0.5, 1.0).rotateZ(-0.35).translate(0.025, 0.09, 0.07));
      if (lv >= 1) b.parts.push(ball(0.024, s, 0, 0, 0, 1.6, 0.5, 1).rotateZ(-0.5).translate(0.065, 0.075, 0.075));
    }
    if (lv >= 1) {
      for (const k of [-1, 0, 1]) {
        const p = sph(0.112, -Math.PI / 2 + k * 0.45, 1.72);
        b.parts.push(new THREE.ConeGeometry(0.014, 0.035, Math.max(5, s >> 2)).rotateX(Math.PI).translate(p.x, p.y - 0.012, p.z));
      }
    }
    b.zones.push(zone(HAIR_R, 1.5));
  },

  bun(b, lv, s, safe) {
    base(b, s);
    const c = safe ? new THREE.Vector3(0, -0.04, -0.118) : new THREE.Vector3(0, 0.078, -0.088);
    const r = safe ? 0.04 : 0.042;
    const dir = c.clone().normalize();
    b.parts.push(ball(r, s, c.x, c.y, c.z));
    if (lv >= 1) b.parts.push(ring(r * 0.98, 0.008, s, c, dir));
    if (lv >= 2) {
      for (let i = 0; i < 8; i++) {
        const [phi, th] = fibPoint(i, 8, 0, Math.PI);
        const p = sph(r * 0.9, phi, th);
        if (p.dot(dir) < 0.005) continue;
        p.add(c);
        b.parts.push(ball(0.018, s, p.x, p.y, p.z));
      }
    }
    b.zones.push(zone(HAIR_R, 1.5), zone(r, Math.PI, c, 0));
  },

  ponytail(b, lv, s, safe, rnd) {
    base(b, s);
    const len = [0.12, 0.16, 0.18][lv]!;
    const at = safe ? new THREE.Vector3(0, -0.035, -0.112) : new THREE.Vector3(0, 0.035, -0.11);
    const tilt = safe ? 0.12 : 0.35;
    b.parts.push(taper(0.026, 0.012, len, s).rotateX(tilt).translate(at.x, at.y, at.z));
    // the tail's axis, root to tip
    const d = new THREE.Vector3(0, -Math.cos(tilt), -Math.sin(tilt));
    if (lv >= 1) b.parts.push(ring(0.026, 0.007, s, at.clone().addScaledVector(d, 0.012), d));
    const e1 = new THREE.Vector3(1, 0, 0), e2 = new THREE.Vector3().crossVectors(d, e1);
    const nf = Math.round(10 * b.cardMul);
    for (let i = 0; i < nf; i++) {
      const a = ((i + rnd() * 0.5) / nf) * TAU;
      const n = e1.clone().multiplyScalar(Math.cos(a)).addScaledVector(e2, Math.sin(a));
      const pts: V3[] = [], nor: V3[] = [];
      for (let k = 0; k <= 5; k++) {
        const t = k / 5;
        pts.push(at.clone().addScaledVector(d, 0.02 + t * (len - 0.02)).addScaledVector(n, lerp(0.026, 0.012, t) + 0.003));
        nor.push(n.clone());
      }
      b.falls.push({ pts, nor });
    }
    b.zones.push(zone(HAIR_R, 1.5));
  },

  headscarf(b, lv, s, safe) {
    // A kerchief tied at the nape: set back from the forehead at the front, down past the ears' tops at the sides and
    // to the nape at the back (a triangle folded over the hair), a rolled hem, folds running back to a knot with two
    // tails. capSafe keeps only what is below the brim: the back of it, the knot and the tails.
    b.cloth = true;
    const r = 0.125;
    const edge = (phi: number): number => 0.62 + 1.28 * Math.pow(Math.abs(fromFront(phi)) / Math.PI, 1.3);
    const th0 = safe ? CAP_LINE + 0.03 : 0;
    // one sphere grid, each column stretched from the top (th0) to the hem at its angle
    const w = Math.max(8, s), h = Math.max(4, Math.round(s * 0.5));
    const scarf = new THREE.SphereGeometry(r, w, h, 0, TAU, 0, 1);
    const pos = scarf.getAttribute("position");
    for (let iy = 0; iy <= h; iy++) {
      for (let ix = 0; ix <= w; ix++) {
        const phi = (ix / w) * TAU;
        const p = sph(r, phi, th0 + (iy / h) * Math.max(0, edge(phi) - th0));
        pos.setXYZ(iy * (w + 1) + ix, p.x, p.y, p.z);
      }
    }
    scarf.computeVertexNormals();
    joinNormals(scarf, Array.from({ length: h + 1 }, (_, iy): [number, number] => [iy * (w + 1), iy * (w + 1) + w]));
    b.parts.push(scarf, lining(scarf, 0.97));
    const knot = sph(r + 0.004, -Math.PI / 2, 1.9);
    for (const sd of [1, -1]) b.parts.push(ball(0.022, s, knot.x + sd * 0.014, knot.y, knot.z, 1.2, 0.9, 0.9));
    if (lv >= 1) {
      for (const sd of [1, -1]) b.parts.push(taper(0.016, 0.01, 0.075, s).scale(1.4, 1, 0.5).rotateX(0.35).rotateZ(sd * 0.3).translate(knot.x + sd * 0.012, knot.y - 0.012, knot.z - 0.008));
      // the rolled hem, round from the knot (t = 0, the back) to the front and back (t = +-1)
      const pts: V3[] = [];
      for (let k = 0; k < (safe ? 25 : 24); k++) { // closed: the last point would repeat the first
        const phi = 1.5 * Math.PI + (k / 24 * 2 - 1) * Math.PI, e = edge(phi);
        if (!safe || e > th0 + 0.08) pts.push(sph(r + 0.002, phi, e));
      }
      if (pts.length >= 2) b.parts.push(tube(pts, 0.007, lv > 1 ? 48 : 28, 5, !safe));
    }
    if (lv >= 2 && !safe) {
      // folds from the front corners over the crown back to the knot
      for (const sd of [1, -1]) {
        for (const off of [1.15, 1.6]) {
          const p0 = Math.PI / 2 + sd * off;
          b.parts.push(tube([sph(r + 0.002, p0, edge(p0) - 0.06), sph(r + 0.003, Math.PI / 2 + sd * (off + 0.9), 1.15), sph(r + 0.003, Math.PI / 2 + sd * (Math.PI - 0.18), 1.78)], 0.0045, 14, 4));
        }
      }
    }
  },

  hijab(b, lv, s, safe) {
    // A fitted wrap: a dome over the crown and the sides, open only round the face, closing under the chin and round
    // the neck, then a cowl that falls over the neck onto the shoulders and the upper chest and back. No brim: the
    // cowl stays inside the shoulders' width (the shirt's shoulder yoke takes it from there).
    b.cloth = true;
    const r = 0.122, open = 0.98;
    if (!safe) b.parts.push(crown(r, 0.9, s));
    const th0 = safe ? CAP_LINE + 0.03 : 0.9;
    const sides = band(r, th0, 2.55 - th0, s, open);
    b.parts.push(sides, lining(sides, 0.97), shell(r, 0, TAU, 2.2, 0.5, s));
    // the cowl: inner wall down, the hem, outer wall up; the lower half falls in soft folds
    const cowl: [number, number][] = [[0.088, -0.07], [0.1, -0.1], [0.115, -0.14], [0.12, -0.19], [0.118, -0.208], [0.128, -0.215], [0.13, -0.19], [0.125, -0.14], [0.11, -0.1], [0.098, -0.07]];
    const segs = Math.max(8, s);
    const drape = new THREE.LatheGeometry(cowl.map(([x, y]) => new THREE.Vector2(x, y)), segs);
    if (lv >= 1) {
      const dp = drape.getAttribute("position");
      for (let i = 0; i < dp.count; i++) {
        const x = dp.getX(i), y = dp.getY(i), z = dp.getZ(i);
        const f = 1 + 0.04 * clamp01((-0.12 - y) / 0.09) * Math.sin(Math.atan2(x, z) * 8);
        dp.setXYZ(i, x * f, y, z * f);
      }
      drape.computeVertexNormals();
      joinNormals(drape, Array.from({ length: cowl.length }, (_, j): [number, number] => [j, segs * cowl.length + j]));
    }
    b.parts.push(drape);
    if (lv >= 1) {
      // a rolled edge round the face opening (only below the brim when capSafe)
      const rr = r + 0.002;
      const pts: V3[] = [];
      const lo = Math.PI / 2 - open, hi = Math.PI / 2 + open;
      if (!safe) for (let k = 0; k <= 4; k++) pts.push(sph(rr, lerp(lo, hi, k / 4), 0.92));
      const top = safe ? CAP_LINE + 0.08 : 1.15;
      for (let k = 0; k <= 4; k++) pts.push(sph(rr, hi, lerp(top, 2.15, k / 4)));
      for (let k = 1; k < 4; k++) pts.push(sph(rr, lerp(hi, lo, k / 4), 2.2));
      for (let k = 0; k <= 4; k++) pts.push(sph(rr, lo, lerp(2.15, top, k / 4)));
      b.parts.push(tube(pts, 0.007, lv > 1 ? 48 : 28, 5, !safe));
    }
    if (lv >= 2) {
      // folds down the cowl from the neck
      for (let i = 0; i < 8; i++) {
        const a = ((i + 0.5) / 8) * TAU;
        const at = (rad: number, y: number): V3 => new THREE.Vector3(Math.sin(a) * rad, y, Math.cos(a) * rad);
        b.parts.push(tube([at(0.103, -0.085), at(0.121, -0.14), at(0.133, -0.2)], 0.004, 10, 4));
      }
    }
  },
};

const ALIASES: Readonly<Record<string, WorldHairStyle>> = {
  tail: "ponytail", pony: "ponytail", curly: "curls", straight: "long", "long-straight": "long", "long-wavy": "wavy", manbun: "bun",
  "man-bun": "bun", topknot: "bun", shaved: "buzz", crop: "short", twists: "locs", dreads: "locs", dreadlocks: "locs",
  cornrows: "braids", scarf: "headscarf", wrap: "headscarf", natural: "afro", "afro-puffs": "puffs",
};

/** A style id from the shared vocabulary; anything else maps to its nearest style (default "short"). */
export function resolveHairStyle(id: string): WorldHairStyle {
  return (HAIR_IDS as readonly string[]).includes(id) ? (id as WorldHairStyle) : ALIASES[id.toLowerCase()] ?? "short";
}

interface CardBuf { pos: number[]; nor: number[]; uv: number[]; idx: number[] }

/** A ribbon through `pts`, lying across the surface (`nor` is the surface normal at each point), w0 wide at the root
 *  tapering to w1. uv: u across, v root to tip. */
function ribbon(out: CardBuf, pts: readonly V3[], nor: readonly V3[], w0: number, w1: number): void {
  const n = pts.length;
  const first = out.pos.length / 3;
  const t = new THREE.Vector3(), side = new THREE.Vector3();
  for (let k = 0; k < n; k++) {
    t.subVectors(pts[Math.min(k + 1, n - 1)]!, pts[Math.max(k - 1, 0)]!).normalize();
    side.crossVectors(t, nor[k]!).normalize();
    const w = lerp(w0, w1, k / (n - 1)) / 2, p = pts[k]!, m = nor[k]!, v = k / (n - 1);
    out.pos.push(p.x - side.x * w, p.y - side.y * w, p.z - side.z * w, p.x + side.x * w, p.y + side.y * w, p.z + side.z * w);
    out.nor.push(m.x, m.y, m.z, m.x, m.y, m.z);
    out.uv.push(0, v, 1, v);
  }
  for (let k = 0; k < n - 1; k++) {
    const a = first + k * 2;
    out.idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
}

/** Strand cards: short tufts flowing down and back over each zone, plus the long-hair guides. */
function buildCards(b: HairBuild, safe: boolean, rnd: () => number): G | null {
  if (!b.cardMul || (!b.zones.length && !b.falls.length)) return null;
  const out: CardBuf = { pos: [], nor: [], uv: [], idx: [] };
  // combed back and down: over the crown the tufts run toward the nape, never forward over the face
  const flow = new THREE.Vector3(0, -0.35, -1).normalize();
  const weight = (z: Zone): number => z.r * z.r * (1 - Math.cos(z.thMax));
  const total = b.zones.reduce((a, z) => a + weight(z), 0) || 1;
  for (const z of b.zones) {
    const m = Math.max(4, Math.round((36 * b.cardMul * weight(z)) / total));
    const tries = m * 6;
    for (let i = 0, placed = 0; i < tries && placed < m; i++) {
      const [phi, th] = fibPoint(i, tries, 0, z.thMax);
      if (z.open > 0 && inFace(phi, th, z.open)) continue;
      const dir = sph(1, phi, th);
      const root = z.c.clone().addScaledVector(dir, z.r + 0.002);
      // capSafe: only roots well under the brim
      if (safe && Math.acos(Math.max(-1, Math.min(1, root.y / (root.length() || 1)))) < CAP_LINE + 0.15) continue;
      const t = flow.clone().addScaledVector(dir, -flow.dot(dir));
      if (t.lengthSq() < 1e-6) t.set(0, -1, 0).addScaledVector(dir, dir.y);
      t.normalize();
      const arc = (0.035 + rnd() * 0.02) / z.r;
      const pts: V3[] = [], nor: V3[] = [];
      for (let k = 0; k <= 3; k++) {
        const d = dir.clone().addScaledVector(t, (arc * k) / 3).normalize();
        pts.push(z.c.clone().addScaledVector(d, z.r + 0.002 + 0.0012 * k));
        nor.push(d);
      }
      ribbon(out, pts, nor, 0.016, 0.004);
      placed++;
    }
  }
  for (const f of b.falls) ribbon(out, f.pts, f.nor, 0.02, 0.006);
  if (!out.idx.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(out.pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(out.nor, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(out.uv, 2));
  g.setIndex(out.idx);
  return g;
}

export function hair(style: string, o: WorldHairOptions = {}): WorldHair {
  const id = resolveHairStyle(String(style));
  const safe = !!o.capSafe;
  const b: HairBuild = { parts: [], zones: [], falls: [], cloth: false, cardMul: cardMulOf(o.tier, o.flat) };
  const rnd = random((o.seed ?? 0x5eed) ^ (HAIR_IDS.indexOf(id) + 1) * 0x9e37);
  STYLES[id](b, levelOf(o.tier), segOf(o.tier, o.flat), safe, rnd);
  const geometry = mergeParts(b.parts);
  const cards = b.cloth ? null : buildCards(b, safe, rnd);
  const k = o.headRadius !== undefined && o.headRadius > 0 ? o.headRadius / HEAD_R : 1;
  if (k !== 1) {
    geometry.scale(k, k, k);
    cards?.scale(k, k, k);
  }
  return { style: id, geometry, cards, cloth: b.cloth, dispose() { geometry.dispose(); cards?.dispose(); } };
}

// ------------------------------------------------------------------------------------------ sleeves and torso

export function sleeve(o: WorldSleeveOptions): WorldSleeve {
  const s = segOf(o.tier, o.flat);
  const rows = Math.max(6, Math.round(s * 0.6));
  const sp = o.shape?.spec;
  const limb = o.shape?.limb ?? 1;
  // The arm wears its ink hull (pushed out along the normals in object space), and a pack scales the capsule by the
  // limb scale, often in x and z only (soccer does): the round top then keeps its unscaled radius in y. So the hull's
  // round top is a half-ellipsoid on the joint, rxz wide and ry tall (with a 0.002 clearance each).
  const ink = Math.max(0, o.ink ?? INK_FLAT);
  const upperHull = (o.armRadius ?? ARM.upperR) + ink, foreHull = (o.foreRadius ?? ARM.foreR) + ink;
  const grow = Math.max(1, limb);
  const rxz = upperHull * limb + 0.002, ry = upperHull * grow + 0.002;
  // the meshes are polygons: an s-sided ring holds a circle of its radius times cos(PI/s), a sphere of s x rows
  // segments a sphere of its radius times cos(PI/s) cos(PI/(2 rows)) (scaled, an ellipsoid likewise), so the radii
  // grow by that much
  const pw = 1 / Math.cos(Math.PI / s), ps = pw / Math.cos(Math.PI / (2 * rows));
  // The cap rides the shoulder joint and only has to hold that round top: a lens 0.7 as tall as the top and 1.12 as
  // wide, centered 0.3 of the top's height above the joint, so it rises no higher than the arm already did and reads
  // as the shirt's shoulder, not a puff. In units of (rxz, ry) a point of the half-sphere at cos(phi) = u is inside
  // when (1 - u^2) / 1.12^2 + (u - 0.3)^2 / 0.7^2 <= 1; that is convex in u, so its maximum over [0, 1] sits at an
  // end: 0.98 at u = 0 (the rim) and exactly 1 at u = 1 (the top, then held by the clearance). The ellipsoid is
  // convex and holds the joint, so it holds the whole round top.
  const capA = 1.12 * rxz * ps, capB = 0.7 * ry * ps, capC = 0.3 * ry;
  const cap = new THREE.SphereGeometry(1, s, rows).scale(capA, capB, capA).translate(0, capC, 0);
  const top = capC + capB;
  const tubeR = (upperHull * limb + 0.004) * pw;
  // the sleeve starts inside the cap's cross-section at the joint (a short taper out of the lens), still wider than
  // the hull's shaft: 1.12 sqrt(1 - (0.3 / 0.7)^2) = 1.012 times rxz, times ps, over pw
  const tubeTop = Math.min(tubeR, capA * Math.sqrt(1 - (capC / capB) ** 2));
  let upper: G, fore: G | null = null, hem: number;
  if (o.length === "long") {
    const elbow = sp?.upper ?? 0.16;
    // Capped at both ends: inner faces are culled, so an open end with any sliver between it and the next part (the
    // lens is a polygon a little inside its curve) lets the arm show through at a slant. The elbow ball also swallows
    // the bottom rim whole: its polygon holds a sphere 0.0005 wider than the rim, so no gap opens at any bend.
    upper = new THREE.CylinderGeometry(tubeTop, tubeR - 0.002, elbow, s, 1, false).translate(0, -elbow / 2, 0);
    const elbowR = Math.max((foreHull * grow + 0.002) * ps, (tubeR - 0.002 + 0.0005) * ps);
    hem = -((sp?.fore ?? 0.15) - 0.022);
    fore = mergeParts([new THREE.SphereGeometry(elbowR, s, rows), new THREE.CylinderGeometry(elbowR, (foreHull * limb + 0.003) * pw, -hem, s, 1, false).translate(0, hem / 2, 0)]);
  } else {
    hem = -0.085 * (o.shape?.height ?? 1);
    upper = new THREE.CylinderGeometry(tubeTop, tubeR + 0.004, -hem, s, 1, false).translate(0, hem / 2, 0);
  }
  return { cap, upper, fore, top, hem, dispose() { cap.dispose(); upper.dispose(); fore?.dispose(); } };
}

/** Per ring of the template lathe: how much wider than soccer's player this shape is there. */
function torsoFactors(sh: WorldBodyShape): number[] {
  const hip = sh.hip / TEMPLATE.hip, waist = sh.waist / TEMPLATE.waist, chest = sh.chest / TEMPLATE.chest;
  const shoulder = sh.shoulder / TEMPLATE.shoulder, neck = sh.neck / TEMPLATE.neck;
  return [hip, lerp(hip, waist, 0.5), waist, waist, lerp(waist, chest, 0.35), lerp(waist, chest, 0.7), chest, chest,
    lerp(chest, shoulder, 0.3), lerp(chest, shoulder, 0.7), lerp(shoulder, neck, 0.5), neck];
}

export function torso(o: WorldTorsoOptions): G {
  const sh = o.shape, s = segOf(o.tier, o.flat);
  const f = torsoFactors(sh);
  const pts = TORSO_RADII.map((r, i) => new THREE.Vector2(r * f[i]!, TORSO_HEIGHTS[i]! * sh.height));
  // soccer's seam: phiStart PI/2 puts u = 0 at the figure's left side
  const g = new THREE.LatheGeometry(pts, s, Math.PI / 2, TAU);
  const pos = g.getAttribute("position"), np = pts.length;
  // The shoulder yoke: the two rings over the shoulders reach out sideways toward the shoulder joints (0.92 and 0.7 of
  // their distance), weighted by sin^2 of the angle so the chest and back keep their line. The shirt then slopes from
  // the neck onto the sleeve caps and the caps sit in the shoulder line instead of beside it.
  const reach = new Map<number, number>([[9, 0.92 * sh.shoulder], [10, 0.7 * sh.shoulder]]);
  const yc = 0.15 * sh.height;
  for (let i = 0; i < pos.count; i++) {
    const j = i % np, r = pts[j]!.x;
    let x = pos.getX(i), z = pos.getZ(i);
    const want = reach.get(j);
    if (want !== undefined && want > r) x *= 1 + (want / r - 1) * (x / r) ** 2;
    if (sh.bust > 0 && z > 0) {
      const fr = z / (Math.hypot(pos.getX(i), z) || 1);
      z += sh.bust * 0.02 * Math.exp(-(((pos.getY(i) - yc) / 0.045) ** 2)) * fr * fr;
    }
    pos.setXYZ(i, x, pos.getY(i), z);
  }
  g.computeVertexNormals();
  // the seam's two columns (first and last) share their normals again
  joinNormals(g, Array.from({ length: np }, (_, j): [number, number] => [j, s * np + j]));
  return g.scale(1, 1, sh.depth);
}

// ------------------------------------------------------------------------------------------ faces

const INK = "#16141c";
const LIP = "#b8475f";
const BLUSH = "#ff6f7d";

function rgbOf(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  const v = m ? parseInt(m[1]!, 16) : 0x808080;
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
function hexOf(r: number, g: number, b: number): string {
  const c = (x: number): string => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}
function mixHex(a: string, b: string, t: number): string {
  const p = rgbOf(a), q = rgbOf(b);
  return hexOf(lerp(p[0], q[0], t), lerp(p[1], q[1], t), lerp(p[2], q[2], t));
}
function rgba(hex: string, a: number): string {
  const [r, g, b] = rgbOf(hex);
  return `rgba(${r},${g},${b},${a})`;
}
/** Brows follow natural hair (darker for blonde and platinum); fashion colors (blue, pink, green...) get a natural
 *  dark brown. Natural hair runs red >= green >= blue. */
function browColorFor(hairColor: string): string {
  const [r, g, b] = rgbOf(hairColor);
  if (!(r >= g && g >= b)) return "#3b2a20";
  const luma = 0.299 * r + 0.587 * g + 0.114 * b;
  return mixHex(hairColor, "#000000", luma > 150 ? 0.4 : 0.1);
}

const NEUTRAL_LASHES: readonly (0 | 1)[] = [1, 0, 1, 1, 0, 1, 0, 1];

export function faceFeatures(a: WorldAppearance | null | undefined, o: WorldFaceOptions = {}): WorldFaceFeatures {
  const p: Presentation = a?.presentation ?? "neutral";
  const v = ((Math.round(a?.face ?? 0) % 8) + 8) % 8;
  const skin = a?.skin ?? "#d39d74", hairColor = a?.hairColor ?? "#2e1f16";
  const fem = p === "feminine", masc = p === "masculine";
  const lashes: 0 | 1 | 2 = fem ? (v === 7 ? 1 : 2) : masc ? (v === 5 ? 1 : 0) : NEUTRAL_LASHES[v]!;
  const glasses = o.glasses === false ? null
    : typeof o.glasses === "string" ? o.glasses
    : o.glasses === true || v === 4 || v === 7 ? (v === 7 ? "#8a5a2b" : "#2a2230") : null;
  return {
    lashes,
    browColor: browColorFor(hairColor),
    browWidth: (fem ? 3.6 : masc ? 5.6 : 4.6) + (v % 3) * (masc ? 0.6 : 0.5),
    browArch: (fem ? 4 : masc ? 0.5 : 2.5) + (v & 1) * (fem ? 2 : 1),
    lipTint: fem ? (v === 5 ? null : mixHex(skin, LIP, 0.45)) : !masc && (v === 2 || v === 6) ? mixHex(skin, LIP, 0.25) : null,
    freckles: v === 2 || v === 6,
    blush: fem ? mixHex(skin, BLUSH, 0.55) : !masc && (v & 1) ? mixHex(skin, BLUSH, 0.4) : null,
    glasses,
    beard: o.beard ?? "none",
  };
}

export function face(a: WorldAppearance | null | undefined, o: WorldFaceOptions = {}): WorldFacePainter {
  const f = faceFeatures(a, o);
  const L = { w: o.width ?? 256, h: o.height ?? 168, eyeY: o.eyeY ?? 72, eyeDX: o.eyeDX ?? 46, mouthY: o.mouthY ?? 128, eyeW: o.eyeW ?? 11, eyeH: o.eyeH ?? 16 };
  const skin = a?.skin ?? "#d39d74", hairColor = a?.hairColor ?? "#2e1f16";
  const beardC = mixHex(hairColor, "#000000", 0.15);
  const variant = ((Math.round(a?.face ?? 0) % 8) + 8) % 8;
  const begin = (g: CanvasRenderingContext2D, scale: number): void => {
    g.save();
    g.setTransform(scale, 0, 0, scale, 0, 0);
    g.lineCap = "round";
    g.lineJoin = "round";
  };

  const beard = (g: CanvasRenderingContext2D): void => {
    const cx = L.w / 2, my = L.mouthY;
    if (f.beard === "stubble") {
      const grd = g.createLinearGradient(0, my - 24, 0, L.h);
      grd.addColorStop(0, rgba(beardC, 0));
      grd.addColorStop(0.35, rgba(beardC, 0.16));
      grd.addColorStop(1, rgba(beardC, 0.26));
      g.fillStyle = grd;
      g.fillRect(40, my - 24, L.w - 80, L.h - my + 24);
      return;
    }
    if (f.beard !== "short" && f.beard !== "full") return;
    const full = f.beard === "full";
    const top = my - (full ? 34 : 28), wide = full ? 92 : 84;
    g.fillStyle = beardC;
    g.globalAlpha = full ? 0.95 : 0.8;
    g.beginPath();
    g.moveTo(cx - wide, top);
    g.quadraticCurveTo(cx - wide + 4, L.h + 6, cx, L.h + 6);
    g.quadraticCurveTo(cx + wide - 4, L.h + 6, cx + wide, top);
    g.lineTo(cx + wide - 14, top);
    g.quadraticCurveTo(cx + wide - 22, my + (full ? 6 : 18), cx, my + (full ? 10 : 20));
    g.quadraticCurveTo(cx - wide + 22, my + (full ? 6 : 18), cx - wide + 14, top);
    g.closePath();
    g.fill();
    g.globalAlpha = 1;
  };

  const lashes = (g: CanvasRenderingContext2D, x: number, side: number, st: WorldFaceState): void => {
    if (!f.lashes) return;
    const blink = st.blink ?? 0;
    g.strokeStyle = INK;
    if (blink >= 2 || st.smile) {
      // shut or smiling: lashes flick off the outer end of the lid line
      const y = st.smile ? L.eyeY + 4 : L.eyeY + 2, ex = x + side * (L.eyeW + 2);
      g.lineWidth = 2.4;
      for (let k = 0; k < f.lashes; k++) {
        g.beginPath();
        g.moveTo(ex - side * k * 5, y);
        g.lineTo(ex - side * k * 5 + side * 5, y + (st.smile ? -4 : 4));
        g.stroke();
      }
      return;
    }
    const open = blink === 1 ? 0.45 : 1;
    const cy = L.eyeY + 1, rx = L.eyeW + 0.5, ry = L.eyeH * open + 0.5;
    if (f.lashes === 2) {
      g.lineWidth = 3;
      g.beginPath();
      g.ellipse(x, cy, rx, ry, 0, Math.PI * 1.08, Math.PI * 1.92);
      g.stroke();
    }
    g.lineWidth = 2.2;
    for (const t of f.lashes === 2 ? [0.2, 0.5, 0.8] : [0.3, 0.65]) {
      const px = x + side * rx * Math.cos(t), py = cy - ry * Math.sin(t);
      g.beginPath();
      g.moveTo(px, py);
      g.lineTo(px + side * (3 + 3 * Math.cos(t)), py - 3 - 2 * Math.sin(t));
      g.stroke();
    }
  };

  const brow = (g: CanvasRenderingContext2D, x: number, side: number, st: WorldFaceState): void => {
    const lift = st.browLift ?? 0, tilt = st.browTilt ?? 0;
    const y = L.eyeY - 27 - lift;
    g.strokeStyle = f.browColor;
    g.lineWidth = f.browWidth;
    g.beginPath();
    g.moveTo(x - side * 14, y - tilt);
    g.quadraticCurveTo(x, y - 2 - f.browArch - tilt * 0.3, x + side * 16, y + 2);
    g.stroke();
  };

  return {
    features: f,
    under(g, scale, st = {}) {
      begin(g, scale);
      const cx = L.w / 2, cheekY = L.mouthY - 18;
      if (f.blush) {
        for (const side of [-1, 1]) {
          const x = cx + side * 60;
          const grd = g.createRadialGradient(x, cheekY, 2, x, cheekY, 24);
          grd.addColorStop(0, rgba(f.blush, 0.55));
          grd.addColorStop(1, rgba(f.blush, 0));
          g.fillStyle = grd;
          g.fillRect(x - 26, cheekY - 26, 52, 52);
        }
      }
      if (f.freckles) {
        g.fillStyle = rgba(mixHex(skin, "#3a1d10", 0.4), 0.6);
        const n = 4 + (variant >> 1);
        for (const side of [-1, 1]) {
          for (let i = 0; i < n; i++) {
            g.beginPath();
            g.arc(cx + side * (44 + i * 6), cheekY - 6 + ((i * 7) % 3) * 4, 1.9, 0, TAU);
            g.fill();
          }
          g.beginPath();
          g.arc(cx + side * 8, cheekY - 12, 1.6, 0, TAU);
          g.fill();
        }
      }
      beard(g);
      if (f.lipTint && !st.mouthOpen) {
        g.fillStyle = rgba(f.lipTint, 0.85);
        g.beginPath();
        g.ellipse(cx, L.mouthY + 4, 13, 5, 0, 0, TAU);
        g.fill();
      }
      g.restore();
    },
    over(g, scale, st = {}) {
      begin(g, scale);
      const cx = L.w / 2;
      for (const side of [-1, 1]) {
        const x = cx + side * L.eyeDX;
        lashes(g, x, side, st);
        brow(g, x, side, st);
      }
      if (f.glasses) {
        g.strokeStyle = f.glasses;
        g.lineWidth = 4;
        for (const side of [-1, 1]) {
          const x = cx + side * L.eyeDX;
          g.beginPath();
          g.roundRect(x - 21, L.eyeY - 17, 42, 34, 9);
          g.fillStyle = "rgba(200,230,255,0.18)";
          g.fill();
          g.stroke();
        }
        g.beginPath();
        g.moveTo(cx - L.eyeDX + 21, L.eyeY - 4);
        g.quadraticCurveTo(cx, L.eyeY - 10, cx + L.eyeDX - 21, L.eyeY - 4);
        g.stroke();
      }
      if (f.beard === "mustache" || f.beard === "full") {
        const y = L.mouthY - 9;
        g.fillStyle = beardC;
        g.beginPath();
        g.moveTo(cx, y - 2);
        g.quadraticCurveTo(cx + 16, y - 9, cx + 26, y + 4);
        g.quadraticCurveTo(cx + 14, y + 1, cx, y + 4);
        g.quadraticCurveTo(cx - 14, y + 1, cx - 26, y + 4);
        g.quadraticCurveTo(cx - 16, y - 9, cx, y - 2);
        g.closePath();
        g.fill();
      }
      g.restore();
    },
  };
}

/** WorldKit.character. */
export const character: WorldCharacterKit = Object.freeze({
  HAIR_STYLES: HAIR_IDS,
  HEAD_RADIUS: HEAD_R,
  HAIR_RADIUS: HAIR_R,
  CAP_LINE,
  CAP_RADIUS: CAP_R,
  TORSO_HEIGHTS,
  bodyShape,
  hair,
  sleeve,
  torso,
  face,
});
