// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_anime.ts - P-VIZ.3 (ADR-0624): the anime mini Lucid (option B, the ninja mask).
//
// The approved anime lab model, ported faithfully: a sleeveless gi with sculpted arms, baggy gi pants, sculpted
// hair spikes (bent tapered tubes merged into one mesh), a mask fitted to the jaw, toon shading (MeshToonMaterial
// over a stepped gradient) and an inverted-hull ink outline. Emotion and effort live in the EYES: the eye band is
// a canvas texture drawn from an Emotion (lid shape, slant, squint, pupil size, brows, a sweat drop), redrawn only
// when the emotion, the blink step or the gaze bucket changes (viz_anime_pose.eyeKey).
//
// Style: 3D = 3 toon steps and a 0.013 ink; flat (the 2D map) = 2 toon steps and a 0.024 ink. The figure's
// materials skip tone mapping, like the lab render, so the persona neon never turns pastel under ACES.
//
// Animation: keyframe clips from viz_anime_pose (smooth eases for flow, an ease-out-back snap for strikes),
// blended on every activity, state or one-shot change, with procedural layers on top (breathing, a head bob,
// typing taps, the meditation float, the headband tails' sway, a shake). Effects: the holo keyboard (typing),
// the ki ball (kiblast), a ground ring (meditate), speed streaks (dash), the aura flames and glowing hair (the
// powerup burst) and rising smoke (killed). Geometry is shared per detail tier (ref-counted); materials and the
// eye canvas texture are per figure and freed by dispose(). update() allocates nothing.

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  animeLook, auraLevel, BLINK_LEVELS, blinkStep, clipDone, clipFor, CLIPS, clipTime, dashSpeed, EMOTIONS, eyeKey, fract, gazeBucket,
  gazeOfBucket, jointOffset, JOINTS, kiBallAt, nextBlinkDelay, POSE_LEN, sampleClip, shakeLevel, stateEmotion, STILL_T, tapCurve, tempoFor,
  transitionShot, ANIME_STATES, type AnimeState, type ClipName, type ClipSample, type Emotion, type KiBall, type ShotName,
} from "./viz_anime_pose.ts";
import { MINI_ACTIVITIES, type MiniActivity, type MiniLook } from "./viz_mini_look.ts";

export type { AnimeState } from "./viz_anime_pose.ts";
export type AnimeDetail = "full" | "reduced" | "minimal";

export interface AnimeFigure {
  /** Feet at the origin, about ANIME_HEIGHT world units tall, facing +Z. Add it to any parent. */
  readonly group: THREE.Group;
  setActivity(a: MiniActivity): void;
  setIntensity(x: number): void;
  setState(s: AnimeState): void;
  /** A token surge: the powerup one-shot (aura, glowing hair, strain eyes, a short shake). */
  burst(): void;
  setLook(l: MiniLook): void;
  update(tSec: number, dt: number, motion: boolean): void;
  dispose(): void;
}

/** The lab model is about 2.5 units from the boots to the hair tips; the scene wants about 1.1. */
export const ANIME_SCALE = 0.44;
export const ANIME_HEIGHT = 1.1;

const TAU = Math.PI * 2;
const BLEND_S = 0.35;
const SNAP_BLEND_S = 0.1;
/** Effects fade in and out over this long. */
const FX_S = 0.25;
/** How far the fired ki ball flies (lab units). */
const KI_RANGE = 1.0;
const INK_3D = 0.013;
const INK_FLAT = 0.024;

// ------------------------------------------------------------------------------------------ eye band

const EB_W = 768, EB_H = 168;
const INK = "#0a0a12";
interface EyePaint { skin: string; eye: string; eyeLight: string }

/** The eye band texture: skin, two anime eyes, brows and an effort sweat drop, all from one Emotion. Drawn in
 *  the lab's 768 x 168 units; `scale` maps them onto a smaller canvas. */
function drawEyeBand(ctx: CanvasRenderingContext2D, p: EyePaint, emo: Emotion, blink: number, gaze: number, scale: number): void {
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, EB_W, EB_H);
  // skin with a soft side fade so the band melts into the head sphere
  const fade = ctx.createLinearGradient(0, 0, EB_W, 0);
  fade.addColorStop(0, "rgba(0,0,0,0)");
  fade.addColorStop(0.2, p.skin);
  fade.addColorStop(0.8, p.skin);
  fade.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = fade;
  ctx.fillRect(0, 0, EB_W, EB_H);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (let side = -1; side <= 1; side += 2) {
    const cx = EB_W / 2 + side * 138, cy = 104;
    const w = 150, inner = -side; // +x toward the nose for the left eye
    const slantY = emo.slant * 30; // the inner corner drops by this much
    const ox = cx - (inner * w) / 2, ix = cx + (inner * w) / 2; // outer and inner corner x
    const oy = cy - 2, iy = cy + slantY * 0.6;
    if (emo.shape === "x") {
      ctx.strokeStyle = INK; ctx.lineWidth = 9;
      ctx.beginPath(); ctx.moveTo(cx - 30, cy - 26); ctx.lineTo(cx + 30, cy + 22); ctx.moveTo(cx + 30, cy - 26); ctx.lineTo(cx - 30, cy + 22); ctx.stroke();
    } else if (emo.shape === "happy") {
      ctx.strokeStyle = INK; ctx.lineWidth = 10;
      ctx.beginPath(); ctx.moveTo(cx - 40, cy + 10); ctx.quadraticCurveTo(cx, cy - 34, cx + 40, cy + 10); ctx.stroke();
    } else if (emo.shape === "closed") {
      ctx.strokeStyle = INK; ctx.lineWidth = 8;
      ctx.beginPath(); ctx.moveTo(cx - 42, cy - 4); ctx.quadraticCurveTo(cx, cy + 20, cx + 42, cy - 4); ctx.stroke();
      ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(ox - inner * 4, cy - 6); ctx.lineTo(ox - inner * 16, cy - 12); ctx.stroke(); // lash flick
    } else if (emo.shape === "strain") {
      // > <  squeezed shut with effort
      ctx.strokeStyle = INK; ctx.lineWidth = 10;
      ctx.beginPath(); ctx.moveTo(ox, cy - 26); ctx.lineTo(ix - inner * 6, cy - 2); ctx.lineTo(ox, cy + 20); ctx.stroke();
    } else {
      const open = Math.max(0.04, emo.open * (1 - blink));
      const h = 92 * open;
      const top = cy - h * 0.62, bot = cy + h * 0.38 - emo.lower * 14;
      // the almond: the upper lid arcs high toward the outer side (anime), the lower lid gentle
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(ox, oy);
      ctx.bezierCurveTo(ox + inner * w * 0.15, top - 4, ix - inner * w * 0.35, top + slantY * 0.9, ix, iy);
      ctx.bezierCurveTo(ix - inner * w * 0.3, bot + 4, ox + inner * w * 0.25, bot + 2, ox, oy);
      ctx.clip();
      ctx.fillStyle = "#ffffff"; ctx.fillRect(cx - 100, cy - 100, 200, 200);
      // iris: a tall ellipse, darker at the top (lid shadow), the pupil, two highlights
      const ix0 = cx + gaze * 12 + inner * 6, iy0 = cy + 4;
      const ir = 36, irh = 50;
      const g = ctx.createLinearGradient(0, iy0 - irh, 0, iy0 + irh);
      g.addColorStop(0, "#0b1220"); g.addColorStop(0.45, p.eye); g.addColorStop(1, p.eyeLight);
      ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(ix0, iy0, ir, irh, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = "#05060a"; ctx.beginPath(); ctx.ellipse(ix0, iy0 + 3, 15 * emo.pupil, 23 * emo.pupil, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = "#ffffff"; ctx.beginPath(); ctx.ellipse(ix0 - 12, iy0 - 19, 11, 14, -0.4, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.arc(ix0 + 13, iy0 + 20, 5.5, 0, TAU); ctx.fill();
      // the upper lid's shadow on the white
      ctx.fillStyle = "rgba(40,50,80,0.28)";
      ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(ix, iy); ctx.lineTo(ix, iy - 40); ctx.lineTo(ox, oy - 40); ctx.closePath(); ctx.fill();
      ctx.restore();
      // ink: a heavy upper lash line with an outer wing, a light lower lid
      ctx.strokeStyle = INK; ctx.lineWidth = 9;
      ctx.beginPath(); ctx.moveTo(ox - inner * 8, oy - 8); ctx.bezierCurveTo(ox + inner * w * 0.15, top - 4, ix - inner * w * 0.35, top + slantY * 0.9, ix, iy); ctx.stroke();
      ctx.lineWidth = 3.5;
      ctx.beginPath(); ctx.moveTo(ox + inner * 8, oy + 6); ctx.bezierCurveTo(ox + inner * w * 0.3, bot + 2, ix - inner * w * 0.3, bot + 4, ix - inner * 6, iy + 2); ctx.stroke();
    }
    // brow: the angle is the emotion (positive pulls the inner end down: effort and anger read)
    const by = 30 - emo.browY * 30;
    ctx.save(); ctx.translate(cx + inner * 6, by); ctx.rotate(inner * emo.brow * 0.5);
    ctx.fillStyle = INK;
    ctx.beginPath(); ctx.moveTo(-74 * inner, 6); ctx.quadraticCurveTo(0, -12, 66 * inner, 2); ctx.lineTo(66 * inner, 15); ctx.quadraticCurveTo(0, 3, -74 * inner, 14); ctx.closePath(); ctx.fill();
    ctx.restore();
  }
  if (emo.sweat) {
    const sx = EB_W / 2 + 205, sy = 52;
    ctx.fillStyle = "#bfe7ff"; ctx.strokeStyle = "#2a5d86"; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(sx, sy - 22); ctx.quadraticCurveTo(sx + 14, sy + 2, sx, sy + 12); ctx.quadraticCurveTo(sx - 14, sy + 2, sx, sy - 22); ctx.fill(); ctx.stroke();
  }
}

// ------------------------------------------------------------------------------------------ shading

/** Stepped toon ramps, shared by every figure (2 steps flat, 3 in 3D). */
const GRADS = new Map<number, THREE.DataTexture>();
function toonGrad(steps: 2 | 3): THREE.DataTexture {
  let tex = GRADS.get(steps);
  if (tex) return tex;
  const tones = steps === 2 ? [120, 255] : [80, 175, 255];
  const data = new Uint8Array(tones.length * 4);
  tones.forEach((t, i) => { data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = t; data[i * 4 + 3] = 255; });
  tex = new THREE.DataTexture(data, tones.length, 1, THREE.RGBAFormat);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  GRADS.set(steps, tex);
  return tex;
}

/** Inverted-hull ink: the back faces pushed out along the normals by `width` (object space). */
function inkMat(width: number): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ color: 0x0a0a12, side: THREE.BackSide, toneMapped: false });
  m.onBeforeCompile = (s) => {
    s.uniforms.uW = { value: width };
    s.vertexShader = "uniform float uW;\n" + s.vertexShader.replace("#include <begin_vertex>", "vec3 transformed = position + normal * uW;");
  };
  m.customProgramCacheKey = () => `anime-ink-${width}`;
  return m;
}

const AURA_VS = "varying vec2 vUv; varying vec3 vN; varying vec3 vV; void main(){ vUv=uv; vN=normalize(normalMatrix*normal); vec4 mv=modelViewMatrix*vec4(position,1.); vV=normalize(-mv.xyz); gl_Position=projectionMatrix*mv; }";
const AURA_FS = "uniform vec3 uC; uniform float uT; uniform float uA; varying vec2 vUv; varying vec3 vN; varying vec3 vV;\n" +
  "float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);} float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y);}\n" +
  "void main(){ float flame = n(vec2(vUv.x*14., vUv.y*3.-uT*2.))*0.7+n(vec2(vUv.x*30., vUv.y*6.-uT*3.))*0.3; float up = smoothstep(0.,0.15,vUv.y)*(1.-smoothstep(0.35,1.,vUv.y)); float tongue = step(vUv.y*0.9, flame*1.1); float rim = pow(1.-abs(dot(vN,vV)),1.6); float a = up*tongue*(0.08+rim*0.95)*uA; vec3 c = mix(uC, vec3(1.), rim*0.5*flame); gl_FragColor=vec4(c*a*1.4, a); }";

// ------------------------------------------------------------------------------------------ detail tiers

type Seg = readonly [number, number];
interface Tier {
  pelvis: Seg; knot: Seg; trap: Seg; head: Seg; ear: Seg | null; mask: Seg; band: Seg; hairCap: Seg; deltoid: Seg; ki: Seg; smoke: Seg;
  torso: number; neck: number; upperArm: number; foreArm: number; thigh: number; shin: number; cuff: number;
  /** Torus [tube, ring] segments. */
  belt: Seg; headband: Seg;
  /** Small capsules [caps, radial] (lapels, belt tails, thumbs); null drops those parts. */
  capsule: Seg | null;
  tail: Seg;
  /** RoundedBox segments for hands and boots; 0 = a plain box. */
  box: number;
  spikes: readonly number[]; bangs: readonly number[]; spikeRings: number; spikeSides: number;
  /** Ink on the small parts (lapels, tails, ears, plate, knot, cuffs, thumbs). */
  smallInk: boolean;
  keyCols: number; keyRows: number; puffs: number; streaks: number; ring: number; aura: number;
  /** The eye canvas size relative to the lab's 768 x 168. */
  eyeScale: number;
}

const TIERS: Record<AnimeDetail, Tier> = {
  full: {
    pelvis: [28, 18], knot: [14, 10], trap: [24, 12], head: [48, 36], ear: [14, 10], mask: [48, 24], band: [64, 16], hairCap: [40, 24], deltoid: [22, 16], ki: [24, 18], smoke: [10, 8],
    torso: 36, neck: 18, upperArm: 24, foreArm: 22, thigh: 26, shin: 26, cuff: 18, belt: [12, 40], headband: [12, 56], capsule: [4, 8], tail: [4, 10], box: 3,
    spikes: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], bangs: [0, 1, 2, 3, 4], spikeRings: 10, spikeSides: 9, smallInk: true,
    keyCols: 10, keyRows: 3, puffs: 14, streaks: 8, ring: 48, aura: 40, eyeScale: 1,
  },
  reduced: {
    pelvis: [16, 10], knot: [10, 6], trap: [14, 6], head: [28, 20], ear: [8, 6], mask: [28, 12], band: [32, 8], hairCap: [24, 12], deltoid: [12, 8], ki: [12, 8], smoke: [8, 6],
    torso: 18, neck: 10, upperArm: 12, foreArm: 12, thigh: 14, shin: 14, cuff: 10, belt: [8, 24], headband: [8, 32], capsule: [2, 6], tail: [2, 6], box: 1,
    spikes: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], bangs: [0, 1, 2], spikeRings: 6, spikeSides: 6, smallInk: true,
    keyCols: 8, keyRows: 3, puffs: 8, streaks: 6, ring: 32, aura: 24, eyeScale: 1,
  },
  minimal: {
    pelvis: [10, 6], knot: [6, 4], trap: [10, 4], head: [16, 12], ear: null, mask: [16, 6], band: [16, 4], hairCap: [14, 6], deltoid: [8, 6], ki: [8, 6], smoke: [6, 4],
    torso: 10, neck: 8, upperArm: 8, foreArm: 8, thigh: 8, shin: 8, cuff: 6, belt: [6, 14], headband: [6, 18], capsule: null, tail: [1, 4], box: 0,
    spikes: [0, 1, 2, 3, 4, 7, 8, 9], bangs: [], spikeRings: 4, spikeSides: 5, smallInk: false,
    keyCols: 6, keyRows: 2, puffs: 5, streaks: 4, ring: 20, aura: 12, eyeScale: 0.5,
  },
};

// The lab's profiles (radius, height), written top down for the limbs; lathe() sorts them bottom to top so the
// faces point outward.
const TORSO: readonly Seg[] = [[0.0, -0.02], [0.18, 0.0], [0.205, 0.1], [0.23, 0.22], [0.285, 0.38], [0.3, 0.5], [0.26, 0.6], [0.14, 0.655], [0.0, 0.665]];
const NECK: readonly Seg[] = [[0.0, -0.06], [0.075, -0.06], [0.068, 0.0], [0.064, 0.07], [0.0, 0.08]];
const UPPER_ARM: readonly Seg[] = [[0.0, 0.01], [0.085, -0.01], [0.095, -0.06], [0.085, -0.11], [0.092, -0.16], [0.075, -0.23], [0.06, -0.27], [0.0, -0.285]];
const FORE_ARM: readonly Seg[] = [[0.0, 0.015], [0.062, 0.0], [0.078, -0.05], [0.07, -0.11], [0.056, -0.17], [0.0, -0.18]];
const THIGH: readonly Seg[] = [[0.0, 0.04], [0.11, 0.02], [0.13, -0.08], [0.13, -0.2], [0.115, -0.32], [0.0, -0.37]];
const SHIN: readonly Seg[] = [[0.0, 0.03], [0.112, 0.0], [0.12, -0.07], [0.108, -0.17], [0.085, -0.26], [0.0, -0.3]];
/** Hair spikes: azimuth (0 = front), elevation, length, width, flatness, bend up, bend back. */
const SPIKES: readonly (readonly [number, number, number, number, number, number, number])[] = [
  [0, 1.15, 0.5, 0.12, 0.6, 0.35, 0.25], [0.55, 1.0, 0.48, 0.12, 0.6, 0.3, 0.3], [-0.55, 1.0, 0.48, 0.12, 0.6, 0.3, 0.3],
  [1.2, 0.75, 0.46, 0.115, 0.6, 0.3, 0.35], [-1.2, 0.75, 0.46, 0.115, 0.6, 0.3, 0.35], [1.9, 0.6, 0.48, 0.12, 0.6, 0.25, 0.45],
  [-1.9, 0.6, 0.48, 0.12, 0.6, 0.25, 0.45], [2.55, 0.65, 0.52, 0.125, 0.6, 0.2, 0.5], [-2.55, 0.65, 0.52, 0.125, 0.6, 0.2, 0.5],
  [Math.PI, 0.75, 0.55, 0.13, 0.6, 0.2, 0.45], [2.2, 0.25, 0.36, 0.1, 0.55, 0.05, 0.35], [-2.2, 0.25, 0.36, 0.1, 0.55, 0.05, 0.35],
  [1.55, 0.2, 0.3, 0.09, 0.55, 0.0, 0.25], [-1.55, 0.2, 0.3, 0.09, 0.55, 0.0, 0.25],
];
/** Bangs: x on the hairline, tilt, length (short spikes curling down over the band). */
const BANGS: readonly (readonly [number, number, number])[] = [[-0.13, 0.5, 0.14], [0.0, 0.0, 0.16], [0.13, -0.5, 0.14], [-0.23, 0.9, 0.12], [0.23, -0.9, 0.12]];

function lathe(pts: readonly Seg[], seg: number): THREE.LatheGeometry {
  return new THREE.LatheGeometry([...pts].sort((a, b) => a[1] - b[1]).map(([r, y]) => new THREE.Vector2(r, y)), seg);
}

function box(w: number, h: number, d: number, seg: number, r: number): THREE.BufferGeometry {
  return seg > 0 ? new RoundedBoxGeometry(w, h, d, seg, r) : new THREE.BoxGeometry(w, h, d);
}

/** A bent, tapered, slightly flattened spike: rings along a quadratic curve, closed to a point. */
function spikeGeo(base: THREE.Vector3, dir: THREE.Vector3, bend: THREE.Vector3, len: number, w: number, flat: number, rs: number, ls: number): THREE.BufferGeometry {
  const pos: number[] = [], idx: number[] = [];
  const pt = (t: number) => base.clone().addScaledVector(dir, len * t).addScaledVector(bend, len * t * t);
  for (let i = 0; i <= ls; i++) {
    const t = i / ls;
    const c = pt(t), T = pt(Math.min(1, t + 0.02)).sub(pt(Math.max(0, t - 0.02))).normalize();
    const S = new THREE.Vector3().crossVectors(T, new THREE.Vector3(0, 0, 1));
    if (S.lengthSq() < 1e-4) S.set(1, 0, 0);
    S.normalize();
    const N = new THREE.Vector3().crossVectors(S, T).normalize();
    const r = w * Math.pow(1 - t, 1.15);
    for (let j = 0; j < rs; j++) {
      const a = (j / rs) * TAU;
      const v = c.clone().addScaledVector(S, Math.cos(a) * r).addScaledVector(N, Math.sin(a) * r * flat);
      pos.push(v.x, v.y, v.z);
    }
  }
  for (let i = 0; i < ls; i++) for (let j = 0; j < rs; j++) {
    const a = i * rs + j, b = i * rs + ((j + 1) % rs), c = a + rs, d = b + rs;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** The jaw: narrow and lengthen the lower half of a head-centered sphere. The mask and the eye band reuse it,
 *  so they fit the face exactly. */
function jaw(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const p = g.attributes.position!;
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    if (y < 0) {
      const k = 1 - Math.min(1, -y / 0.27) * 0.4;
      x *= k;
      z *= 0.9 + 0.1 * k;
      y *= 1.1;
    }
    p.setXYZ(i, x, y, z);
  }
  g.computeVertexNormals();
  return g;
}

function hairGeo(t: Tier): THREE.BufferGeometry {
  const geos: THREE.BufferGeometry[] = [];
  // the front edge lifted to the headband: forehead and brows stay clear, the back of the head is covered
  const cap = new THREE.SphereGeometry(0.288, t.hairCap[0], t.hairCap[1], 0, TAU, 0, Math.PI * 0.5);
  cap.rotateX(-0.5);
  cap.translate(0, 0.03, -0.01);
  geos.push(cap);
  for (const i of t.spikes) {
    const [az, el, len, w, flat, up, back] = SPIKES[i]!;
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).normalize();
    const base = dir.clone().multiplyScalar(0.2).add(new THREE.Vector3(0, 0.06, -0.02));
    geos.push(spikeGeo(base, dir, new THREE.Vector3(0, up, -back), len, w * 1.35, flat, t.spikeSides, t.spikeRings));
  }
  for (const i of t.bangs) {
    const [x, tilt, len] = BANGS[i]!;
    const base = new THREE.Vector3(x, 0.2, 0.19);
    const dir = new THREE.Vector3(Math.sin(-tilt) * 0.4, -0.35, 0.9).normalize();
    geos.push(spikeGeo(base, dir, new THREE.Vector3(-tilt * 0.08, -0.25, 0.05), len, 0.07, 0.55, t.spikeSides, t.spikeRings));
  }
  const parts = geos.map((g) => {
    const n = g.index ? g.toNonIndexed() : g;
    n.deleteAttribute("uv");
    return n;
  });
  const merged = mergeGeometries(parts, false)!;
  merged.computeVertexNormals();
  for (const g of geos) g.dispose();
  for (const g of parts) g.dispose();
  return merged;
}

interface GeoSet {
  refs: number;
  pelvis: THREE.BufferGeometry; torso: THREE.BufferGeometry; vee: THREE.BufferGeometry; lapel: THREE.BufferGeometry | null;
  belt: THREE.BufferGeometry; knot: THREE.BufferGeometry; beltTail: THREE.BufferGeometry | null; neck: THREE.BufferGeometry; trap: THREE.BufferGeometry;
  head: THREE.BufferGeometry; ear: THREE.BufferGeometry | null; mask: THREE.BufferGeometry; band: THREE.BufferGeometry; headband: THREE.BufferGeometry;
  plate: THREE.BufferGeometry; tail: THREE.BufferGeometry; hair: THREE.BufferGeometry;
  deltoid: THREE.BufferGeometry; upperArm: THREE.BufferGeometry; foreArm: THREE.BufferGeometry; wrist: THREE.BufferGeometry; hand: THREE.BufferGeometry; thumb: THREE.BufferGeometry | null;
  thigh: THREE.BufferGeometry; shin: THREE.BufferGeometry; ankle: THREE.BufferGeometry; boot: THREE.BufferGeometry;
  kbPlane: THREE.BufferGeometry; kbKey: THREE.BufferGeometry; kbEdges: THREE.BufferGeometry;
  ball: THREE.BufferGeometry; auraIn: THREE.BufferGeometry; auraOut: THREE.BufferGeometry; puff: THREE.BufferGeometry; ring: THREE.BufferGeometry; streak: THREE.BufferGeometry;
}

const AURA_H = 2.6;

function buildGeo(t: Tier): GeoSet {
  const cap = t.capsule;
  return {
    refs: 0,
    pelvis: new THREE.SphereGeometry(0.2, t.pelvis[0], t.pelvis[1]),
    torso: lathe(TORSO, t.torso),
    vee: new THREE.ConeGeometry(0.12, 0.27, 3),
    lapel: cap ? new THREE.CapsuleGeometry(0.018, 0.26, cap[0], cap[1]) : null,
    belt: new THREE.TorusGeometry(0.212, 0.034, t.belt[0], t.belt[1]),
    knot: new THREE.SphereGeometry(0.045, t.knot[0], t.knot[1]),
    beltTail: cap ? new THREE.CapsuleGeometry(0.022, 0.17, cap[0], cap[1]) : null,
    neck: lathe(NECK, t.neck),
    trap: new THREE.SphereGeometry(0.16, t.trap[0], t.trap[1], 0, TAU, 0, Math.PI / 2),
    head: jaw(new THREE.SphereGeometry(0.27, t.head[0], t.head[1])),
    ear: t.ear ? new THREE.SphereGeometry(0.05, t.ear[0], t.ear[1]) : null,
    // a clean lower cap (from just under the eyes to the chin), deformed by the same jaw
    mask: jaw(new THREE.SphereGeometry(0.278, t.mask[0], t.mask[1], 0, TAU, Math.PI * 0.53, Math.PI * 0.47)),
    // a patch of the head sphere itself (the same jaw), so the eyes sit ON the face; front centered UVs
    band: jaw(new THREE.SphereGeometry(0.2712, t.band[0], t.band[1], Math.PI / 2 - 1.1, 2.2, Math.PI * 0.31, Math.PI * 0.23)),
    headband: new THREE.TorusGeometry(0.274, 0.03, t.headband[0], t.headband[1]),
    plate: box(0.17, 0.065, 0.025, Math.min(2, t.box), 0.01),
    tail: new THREE.CapsuleGeometry(0.024, 0.34, t.tail[0], t.tail[1]),
    hair: hairGeo(t),
    deltoid: new THREE.SphereGeometry(0.095, t.deltoid[0], t.deltoid[1]),
    upperArm: lathe(UPPER_ARM, t.upperArm),
    foreArm: lathe(FORE_ARM, t.foreArm),
    wrist: new THREE.CylinderGeometry(0.066, 0.07, 0.075, t.cuff),
    hand: box(0.115, 0.11, 0.125, t.box, 0.04),
    thumb: cap ? new THREE.CapsuleGeometry(0.022, 0.05, cap[0], cap[1]) : null,
    thigh: lathe(THIGH, t.thigh),
    shin: lathe(SHIN, t.shin),
    ankle: new THREE.CylinderGeometry(0.075, 0.078, 0.065, t.cuff),
    boot: box(0.13, 0.1, 0.24, t.box, 0.045),
    kbPlane: new THREE.PlaneGeometry(0.7, 0.26),
    kbKey: new THREE.PlaneGeometry(0.05, 0.05),
    kbEdges: new THREE.EdgesGeometry(new THREE.PlaneGeometry(0.7, 0.26)),
    ball: new THREE.SphereGeometry(1, t.ki[0], t.ki[1]),
    auraIn: new THREE.CylinderGeometry(0.62 * 0.5, 0.62, AURA_H, t.aura, 1, true),
    auraOut: new THREE.CylinderGeometry(0.8 * 0.5, 0.8, AURA_H * 1.18, t.aura, 1, true),
    puff: new THREE.SphereGeometry(1, t.smoke[0], t.smoke[1]),
    ring: new THREE.RingGeometry(0.45, 0.52, t.ring),
    streak: new THREE.PlaneGeometry(1, 1),
  };
}

const GEO_CACHE = new Map<AnimeDetail, GeoSet>();

function acquireGeo(detail: AnimeDetail): GeoSet {
  let set = GEO_CACHE.get(detail);
  if (!set) {
    set = buildGeo(TIERS[detail]);
    GEO_CACHE.set(detail, set);
  }
  set.refs++;
  return set;
}

function releaseGeo(detail: AnimeDetail): void {
  const set = GEO_CACHE.get(detail);
  if (!set || --set.refs > 0) return;
  for (const v of Object.values(set)) if (v instanceof THREE.BufferGeometry) v.dispose();
  GEO_CACHE.delete(detail);
}

/** Triangles drawn for `root` right now: visible meshes only (an invisible ancestor hides its subtree). The perf
 *  budgets are stated in these units. */
export function animeTriangles(root: THREE.Object3D): number {
  if (!root.visible) return 0;
  let n = 0;
  if (root instanceof THREE.Mesh) {
    const g = root.geometry as THREE.BufferGeometry;
    n += g.index ? g.index.count / 3 : (g.getAttribute("position")?.count ?? 0) / 3;
  }
  for (const c of root.children) n += animeTriangles(c);
  return n;
}

// ------------------------------------------------------------------------------------------ the figure

const O_SPINE = jointOffset("spine");
const O_CHEST = jointOffset("chest");
const O_HEAD = jointOffset("head");
const O_SHL = jointOffset("shL");
const O_ELL = jointOffset("elL");
const O_SHR = jointOffset("shR");
const O_ELR = jointOffset("elR");
const DEAD_GRAY = new THREE.Color("#5a5f6a");
const WHITE = new THREE.Color("#ffffff");
const HALO_ALPHA = [0.85, 0.4, 0.14] as const;
const HALO_SCALE = [0.2, 0.31, 0.46] as const;
let instanceSeed = 1;

/** Moves `w` toward `target` at `rate` per call (rate 1 = jump). */
function approach(w: number, target: number, rate: number): number {
  return w < target ? Math.min(target, w + rate) : Math.max(target, w - rate);
}

class Anime implements AnimeFigure {
  readonly group = new THREE.Group();
  private readonly body = new THREE.Group();
  private readonly detail: AnimeDetail;
  private readonly tier: Tier;
  private readonly geo: GeoSet;
  private readonly mats: THREE.Material[] = [];
  private disposed = false;

  // materials
  private readonly mGi: THREE.MeshToonMaterial;
  private readonly mGiDark: THREE.MeshToonMaterial;
  private readonly mSkin: THREE.MeshToonMaterial;
  private readonly mHair: THREE.MeshToonMaterial;
  private readonly mAccent: THREE.MeshToonMaterial;
  private readonly mBand: THREE.MeshToonMaterial;
  private readonly mInk: THREE.MeshBasicMaterial;
  private readonly mInkThin: THREE.MeshBasicMaterial;
  private readonly mKbPlane: THREE.MeshBasicMaterial;
  private readonly mKey: THREE.MeshBasicMaterial;
  private readonly mKeyHot: THREE.MeshBasicMaterial;
  private readonly mKbLine: THREE.LineBasicMaterial;
  private readonly mKiCore: THREE.MeshBasicMaterial;
  private readonly mKiHalo: THREE.MeshBasicMaterial[] = [];
  private readonly mAura: THREE.ShaderMaterial;
  private readonly mRing: THREE.MeshBasicMaterial;
  private readonly mStreak: THREE.MeshBasicMaterial;
  private readonly mSmoke: THREE.MeshBasicMaterial;

  // look
  private readonly cAccent = new THREE.Color();
  private readonly cAccNow = new THREE.Color();
  private readonly tmpColor = new THREE.Color();
  private readonly paint: EyePaint = { skin: "#f3c9a1", eye: "#1fd17a", eyeLight: "#ffffff" };
  private readonly eyeCtx: CanvasRenderingContext2D | null;
  private readonly eyeTex: THREE.CanvasTexture;
  private eyeKeyNow = -1;

  // rig (JOINTS order)
  private readonly joints: THREE.Group[] = [];
  private readonly root: THREE.Group;
  private readonly chest: THREE.Group;
  private readonly tails = new THREE.Group();
  private readonly hands: THREE.Group[] = [];

  // effects
  private readonly keyboard = new THREE.Group();
  private readonly keys: THREE.Mesh[] = [];
  private readonly keyLit: Uint8Array;
  private hotKey = -1;
  private readonly ki = new THREE.Group();
  private readonly aura = new THREE.Group();
  private readonly ring: THREE.Mesh;
  private readonly streaks: THREE.Mesh[] = [];
  private readonly smoke = new THREE.Group();
  private readonly puffs: THREE.Mesh[] = [];
  private readonly puffR: Float32Array;

  // animation state
  private activity: MiniActivity = "typing";
  /** A new figure starts idle: only a turn it was SEEN working through ends in a victory. */
  private state: AnimeState = "idle";
  private shot: ShotName | null = null;
  private shotT = 0;
  private k = 0.5;
  private kS = 0.5;
  private life = 0;
  private actT = 0;
  private stateT = 0;
  private tapPh = 0;
  private tapBeat = 0;
  private blendT = BLEND_S;
  private blendDur = BLEND_S;
  private blendSnap = false;
  private readonly from = new Float32Array(POSE_LEN);
  private readonly cur = new Float32Array(POSE_LEN);
  private readonly tgt = new Float32Array(POSE_LEN);
  private readonly out = new Float32Array(POSE_LEN);
  private readonly info: ClipSample = { emotion: "neutral", gaze: 0 };
  private readonly kiState: KiBall = { scale: 0, alpha: 0, fly: -1 };
  private kiFlying = false;
  private readonly kiFrom = new THREE.Vector3();
  private readonly kiDir = new THREE.Vector3();
  private readonly v1 = new THREE.Vector3();
  private readonly v2 = new THREE.Vector3();
  private wType = 0;
  private wRing = 0;
  private wKi = 0;
  private wDash = 0;
  private wAura = 0;
  private wSmoke = 0;
  private wPause = 0;
  private dead = 0;
  private glow = 0.35;
  private flash = 0;
  private blinkIn: number;
  private blinkAge = 99;
  private rng: number;
  private readonly phase: number;

  constructor(look: MiniLook, detail: AnimeDetail, flat: boolean) {
    this.detail = Object.prototype.hasOwnProperty.call(TIERS, detail) ? detail : "full";
    const t = (this.tier = TIERS[this.detail]);
    const g = (this.geo = acquireGeo(this.detail));
    this.rng = (instanceSeed++ * 2654435761) >>> 0 || 1;
    this.phase = this.random() * TAU;
    this.blinkIn = nextBlinkDelay(this.random());
    this.group.name = "anime-lucid";

    // ---- materials (lab look; untoned like the lab render, so the persona neon stays neon)
    const grad = toonGrad(flat ? 2 : 3);
    const toon = (p: THREE.MeshToonMaterialParameters = {}) => this.own(new THREE.MeshToonMaterial({ gradientMap: grad, toneMapped: false, ...p }));
    const basic = (p: THREE.MeshBasicMaterialParameters) => this.own(new THREE.MeshBasicMaterial({ toneMapped: false, ...p }));
    const fx = { transparent: true, blending: THREE.AdditiveBlending, depthWrite: false } as const;
    this.mGi = toon();
    this.mGiDark = toon();
    this.mSkin = toon();
    this.mHair = toon();
    this.mAccent = toon({ emissiveIntensity: 0.35 });
    const cv = document.createElement("canvas");
    cv.width = Math.round(EB_W * t.eyeScale);
    cv.height = Math.round(EB_H * t.eyeScale);
    this.eyeCtx = cv.getContext("2d");
    this.eyeTex = new THREE.CanvasTexture(cv);
    this.eyeTex.colorSpace = THREE.SRGBColorSpace;
    this.eyeTex.anisotropy = 4;
    this.mBand = toon({ map: this.eyeTex, transparent: true });
    const mPlate = toon({ color: "#b9c6d6" });
    const ink = flat ? INK_FLAT : INK_3D;
    this.mInk = this.own(inkMat(ink));
    this.mInkThin = this.own(inkMat(ink * 0.6));
    this.mKbPlane = basic({ ...fx, opacity: 0.22, side: THREE.DoubleSide });
    this.mKey = basic({ ...fx, opacity: 0.85 });
    this.mKeyHot = basic({ color: 0xffffff });
    this.mKbLine = this.own(new THREE.LineBasicMaterial({ toneMapped: false }));
    this.mKiCore = basic({ color: 0xffffff, transparent: true });
    for (let i = 0; i < HALO_ALPHA.length; i++) this.mKiHalo.push(basic({ ...fx, opacity: HALO_ALPHA[i] }));
    this.mAura = this.own(new THREE.ShaderMaterial({
      ...fx, side: THREE.DoubleSide, toneMapped: false,
      uniforms: { uC: { value: new THREE.Color() }, uT: { value: 0 }, uA: { value: 0 } },
      vertexShader: AURA_VS, fragmentShader: AURA_FS,
    }));
    this.mRing = basic({ ...fx, opacity: 0.7, side: THREE.DoubleSide });
    this.mStreak = basic({ ...fx, opacity: 0, side: THREE.DoubleSide });
    this.mSmoke = basic({ color: 0x4a4f5c, transparent: true, opacity: 0.35, depthWrite: false });
    this.setLook(look);

    // ---- the rig (the lab's buildFigure)
    const thin = t.smallInk ? 2 : 0;
    const smallThick = t.smallInk ? 1 : 0;
    const G = () => new THREE.Group();
    const root = (this.root = G()), hips = G(), spine = G(), chest = (this.chest = G()), neck = G(), head = G();
    this.group.add(this.body);
    this.body.scale.setScalar(ANIME_SCALE);
    this.body.add(root);
    root.add(hips); hips.position.y = 0.86; hips.add(spine); spine.add(chest); chest.position.y = 0.26; chest.add(neck); neck.position.y = 0.36; neck.add(head); head.position.y = 0.08;

    // torso: a sleeveless gi vest over a broad chest, a V opening shows the accent undershirt
    const pelvis = this.add(hips, g.pelvis, this.mGi, 1); pelvis.scale.set(1.18, 0.78, 0.92); pelvis.position.y = -0.03;
    const torso = this.add(spine, g.torso, this.mGi, 1); torso.scale.set(1, 1, 0.76);
    const vee = this.add(chest, g.vee, this.mAccent, 0); vee.rotation.set(Math.PI, Math.PI / 6 + Math.PI, 0); vee.position.set(0, 0.25, 0.185); vee.scale.set(1, 1, 0.16);
    for (let s = -1; s <= 1; s += 2) {
      if (g.lapel) { const l = this.add(chest, g.lapel, this.mGiDark, thin); l.position.set(s * 0.06, 0.25, 0.2); l.rotation.set(0.1, 0, s * 0.45); }
      if (g.beltTail) { const bt = this.add(hips, g.beltTail, this.mAccent, thin); bt.position.set(0.06 + s * 0.035, 0, 0.205); bt.rotation.z = s * 0.25; bt.scale.z = 0.5; }
    }
    const belt = this.add(hips, g.belt, this.mAccent, 1); belt.rotation.x = Math.PI / 2; belt.scale.set(1.13, 0.9, 1); belt.position.y = 0.1;
    this.add(hips, g.knot, this.mAccent, smallThick).position.set(0.06, 0.1, 0.195);
    this.add(neck, g.neck, this.mSkin, 1);
    const trap = this.add(chest, g.trap, this.mGi, 1); trap.scale.set(1.45, 0.45, 0.75); trap.position.y = 0.33; // the neck sits in the shoulders

    // head: an anime skull with a tapered jaw, the fitted mask, the canvas eye band, the headband and its tails
    const skull = G(); head.add(skull); skull.position.y = 0.2;
    this.add(skull, g.head, this.mSkin, 1);
    if (g.ear) for (let s = -1; s <= 1; s += 2) { const e = this.add(skull, g.ear, this.mSkin, thin); e.scale.set(0.45, 1, 0.8); e.position.set(s * 0.262, -0.02, -0.01); }
    this.add(skull, g.mask, this.mGiDark, 1);
    const band = new THREE.Mesh(g.band, this.mBand); band.renderOrder = 1; skull.add(band);
    const hb = this.add(skull, g.headband, this.mAccent, 1); hb.rotation.x = Math.PI / 2 - 0.06; hb.position.y = 0.168; hb.scale.set(1, 1.02, 1);
    const plate = this.add(skull, g.plate, mPlate, thin); plate.position.set(0, 0.18, 0.255); plate.rotation.x = -0.2;
    skull.add(this.tails); this.tails.position.set(0, 0.16, -0.26);
    for (let s = -1; s <= 1; s += 2) { const tl = this.add(this.tails, g.tail, this.mAccent, thin); tl.position.set(s * 0.05, -0.12, -0.09); tl.rotation.set(-1.0, 0, s * 0.35); tl.scale.set(1.6, 1, 0.4); }
    this.add(skull, g.hair, this.mHair, 1);

    // arms: sculpted deltoid, bicep, forearm; accent wristbands; rounded fists with a thumb. L is -X.
    const arm = (side: number): [THREE.Group, THREE.Group] => {
      const sh = G(); chest.add(sh); sh.position.set(side * 0.31, 0.3, 0);
      this.add(sh, g.deltoid, this.mSkin, 1).scale.set(1.05, 0.95, 0.95);
      this.add(sh, g.upperArm, this.mSkin, 1);
      const el = G(); sh.add(el); el.position.y = -0.27;
      this.add(el, g.foreArm, this.mSkin, 1);
      this.add(el, g.wrist, this.mAccent, smallThick).position.y = -0.175;
      const hand = G(); el.add(hand); hand.position.y = -0.255;
      this.add(hand, g.hand, this.mSkin, 1);
      if (g.thumb) { const th = this.add(hand, g.thumb, this.mSkin, thin); th.position.set(-side * 0.055, 0, 0.045); th.rotation.set(0.3, 0, side * 0.9); }
      this.hands.push(hand);
      return [sh, el];
    };
    // legs: baggy gi pants gathered at the ankle, accent ankle wraps, boots
    const leg = (side: number): [THREE.Group, THREE.Group] => {
      const hip = G(); hips.add(hip); hip.position.set(side * 0.115, -0.05, 0);
      this.add(hip, g.thigh, this.mGi, 1);
      const knee = G(); hip.add(knee); knee.position.y = -0.35;
      this.add(knee, g.shin, this.mGi, 1);
      this.add(knee, g.ankle, this.mAccent, smallThick).position.y = -0.285;
      this.add(knee, g.boot, this.mGiDark, 1).position.set(0, -0.36, 0.04);
      return [hip, knee];
    };
    const [shL, elL] = arm(-1), [shR, elR] = arm(1), [hipL, kneeL] = leg(-1), [hipR, kneeR] = leg(1);
    const byName: Record<(typeof JOINTS)[number], THREE.Group> = { root, hips, spine, chest, neck, head, shL, elL, shR, elR, hipL, kneeL, hipR, kneeR };
    for (const j of JOINTS) this.joints.push(byName[j]);

    // ---- effects
    // holo keyboard in front of the hands at chest height
    root.add(this.keyboard);
    this.keyboard.position.set(0, 1.17, 0.46);
    this.keyboard.rotation.x = -1.1;
    this.keyboard.add(new THREE.Mesh(g.kbPlane, this.mKbPlane));
    this.keyLit = new Uint8Array(t.keyCols * t.keyRows);
    for (let r = 0; r < t.keyRows; r++) for (let c = 0; c < t.keyCols; c++) {
      const i = r * t.keyCols + c;
      this.keyLit[i] = i % 7 === 3 ? 1 : 0;
      const key = new THREE.Mesh(g.kbKey, this.keyLit[i] ? this.mKeyHot : this.mKey);
      key.position.set(-0.29 + (c * 0.58) / (t.keyCols - 1), -0.07 + (r * 0.14) / (t.keyRows - 1), 0.002);
      this.keyboard.add(key);
      this.keys.push(key);
    }
    this.keyboard.add(new THREE.LineSegments(g.kbEdges, this.mKbLine));

    // ki ball: a white core inside three additive halos (the lab's r = 0.2)
    this.body.add(this.ki);
    const core = new THREE.Mesh(g.ball, this.mKiCore); core.scale.setScalar(0.11); this.ki.add(core);
    for (let i = 0; i < HALO_SCALE.length; i++) { const h = new THREE.Mesh(g.ball, this.mKiHalo[i]!); h.scale.setScalar(HALO_SCALE[i]); this.ki.add(h); }

    // aura flames: two open cones with the flame shader
    this.body.add(this.aura);
    const aIn = new THREE.Mesh(g.auraIn, this.mAura); aIn.position.y = AURA_H * 0.5 - 0.15; this.aura.add(aIn);
    const aOut = new THREE.Mesh(g.auraOut, this.mAura); aOut.position.y = AURA_H * 1.18 * 0.5 - 0.15; this.aura.add(aOut);

    // meditation ground ring
    this.ring = new THREE.Mesh(g.ring, this.mRing);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.02;
    this.body.add(this.ring);

    // dash speed streaks: thin accent lines facing the viewer, rushing outward around him
    for (let i = 0; i < t.streaks; i++) {
      const s = new THREE.Mesh(g.streak, this.mStreak);
      s.rotation.z = (i / t.streaks) * TAU + 0.4;
      this.body.add(s);
      this.streaks.push(s);
    }

    // power-down smoke
    this.body.add(this.smoke);
    this.puffR = new Float32Array(t.puffs);
    for (let i = 0; i < t.puffs; i++) {
      this.puffR[i] = 0.08 + this.random() * 0.08;
      const p = new THREE.Mesh(g.puff, this.mSmoke);
      p.position.set((this.random() - 0.5) * 0.6, 0.9, (this.random() - 0.5) * 0.3);
      this.smoke.add(p);
      this.puffs.push(p);
    }

    this.update(0, 0, false);
  }

  // ------------------------------------------------------------------------------------------ API

  setActivity(a: MiniActivity): void {
    if (a === this.activity || !MINI_ACTIVITIES.includes(a)) return;
    this.activity = a;
    this.actT = 0;
    this.kiFlying = false;
    this.snapshot(BLEND_S, false);
  }

  setIntensity(x: number): void {
    this.k = Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
  }

  setState(s: AnimeState): void {
    if (s === this.state || !ANIME_STATES.includes(s)) return;
    const prev = this.state;
    this.state = s;
    this.stateT = 0;
    const shot = transitionShot(prev, s);
    if (shot) {
      this.shot = shot;
      this.shotT = 0;
    } else if (s === "paused" || s === "ended" || s === "killed" || s === "failed") this.shot = null;
    if (s === "failed") this.snapshot(SNAP_BLEND_S, true);
    else this.snapshot(prev === "failed" ? 0.45 : BLEND_S, false);
  }

  burst(): void {
    if (this.state === "paused" || this.state === "ended" || this.state === "killed") return;
    if (this.shot === "powerup" && this.shotT < 0.6) return;
    this.shot = "powerup";
    this.shotT = 0;
    this.flash = 0.6;
    this.snapshot(SNAP_BLEND_S, true);
  }

  setLook(l: MiniLook): void {
    const a = animeLook(l);
    this.mGi.color.set(a.gi);
    this.mGiDark.color.set(a.giDark);
    this.mSkin.color.set(a.skin);
    this.mHair.color.set(a.hair);
    this.cAccent.set(a.accent);
    this.paint.skin = a.skin;
    this.paint.eye = a.eye;
    this.paint.eyeLight = `#${this.tmpColor.set(a.eye).lerp(WHITE, 0.35).getHexString()}`;
    this.eyeKeyNow = -1;
  }

  update(_tSec: number, dt: number, motion: boolean): void {
    if (this.disposed) return;
    const d = motion && Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.1) : 0;
    this.life += d;
    this.stateT += d;
    this.blendT += d;
    this.kS = motion ? this.kS + (this.k - this.kS) * (1 - Math.exp(-d * 3)) : this.k;
    const tempo = tempoFor(this.state, this.kS);
    this.actT += d * tempo;
    if (!motion) this.shot = null;
    if (this.shot) {
      this.shotT += d;
      if (clipDone(CLIPS[this.shot], this.shotT)) {
        this.shot = null;
        this.snapshot(BLEND_S, false);
      }
    }

    // ---- the pose: a clip sample, blended from the last change
    const base: ClipName = clipFor(this.state, this.activity);
    const onActivity = base === this.activity;
    const baseT = onActivity ? this.actT : this.stateT;
    const info = this.info;
    if (!motion) {
      sampleClip(CLIPS[base], STILL_T[base], this.tgt, info);
      this.cur.set(this.tgt);
      this.blendT = this.blendDur;
    } else {
      if (this.shot) sampleClip(CLIPS[this.shot], this.shotT, this.tgt, info);
      else sampleClip(CLIPS[base], baseT, this.tgt, info);
      if (this.blendT >= this.blendDur) this.cur.set(this.tgt);
      else {
        const u = this.blendT / this.blendDur;
        const w = this.blendSnap ? 1 - (1 - u) * (1 - u) * (1 - u) : u * u * (3 - 2 * u);
        for (let i = 0; i < POSE_LEN; i++) this.cur[i] = this.from[i]! + (this.tgt[i]! - this.from[i]!) * w;
      }
    }
    const emotion = this.shot ? info.emotion : stateEmotion(this.state, info.emotion);

    // ---- effect weights
    const live = onActivity && this.shot === null;
    const act = this.activity;
    const actClipT = clipTime(CLIPS[act], motion ? this.actT : STILL_T[act]);
    const speed = act === "dash" ? dashSpeed(actClipT) : 0;
    const rate = motion ? d / FX_S : 1;
    this.wType = approach(this.wType, live && act === "typing" ? 1 : 0, rate);
    this.wRing = approach(this.wRing, live && act === "meditate" ? 1 : 0, rate);
    this.wKi = approach(this.wKi, live && act === "kiblast" ? 1 : 0, rate);
    this.wDash = approach(this.wDash, live && act === "dash" ? speed : 0, rate * 3);
    const auraT = this.shot === "powerup" ? auraLevel(this.shotT) : 0;
    this.wAura = approach(this.wAura, auraT, rate * 2);
    this.wSmoke = approach(this.wSmoke, this.state === "killed" && this.stateT > 0.5 ? 1 : 0, motion ? d / 1.2 : 1);
    this.wPause = approach(this.wPause, this.state === "paused" ? 1 : 0, motion ? d / 0.8 : 1);

    // ---- procedural layers
    const o = this.out;
    o.set(this.cur);
    const br = motion ? Math.sin((this.life * TAU) / (this.state === "paused" ? 5 : 3.2)) : 0;
    if (motion) {
      const amp = this.state === "killed" ? 0.3 : 1;
      o[O_CHEST] += 0.03 * br * amp;
      o[O_HEAD] -= 0.02 * br * amp;
      o[O_SHL + 2] -= 0.025 * br * amp;
      o[O_SHR + 2] += 0.025 * br * amp;
      o[O_HEAD] += 0.015 * Math.sin(this.life * 1.7 + this.phase) * (this.state === "working" ? 1 : 0.5);
      o[1] += this.wRing * 0.06 * Math.sin((this.life * TAU) / 3.6 + this.phase);
      o[1] += 0.03 * Math.sin(this.life * 17) * this.wDash;
      const shake = Math.max(this.shot === "powerup" ? shakeLevel(this.shotT) : 0, this.state === "failed" ? shakeLevel(this.stateT) : 0);
      o[0] += 0.03 * Math.sin(this.life * 83) * shake;
      // typing: fast alternating taps, the tempo following the intensity; a key lights on every tap
      this.tapPh += d * tempo * (5 + 6 * this.kS);
      if (this.wType > 0.001) {
        const tl = tapCurve(fract(this.tapPh)) * this.wType;
        const tr = tapCurve(fract(this.tapPh + 0.5)) * this.wType;
        o[O_ELL] += 0.28 * tl; o[O_SHL] += 0.05 * tl;
        o[O_ELR] += 0.28 * tr; o[O_SHR] += 0.05 * tr;
        const beat = Math.floor(this.tapPh * 2);
        if (beat !== this.tapBeat) { this.tapBeat = beat; this.lightKey(beat); }
      }
    }
    // paused: a slow tired slump over the frozen pose
    o[O_SPINE] += 0.12 * this.wPause;
    o[O_HEAD] += 0.2 * this.wPause;
    o[1] -= 0.02 * this.wPause;
    this.apply(o);
    const sway = motion ? 1 : 0;
    this.tails.rotation.set(0.12 * Math.sin(this.life * 3.1) * sway + 0.35 * this.wDash + 0.3 * this.dead, 0.18 * Math.sin(this.life * 2.3 + 1) * sway, 0);

    // ---- eyes: redrawn only when the emotion, the blink step or the gaze bucket changes
    if (motion) {
      this.blinkIn -= d;
      this.blinkAge += d;
      if (this.blinkIn <= 0) {
        this.blinkAge = 0;
        this.blinkIn = nextBlinkDelay(this.random());
      }
    } else this.blinkAge = 99;
    const emo = EMOTIONS[emotion];
    const bl = emo.shape === "open" ? blinkStep(this.blinkAge) : 0;
    const gb = gazeBucket(info.gaze);
    const key = eyeKey(emotion, bl, gb);
    if (key !== this.eyeKeyNow) {
      this.eyeKeyNow = key;
      if (this.eyeCtx) drawEyeBand(this.eyeCtx, this.paint, emo, BLINK_LEVELS[bl]!, gazeOfBucket(gb), this.tier.eyeScale);
      this.eyeTex.needsUpdate = true;
    }

    this.updateColors(d, motion);
    this.updateFx(d, motion, act === "kiblast" ? actClipT : -1, speed, br, auraT);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.group.removeFromParent();
    for (const m of this.mats) m.dispose();
    this.eyeTex.dispose();
    releaseGeo(this.detail);
  }

  // ------------------------------------------------------------------------------------------ internals

  private own<T extends THREE.Material>(m: T): T {
    this.mats.push(m);
    return m;
  }

  /** A mesh with an ink hull: 0 none, 1 the full ink, 2 the thin ink. */
  private add(parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, ink: 0 | 1 | 2): THREE.Mesh {
    const m = new THREE.Mesh(geo, mat);
    parent.add(m);
    if (ink !== 0) m.add(new THREE.Mesh(geo, ink === 1 ? this.mInk : this.mInkThin));
    return m;
  }

  private snapshot(dur: number, snap: boolean): void {
    this.from.set(this.cur);
    this.blendT = 0;
    this.blendDur = dur;
    this.blendSnap = snap;
  }

  private random(): number {
    let x = this.rng;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rng = x >>> 0;
    return this.rng / 4294967296;
  }

  private apply(p: Float32Array): void {
    this.root.position.set(p[0]!, p[1]!, p[2]!);
    for (let j = 0; j < this.joints.length; j++) {
      const i = 3 + j * 3;
      this.joints[j]!.rotation.set(p[i]!, p[i + 1]!, p[i + 2]!);
    }
  }

  /** One key lights per tap (the previous one goes back to its resting look). */
  private lightKey(beat: number): void {
    if (this.hotKey >= 0) this.keys[this.hotKey]!.material = this.keyLit[this.hotKey] ? this.mKeyHot : this.mKey;
    const h = Math.imul(beat + 1, 2654435761) >>> 0;
    const n = this.keys.length;
    // left hand on even beats, right hand on odd ones: the key lands under the hand that tapped
    const cols = this.tier.keyCols, half = cols >> 1;
    const row = (h >>> 8) % this.tier.keyRows;
    const col = (beat & 1) === 0 ? h % half : half + (h % (cols - half));
    this.hotKey = Math.min(n - 1, row * cols + col);
    this.keys[this.hotKey]!.material = this.mKeyHot;
  }

  private updateColors(d: number, motion: boolean): void {
    const st = this.state;
    const r = motion ? 1 - Math.exp(-d * 4) : 1;
    const glowT = st === "killed" ? 0 : st === "ended" ? 0.25 : st === "paused" ? 0.2 : st === "idle" ? 0.3 : 0.35 + 0.25 * this.kS;
    this.glow += (glowT - this.glow) * r;
    this.dead = approach(this.dead, st === "killed" && this.stateT > 0.4 ? 1 : 0, motion ? d : 1);
    this.flash = motion ? this.flash * Math.exp(-d * 5) : 0;
    const acc = this.cAccNow.copy(this.cAccent).lerp(DEAD_GRAY, 0.75 * this.dead);
    this.mAccent.color.copy(acc);
    this.mAccent.emissive.copy(acc);
    this.mAccent.emissiveIntensity = (this.glow + this.flash) * (1 - this.dead);
    // the powerup: the hair glows the accent
    this.mHair.emissive.copy(acc);
    this.mHair.emissiveIntensity = 0.35 * this.wAura;
    this.mKbPlane.color.copy(acc);
    this.mKey.color.copy(acc);
    this.mKbLine.color.copy(acc);
    for (let i = 0; i < this.mKiHalo.length; i++) this.mKiHalo[i]!.color.copy(acc);
    (this.mAura.uniforms.uC!.value as THREE.Color).copy(acc);
    this.mRing.color.copy(acc);
    this.mStreak.color.copy(acc);
  }

  private updateFx(d: number, motion: boolean, kiT: number, speed: number, br: number, auraT: number): void {
    // holo keyboard
    const kb = this.keyboard;
    kb.visible = this.wType > 0.01;
    if (kb.visible) kb.scale.setScalar(this.wType);

    // ki ball: grows between the hands while he charges, then flies off along his thrust and fades
    const ki = this.ki;
    const ks = kiT >= 0 && this.wKi > 0.001 ? kiBallAt(kiT, this.kiState) : null;
    ki.visible = ks !== null && ks.alpha > 0.001;
    if (ks && ki.visible) {
      const mid = this.hands[0]!.getWorldPosition(this.v1).add(this.hands[1]!.getWorldPosition(this.v2)).multiplyScalar(0.5);
      this.body.worldToLocal(mid);
      if (ks.fly >= 0) {
        if (!this.kiFlying) {
          this.kiFlying = true;
          this.kiFrom.copy(mid);
          this.body.worldToLocal(this.chest.getWorldPosition(this.v2));
          this.kiDir.subVectors(mid, this.v2).setY(0);
          if (this.kiDir.lengthSq() < 1e-6) this.kiDir.set(0, 0, 1);
          this.kiDir.normalize();
        }
        ki.position.copy(this.kiFrom).addScaledVector(this.kiDir, ks.fly * KI_RANGE);
      } else {
        this.kiFlying = false;
        ki.position.copy(mid);
      }
      ki.scale.setScalar(Math.max(0.001, ks.scale * this.wKi * (1 + (motion ? 0.06 * Math.sin(this.life * 22) : 0))));
      const a = ks.alpha * this.wKi;
      this.mKiCore.opacity = a;
      for (let i = 0; i < this.mKiHalo.length; i++) this.mKiHalo[i]!.opacity = HALO_ALPHA[i]! * a;
    } else if (!ks) this.kiFlying = false;

    // meditation ground ring, breathing with him
    this.ring.visible = this.wRing > 0.01;
    if (this.ring.visible) {
      this.mRing.opacity = 0.7 * this.wRing * (0.8 + 0.2 * br);
      this.ring.scale.setScalar(1 + 0.06 * br);
    }

    // dash speed streaks
    const ws = this.wDash;
    const on = ws > 0.01;
    this.mStreak.opacity = 0.6 * ws;
    for (let i = 0; i < this.streaks.length; i++) {
      const s = this.streaks[i]!;
      s.visible = on;
      if (!on) continue;
      const ph = fract(this.life * 2.2 + i / this.streaks.length);
      const a = s.rotation.z;
      const r = 0.6 + 0.9 * ph;
      s.position.set(Math.cos(a) * r, 1.1 + Math.sin(a) * r * 0.9, 0.5);
      s.scale.set(0.25 + 0.45 * ph * Math.min(1, speed + 0.3), 0.018, 1);
    }

    // aura flames
    this.aura.visible = this.wAura > 0.01 || auraT > 0.01;
    if (this.aura.visible) {
      const u = this.mAura.uniforms;
      u.uT!.value = (u.uT!.value as number) + d;
      u.uA!.value = this.wAura;
    }

    // power-down smoke rising
    this.smoke.visible = this.wSmoke > 0.01;
    if (this.smoke.visible) {
      this.mSmoke.opacity = 0.35 * this.wSmoke;
      const n = this.puffs.length;
      for (let i = 0; i < n; i++) {
        const p = this.puffs[i]!;
        const f = fract((motion ? this.life * 0.22 : 0.5) + i / n);
        p.position.y = 0.6 + f * 1.1;
        p.scale.setScalar(this.puffR[i]! * (0.6 + f) * (1 - 0.6 * f * f));
      }
    }
  }
}

export function createAnimeFigure(o: { look: MiniLook; detail: AnimeDetail; flat: boolean }): AnimeFigure {
  return new Anime(o.look, o.detail, o.flat);
}
