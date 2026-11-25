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
//
// P-VIZ.4 (ADR-0628): react() layers a stare or an outburst over the running activity (viz_anime_pose's reaction
// timeline: the turn to the camera, the raised fists, the anger mark and steam built lazily on the first
// outburst, a red-tinted aura flare), and the `supervise` activity adds a holo checklist that ticks.
//
// P-VIZ.6 (ADR-0637): a node is a ninja or a kunoichi (viz_anime_pose.seededGender on the node's seed, the same
// as its office worker's). The kunoichi is an original variant on the same rig, clips and eye band: a long high
// ponytail (its own mesh, swaying like the headband tails) instead of the crown spikes, side locks framing the
// mask, lashes on the eyes, slightly narrower shoulders and a slimmer build, accent lapels and longer wrist wraps.
// Her hair is built once per detail tier on first need (shared, ref-counted). hit() plays the throw tray's
// reactions over the activity (viz_anime_pose's hit plan: turned toward the throw, blended in from the pose on
// screen); the charge they leave (bolt, energy balls, Storm) speeds the activity up, lights the accent, keeps a
// small aura burning (crackling while a bolt's boost lasts) and, for energy balls, grows him up to +12 percent.
//
// P-VIZ.7 (ADR-0641): the node's model sponsors him (viz_brand): its size class scales the whole figure (capped so
// he stays inside his glass cube), its sponsor emblem is a patch on his chest and on his left thigh (riding those
// joints; the 2D map and the lowest tier keep the chest one), and its variant picks his weapon: a katana on the
// back, a kunai pair in thigh pouches, a bo staff on the back or a chakram on the back of the belt (shared
// vertex-colored geometry per tier, ref-counted). The kata, dash and kiblast slots play the weapon move on some
// loops (viz_anime_pose.weaponTurn); everything else keeps it on its mount. setCommit() is the git commit: the
// raised arm, a jagged ribbon bolt (crossed strips re-jittered in place, BOLT_HZ times a second) up into a storm
// cloud of toon puffs, sparks off the hand and glowing raiden eyes, all built on the first commit and reused.

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  animeLook, auraLevel, BLINK_LEVELS, blinkStep, CHECK_ROWS, checklistTicks, clearReaction, clipDone, clipFor, CLIPS, clipTime, dashSpeed,
  distributeYaw, EMOTIONS, eyeKey, fract, gazeBucket, gazeOfBucket, jointOffset, JOINTS, kiBallAt, newReactionSample, nextBlinkDelay,
  planReaction, POSE_LEN, POSE_VECTORS, REACTION_KINDS, sampleClip, sampleReaction, shakeLevel, stateEmotion, STILL_T, tapCurve, tempoFor,
  transitionShot, ANIME_STATES, type AnimeState, type ClipName, type ClipSample, type Emotion, type KiBall, type Reaction, type ReactionKind,
  type ShotName,
  animeHitCharge, chargeLevel, chargeTempo, clearHit, decayCharge, HIT_KINDS, newCharge, newHitSample, orbScale, planHit, sampleHit,
  seededGender, type HitPlan,
  BOLT_AT, BOLT_HZ, clamp01, CLOUD_IN_S, CLOUD_OUT_S, COMMIT_IN_S, COMMIT_OUT_S, newWeaponSample, smoothEase, variantOf, WEAPON_CLIP, WEAPON_SLOTS, WEAPONS,
  weaponAt, weaponTurn, type AnimeWeapon,
} from "./viz_anime_pose.ts";
import { drawEmblem, type VizBrand } from "./viz_brand.ts";
import { MINI_ACTIVITIES, type MiniActivity, type MiniLook } from "./viz_mini_look.ts";
import type { HitKind } from "./viz_throw_kinds.ts";
import { isTrayReactionKind } from "./viz_tray_reactions.ts";

export type { AnimeState, ReactionKind } from "./viz_anime_pose.ts";
export type AnimeDetail = "full" | "reduced" | "minimal";

export interface AnimeFigure {
  /** Feet at the origin, about ANIME_HEIGHT world units tall, facing +Z. Add it to any parent. */
  readonly group: THREE.Group;
  setActivity(a: MiniActivity): void;
  setIntensity(x: number): void;
  setState(s: AnimeState): void;
  /** A token surge: the powerup one-shot (aura, glowing hair, strain eyes, a short shake). */
  burst(): void;
  /** A tap (stare) or a double tap (outburst) at `camera`: a layer over the current activity, which keeps
   *  running underneath and resumes; never changes the agent state. Ignored while killed. */
  react(kind: ReactionKind, camera: THREE.Camera): void;
  /** Something reached him (P-VIZ.6): throwing stars (blocked, dodged, the third caught), a lightning bolt
   *  (supercharged), an energy ball (absorbed: he grows, up to 3 stacks) or the Storm (a power-up to the sky); the
   *  office throwables are a generic flinch. `from` is the world point the throw came from (he turns toward it);
   *  `strength` 0..1 scales the effect. A hit replaces any reaction or hit playing; a no-op once disposed or killed. */
  hit(kind: HitKind, from: THREE.Vector3, camera: THREE.Camera, strength?: number): void;
  /** 0..1: how supercharged he is right now (bolt, energy balls, Storm); decays inside update(). */
  readonly charge: number;
  /** How long the agent has been idle. The anime figure ignores it (the office worker uses it). */
  setIdleSeconds(sec: number): void;
  /** P-VIZ.7 (ADR-0641): a git commit or push is running. He plants his feet, raises his right arm and holds a
   *  jagged lightning bolt from his hand up into a storm cloud over his head, eyes glowing white-blue, for as long
   *  as it stays on (seconds to minutes); off, the bolt cuts out, the cloud dissipates and he blends back. */
  setCommit(on: boolean): void;
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
/** `lashes`: the kunoichi's two lash flicks at the outer corner of each open eye. */
interface EyePaint { skin: string; eye: string; eyeLight: string; lashes: boolean }

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
    } else if (emo.shape === "glow") {
      // P-VIZ.7 (ADR-0641): raiden eyes. The light bleeds out over the skin first, a streak trails off the outer
      // corner, then the almond is lit white-blue from within (no iris, no pupil), under the usual inked lash line.
      const h = 92 * emo.open;
      const top = cy - h * 0.62, bot = cy + h * 0.38 - emo.lower * 14;
      const halo = ctx.createRadialGradient(cx, cy, 12, cx, cy, 118);
      halo.addColorStop(0, "rgba(214,244,255,0.9)");
      halo.addColorStop(0.4, "rgba(130,205,255,0.42)");
      halo.addColorStop(1, "rgba(80,160,255,0)");
      ctx.fillStyle = halo;
      ctx.fillRect(cx - 128, cy - 104, 256, 208);
      ctx.strokeStyle = "rgba(190,236,255,0.85)"; ctx.lineWidth = 7;
      ctx.beginPath(); ctx.moveTo(ox, oy); ctx.quadraticCurveTo(ox - inner * 40, oy - 2, ox - inner * 78, oy - 14); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(ox, oy);
      ctx.bezierCurveTo(ox + inner * w * 0.15, top - 4, ix - inner * w * 0.35, top + slantY * 0.9, ix, iy);
      ctx.bezierCurveTo(ix - inner * w * 0.3, bot + 4, ox + inner * w * 0.25, bot + 2, ox, oy);
      const lit = ctx.createRadialGradient(cx, cy, 4, cx, cy, 80);
      lit.addColorStop(0, "#ffffff"); lit.addColorStop(0.45, "#c8f0ff"); lit.addColorStop(1, "#5cb6ff");
      ctx.fillStyle = lit;
      ctx.shadowColor = "#9fdcff"; ctx.shadowBlur = 26;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = INK; ctx.lineWidth = 9;
      ctx.beginPath(); ctx.moveTo(ox - inner * 8, oy - 8); ctx.bezierCurveTo(ox + inner * w * 0.15, top - 4, ix - inner * w * 0.35, top + slantY * 0.9, ix, iy); ctx.stroke();
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
      if (p.lashes && open > 0.3) {
        // two lashes flicking up and out from the outer end of the lash line
        ctx.lineWidth = 7;
        ctx.beginPath();
        ctx.moveTo(ox - inner * 6, oy - 10); ctx.lineTo(ox - inner * 30, oy - 26);
        const ly = (oy + top) / 2 - 4;
        ctx.moveTo(ox + inner * 14, ly); ctx.lineTo(ox - inner * 4, ly - 20);
        ctx.stroke();
      }
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
  /** P-VIZ.7: radial segments of the weapon rods (the torus rings scale from it), sponsor patch columns, the
   *  commit bolt's segments, its side forks, the storm cloud's puffs and the sparks off the hand (0 = none). */
  wpn: number; patch: number; bolt: number; forks: number; cloud: number; sparks: number;
}

const TIERS: Record<AnimeDetail, Tier> = {
  full: {
    pelvis: [28, 18], knot: [14, 10], trap: [24, 12], head: [48, 36], ear: [14, 10], mask: [48, 24], band: [64, 16], hairCap: [40, 24], deltoid: [22, 16], ki: [24, 18], smoke: [10, 8],
    torso: 36, neck: 18, upperArm: 24, foreArm: 22, thigh: 26, shin: 26, cuff: 18, belt: [12, 40], headband: [12, 56], capsule: [4, 8], tail: [4, 10], box: 3,
    spikes: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], bangs: [0, 1, 2, 3, 4], spikeRings: 10, spikeSides: 9, smallInk: true,
    keyCols: 10, keyRows: 3, puffs: 14, streaks: 8, ring: 48, aura: 40, eyeScale: 1,
    wpn: 12, patch: 8, bolt: 24, forks: 3, cloud: 11, sparks: 16,
  },
  reduced: {
    pelvis: [16, 10], knot: [10, 6], trap: [14, 6], head: [28, 20], ear: [8, 6], mask: [28, 12], band: [32, 8], hairCap: [24, 12], deltoid: [12, 8], ki: [12, 8], smoke: [8, 6],
    torso: 18, neck: 10, upperArm: 12, foreArm: 12, thigh: 14, shin: 14, cuff: 10, belt: [8, 24], headband: [8, 32], capsule: [2, 6], tail: [2, 6], box: 1,
    spikes: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], bangs: [0, 1, 2], spikeRings: 6, spikeSides: 6, smallInk: true,
    keyCols: 8, keyRows: 3, puffs: 8, streaks: 6, ring: 32, aura: 24, eyeScale: 1,
    wpn: 8, patch: 6, bolt: 18, forks: 2, cloud: 8, sparks: 10,
  },
  minimal: {
    pelvis: [10, 6], knot: [6, 4], trap: [10, 4], head: [16, 12], ear: null, mask: [16, 6], band: [16, 4], hairCap: [14, 6], deltoid: [8, 6], ki: [8, 6], smoke: [6, 4],
    torso: 10, neck: 8, upperArm: 8, foreArm: 8, thigh: 8, shin: 8, cuff: 6, belt: [6, 14], headband: [6, 18], capsule: null, tail: [1, 4], box: 0,
    spikes: [0, 1, 2, 3, 4, 7, 8, 9], bangs: [], spikeRings: 4, spikeSides: 5, smallInk: false,
    keyCols: 6, keyRows: 2, puffs: 5, streaks: 4, ring: 20, aura: 12, eyeScale: 0.5,
    wpn: 6, patch: 4, bolt: 12, forks: 1, cloud: 5, sparks: 0,
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

/** The kunoichi keeps only the side and lower spikes (the ponytail takes the crown). */
const FEMALE_SPIKES: readonly number[] = [3, 4, 5, 6, 10, 11, 12, 13];
/** Her ponytail's root on the skull: high on the back of the head. */
const PONY_AT = [0, 0.22, -0.2] as const;

function hairGeo(t: Tier, female: boolean): THREE.BufferGeometry {
  const geos: THREE.BufferGeometry[] = [];
  // the front edge lifted to the headband: forehead and brows stay clear, the back of the head is covered
  const cap = new THREE.SphereGeometry(0.288, t.hairCap[0], t.hairCap[1], 0, TAU, 0, Math.PI * 0.5);
  cap.rotateX(-0.5);
  cap.translate(0, 0.03, -0.01);
  geos.push(cap);
  for (const i of t.spikes) {
    if (female && !FEMALE_SPIKES.includes(i)) continue;
    const [az, el, len, w, flat, up, back] = SPIKES[i]!;
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).normalize();
    const base = dir.clone().multiplyScalar(0.2).add(new THREE.Vector3(0, 0.06, -0.02));
    geos.push(spikeGeo(base, dir, new THREE.Vector3(0, up, -back), len, w * 1.35, flat, t.spikeSides, t.spikeRings));
  }
  // her side locks: two long strands falling past the mask in front of the ears
  if (female) for (let s = -1; s <= 1; s += 2) {
    const dir = new THREE.Vector3(s * 0.15, -1, 0.25).normalize();
    geos.push(spikeGeo(new THREE.Vector3(s * 0.25, 0.06, 0.09), dir, new THREE.Vector3(s * 0.06, 0, 0.08), 0.42, 0.1, 0.55, t.spikeSides, t.spikeRings));
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

/** Her long high ponytail, rooted at its pivot (PONY_AT): it rises up and back off the crown, then falls down the
 *  back of the head to the shoulders. */
function ponytailGeo(t: Tier): THREE.BufferGeometry {
  // built in the XY plane (+X standing for -Z, back) so spikeGeo's ring frame never flips at the arc's peak, then
  // turned so the arc runs backward
  const g = spikeGeo(new THREE.Vector3(), new THREE.Vector3(0.6, 0.9, 0).normalize(), new THREE.Vector3(0.1, -1.6, 0), 1.0, 0.15, 0.9, t.spikeSides, t.spikeRings * 2);
  g.rotateY(Math.PI / 2);
  return g;
}

/** The kunoichi's own parts per detail tier, built on first need and ref-counted like GeoSet. */
interface FemaleGeo { refs: number; hair: THREE.BufferGeometry; pony: THREE.BufferGeometry }
const FEMALE_GEO = new Map<AnimeDetail, FemaleGeo>();

function acquireFemaleGeo(detail: AnimeDetail): FemaleGeo {
  let set = FEMALE_GEO.get(detail);
  if (!set) {
    set = { refs: 0, hair: hairGeo(TIERS[detail], true), pony: ponytailGeo(TIERS[detail]) };
    FEMALE_GEO.set(detail, set);
  }
  set.refs++;
  return set;
}

function releaseFemaleGeo(detail: AnimeDetail): void {
  const set = FEMALE_GEO.get(detail);
  if (!set || --set.refs > 0) return;
  set.hair.dispose();
  set.pony.dispose();
  FEMALE_GEO.delete(detail);
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
  /** P-VIZ.7: the sponsor patches, curved to the chest and the thigh. */
  patchChest: THREE.BufferGeometry; patchThigh: THREE.BufferGeometry;
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
    hair: hairGeo(t, false),
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
    patchChest: patchGeo(PATCH_CHEST[0], PATCH_CHEST[1], 0.31, t.patch),
    patchThigh: patchGeo(PATCH_THIGH[0], PATCH_THIGH[1], THIGH_R + PATCH_LIFT, t.patch),
  };
}

// ------------------------------------------------------------------------------------------ P-VIZ.7 patches and weapons

/** Patch sizes (lab units, the patch canvas's aspect PATCH_W x PATCH_H) and how far a patch stands off the cloth.
 *  The chest patch is a jersey sponsor across the front of the gi, big enough to read at the overview distance. */
const PATCH_CHEST = [0.26, 0.19] as const;
const PATCH_THIGH = [0.15, 0.11] as const;
const PATCH_LIFT = 0.014;
const PATCH_W = 320, PATCH_H = 234;
/** The torso (TORSO on the spine) where the chest patch sits: its height on the spine, its radius there, and how
 *  much the torso widens per unit of height (the patch tilts to match). */
const CHEST_PATCH_Y = 0.235;
const CHEST_PATCH_R = 0.235;
const CHEST_SLOPE = 0.21;
/** The thigh's radius where the patch sits (THIGH at about -0.15) and the patch's angle round it (front, toward -X). */
const THIGH_R = 0.13;
const THIGH_PATCH_A = -0.3;

/** A plane bent round a vertical cylinder of radius `r` (it curves back at its sides, like the cloth under it). */
function patchGeo(w: number, h: number, r: number, seg: number): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(w, h, seg, 1);
  const p = g.attributes.position!;
  for (let i = 0; i < p.count; i++) {
    const a = p.getX(i) / r;
    p.setXYZ(i, r * Math.sin(a), p.getY(i), r * Math.cos(a) - r);
  }
  g.computeVertexNormals();
  return g;
}

/** A rod along +Z centered at `z` (radius r0 at the -Z end, r1 at the +Z end). */
function rod(r0: number, r1: number, len: number, seg: number, z: number): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(r1, r0, len, seg).rotateX(Math.PI / 2).translate(0, 0, z);
}

/** Parts merged into one non-indexed, vertex-colored geometry (one draw per prop). The parts are consumed. */
function paintedMerge(parts: readonly (readonly [THREE.BufferGeometry, string])[]): THREE.BufferGeometry {
  const flat: THREE.BufferGeometry[] = [];
  const c = new THREE.Color();
  for (const [g, hex] of parts) {
    const n = g.index ? g.toNonIndexed() : g;
    if (n !== g) g.dispose();
    for (const k of Object.keys(n.attributes)) if (k !== "position" && k !== "normal") n.deleteAttribute(k);
    c.set(hex);
    const col = new Float32Array(n.attributes.position!.count * 3);
    for (let i = 0; i < col.length; i += 3) { col[i] = c.r; col[i + 1] = c.g; col[i + 2] = c.b; }
    n.setAttribute("color", new THREE.BufferAttribute(col, 3));
    flat.push(n);
  }
  const merged = mergeGeometries(flat, false)!;
  for (const g of flat) g.dispose();
  return merged;
}

/** The katana's blade: a flat, slightly tapered strip along +Z from 0 to `len`, the tip swept up to the spine. */
function bladeGeo(len: number): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(0, -0.021);
  s.lineTo(len * 0.82, -0.016);
  s.lineTo(len, 0.026);
  s.lineTo(len * 0.8, 0.03);
  s.lineTo(0, 0.023);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.014, bevelEnabled: false, curveSegments: 1 });
  g.translate(0, 0, -0.007);
  g.rotateY(-Math.PI / 2);
  return g;
}

const GOLD = "#c9a54b";
const STEEL = "#dfe7ef";
const WRAP = "#1d2230";

/** A weapon's shared parts, built in its grip frame (the grip at the origin, the blade or shaft along +Z).
 *  katana: held = blade + guard + hilt, hilt = guard + hilt (sheathed), sheath = the scabbard. kunai: held = one
 *  kunai, sheath = a thigh pouch. staff: held = the staff. disc: held = the chakram, glow = its energy ring. */
interface WeaponGeo { refs: number; held: THREE.BufferGeometry; hilt: THREE.BufferGeometry | null; sheath: THREE.BufferGeometry | null; glow: THREE.BufferGeometry | null }
const WEAPON_GEO = new Map<string, WeaponGeo>();

function buildWeaponGeo(w: AnimeWeapon, t: Tier): WeaponGeo {
  const s = t.wpn;
  switch (w) {
    case "katana": {
      const fittings = (): [THREE.BufferGeometry, string][] => [[rod(0.05, 0.05, 0.014, s, 0.118), GOLD], [rod(0.021, 0.023, 0.23, s, 0), WRAP], [rod(0.025, 0.025, 0.02, s, -0.12), GOLD]];
      return {
        refs: 0,
        held: paintedMerge([[bladeGeo(0.8).translate(0, 0, 0.125), STEEL], ...fittings()]),
        hilt: paintedMerge(fittings()),
        sheath: paintedMerge([[rod(0.033, 0.028, 0.82, s, 0.535), "#3a1f2b"], [rod(0.036, 0.036, 0.03, s, 0.15), GOLD], [rod(0.03, 0.03, 0.03, s, 0.93), GOLD]]),
        glow: null,
      };
    }
    case "kunai": {
      const blade = new THREE.ConeGeometry(0.032, 0.14, 4).rotateX(Math.PI / 2).scale(0.4, 1, 1).translate(0, 0, 0.11);
      const ring = new THREE.TorusGeometry(0.022, 0.006, 4, Math.max(6, s)).rotateY(Math.PI / 2).translate(0, 0, -0.062);
      return {
        refs: 0,
        held: paintedMerge([[blade, STEEL], [rod(0.012, 0.013, 0.08, Math.max(5, s >> 1), 0), WRAP], [ring, STEEL]]),
        hilt: null,
        sheath: paintedMerge([[new THREE.BoxGeometry(0.05, 0.13, 0.075), "#3b3f4a"], [new THREE.BoxGeometry(0.056, 0.03, 0.08).translate(0, 0.055, 0), "#2a2d36"]]),
        glow: null,
      };
    }
    case "staff":
      return {
        refs: 0,
        held: paintedMerge([[rod(0.024, 0.024, 1.5, s, 0), "#7a5534"], [rod(0.03, 0.03, 0.07, s, 0.68), GOLD], [rod(0.03, 0.03, 0.07, s, -0.68), GOLD], [rod(0.028, 0.028, 0.18, s, 0), WRAP]]),
        hilt: null, sheath: null, glow: null,
      };
    case "disc": {
      const parts: [THREE.BufferGeometry, string][] = [[new THREE.TorusGeometry(0.15, 0.02, Math.max(4, s >> 1), Math.round(s * 2.5)), STEEL], [new THREE.TorusGeometry(0.11, 0.008, 3, Math.round(s * 2)), GOLD]];
      for (let k = 0; k < 6; k++) {
        const a = (k * Math.PI) / 3;
        parts.push([new THREE.ConeGeometry(0.03, 0.085, 4).scale(1, 1, 0.35).rotateZ(a - Math.PI / 2).translate(0.19 * Math.cos(a), 0.19 * Math.sin(a), 0), STEEL]);
      }
      return { refs: 0, held: paintedMerge(parts), hilt: null, sheath: null, glow: new THREE.RingGeometry(0.03, 0.135, Math.round(s * 2)) };
    }
  }
}

function acquireWeaponGeo(detail: AnimeDetail, w: AnimeWeapon): WeaponGeo {
  const key = `${detail}/${w}`;
  let set = WEAPON_GEO.get(key);
  if (!set) {
    set = buildWeaponGeo(w, TIERS[detail]);
    WEAPON_GEO.set(key, set);
  }
  set.refs++;
  return set;
}

function releaseWeaponGeo(detail: AnimeDetail, w: AnimeWeapon): void {
  const key = `${detail}/${w}`;
  const set = WEAPON_GEO.get(key);
  if (!set || --set.refs > 0) return;
  set.held.dispose();
  set.hilt?.dispose();
  set.sheath?.dispose();
  set.glow?.dispose();
  WEAPON_GEO.delete(key);
}

// ------------------------------------------------------------------------------------------ P-VIZ.7 commit storm

/** The storm cloud's center, high over the raised right hand (body space, lab units). The cube's top is about 2.9
 *  here and one cube height is about 2.9 more, so the cloud rides about 1.2 cube heights above the cube, where it
 *  reads from the overview camera too. */
const CLOUD_X = 0.45, CLOUD_Y = 6.2, CLOUD_Z = 0.02;
/** Floats per cloud puff in CommitFx.puffAt, and the cloud's overall size (about 1.6 lab units wide). */
const CLOUD_FIELDS = 5;
const CLOUD_SIZE = 0.85;
/** How far the bolt's joints wander sideways at each re-jitter (lab units); forks have this many segments. */
const BOLT_AMP = 0.17;
const FORK_SEG = 6;
const BOLT_BLUE = new THREE.Color("#8fd0ff");
/** A ribbon's look across its width (uv.y): a white-hot core inside a blue-white glow, additive. */
const BOLT_VS = "varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }";
const BOLT_FS = "uniform vec3 uC; uniform float uA; varying vec2 vUv;\n" +
  "void main(){ float d = abs(vUv.y-0.5)*2.; float core = 1.-smoothstep(0.12,0.32,d); float glow = pow(1.-d,2.2); float a = (glow*0.8+core)*uA; vec3 c = mix(uC, vec3(1.), core); gl_FragColor = vec4(c*a, a); }";

/** A polyline drawn as two crossed strips (one spread along X, one along Z), so a mostly vertical bolt reads from
 *  any side. `pts` (n + 1 points) is rewritten in place and pushed with writeRibbon; nothing is reallocated. */
interface Ribbon { geo: THREE.BufferGeometry; pos: Float32Array; pts: Float32Array; n: number; mesh: THREE.Mesh }

function ribbon(n: number, mat: THREE.Material): Ribbon {
  const v = (n + 1) * 4;
  const pos = new Float32Array(v * 3), uv = new Float32Array(v * 2), idx: number[] = [];
  for (let s = 0; s < 2; s++) for (let i = 0; i <= n; i++) {
    const k = (s * (n + 1) + i) * 2;
    uv[k * 2] = i / n; uv[k * 2 + 1] = 0; uv[k * 2 + 2] = i / n; uv[k * 2 + 3] = 1;
    if (i < n) idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
  }
  const geo = new THREE.BufferGeometry();
  const attr = new THREE.BufferAttribute(pos, 3);
  attr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute("position", attr);
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.raycast = () => {};
  mesh.visible = false;
  return { geo, pos, pts: new Float32Array((n + 1) * 3), n, mesh };
}

/** Writes the ribbon's strips from its points, `w0` wide at the first point tapering to `w1` at the last. */
function writeRibbon(r: Ribbon, w0: number, w1: number): void {
  const { pos, pts, n } = r;
  const second = (n + 1) * 6;
  for (let i = 0; i <= n; i++) {
    const w = (w0 + (w1 - w0) * (i / n)) * 0.5;
    const x = pts[i * 3]!, y = pts[i * 3 + 1]!, z = pts[i * 3 + 2]!;
    let k = i * 6;
    pos[k] = x - w; pos[k + 1] = y; pos[k + 2] = z; pos[k + 3] = x + w; pos[k + 4] = y; pos[k + 5] = z;
    k += second;
    pos[k] = x; pos[k + 1] = y; pos[k + 2] = z - w; pos[k + 3] = x; pos[k + 4] = y; pos[k + 5] = z + w;
  }
  r.geo.attributes.position!.needsUpdate = true;
}

/** The commit storm, built on the first setCommit(true) and kept (a node that committed once will again). */
interface CommitFx {
  bolt: Ribbon; forks: Ribbon[]; mBolt: THREE.ShaderMaterial;
  /** Per bolt point: the x, y, z wander of the current jitter. */
  jit: Float32Array;
  /** Per fork: its points relative to the bolt point it leaves from, that point, and whether it shows this tick. */
  forkRel: Float32Array; forkAt: Int32Array; forkOn: Uint8Array;
  cloud: THREE.Group; puffs: THREE.Mesh[]; puffAt: Float32Array; mCloud: THREE.MeshToonMaterial; mCloudInk: THREE.MeshBasicMaterial; mCloudRim: THREE.MeshBasicMaterial;
  glow: THREE.Mesh; mGlow: THREE.MeshBasicMaterial; eyes: THREE.Mesh[]; mEye: THREE.MeshBasicMaterial;
  sparks: THREE.Points | null; sparkGeo: THREE.BufferGeometry | null; sparkPos: Float32Array; sparkDir: Float32Array; mSpark: THREE.PointsMaterial;
  /** The jitter tick last drawn (-1 = never). */
  tick: number;
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

const O_ROOT = jointOffset("root");
const O_HIPS = jointOffset("hips");
const O_SPINE = jointOffset("spine");
const O_CHEST = jointOffset("chest");
const O_NECK = jointOffset("neck");
const O_HEAD = jointOffset("head");
const O_SHL = jointOffset("shL");
const O_ELL = jointOffset("elL");
const O_SHR = jointOffset("shR");
const O_ELR = jointOffset("elR");
const DEAD_GRAY = new THREE.Color("#5a5f6a");
const WHITE = new THREE.Color("#ffffff");
const HALO_ALPHA = [0.85, 0.4, 0.14] as const;
const HALO_SCALE = [0.2, 0.31, 0.46] as const;
const RAGE_RED = new THREE.Color("#ff3a24");
/** Eye height in the body's lab units (hips 0.86 + spine 0.26 + neck 0.36 + head 0.08 + skull 0.2). */
const EYE_Y = 1.76;
/** The stare glares from under the brows: the head dips this much below looking straight at the camera. */
const GLARE_DIP = 0.08;
/** The outburst pose's upper body joints (x, y, z each), blended over the activity by the rage weight. */
const RAGE_JOINTS = (["spine", "chest", "shL", "elL", "shR", "elR"] as const).map(jointOffset);
const STEAM_PUFFS = 4;
/** P-VIZ.6: the aura level a full charge keeps burning (a hit's own flare goes higher). */
const CHARGE_AURA = 0.45;
/** The hit turn glares a little from under the brows too, less than the stare. */
const HIT_DIP = 0.04;
/** P-VIZ.7: the most the body may grow (size class x energy balls). viz_scene stands him ANIME_HEIGHT x 1.15 tall
 *  on a plate inside a CUBE (1.5) glass cube: 1.455 / 1.265 is about 1.15 of headroom, less a margin. */
const MAX_SIZE = 1.13;
/** How far a thrown kunai flies and how far out the chakram arcs before it comes back (lab units). */
const KUNAI_RANGE = 1.1;
const DISC_RANGE = 1.0;
const Z_AXIS = new THREE.Vector3(0, 0, 1);
let instanceSeed = 1;

/** The anger mark (the red cross-shaped vein): four bent strokes around a center, dark rim under a bright red. */
function drawAngerMark(ctx: CanvasRenderingContext2D, size: number): void {
  const s = size / 128;
  ctx.setTransform(s, 0, 0, s, 0, 0);
  ctx.clearRect(0, 0, 128, 128);
  ctx.lineCap = "round";
  for (const [color, width] of [["#5a0608", 24], ["#ff2a1c", 13]] as const) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    for (let k = 0; k < 4; k++) {
      ctx.save();
      ctx.translate(64, 64);
      ctx.rotate((k * Math.PI) / 2);
      ctx.beginPath(); ctx.moveTo(12, 46); ctx.quadraticCurveTo(15, 15, 46, 12); ctx.stroke();
      ctx.restore();
    }
  }
}

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
  private readonly paint: EyePaint = { skin: "#f3c9a1", eye: "#1fd17a", eyeLight: "#ffffff", lashes: false };
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

  // P-VIZ.4 reactions: a layer over the activity (the turn to the camera, the outburst's fists and effects)
  private readonly skull: THREE.Group;
  private reaction: Reaction | null = null;
  private reactT = 0;
  private reactCam: THREE.Camera | null = null;
  private readonly rs = newReactionSample();
  private readonly yaw = new Float32Array(5);
  private readonly q1 = new THREE.Quaternion();
  private readonly q2 = new THREE.Quaternion();
  /** Built on the first outburst (most figures never get one). */
  private rageFx: { mark: THREE.Mesh; mMark: THREE.MeshBasicMaterial; mSteam: THREE.MeshBasicMaterial; steam: THREE.Mesh[]; geo: THREE.PlaneGeometry; tex: THREE.CanvasTexture } | null = null;
  // P-VIZ.6: the kunoichi variant (her own hair and ponytail), the hit layer (a one-shot over the activity) and charge
  private readonly female: boolean;
  /** The body's size: 1 for him, a little smaller for her (the energy balls scale on top). */
  private readonly size: number;
  private readonly pony: THREE.Group | null = null;
  private hitPlan: HitPlan | null = null;
  private hitT = 0;
  private readonly hs = newHitSample();
  private readonly hitPose = new Float32Array(POSE_LEN);
  /** The pose on screen when the hit landed: the hit blends in from it. */
  private readonly hitSnap = new Float32Array(POSE_LEN);
  private readonly hitFrom = new THREE.Vector3();
  /** The throw had no usable origin: turn toward `hitCam` instead. */
  private hitAtCam = false;
  private hitCam: THREE.Camera | null = null;
  private readonly chg = newCharge();
  private chargeNow = 0;
  private clockAt = Number.NaN;
  // supervise: the holo checklist at his -X side
  private readonly checklist = new THREE.Group();
  private readonly checkBoxes: THREE.Mesh[] = [];
  private wCheck = 0;
  private ticksNow = -1;
  // P-VIZ.7 (ADR-0641): the sponsor patch, the variant's weapon and the git commit storm
  private readonly flat: boolean;
  /** The node seed (or a per-instance one): picks the weapon loops of the slots. */
  private readonly seed: number;
  private readonly weapon: AnimeWeapon;
  private readonly patchTex: THREE.CanvasTexture | null = null;
  private readonly mWeapon: THREE.MeshToonMaterial;
  /** Additive accent: the staff's spin blur or the chakram's energy ring. */
  private readonly mWeaponGlow: THREE.MeshBasicMaterial;
  /** Shown while the weapon rests on its mount / is in the hand(s) / is in flight (the thrown copies, body space). */
  private readonly onMount: THREE.Object3D[] = [];
  private readonly inHand: THREE.Object3D[] = [];
  private readonly thrown: THREE.Mesh[] = [];
  private readonly spinner: THREE.Group | null = null;
  private readonly spinBlur: THREE.Mesh | null = null;
  private readonly ws = newWeaponSample();
  /** What the activity's current loop plays: the activity's own clip or, in a weapon slot, the weapon move. */
  private segClip: ClipName = "typing";
  private cycle = 0;
  private flying = false;
  private readonly flyFrom = [new THREE.Vector3(), new THREE.Vector3()];
  private readonly flyDir = [new THREE.Vector3(), new THREE.Vector3()];
  private readonly v3 = new THREE.Vector3();
  private discSpin = 0;
  private commitOn = false;
  private commitT = 0;
  private wCommit = 0;
  private wCloud = 0;
  private wBolt = 0;
  /** The bolt's brightness this jitter tick (1 under reduced motion). */
  private flick = 1;
  private readonly commitPose = new Float32Array(POSE_LEN);
  private readonly commitInfo: ClipSample = { emotion: "raiden", gaze: 0 };
  private commitFx: CommitFx | null = null;

  constructor(look: MiniLook, detail: AnimeDetail, flat: boolean, seed: number, brand: VizBrand | null) {
    this.detail = Object.prototype.hasOwnProperty.call(TIERS, detail) ? detail : "full";
    const t = (this.tier = TIERS[this.detail]);
    const g = (this.geo = acquireGeo(this.detail));
    // no node seed (a standalone figure): a per-instance one, so a set of them is still mixed
    this.seed = Number.isFinite(seed) ? seed : instanceSeed;
    const female = (this.female = seededGender(this.seed) === "female");
    const fg = female ? acquireFemaleGeo(this.detail) : null;
    // P-VIZ.7: the sponsor's size class scales the whole figure (a flagship stands taller than a mini)
    const brandScale = brand && Number.isFinite(brand.scale) && brand.scale > 0 ? brand.scale : 1;
    this.size = (female ? 0.97 : 1) * brandScale;
    this.flat = flat;
    this.weapon = WEAPONS[variantOf(brand?.variant, this.seed)]!;
    this.paint.lashes = female;
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
    this.mWeapon = toon({ vertexColors: true });
    this.mWeaponGlow = basic({ ...fx, opacity: this.weapon === "disc" ? 0.75 : 0, side: THREE.DoubleSide });
    this.setLook(look);

    // ---- the rig (the lab's buildFigure)
    const thin = t.smallInk ? 2 : 0;
    const smallThick = t.smallInk ? 1 : 0;
    const G = () => new THREE.Group();
    const root = (this.root = G()), hips = G(), spine = G(), chest = (this.chest = G()), neck = G(), head = G();
    this.group.add(this.body);
    this.body.scale.setScalar(ANIME_SCALE * Math.min(MAX_SIZE, this.size));
    this.body.add(root);
    root.add(hips); hips.position.y = 0.86; hips.add(spine); spine.add(chest); chest.position.y = 0.26; chest.add(neck); neck.position.y = 0.36; neck.add(head); head.position.y = 0.08;

    // torso: a sleeveless gi vest over a broad chest (hers slimmer), a V opening shows the accent undershirt; her
    // lapels are accent trim
    const pelvis = this.add(hips, g.pelvis, this.mGi, 1); pelvis.position.y = -0.03;
    if (female) pelvis.scale.set(1.22, 0.8, 0.92); else pelvis.scale.set(1.18, 0.78, 0.92);
    const torso = this.add(spine, g.torso, this.mGi, 1);
    if (female) torso.scale.set(0.93, 1, 0.72); else torso.scale.set(1, 1, 0.76);
    const vee = this.add(chest, g.vee, this.mAccent, 0); vee.rotation.set(Math.PI, Math.PI / 6 + Math.PI, 0); vee.position.set(0, 0.25, 0.185); vee.scale.set(1, 1, 0.16);
    for (let s = -1; s <= 1; s += 2) {
      if (g.lapel) { const l = this.add(chest, g.lapel, female ? this.mAccent : this.mGiDark, thin); l.position.set(s * 0.06, 0.25, female ? 0.19 : 0.2); l.rotation.set(0.1, 0, s * 0.45); }
      if (g.beltTail) { const bt = this.add(hips, g.beltTail, this.mAccent, thin); bt.position.set(0.06 + s * 0.035, 0, 0.205); bt.rotation.z = s * 0.25; bt.scale.z = 0.5; }
    }
    const belt = this.add(hips, g.belt, this.mAccent, 1); belt.rotation.x = Math.PI / 2; belt.scale.set(1.13, 0.9, 1); belt.position.y = 0.1;
    this.add(hips, g.knot, this.mAccent, smallThick).position.set(0.06, 0.1, 0.195);
    this.add(neck, g.neck, this.mSkin, 1);
    const trap = this.add(chest, g.trap, this.mGi, 1); trap.scale.set(female ? 1.3 : 1.45, 0.45, female ? 0.72 : 0.75); trap.position.y = 0.33; // the neck sits in the shoulders

    // head: an anime skull with a tapered jaw, the fitted mask, the canvas eye band, the headband and its tails
    const skull = (this.skull = G()); head.add(skull); skull.position.y = 0.2;
    this.add(skull, g.head, this.mSkin, 1);
    if (g.ear) for (let s = -1; s <= 1; s += 2) { const e = this.add(skull, g.ear, this.mSkin, thin); e.scale.set(0.45, 1, 0.8); e.position.set(s * 0.262, -0.02, -0.01); }
    this.add(skull, g.mask, this.mGiDark, 1);
    const band = new THREE.Mesh(g.band, this.mBand); band.renderOrder = 1; skull.add(band);
    const hb = this.add(skull, g.headband, this.mAccent, 1); hb.rotation.x = Math.PI / 2 - 0.06; hb.position.y = 0.168; hb.scale.set(1, 1.02, 1);
    const plate = this.add(skull, g.plate, mPlate, thin); plate.position.set(0, 0.18, 0.255); plate.rotation.x = -0.2;
    skull.add(this.tails); this.tails.position.set(0, 0.16, -0.26);
    for (let s = -1; s <= 1; s += 2) { const tl = this.add(this.tails, g.tail, this.mAccent, thin); tl.position.set(s * 0.05, -0.12, -0.09); tl.rotation.set(-1.0, 0, s * 0.35); tl.scale.set(1.6, 1, 0.4); }
    this.add(skull, fg ? fg.hair : g.hair, this.mHair, 1);
    if (fg) {
      // her ponytail on its own pivot (it sways), tied with an accent band
      const pony = (this.pony = G());
      skull.add(pony);
      pony.position.set(PONY_AT[0], PONY_AT[1], PONY_AT[2]);
      this.add(pony, fg.pony, this.mHair, 1);
      this.add(pony, g.knot, this.mAccent, smallThick).scale.set(1.1, 1.1, 0.9);
    }

    // arms: sculpted deltoid, bicep, forearm; accent wristbands (hers longer); rounded fists with a thumb. L is -X.
    const arm = (side: number): [THREE.Group, THREE.Group] => {
      const sh = G(); chest.add(sh); sh.position.set(side * (female ? 0.29 : 0.31), 0.3, 0);
      this.add(sh, g.deltoid, this.mSkin, 1).scale.set(1.05, 0.95, 0.95);
      this.add(sh, g.upperArm, this.mSkin, 1);
      const el = G(); sh.add(el); el.position.y = -0.27;
      this.add(el, g.foreArm, this.mSkin, 1);
      const wrap = this.add(el, g.wrist, this.mAccent, smallThick);
      wrap.position.y = female ? -0.16 : -0.175;
      if (female) wrap.scale.y = 1.5;
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

    // ---- P-VIZ.7 (ADR-0641): the sponsor patches, worn like a sponsored athlete's: across the front of the gi (on
    // the spine, which carries the torso, just under the V) and on the front of the left thigh (on its hip, so it
    // follows the leg); the 2D map and the lowest tier keep only the front patch. Each is the sponsor's emblem on a
    // white stitched backing, so a dark sponsor field still reads on a dark gi.
    if (brand) {
      const cv = document.createElement("canvas");
      cv.width = PATCH_W;
      cv.height = PATCH_H;
      const ctx = cv.getContext("2d");
      if (ctx) {
        ctx.fillStyle = "#f4f6fa";
        ctx.strokeStyle = "#0a0a12";
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.roundRect(3, 3, PATCH_W - 6, PATCH_H - 6, 34);
        ctx.fill();
        ctx.stroke();
        drawEmblem(ctx, brand, 16, 16, PATCH_W - 32, PATCH_H - 32);
      }
      const tex = (this.patchTex = new THREE.CanvasTexture(cv));
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      const mPatch = toon({ map: tex, transparent: true, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.45, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
      // the torso's front at that height (its cross-section is the torso mesh's scale), tilted with its taper
      const rz = CHEST_PATCH_R * (female ? 0.72 : 0.76);
      const cp = new THREE.Mesh(g.patchChest, mPatch);
      cp.position.set(0, CHEST_PATCH_Y, rz + PATCH_LIFT);
      cp.rotation.x = CHEST_SLOPE;
      spine.add(cp);
      if (!flat && this.detail !== "minimal") {
        const tp = new THREE.Mesh(g.patchThigh, mPatch);
        tp.position.set((THIGH_R + PATCH_LIFT) * Math.sin(THIGH_PATCH_A), -0.15, (THIGH_R + PATCH_LIFT) * Math.cos(THIGH_PATCH_A));
        tp.rotation.y = THIGH_PATCH_A;
        hipL.add(tp);
      }
    }

    // ---- P-VIZ.7: the variant's weapon on its mount, its in-hand copy (the right hand; the kunai both) and the
    // thrown copies (body space); updateWeapon shows the one the weapon move's clock asks for
    const wg = acquireWeaponGeo(this.detail, this.weapon);
    const wInk = t.smallInk ? 2 : 0;
    const handR = this.hands[1]!;
    if (this.weapon === "katana") {
      // diagonally across the back, the hilt up over the right shoulder
      const back = G(); chest.add(back);
      back.position.set(0.2, 0.47, -0.27);
      back.quaternion.setFromUnitVectors(Z_AXIS, this.v1.set(-0.55, -0.83, 0.04).normalize());
      this.add(back, wg.sheath!, this.mWeapon, wInk);
      this.onMount.push(this.add(back, wg.hilt!, this.mWeapon, wInk));
      // in the fist the blade tilts down toward the forearm's line, so a forward arm holds it level
      const grip = G(); handR.add(grip);
      grip.rotation.x = 0.5;
      this.add(grip, wg.held, this.mWeapon, wInk);
      this.inHand.push(grip);
    } else if (this.weapon === "staff") {
      const back = G(); chest.add(back);
      back.position.set(0, 0.16, -0.3);
      back.quaternion.setFromUnitVectors(Z_AXIS, this.v1.set(0.55, 0.83, 0).normalize());
      this.onMount.push(this.add(back, wg.held, this.mWeapon, wInk));
      // spun about the forearm's axis (the hand's Y), with a faint accent blur disc while it whirls
      const spin = (this.spinner = G()); handR.add(spin);
      this.add(spin, wg.held, this.mWeapon, wInk);
      const blur = (this.spinBlur = new THREE.Mesh(g.ring, this.mWeaponGlow));
      blur.rotation.x = Math.PI / 2;
      blur.scale.setScalar(1.45);
      blur.raycast = () => {};
      spin.add(blur);
      this.inHand.push(spin);
    } else if (this.weapon === "kunai") {
      const hipsLR = [hipL, hipR];
      for (let i = 0; i < 2; i++) {
        const s = i === 0 ? -1 : 1, hip = hipsLR[i]!;
        // a pouch on the outside of each thigh, a kunai standing in it ring up
        this.add(hip, wg.sheath!, this.mWeapon, wInk).position.set(s * 0.16, -0.135, 0);
        const k = this.add(hip, wg.held, this.mWeapon, wInk);
        k.position.set(s * 0.16, -0.03, 0);
        k.rotation.x = Math.PI / 2;
        this.onMount.push(k);
        // held point out past the fist, in line with the forearm (a throwing grip)
        const h = this.add(this.hands[i]!, wg.held, this.mWeapon, wInk);
        h.rotation.x = Math.PI / 2;
        this.inHand.push(h);
        const f = this.add(this.body, wg.held, this.mWeapon, wInk);
        f.rotation.order = "YXZ";
        this.thrown.push(f);
      }
    } else {
      // the chakram flat against the back of the belt; held at its rim, it lies in the hand's plane past the fingers
      this.onMount.push(this.add(hips, wg.held, this.mWeapon, wInk));
      this.onMount[0]!.position.set(0, 0.02, -0.25);
      const h = this.add(handR, wg.held, this.mWeapon, wInk);
      h.position.set(0, -0.17, 0);
      h.add(new THREE.Mesh(wg.glow!, this.mWeaponGlow));
      this.inHand.push(h);
      const f = this.add(this.body, wg.held, this.mWeapon, wInk);
      f.add(new THREE.Mesh(wg.glow!, this.mWeaponGlow));
      this.thrown.push(f);
    }
    for (const m of this.inHand) m.visible = false;
    for (const m of this.thrown) m.visible = false;

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

    // supervise: a small holo checklist floating at his -X side, tilted toward him; a box ticks on every glance
    root.add(this.checklist);
    this.checklist.position.set(-0.5, 1.08, 0.42);
    this.checklist.rotation.set(-0.35, 0.45, 0);
    const panel = new THREE.Mesh(g.kbPlane, this.mKbPlane); panel.scale.set(0.4, 1.3, 1); this.checklist.add(panel);
    const frame = new THREE.LineSegments(g.kbEdges, this.mKbLine); frame.scale.set(0.4, 1.3, 1); this.checklist.add(frame);
    for (let r = 0; r < CHECK_ROWS; r++) {
      const y = 0.1 - (r * 0.2) / Math.max(1, CHECK_ROWS - 1);
      const boxM = new THREE.Mesh(g.kbKey, this.mKey); boxM.position.set(-0.085, y, 0.002); boxM.scale.setScalar(0.8); this.checklist.add(boxM);
      const line = new THREE.Mesh(g.kbKey, this.mKey); line.position.set(0.035, y, 0.002); line.scale.set(2.8, 0.22, 1); this.checklist.add(line);
      this.checkBoxes.push(boxM);
    }

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
    this.segClip = a;
    this.cycle = 0;
    this.snapshot(BLEND_S, false);
  }

  setCommit(on: boolean): void {
    if (this.disposed || on === this.commitOn) return;
    this.commitOn = on === true;
    if (!this.commitOn) return;
    // a fresh commit starts the loop from its first key; one that lands while the last is still fading picks up
    if (this.wCommit < 0.01) this.commitT = 0;
    this.ensureCommitFx();
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

  react(kind: ReactionKind, camera: THREE.Camera): void {
    if (this.disposed || this.state === "killed" || !REACTION_KINDS.includes(kind) || !camera) return;
    // a reaction during a reaction restarts from the weights already on (this.rs), so nothing pops
    this.reaction = planReaction(kind, this.random(), this.rs);
    this.reactT = 0;
    this.reactCam = camera;
    if (kind === "outburst") {
      this.ensureRageFx();
      this.flash = 0.6;
    }
  }

  hit(kind: HitKind, from: THREE.Vector3, camera: THREE.Camera, strength = 1): void {
    if (this.disposed || this.state === "killed" || !(HIT_KINDS.includes(kind) || isTrayReactionKind(kind))) return; // P-VIZ.TRAY2: or a tray reaction
    animeHitCharge(this.chg, kind, strength);
    this.chargeNow = chargeLevel(this.chg);
    // the new hit chains (throwing stars), turns on from the weight already on and blends in from the pose on
    // screen, so a hit that lands mid-reaction or mid-hit never pops
    const prev = this.hitPlan;
    this.hitPlan = planHit(kind, strength, prev, this.hitT, prev ? this.hs.turn : 0);
    this.hitT = 0;
    this.hitSnap.set(this.out);
    this.hitAtCam = !(from && Number.isFinite(from.x) && Number.isFinite(from.y) && Number.isFinite(from.z));
    if (!this.hitAtCam) this.hitFrom.copy(from);
    this.hitCam = camera ?? null;
    if (this.reaction) this.endReaction(); // a hit replaces a stare or an outburst
    if (kind === "bolt") this.flash = 0.6;
  }

  get charge(): number {
    return this.chargeNow;
  }

  setIdleSeconds(_sec: number): void {
    // the anime figure has no idle props; the office worker uses this
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

  update(tSec: number, dt: number, motion: boolean): void {
    if (this.disposed) return;
    const d = motion && Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.1) : 0;
    this.life += d;
    this.stateT += d;
    this.blendT += d;
    this.kS = motion ? this.kS + (this.k - this.kS) * (1 - Math.exp(-d * 3)) : this.k;
    // ---- the charge decays on the wall clock (under reduced motion too, where the frame's dt is 0)
    const dc = tSec > this.clockAt ? Math.min(tSec - this.clockAt, 5) : d;
    if (Number.isFinite(tSec)) this.clockAt = tSec;
    this.chargeNow = chargeLevel(decayCharge(this.chg, dc));
    // supercharged: the activity runs faster
    const tempo = tempoFor(this.state, this.kS) * chargeTempo(this.chargeNow);
    this.actT += d * tempo;
    // ---- P-VIZ.7: the commit layer's weights (the pose blends in fast, the cloud gathers slower and lingers, the
    // bolt only fires once the arm is up and cuts out first); under reduced motion they jump
    const committing = this.commitOn && this.state !== "killed";
    this.commitT += d;
    this.wCommit = approach(this.wCommit, committing ? 1 : 0, motion ? d / (committing ? COMMIT_IN_S : COMMIT_OUT_S) : 1);
    this.wCloud = approach(this.wCloud, committing ? 1 : 0, motion ? d / (committing ? CLOUD_IN_S : CLOUD_OUT_S) : 1);
    this.wBolt = approach(this.wBolt, committing && this.wCommit >= BOLT_AT ? 1 : 0, motion ? d / 0.12 : 1);
    if (!motion) this.shot = null;
    if (this.shot) {
      this.shotT += d;
      if (clipDone(CLIPS[this.shot], this.shotT)) {
        this.shot = null;
        this.snapshot(BLEND_S, false);
      }
    }
    // ---- the reaction layer's clock: dropped without motion or once he is knocked out
    const rs = this.rs;
    if (this.reaction && (!motion || this.state === "killed")) this.endReaction();
    if (this.reaction) {
      this.reactT += d;
      if (sampleReaction(this.reaction, this.reactT, rs).done) this.endReaction();
    }
    // ---- the hit layer's clock (P-VIZ.6): dropped like a reaction (the charge it left stays)
    const hs = this.hs;
    if (this.hitPlan && (!motion || this.state === "killed")) this.endHit();
    if (this.hitPlan) {
      this.hitT += d;
      if (sampleHit(this.hitPlan, this.hitT, hs, this.hitPose).done) this.endHit();
    }

    // ---- the pose: a clip sample, blended from the last change
    const base: ClipName = clipFor(this.state, this.activity);
    const onActivity = base === this.activity;
    // P-VIZ.7: each loop of a weapon slot is the activity's own clip or the variant's weapon move (decided at the
    // loop boundary, blended across it)
    if (onActivity && motion && WEAPON_SLOTS.includes(this.activity)) {
      const len = CLIPS[this.segClip].len;
      if (this.actT >= len) {
        // (a clock that ran on while a state clip played catches up in one step)
        const loops = Math.floor(this.actT / len);
        this.actT -= loops * len;
        this.cycle += loops;
        const next: ClipName = weaponTurn(this.activity, this.seed, this.cycle) ? WEAPON_CLIP[this.weapon] : this.activity;
        if (next !== this.segClip) {
          this.segClip = next;
          this.snapshot(0.25, false);
        }
      }
    }
    const baseT = onActivity ? this.actT : this.stateT;
    const info = this.info;
    if (!motion) {
      sampleClip(CLIPS[base], STILL_T[base], this.tgt, info);
      this.cur.set(this.tgt);
      this.blendT = this.blendDur;
    } else {
      if (this.shot) sampleClip(CLIPS[this.shot], this.shotT, this.tgt, info);
      else sampleClip(CLIPS[onActivity ? this.segClip : base], baseT, this.tgt, info);
      if (this.blendT >= this.blendDur) this.cur.set(this.tgt);
      else {
        const u = this.blendT / this.blendDur;
        const w = this.blendSnap ? 1 - (1 - u) * (1 - u) * (1 - u) : u * u * (3 - 2 * u);
        for (let i = 0; i < POSE_LEN; i++) this.cur[i] = this.from[i]! + (this.tgt[i]! - this.from[i]!) * w;
      }
    }
    const emotion = hs.emotion ?? rs.emotion ?? (this.wCommit > 0.5 ? "raiden" : this.shot ? info.emotion : stateEmotion(this.state, info.emotion));

    // ---- effect weights (a hit holding the body puts the activity's effects away; so do a weapon move and the
    // commit)
    const act = this.activity;
    const live = onActivity && this.shot === null && hs.body < 0.5 && this.segClip === act && this.wCommit < 0.5;
    // P-VIZ.7: where the weapon is (in the hand only during its move, never through the commit)
    const ws = this.ws;
    if (onActivity && motion && this.segClip !== act && this.shot === null && this.wCommit < 0.3) weaponAt(this.weapon, this.actT, ws);
    else { ws.hand = false; ws.fly = -1; ws.spin = 0; ws.blur = 0; }
    const actClipT = clipTime(CLIPS[act], motion ? this.actT : STILL_T[act]);
    const speed = act === "dash" ? dashSpeed(actClipT) : 0;
    const rate = motion ? d / FX_S : 1;
    this.wType = approach(this.wType, live && act === "typing" ? 1 : 0, rate);
    this.wRing = approach(this.wRing, live && act === "meditate" ? 1 : 0, rate);
    this.wKi = approach(this.wKi, live && act === "kiblast" ? 1 : 0, rate);
    this.wDash = approach(this.wDash, live && act === "dash" ? speed : 0, rate * 3);
    // (widened to ClipName so this reads the same before and after MiniActivity carries "supervise")
    const supervising = (act as ClipName) === "supervise";
    this.wCheck = approach(this.wCheck, live && supervising ? 1 : 0, rate);
    // the charge keeps a small aura burning (the hits flare it)
    const auraT = Math.max(this.shot === "powerup" ? auraLevel(this.shotT) : 0, rs.aura, hs.aura, CHARGE_AURA * this.chargeNow, 0.6 * this.wCommit);
    this.wAura = approach(this.wAura, auraT, rate * 2);
    this.wSmoke = approach(this.wSmoke, this.state === "killed" && this.stateT > 0.5 ? 1 : 0, motion ? d / 1.2 : 1);
    this.wPause = approach(this.wPause, this.state === "paused" ? 1 : 0, motion ? d / 0.8 : 1);

    // ---- procedural layers
    const o = this.out;
    o.set(this.cur);
    // P-VIZ.7: the commit stance over whatever he was doing, by its (smoothed) weight
    if (this.wCommit > 0.001) {
      sampleClip(CLIPS.commit, motion ? this.commitT : STILL_T.commit, this.commitPose, this.commitInfo);
      const wc = this.wCommit * this.wCommit * (3 - 2 * this.wCommit), cp = this.commitPose;
      for (let i = 0; i < POSE_LEN; i++) o[i] = o[i]! + (cp[i]! - o[i]!) * wc;
    }
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
      // the bolt arm trembles with the current running through it
      o[O_SHR] += 0.02 * Math.sin(this.life * 47) * this.wBolt;
      o[O_SHR + 2] += 0.015 * Math.sin(this.life * 61 + 1) * this.wBolt;
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
    if (rs.turn > 0.001 || rs.rage > 0.001) this.layerReaction(o);
    if (hs.body > 0.001) this.layerHit(o, motion);
    this.apply(o);
    // the energy balls grow him (never out of his cube)
    this.body.scale.setScalar(ANIME_SCALE * Math.min(MAX_SIZE, this.size * orbScale(this.chg)));
    const sway = motion ? 1 : 0;
    this.tails.rotation.set(0.12 * Math.sin(this.life * 3.1) * sway + 0.35 * this.wDash + 0.3 * this.dead, 0.18 * Math.sin(this.life * 2.3 + 1) * sway, 0);
    if (this.pony) this.pony.rotation.set(0.08 * Math.sin(this.life * 2.6 + 0.4) * sway + 0.3 * this.wDash + 0.25 * this.dead, 0.14 * Math.sin(this.life * 1.9 + 2) * sway, 0);

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
    // a reaction owns the lids (no natural blinks, only the stare's slow one) and looks straight down the turn
    // (so does a hit: no blinks while it owns the eyes)
    const bl = emo.shape !== "open" || hs.emotion !== null ? 0 : rs.emotion !== null ? rs.blink : blinkStep(this.blinkAge);
    const gb = gazeBucket(info.gaze * (1 - Math.max(rs.turn, hs.turn * hs.body)));
    const key = eyeKey(emotion, bl, gb);
    if (key !== this.eyeKeyNow) {
      this.eyeKeyNow = key;
      if (this.eyeCtx) drawEyeBand(this.eyeCtx, this.paint, emo, BLINK_LEVELS[bl]!, gazeOfBucket(gb), this.tier.eyeScale);
      this.eyeTex.needsUpdate = true;
    }

    this.updateColors(d, motion);
    this.updateFx(d, motion, act === "kiblast" ? actClipT : -1, speed, br, auraT);
    this.updateChecklist(supervising ? (motion ? this.actT : STILL_T.supervise) : -1);
    this.updateRageFx();
    this.updateWeapon(d);
    this.updateCommitFx(motion);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.group.removeFromParent();
    for (const m of this.mats) m.dispose();
    this.eyeTex.dispose();
    if (this.rageFx) {
      this.rageFx.tex.dispose();
      this.rageFx.geo.dispose();
    }
    this.patchTex?.dispose();
    const cf = this.commitFx;
    if (cf) {
      cf.bolt.geo.dispose();
      for (const f of cf.forks) f.geo.dispose();
      cf.sparkGeo?.dispose();
      this.commitFx = null;
    }
    releaseWeaponGeo(this.detail, this.weapon);
    this.reactCam = null;
    this.hitPlan = null;
    this.hitCam = null;
    releaseGeo(this.detail);
    if (this.female) releaseFemaleGeo(this.detail);
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

  private endReaction(): void {
    this.reaction = null;
    this.reactCam = null;
    clearReaction(this.rs);
  }

  /** The reaction over the activity pose. First the outburst: the raised fists on the upper body (shaking), a
   *  body tremble and the stomp. Then the turn: the yaw to the camera spread over spine, chest, neck and head
   *  (the root takes what they cannot), the head pitched to the camera's height, glaring from under the brows. */
  private layerReaction(o: Float32Array): void {
    const rs = this.rs;
    const rage = rs.rage;
    if (rage > 0.001) {
      const p = POSE_VECTORS.outburst;
      for (const j of RAGE_JOINTS) for (let c = j; c < j + 3; c++) o[c] = o[c]! + (p[c]! - o[c]!) * rage;
      const sh = Math.sin(this.life * 32);
      o[O_ELL] += 0.25 * sh * rage; o[O_ELR] -= 0.25 * sh * rage;
      o[O_SHL] += 0.08 * sh * rage; o[O_SHR] -= 0.08 * sh * rage;
      o[0] += 0.012 * Math.sin(this.life * 61) * rage;
    }
    if (rs.stomp > 0) {
      o[1] -= 0.05 * rs.stomp;
      o[0] += 0.035 * Math.sin(this.life * 83) * rs.stomp;
    }
    const cam = this.reactCam;
    const w = rs.turn;
    if (w <= 0.001 || !cam) return;
    cam.getWorldPosition(this.v1);
    this.turnToward(o, w, GLARE_DIP, 0.06); // glaring from under the brows, with a slight suspicious tilt
  }

  /** The turn toward the world point in `v1` by weight `w`: the yaw spread over spine, chest, neck and head (the
   *  root takes what they cannot), the head pitched to the point's height less `dip`, tilted by `tilt` (null keeps
   *  the pose's own tilt). */
  private turnToward(o: Float32Array, w: number, dip: number, tilt: number | null): void {
    // the point in the body's frame (lab units, facing +Z); the last render's matrices are current enough
    const v = this.body.worldToLocal(this.v1);
    const horiz = Math.hypot(v.x, v.z), dy = v.y - EYE_Y;
    let need = Math.atan2(v.x, v.z) - o[O_ROOT + 1]! - o[O_HIPS + 1]!;
    need -= Math.round(need / TAU) * TAU;
    // a camera overhead (the 2D map) has no meaningful heading: turn less the steeper it looks down
    distributeYaw(need * Math.min(1, horiz / Math.max(1e-6, Math.abs(dy))), this.yaw);
    const y = this.yaw;
    o[O_ROOT + 1] += y[0]! * w;
    o[O_SPINE + 1] += (y[1]! - o[O_SPINE + 1]!) * w;
    o[O_CHEST + 1] += (y[2]! - o[O_CHEST + 1]!) * w;
    o[O_NECK + 1] += (y[3]! - o[O_NECK + 1]!) * w;
    o[O_HEAD + 1] += (y[4]! - o[O_HEAD + 1]!) * w;
    const lean = o[O_HIPS]! + o[O_SPINE]! + o[O_CHEST]! + o[O_NECK]!;
    const headX = Math.min(0.9, Math.max(-0.9, -Math.atan2(dy, horiz) - lean + dip));
    o[O_HEAD] += (headX - o[O_HEAD]!) * w;
    if (tilt !== null) o[O_HEAD + 2] += (tilt - o[O_HEAD + 2]!) * w;
  }

  private endHit(): void {
    this.hitPlan = null;
    this.hitCam = null;
    clearHit(this.hs);
  }

  /** The hit over the pose: the hit clip's pose (already in hitPose) turned toward the throw (keeping the clip's
   *  head tilt), blended in from the pose on screen when it landed, then laid over the activity by its weight. */
  private layerHit(o: Float32Array, motion: boolean): void {
    const hs = this.hs, hp = this.hitPose, snap = this.hitSnap;
    const cam = this.hitAtCam ? this.hitCam : null;
    if (hs.turn > 0.001 && (cam || !this.hitAtCam)) {
      if (cam) cam.getWorldPosition(this.v1);
      else this.v1.copy(this.hitFrom);
      this.turnToward(hp, hs.turn, HIT_DIP, null);
    }
    if (hs.blend < 1) for (let i = 0; i < POSE_LEN; i++) hp[i] = snap[i]! + (hp[i]! - snap[i]!) * hs.blend;
    const w = hs.body;
    for (let i = 0; i < POSE_LEN; i++) o[i] = o[i]! + (hp[i]! - o[i]!) * w;
    if (motion && hs.shake > 0) o[0] += 0.035 * Math.sin(this.life * 83) * hs.shake;
  }

  private ensureRageFx(): void {
    if (this.rageFx) return;
    const cv = document.createElement("canvas");
    cv.width = cv.height = 64;
    const ctx = cv.getContext("2d");
    if (ctx) drawAngerMark(ctx, 64);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const geo = new THREE.PlaneGeometry(1, 1);
    const mMark = this.own(new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
    const mSteam = this.own(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, toneMapped: false }));
    // effects only: never a pick target
    const noPick = (): void => {};
    const mark = new THREE.Mesh(geo, mMark);
    mark.position.set(0.22, 0.14, 0.17); // the temple, just off the skull
    mark.renderOrder = 3;
    mark.raycast = noPick;
    mark.visible = false;
    this.skull.add(mark);
    const steam: THREE.Mesh[] = [];
    for (let i = 0; i < STEAM_PUFFS; i++) {
      const p = new THREE.Mesh(this.geo.puff, mSteam);
      p.raycast = noPick;
      p.visible = false;
      this.skull.add(p);
      steam.push(p);
    }
    this.rageFx = { mark, mMark, mSteam, steam, geo, tex };
  }

  /** The anger mark pops and pulses at the temple facing the camera; steam puffs rise off both sides of the head. */
  private updateRageFx(): void {
    const fx = this.rageFx;
    if (!fx) return;
    const rs = this.rs;
    fx.mark.visible = rs.mark > 0.01;
    if (fx.mark.visible) {
      fx.mark.scale.setScalar(0.17 * rs.mark * (1 + 0.18 * Math.sin(this.life * 16)));
      fx.mMark.opacity = Math.min(1, rs.mark * 1.5);
      const cam = this.reactCam;
      if (cam) fx.mark.quaternion.copy(this.skull.getWorldQuaternion(this.q1).invert()).multiply(cam.getWorldQuaternion(this.q2));
    }
    const on = rs.steam > 0.01;
    fx.mSteam.opacity = 0.75 * rs.steam;
    const n = fx.steam.length;
    for (let i = 0; i < n; i++) {
      const p = fx.steam[i]!;
      p.visible = on;
      if (!on) continue;
      const f = fract(this.life * 1.4 + i / n);
      const side = i % 2 === 0 ? -1 : 1;
      p.position.set(side * (0.17 + 0.12 * f), 0.24 + 0.4 * f, -0.02);
      p.scale.setScalar(0.001 + (0.035 + 0.075 * f) * (1 - f * f) * rs.steam);
    }
  }

  /** supervise: the holo checklist grows in with the activity; `t` (the supervise clock, -1 when not
   *  supervising) ticks a box on every glance. */
  private updateChecklist(t: number): void {
    const cl = this.checklist;
    cl.visible = this.wCheck > 0.01;
    if (!cl.visible) return;
    cl.scale.setScalar(this.wCheck);
    if (t < 0) return;
    const n = checklistTicks(t);
    if (n === this.ticksNow) return;
    this.ticksNow = n;
    for (let i = 0; i < this.checkBoxes.length; i++) this.checkBoxes[i]!.material = i < n ? this.mKeyHot : this.mKey;
  }

  /** P-VIZ.7: the weapon on its mount, in the hand(s) or in flight, as the move's clock says (ws, sampled in
   *  update). A thrown kunai flies from its hand out along the throw and drops away; the chakram arcs out, curves
   *  aside and comes back to the throwing hand, spinning flat. */
  private updateWeapon(d: number): void {
    const ws = this.ws;
    const flying = ws.fly >= 0;
    for (const m of this.onMount) m.visible = !ws.hand && !flying;
    for (const m of this.inHand) m.visible = ws.hand;
    if (this.spinner) {
      this.spinner.rotation.y = ws.spin;
      this.spinBlur!.visible = ws.blur > 0.02;
      this.mWeaponGlow.opacity = 0.4 * ws.blur;
    }
    const n = this.thrown.length;
    for (let i = 0; i < n; i++) this.thrown[i]!.visible = flying;
    if (!flying) {
      this.flying = false;
      return;
    }
    if (!this.flying) {
      // released: from the hand, away from the chest and forward
      this.flying = true;
      const c = this.body.worldToLocal(this.chest.getWorldPosition(this.v2));
      for (let i = 0; i < n; i++) {
        const from = this.body.worldToLocal(this.hands[n === 2 ? i : 1]!.getWorldPosition(this.flyFrom[i]!));
        const dir = this.flyDir[i]!.subVectors(from, c).setY(0);
        if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
        dir.normalize();
        dir.z += 1.2;
        dir.normalize();
      }
    }
    const u = ws.fly;
    if (this.weapon === "kunai") {
      const fade = Math.max(0.001, 1 - smoothEase((u - 0.7) / 0.3));
      for (let i = 0; i < n; i++) {
        const m = this.thrown[i]!, dir = this.flyDir[i]!;
        m.position.copy(this.flyFrom[i]!).addScaledVector(dir, u * KUNAI_RANGE);
        m.position.y -= 0.12 * u * u;
        m.rotation.set(0.25 * u, Math.atan2(dir.x, dir.z), 0);
        m.scale.setScalar(fade);
      }
      return;
    }
    const m = this.thrown[0]!, f = this.flyDir[0]!;
    const back = this.body.worldToLocal(this.hands[1]!.getWorldPosition(this.v3));
    const out = Math.sin(Math.PI * u), side = 0.35 * Math.sin(TAU * u);
    m.position.lerpVectors(this.flyFrom[0]!, back, smoothEase(u)).addScaledVector(f, DISC_RANGE * out);
    m.position.x += f.z * side;
    m.position.z -= f.x * side;
    m.position.y += 0.15 * out;
    this.discSpin += d * 28;
    m.rotation.set(Math.PI / 2, 0, this.discSpin);
  }

  /** P-VIZ.7: builds the commit storm once (most nodes commit at some point; the parts are then reused). */
  private ensureCommitFx(): void {
    if (this.commitFx) return;
    const t = this.tier, g = this.geo;
    const noPick = (): void => {};
    const fx = { transparent: true, blending: THREE.AdditiveBlending, depthWrite: false } as const;
    const mBolt = this.own(new THREE.ShaderMaterial({
      ...fx, side: THREE.DoubleSide,
      uniforms: { uC: { value: BOLT_BLUE.clone() }, uA: { value: 0 } },
      vertexShader: BOLT_VS, fragmentShader: BOLT_FS,
    }));
    const bolt = ribbon(t.bolt, mBolt);
    bolt.mesh.renderOrder = 4;
    this.body.add(bolt.mesh);
    const forks: Ribbon[] = [];
    for (let f = 0; f < t.forks; f++) {
      const r = ribbon(FORK_SEG, mBolt);
      r.mesh.renderOrder = 4;
      this.body.add(r.mesh);
      forks.push(r);
    }
    // the storm cloud, Raiden style: a dark charcoal-navy storm head (a flat dark underside, lumpy billows heaped on
    // it), inked, with a thin bright rim so it reads against the dark sky, and lit blue-white from inside by the
    // bolt's flashes
    const mCloud = this.own(new THREE.MeshToonMaterial({ gradientMap: toonGrad(this.flat ? 2 : 3), toneMapped: false, color: "#151a28", emissive: "#a6dcff", emissiveIntensity: 0, transparent: true, opacity: 0 }));
    // the puffs' ink fades with them (object space: about 0.02 lab units on a 0.4 puff), the rim just outside it
    const mCloudInk = this.own(inkMat(0.05));
    mCloudInk.transparent = true;
    mCloudInk.opacity = 0;
    const mCloudRim = this.own(inkMat(0.1));
    mCloudRim.color.set("#8fd0ff");
    mCloudRim.blending = THREE.AdditiveBlending;
    mCloudRim.transparent = true;
    mCloudRim.depthWrite = false;
    mCloudRim.opacity = 0;
    const cloud = new THREE.Group();
    cloud.position.set(CLOUD_X, CLOUD_Y, CLOUD_Z);
    cloud.visible = false;
    this.body.add(cloud);
    // per puff (CLOUD_FIELDS): angle, radius, height, size, flatness. Puff 0 is the flat dark underside the bolt
    // hits, puff 1 the tall central billow; the rest are rounded billows of varied size heaped round it (lumpy from
    // above and from the side), and the full tier's last puff is a subtle top shelf.
    const puffAt = new Float32Array(t.cloud * CLOUD_FIELDS);
    const puffs: THREE.Mesh[] = [];
    const shelf = t.cloud >= 10 ? t.cloud - 1 : -1;
    for (let k = 0; k < t.cloud; k++) {
      const at = k * CLOUD_FIELDS;
      if (k === 0) puffAt.set([0, 0, 0, 0.82, 0.18], at);
      else if (k === 1) puffAt.set([0, 0, 0.24, 0.5, 0.85], at);
      else if (k === shelf) puffAt.set([0.6, 0.1, 0.56, 0.5, 0.16], at);
      else puffAt.set([k * 2.4, 0.32 + 0.26 * fract(k * 0.618), 0.1 + 0.2 * fract(k * 0.37), 0.28 + 0.2 * fract(k * 0.53), 0.82], at);
      const p = new THREE.Mesh(g.puff, mCloud);
      p.raycast = noPick;
      if (t.smallInk) {
        const ink = new THREE.Mesh(g.puff, mCloudInk);
        ink.raycast = noPick;
        p.add(ink);
      }
      const rim = new THREE.Mesh(g.puff, mCloudRim);
      rim.raycast = noPick;
      p.add(rim);
      cloud.add(p);
      puffs.push(p);
    }
    // the glow at the fist and over the eyes
    const mGlow = this.own(new THREE.MeshBasicMaterial({ ...fx, color: 0xcdeeff, opacity: 0, toneMapped: false }));
    const glow = new THREE.Mesh(g.puff, mGlow);
    glow.position.y = -0.1;
    glow.raycast = noPick;
    glow.visible = false;
    this.hands[1]!.add(glow);
    const mEye = this.own(new THREE.MeshBasicMaterial({ ...fx, color: 0xbfe9ff, opacity: 0, toneMapped: false }));
    const eyes: THREE.Mesh[] = [];
    for (let s = -1; s <= 1; s += 2) {
      // over the eye band's eyes (canvas x 384 +- 138, y 104 on the band's patch of the head sphere)
      const e = new THREE.Mesh(g.puff, mEye);
      e.position.set(s * 0.103, 0.041, 0.252);
      e.scale.set(0.075, 0.04, 0.02);
      e.renderOrder = 2;
      e.raycast = noPick;
      e.visible = false;
      this.skull.add(e);
      eyes.push(e);
    }
    // sparks spraying off the fist (none at the lowest tier)
    const sparkPos = new Float32Array(t.sparks * 3), sparkDir = new Float32Array(t.sparks * 3);
    const mSpark = this.own(new THREE.PointsMaterial({ ...fx, color: 0xdff4ff, size: 0.06, sizeAttenuation: true, opacity: 0, toneMapped: false }));
    let sparks: THREE.Points | null = null, sparkGeo: THREE.BufferGeometry | null = null;
    if (t.sparks > 0) {
      for (let k = 0; k < t.sparks; k++) {
        const a = this.random() * TAU, up = 0.2 + 0.8 * this.random(), h = Math.sqrt(1 - up * up);
        sparkDir[k * 3] = Math.cos(a) * h;
        sparkDir[k * 3 + 1] = up;
        sparkDir[k * 3 + 2] = Math.sin(a) * h;
      }
      sparkGeo = new THREE.BufferGeometry();
      const attr = new THREE.BufferAttribute(sparkPos, 3);
      attr.setUsage(THREE.DynamicDrawUsage);
      sparkGeo.setAttribute("position", attr);
      sparks = new THREE.Points(sparkGeo, mSpark);
      sparks.frustumCulled = false;
      sparks.raycast = noPick;
      sparks.visible = false;
      this.body.add(sparks);
    }
    this.commitFx = {
      bolt, forks, mBolt, jit: new Float32Array((t.bolt + 1) * 3),
      forkRel: new Float32Array(t.forks * (FORK_SEG + 1) * 3), forkAt: new Int32Array(t.forks), forkOn: new Uint8Array(t.forks),
      cloud, puffs, puffAt, mCloud, mCloudInk, mCloudRim, glow, mGlow, eyes, mEye, sparks, sparkGeo, sparkPos, sparkDir, mSpark, tick: -1,
    };
  }

  /** A new jagged shape: every bolt joint wanders sideways (pinned at the hand and the cloud), and each fork picks
   *  a joint to leave from, a heading and a zigzag climbing toward the cloud, or stays dark this tick. */
  private jitterBolt(fx: CommitFx): void {
    const n = fx.bolt.n, j = fx.jit;
    for (let i = 0; i <= n; i++) {
      const taper = i === 0 || i === n ? 0 : 0.35 + 0.65 * Math.sin((Math.PI * i) / n);
      j[i * 3] = (this.random() * 2 - 1) * BOLT_AMP * taper;
      j[i * 3 + 1] = (this.random() * 2 - 1) * 0.03 * taper;
      j[i * 3 + 2] = (this.random() * 2 - 1) * BOLT_AMP * 0.7 * taper;
    }
    const m = FORK_SEG, rel = fx.forkRel;
    for (let f = 0; f < fx.forks.length; f++) {
      fx.forkOn[f] = this.random() < 0.6 ? 1 : 0;
      fx.forkAt[f] = 2 + Math.floor(this.random() * (n - 4));
      const a = this.random() * TAU, len = 0.5 + 0.45 * this.random();
      const ca = Math.cos(a), sa = Math.sin(a), o = f * (m + 1) * 3;
      for (let k = 0; k <= m; k++) {
        const u = k / m, z = k === 0 ? 0 : (this.random() * 2 - 1) * 0.09;
        rel[o + k * 3] = ca * len * u + z;
        rel[o + k * 3 + 1] = 0.75 * len * u + 0.5 * z;
        rel[o + k * 3 + 2] = 0.8 * sa * len * u - z;
      }
    }
  }

  /** P-VIZ.7: the commit storm. The bolt runs from the raised fist to the cloud's underside, re-jittered BOLT_HZ
   *  times a second (its points rewritten in place), flickering, with forks, sparks and a glow at the fist; the
   *  cloud gathers in and churns slowly, then spreads out as it fades; the eye glow follows the commit weight.
   *  Without motion: one static bolt, a still cloud, no sparks, no flicker. */
  private updateCommitFx(motion: boolean): void {
    const fx = this.commitFx;
    if (!fx) return;
    const boltOn = this.wBolt > 0.01, cloudOn = this.wCloud > 0.01, eyesOn = this.wCommit > 0.05;
    fx.bolt.mesh.visible = boltOn;
    fx.glow.visible = boltOn;
    fx.cloud.visible = cloudOn;
    for (const e of fx.eyes) e.visible = eyesOn;
    if (fx.sparks) fx.sparks.visible = boltOn && motion;
    if (!boltOn) for (const f of fx.forks) f.mesh.visible = false;
    if (!boltOn && !cloudOn && !eyesOn) return;
    if (motion) {
      const tick = Math.floor(this.life * BOLT_HZ);
      if (tick !== fx.tick) {
        fx.tick = tick;
        this.jitterBolt(fx);
        this.flick = 0.6 + 0.4 * this.random();
      }
    } else {
      if (fx.tick < 0) {
        fx.tick = 0;
        this.jitterBolt(fx);
      }
      this.flick = 1;
    }
    fx.mEye.opacity = Math.min(1, this.wCommit * 1.2) * (motion ? 0.75 + 0.25 * this.flick : 0.9);
    if (boltOn) {
      const s = this.body.worldToLocal(this.hands[1]!.getWorldPosition(this.v1));
      s.y += 0.1;
      const b = fx.bolt, n = b.n, j = fx.jit, p = b.pts;
      const ey = CLOUD_Y - 0.2;
      for (let i = 0; i <= n; i++) {
        const u = i / n;
        p[i * 3] = s.x + (CLOUD_X - s.x) * u + j[i * 3]!;
        p[i * 3 + 1] = s.y + (ey - s.y) * u + j[i * 3 + 1]!;
        p[i * 3 + 2] = s.z + (CLOUD_Z - s.z) * u + j[i * 3 + 2]!;
      }
      writeRibbon(b, 0.3, 0.46);
      const m = FORK_SEG;
      for (let f = 0; f < fx.forks.length; f++) {
        const r = fx.forks[f]!;
        r.mesh.visible = fx.forkOn[f] === 1;
        if (!r.mesh.visible) continue;
        const at = fx.forkAt[f]! * 3, o = f * (m + 1) * 3;
        for (let k = 0; k <= m; k++) {
          r.pts[k * 3] = p[at]! + fx.forkRel[o + k * 3]!;
          r.pts[k * 3 + 1] = p[at + 1]! + fx.forkRel[o + k * 3 + 1]!;
          r.pts[k * 3 + 2] = p[at + 2]! + fx.forkRel[o + k * 3 + 2]!;
        }
        writeRibbon(r, 0.18, 0.05);
      }
      const pulse = motion ? 0.88 + 0.12 * Math.sin(this.life * 41) : 1;
      fx.mBolt.uniforms.uA!.value = this.wBolt * this.flick * pulse;
      fx.mGlow.opacity = 0.8 * this.wBolt * this.flick;
      fx.glow.scale.setScalar(0.12 * (motion ? 1 + 0.25 * Math.sin(this.life * 33) : 1));
      if (fx.sparks && motion) {
        const sp = fx.sparkPos, dir = fx.sparkDir, count = sp.length / 3;
        for (let k = 0; k < count; k++) {
          const f = fract(this.life * 2.3 + k * 0.618);
          const r = 0.05 + 0.34 * f;
          sp[k * 3] = s.x + dir[k * 3]! * r;
          sp[k * 3 + 1] = s.y + dir[k * 3 + 1]! * r - 0.2 * f * f;
          sp[k * 3 + 2] = s.z + dir[k * 3 + 2]! * r;
        }
        fx.sparkGeo!.attributes.position!.needsUpdate = true;
        fx.mSpark.opacity = 0.9 * this.wBolt * this.flick;
      }
    }
    if (cloudOn) {
      // gathers in from wide and small, spreads out wide as it fades
      const w = this.wCloud, grow = CLOUD_SIZE * (0.35 + 0.65 * w * w * (3 - 2 * w)), spread = 1 + 0.9 * (1 - w);
      fx.cloud.scale.setScalar(grow);
      fx.mCloud.opacity = w * (this.flat ? 0.6 : 0.97);
      fx.mCloudInk.opacity = w * w * (this.flat ? 0.6 : 1);
      // the inside flashes with the bolt: the brighter jitter ticks light it hard, the dim ones barely (a steady
      // middle glow under reduced motion)
      const f = clamp01((this.flick - 0.6) / 0.4), flash = motion ? f * f : 0.35;
      fx.mCloud.emissiveIntensity = this.wBolt * (0.06 + 0.55 * flash);
      fx.mCloudRim.opacity = w * (0.3 + 0.45 * flash * this.wBolt);
      const churn = motion ? this.life * 0.25 : 0, pa = fx.puffAt;
      for (let k = 0; k < fx.puffs.length; k++) {
        const q = fx.puffs[k]!, at = k * CLOUD_FIELDS;
        const a = pa[at]! + (k % 2 === 0 ? churn : -churn), r = pa[at + 1]! * spread, sz = pa[at + 3]!;
        q.position.set(Math.cos(a) * r, pa[at + 2]! + 0.25 * (spread - 1), Math.sin(a) * r * 0.75);
        q.scale.set(sz, sz * pa[at + 4]!, sz * 0.9);
      }
    }
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
    // supercharged: the accent burns brighter while the charge lasts, flaring white-hot as a bolt strikes
    if (this.hs.crackle > 0) acc.lerp(WHITE, 0.5 * this.hs.crackle);
    this.mAccent.color.copy(acc);
    this.mAccent.emissive.copy(acc);
    // P-VIZ.7: the commit lights him blue-white with the bolt's flicker (accent, hair and aura)
    const wc = this.wCommit, lit = wc * (0.7 + 0.3 * this.flick);
    this.mAccent.emissiveIntensity = (this.glow + this.flash + 0.6 * this.chargeNow + 0.5 * this.hs.crackle) * (1 - this.dead) + 0.5 * lit;
    // the powerup: the hair glows the accent
    this.mHair.emissive.copy(acc).lerp(BOLT_BLUE, wc);
    this.mHair.emissiveIntensity = Math.max(0.35 * this.wAura, 0.55 * lit);
    this.mWeaponGlow.color.copy(acc);
    this.mKbPlane.color.copy(acc);
    this.mKey.color.copy(acc);
    this.mKbLine.color.copy(acc);
    for (let i = 0; i < this.mKiHalo.length; i++) this.mKiHalo[i]!.color.copy(acc);
    // the outburst's flare burns toward red
    (this.mAura.uniforms.uC!.value as THREE.Color).copy(acc).lerp(RAGE_RED, 0.7 * Math.min(1, this.rs.aura / 0.8)).lerp(BOLT_BLUE, 0.8 * wc);
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
      // a boost (the bolt, the Storm) crackles: the flames run faster and shimmer; under reduced motion they hold still
      const crackle = motion ? Math.max(this.hs.crackle, this.chg.boost) : 0;
      u.uT!.value = (u.uT!.value as number) + d * (1 + 1.5 * crackle);
      u.uA!.value = this.wAura * (1 - 0.18 * crackle * (0.5 + 0.5 * Math.sin(this.life * 37) * Math.sin(this.life * 23)));
    }

    // the energy ball held between the hands while he absorbs it (the ki ball's meshes, not firing)
    const ab = this.hs.absorb;
    if (ab > 0.001) {
      const mid = this.hands[0]!.getWorldPosition(this.v1).add(this.hands[1]!.getWorldPosition(this.v2)).multiplyScalar(0.5);
      this.body.worldToLocal(mid);
      ki.visible = true;
      ki.position.copy(mid);
      ki.scale.setScalar(Math.max(0.001, 0.9 * ab * (1 + (motion ? 0.08 * Math.sin(this.life * 18) : 0))));
      this.mKiCore.opacity = ab;
      for (let i = 0; i < this.mKiHalo.length; i++) this.mKiHalo[i]!.opacity = HALO_ALPHA[i]! * ab;
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

/** `seed`: the node's id hash (viz_scene), which picks the ninja or the kunoichi stably for the node.
 *  `brand` (P-VIZ.7, ADR-0641): the node's sponsor from its model (viz_brand.vizBrandFor); null while the model is
 *  unknown (no patches, scale 1, the weapon from the seed). Constructor-only: the scene rebuilds on a change. */
export function createAnimeFigure(o: { look: MiniLook; detail: AnimeDetail; flat: boolean; seed?: number; brand?: VizBrand | null }): AnimeFigure {
  return new Anime(o.look, o.detail, o.flat, o.seed ?? Number.NaN, o.brand ?? null);
}
