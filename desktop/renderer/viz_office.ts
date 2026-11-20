// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_office.ts - P-VIZ.4 (ADR-0627): the professional office cast for the Visualize view.
//
// The "professional" style's figure, the twin of viz_anime.ts with the same handle, detail tiers, toon shading
// (MeshToonMaterial over a stepped ramp), inverted-hull ink outline and canvas-face technique, so viz_scene can
// swap one for the other per node. Original comic-strip office characters (no borrowed designs): flat toon
// colors, bold ink, a big head on a compact seated body.
//   Worker: a short-sleeve dress shirt tinted pastel toward the persona color, a tie IN the persona color,
//     slacks, sometimes glasses; an office chair at a desk with a monitor (persona-colored code scrolling on the
//     screen while he works, dim when idle), a keyboard, a coffee mug and a paper pile.
//   Boss (the hub): a charcoal suit, white shirt, persona tie, gray hair ring, reading glasses and a mustache, at
//     a larger wooden desk with a report pile, a clipboard, a mug and a nameplate.
// The face is a canvas texture on a patch of the head sphere (eyes, brows, mouth, glasses, mustache, a sweat
// drop) drawn from an OfficeEmotion and redrawn only when the emotion, the blink step or the gaze bucket changes.
// The canvas is transparent, so a red face (the outburst) is the skin material turning red under it.
//
// 3D: the worker's whole diorama (desk, chair, him, and the optional low fabric cubicle) is turned OFFICE_YAW_3D
// inside the figure, so a camera on the figure's +Z (viz_scene turns the holder to the camera) sees his face
// three-quarter and the monitor's screen at an angle at the same time. 2D (flat): no turn, the monitor angled
// toward the viewer, 2 toon steps and a thicker ink.
//
// Animation: keyframe clips from viz_office_pose (smooth eases, snaps for slams), blended on every clip change,
// with procedural layers (breathing, typing taps, pen ticks, a shake) and reactions on top (react(): a stare at
// the camera, or an outburst then a glare) that never change what the agent is doing underneath. Geometry and
// the three shared canvases (code, clipboard checklist, the sleeping "Z") are shared per detail tier and
// ref-counted; materials, the face canvas and the per-figure screen texture (a clone sharing the code canvas's
// GPU upload) are per figure and freed by dispose(). update() allocates nothing.

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { BLINK_LEVELS, blinkStep, bump, fract, gazeBucket, gazeOfBucket, nextBlinkDelay, tapCurve } from "./viz_anime_pose.ts";
import {
  crtOff, ENTER_SLAM_S, enterTapBoost, lookAngles, mugHeld, OFFICE_CLIPS, OFFICE_EMOTIONS, OFFICE_POSE_LEN, OFFICE_STATES, OFFICE_STILL_T,
  officeClipDone, officeClipFor, officeClipTime, officeFaceKey, officeJointOffset, OFFICE_JOINTS, officeLook, officeTempo, officeTransitionShot,
  OUTBURST_S, pageFlipAt, paperFlight, printHeld, reactAt, sampleOfficeClip, stareHold, tapRate, zedAt,
  type Crt, type LookAngles, type MouthShape, type OfficeClipName, type OfficeClipSample, type OfficeEmotion,
  type OfficeLook, type OfficeRole, type OfficeState, type Paper, type ReactKind, type ReactSample, type Zed,
} from "./viz_office_pose.ts";
import { MINI_ACTIVITIES, type MiniActivity, type MiniLook } from "./viz_mini_look.ts";

export type { OfficeRole, OfficeState } from "./viz_office_pose.ts";
export type OfficeDetail = "full" | "reduced" | "minimal";

export interface OfficeFigure {
  /** The floor at the origin, the seated figure about 1 unit tall, facing +Z. Add it to any parent. */
  readonly group: THREE.Group;
  setActivity(a: MiniActivity): void;
  setIntensity(x: number): void;
  setState(s: OfficeState): void;
  /** A token surge: frantic typing with sweat. */
  burst(): void;
  setLook(l: MiniLook): void;
  /** The user tapped (stare) or double-tapped (outburst) him; layers over the activity, never changes state. */
  react(kind: ReactKind, camera: THREE.Camera): void;
  /** Seconds the agent has been idle: coffee under 60 s, head down on the desk after. */
  setIdleSeconds(sec: number): void;
  update(tSec: number, dt: number, motion: boolean): void;
  dispose(): void;
}

export interface OfficeFigureOptions {
  look: MiniLook;
  detail: OfficeDetail;
  flat: boolean;
  role: OfficeRole;
  /** Varies skin, hair and glasses across a fleet (viz_scene passes the node's id hash). */
  seed: number;
  /** 3D only: build the low fabric cubicle around the desk; its top edges are drawn with `status` (owned and
   *  recolored by the caller, never disposed here). */
  cubicle?: { status: THREE.LineBasicMaterial } | null;
}

/** The diorama's scale: the seated figure comes out about 1 unit tall, like viz_anime.ANIME_HEIGHT. */
const OFFICE_SCALE = 0.9;
/** 3D: how far the worker's diorama turns inside the figure (see the header). */
const OFFICE_YAW_3D = 0.35;

const TAU = Math.PI * 2;
const BLEND_S = 0.35;
const SNAP_BLEND_S = 0.1;
const FX_S = 0.25;
const INK_3D = 0.007;
const INK_FLAT = 0.012;
const INK = "#0a0a12";

// Layout (figure units, the floor at y 0, he faces +Z).
const SEAT_Y = 0.36;
const HIP_Y = 0.41;
const DESK_Y = 0.5;
const MONITOR_POS = [0.33, DESK_Y, 0.38] as const;
const MONITOR_YAW_3D = -1.4;
const MONITOR_YAW_FLAT = -0.6;
const SCREEN_Y = 0.2;

// ------------------------------------------------------------------------------------------ the face

const FW = 512, FH = 380;
const EYE_Y = 148, EYE_DX = 78;
interface FacePaint { glasses: boolean; boss: boolean; brow: string; mustache: string | null }

function drawEye(c: CanvasRenderingContext2D, cx: number, cy: number, inner: number, emo: OfficeEmotion, blink: number, gaze: number): void {
  c.strokeStyle = INK;
  if (emo.shape === "x") {
    c.lineWidth = 9;
    c.beginPath(); c.moveTo(cx - 26, cy - 26); c.lineTo(cx + 26, cy + 24); c.moveTo(cx + 26, cy - 26); c.lineTo(cx - 26, cy + 24); c.stroke();
    return;
  }
  if (emo.shape === "happy") {
    c.lineWidth = 9;
    c.beginPath(); c.moveTo(cx - 30, cy + 12); c.quadraticCurveTo(cx, cy - 30, cx + 30, cy + 12); c.stroke();
    return;
  }
  if (emo.shape === "closed") {
    c.lineWidth = 8;
    c.beginPath(); c.moveTo(cx - 32, cy + 2); c.quadraticCurveTo(cx, cy + 22, cx + 32, cy + 2); c.stroke();
    return;
  }
  if (emo.shape === "strain") {
    const ox = cx - inner * 30, ix = cx + inner * 26;
    c.lineWidth = 9;
    c.beginPath(); c.moveTo(ox, cy - 24); c.lineTo(ix, cy); c.lineTo(ox, cy + 22); c.stroke();
    return;
  }
  const rx = 40, ry = 44 * Math.max(1, emo.open);
  const open = Math.max(0.06, Math.min(1, emo.open) * (1 - blink));
  const top = cy - ry + (1 - open) * ry * 1.7;
  const tilt = emo.slant * 22; // the inner end of the lid drops (anger, effort)
  const x0 = cx - rx - 4, x1 = cx + rx + 4;
  const lid0 = top + tilt * (((x0 - cx) * inner) / rx), lid1 = top + tilt * (((x1 - cx) * inner) / rx);
  const bot = cy + ry - emo.lower * 22;
  c.save();
  c.beginPath(); c.ellipse(cx, cy, rx, ry, 0, 0, TAU); c.clip();
  c.beginPath(); c.moveTo(x0, lid0); c.lineTo(x1, lid1); c.lineTo(x1, bot); c.lineTo(x0, bot); c.closePath(); c.clip();
  c.fillStyle = "#ffffff"; c.fillRect(x0, cy - ry - 4, x1 - x0, ry * 2 + 8);
  const pr = Math.max(5, 15 * emo.pupil), px = cx + gaze * 16, py = cy + 6;
  c.fillStyle = INK; c.beginPath(); c.arc(px, py, pr, 0, TAU); c.fill();
  c.fillStyle = "#ffffff"; c.beginPath(); c.arc(px - pr * 0.35, py - pr * 0.4, Math.max(1.5, pr * 0.3), 0, TAU); c.fill();
  c.lineWidth = 9; c.beginPath(); c.ellipse(cx, cy, rx, ry, 0, 0, TAU); c.stroke(); // clipped: only the visible rim
  c.restore();
  if (open < 0.97 || tilt !== 0) {
    c.save();
    c.beginPath(); c.ellipse(cx, cy, rx + 4, ry + 4, 0, 0, TAU); c.clip();
    c.lineWidth = 8; c.beginPath(); c.moveTo(x0, lid0); c.lineTo(x1, lid1); c.stroke();
    c.restore();
  }
}

function drawMouth(c: CanvasRenderingContext2D, m: MouthShape, x: number, y: number): void {
  c.save();
  c.translate(x, y);
  c.strokeStyle = INK; c.lineWidth = 7;
  c.beginPath();
  switch (m) {
    case "flat": c.moveTo(-28, 0); c.lineTo(28, 0); c.stroke(); break;
    case "smile": c.moveTo(-34, -6); c.quadraticCurveTo(0, 20, 34, -6); c.stroke(); break;
    case "frown": c.moveTo(-30, 10); c.quadraticCurveTo(0, -12, 30, 10); c.stroke(); break;
    case "smirk": c.moveTo(-26, 4); c.quadraticCurveTo(2, 6, 24, -6); c.lineTo(30, -2); c.stroke(); break;
    case "wavy": c.moveTo(-30, 0); c.quadraticCurveTo(-22, -8, -15, 0); c.quadraticCurveTo(-7, 8, 0, 0); c.quadraticCurveTo(7, -8, 15, 0); c.quadraticCurveTo(22, 8, 30, 0); c.stroke(); break;
    case "o":
      c.fillStyle = "#4a1414"; c.ellipse(0, 4, 11, 14, 0, 0, TAU); c.fill(); c.lineWidth = 5; c.stroke(); break;
    case "shout":
      c.moveTo(-40, -14); c.lineTo(40, -14); c.quadraticCurveTo(36, 34, 0, 38); c.quadraticCurveTo(-36, 34, -40, -14); c.closePath();
      c.fillStyle = "#5a1010"; c.fill();
      c.fillStyle = "#ffffff"; c.fillRect(-36, -14, 72, 10);
      c.lineWidth = 6; c.stroke(); break;
    case "grit":
      c.rect(-30, -11, 60, 22); c.fillStyle = "#ffffff"; c.fill(); c.lineWidth = 5; c.stroke();
      c.lineWidth = 3; c.beginPath(); c.moveTo(-30, 0); c.lineTo(30, 0);
      for (let k = -15; k <= 15; k += 15) { c.moveTo(k, -11); c.lineTo(k, 11); }
      c.stroke(); break;
  }
  c.restore();
}

/** The whole face from one emotion, on a transparent canvas in the 512 x 380 face units. */
function drawFace(c: CanvasRenderingContext2D, p: FacePaint, emo: OfficeEmotion, blink: number, gaze: number, scale: number): void {
  c.setTransform(scale, 0, 0, scale, 0, 0);
  c.clearRect(0, 0, FW, FH);
  c.lineCap = "round";
  c.lineJoin = "round";
  for (let side = -1; side <= 1; side += 2) {
    const cx = FW / 2 + side * EYE_DX, inner = -side;
    drawEye(c, cx, EYE_Y, inner, emo, blink, gaze);
    // the brow's angle is the emotion: a positive brow pulls the inner end down
    c.save();
    c.translate(cx + inner * 4, EYE_Y - 66 - emo.browY * 34);
    c.rotate(inner * emo.brow * 0.5);
    c.strokeStyle = p.brow; c.lineWidth = p.boss ? 16 : 11;
    c.beginPath(); c.moveTo(-36, 0); c.quadraticCurveTo(0, -8, 36, 0); c.stroke();
    c.restore();
  }
  if (p.mustache) {
    c.fillStyle = p.mustache; c.strokeStyle = INK; c.lineWidth = 4;
    for (let side = -1; side <= 1; side += 2) {
      c.beginPath(); c.ellipse(FW / 2 + side * 24, 262, 30, 12, side * 0.15, 0, TAU); c.fill(); c.stroke();
    }
  }
  drawMouth(c, emo.mouth, FW / 2, p.mustache ? 302 : 292);
  if (p.glasses) {
    c.strokeStyle = INK; c.lineWidth = 7;
    for (let side = -1; side <= 1; side += 2) {
      const cx = FW / 2 + side * EYE_DX;
      c.beginPath();
      if (p.boss) { c.moveTo(cx - 50, EYE_Y + 6); c.lineTo(cx + 50, EYE_Y + 6); c.quadraticCurveTo(cx + 48, EYE_Y + 52, cx, EYE_Y + 52); c.quadraticCurveTo(cx - 48, EYE_Y + 52, cx - 50, EYE_Y + 6); }
      else {
        const x = cx - 52, y = EYE_Y - 46, w = 104, h = 92, r = 18;
        c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
      }
      c.fillStyle = "rgba(170,210,255,0.16)"; c.fill(); c.stroke();
      c.strokeStyle = "rgba(255,255,255,0.75)"; c.lineWidth = 5;
      c.beginPath(); c.moveTo(cx + 18, EYE_Y + (p.boss ? 14 : -32)); c.lineTo(cx + 34, EYE_Y + (p.boss ? 2 : -16)); c.stroke();
      c.strokeStyle = INK; c.lineWidth = 7;
      // the temple arm runs from the outer rim toward the ear
      c.beginPath(); c.moveTo(cx + side * 52, EYE_Y - 20); c.lineTo(FW / 2 + side * 200, EYE_Y - 26); c.stroke();
    }
    const by = p.boss ? EYE_Y + 10 : EYE_Y - 8;
    c.beginPath(); c.moveTo(FW / 2 - EYE_DX + 52, by); c.quadraticCurveTo(FW / 2, by - 10, FW / 2 + EYE_DX - 52, by); c.stroke();
  }
  if (emo.sweat) {
    const sx = FW / 2 + 196, sy = 66;
    c.fillStyle = "#bfe7ff"; c.strokeStyle = "#2a5d86"; c.lineWidth = 3;
    c.beginPath(); c.moveTo(sx, sy - 22); c.quadraticCurveTo(sx + 14, sy + 2, sx, sy + 12); c.quadraticCurveTo(sx - 14, sy + 2, sx, sy - 22); c.fill(); c.stroke();
  }
}

// ------------------------------------------------------------------------------------------ shared canvases

function codeCanvas(scale: number): HTMLCanvasElement {
  const w = Math.round(128 * scale), h = Math.round(256 * scale);
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const c = cv.getContext("2d");
  if (!c) return cv;
  c.fillStyle = "#0a0d12";
  c.fillRect(0, 0, w, h);
  let seed = 11;
  const rnd = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const rows = 32, rh = h / rows;
  let indent = 0;
  for (let r = 0; r < rows; r++) {
    if (rnd() < 0.12) continue;
    indent = Math.max(0, Math.min(4, indent + (rnd() < 0.3 ? 1 : rnd() < 0.3 ? -1 : 0)));
    let x = (4 + indent * 8) * scale;
    const words = 1 + Math.floor(rnd() * 4);
    for (let k = 0; k < words && x < w - 8 * scale; k++) {
      const len = (8 + rnd() * 26) * scale;
      const g = 140 + Math.floor(rnd() * 115);
      c.fillStyle = `rgb(${g},${g},${g})`;
      c.fillRect(x, r * rh + rh * 0.3, Math.min(len, w - 4 * scale - x), rh * 0.42);
      x += len + 5 * scale;
    }
  }
  return cv;
}

function checklistCanvas(): HTMLCanvasElement {
  const cv = document.createElement("canvas");
  cv.width = 128; cv.height = 160;
  const c = cv.getContext("2d");
  if (!c) return cv;
  c.fillStyle = "#fbfaf4"; c.fillRect(0, 0, 128, 160);
  c.fillStyle = "#9aa3b2"; c.fillRect(12, 12, 104, 8);
  c.lineCap = "round";
  for (let r = 0; r < 6; r++) {
    const y = 34 + r * 20;
    c.strokeStyle = "#3a3f4a"; c.lineWidth = 2; c.strokeRect(12, y, 12, 12);
    c.fillStyle = "#b7bdc8"; c.fillRect(32, y + 4, 60 + ((r * 37) % 24), 4);
    if (r < 4) {
      c.strokeStyle = "#1d3c8a"; c.lineWidth = 3;
      c.beginPath(); c.moveTo(13, y + 6); c.lineTo(18, y + 12); c.lineTo(27, y - 3); c.stroke();
    }
  }
  return cv;
}

function zedCanvas(): HTMLCanvasElement {
  const cv = document.createElement("canvas");
  cv.width = 64; cv.height = 64;
  const c = cv.getContext("2d");
  if (!c) return cv;
  c.font = "900 52px system-ui, -apple-system, \"Segoe UI\", sans-serif";
  c.textAlign = "center"; c.textBaseline = "middle";
  c.lineJoin = "round";
  c.strokeStyle = "#ffffff"; c.lineWidth = 8; c.strokeText("Z", 32, 34);
  c.fillStyle = INK; c.fillText("Z", 32, 34);
  return cv;
}

function canvasTex(cv: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ------------------------------------------------------------------------------------------ shading

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
  m.customProgramCacheKey = () => `office-ink-${width}`;
  return m;
}

// ------------------------------------------------------------------------------------------ detail tiers

type Seg = readonly [number, number];
interface Tier {
  /** Sphere [width, height] segments for the head and the big round parts; `small` for hands, ears, puffs. */
  head: Seg; small: Seg;
  /** Radial segments for limbs, mugs, the post. */
  limb: number;
  /** RoundedBox segments for furniture and shoes; 0 = a plain box. */
  box: number;
  /** Ink on the small parts (ears, nose, collar, tie, hands, props) and the extra details (ears, belt, collar). */
  smallInk: boolean; extras: boolean;
  faceScale: number; codeScale: number;
  papers: number; puffs: number; steam: number; drops: number; zeds: number;
}

const TIERS: Record<OfficeDetail, Tier> = {
  full: { head: [32, 24], small: [12, 10], limb: 14, box: 2, smallInk: true, extras: true, faceScale: 1, codeScale: 1, papers: 6, puffs: 8, steam: 4, drops: 3, zeds: 3 },
  reduced: { head: [22, 16], small: [8, 6], limb: 10, box: 1, smallInk: true, extras: true, faceScale: 1, codeScale: 1, papers: 4, puffs: 6, steam: 3, drops: 3, zeds: 3 },
  minimal: { head: [14, 10], small: [6, 4], limb: 6, box: 0, smallInk: false, extras: false, faceScale: 0.5, codeScale: 0.5, papers: 3, puffs: 4, steam: 2, drops: 2, zeds: 2 },
};

const TORSO: readonly Seg[] = [[0.0, -0.02], [0.125, 0.0], [0.135, 0.08], [0.15, 0.18], [0.16, 0.26], [0.15, 0.31], [0.09, 0.34], [0.0, 0.345]];

function box(w: number, h: number, d: number, seg: number, r: number): THREE.BufferGeometry {
  return seg > 0 ? new RoundedBoxGeometry(w, h, d, seg, Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4, d / 2 - 1e-4)) : new THREE.BoxGeometry(w, h, d);
}

/** Rotate (XYZ order) then move a geometry in place. */
function placed<T extends THREE.BufferGeometry>(g: T, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): T {
  if (rx) g.rotateX(rx);
  if (ry) g.rotateY(ry);
  if (rz) g.rotateZ(rz);
  g.translate(x, y, z);
  return g;
}

/** Merge static parts into one geometry (one draw call, one ink hull). */
function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const flat = parts.map((g) => (g.index ? g.toNonIndexed() : g));
  const m = mergeGeometries(flat, false)!;
  for (const g of parts) g.dispose();
  for (const g of flat) g.dispose();
  return m;
}

interface GeoSet {
  refs: number;
  pelvis: THREE.BufferGeometry; torso: THREE.BufferGeometry; belt: THREE.BufferGeometry | null; collar: THREE.BufferGeometry | null;
  tieKnot: THREE.BufferGeometry; tieBlade: THREE.BufferGeometry; vee: THREE.BufferGeometry; neck: THREE.BufferGeometry;
  head: THREE.BufferGeometry; face: THREE.BufferGeometry; ear: THREE.BufferGeometry | null; nose: THREE.BufferGeometry;
  hair: THREE.BufferGeometry; bossHair: THREE.BufferGeometry;
  shoulderCap: THREE.BufferGeometry; sleeve: THREE.BufferGeometry; upperArm: THREE.BufferGeometry; foreArm: THREE.BufferGeometry;
  jacketCap: THREE.BufferGeometry; jacketUpper: THREE.BufferGeometry; jacketFore: THREE.BufferGeometry; hand: THREE.BufferGeometry;
  thigh: THREE.BufferGeometry; shin: THREE.BufferGeometry; shoe: THREE.BufferGeometry;
  seat: THREE.BufferGeometry; back: THREE.BufferGeometry; bossBack: THREE.BufferGeometry; chairBase: THREE.BufferGeometry;
  deskTop: THREE.BufferGeometry; deskFrame: THREE.BufferGeometry; bossTop: THREE.BufferGeometry; bossFrame: THREE.BufferGeometry;
  monitor: THREE.BufferGeometry; screen: THREE.BufferGeometry; keyboard: THREE.BufferGeometry;
  mug: THREE.BufferGeometry; coffee: THREE.BufferGeometry; pile: THREE.BufferGeometry; sheet: THREE.BufferGeometry;
  report: THREE.BufferGeometry; page: THREE.BufferGeometry; board: THREE.BufferGeometry; clip: THREE.BufferGeometry; pen: THREE.BufferGeometry;
  nameplate: THREE.BufferGeometry;
  walls: THREE.BufferGeometry; trim: THREE.BufferGeometry; statusLines: THREE.BufferGeometry;
  puff: THREE.BufferGeometry;
  codeTex: THREE.CanvasTexture; checkTex: THREE.CanvasTexture; zedTex: THREE.CanvasTexture;
}

function buildGeo(t: Tier): GeoSet {
  const L = t.limb, S = t.small, B = t.box;
  const tieShape = new THREE.Shape();
  tieShape.moveTo(-0.018, 0); tieShape.lineTo(0.018, 0); tieShape.lineTo(0.034, -0.17); tieShape.lineTo(0, -0.205); tieShape.lineTo(-0.034, -0.17); tieShape.closePath();
  const hand = new THREE.SphereGeometry(0.046, S[0], S[1]);
  hand.scale(0.85, 1.1, 0.75);
  const star: THREE.BufferGeometry[] = [placed(new THREE.CylinderGeometry(0.022, 0.022, 0.25, L), 0, 0.165, -0.02)];
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * TAU;
    star.push(placed(new THREE.BoxGeometry(0.028, 0.022, 0.2), Math.sin(a) * 0.1, 0.045, Math.cos(a) * 0.1 - 0.02, 0, a));
    star.push(placed(new THREE.SphereGeometry(0.022, S[0], S[1]), Math.sin(a) * 0.2, 0.022, Math.cos(a) * 0.2 - 0.02));
  }
  const hairCap = new THREE.SphereGeometry(0.163, t.head[0], t.head[1] >> 1, 0, TAU, 0, Math.PI / 2);
  hairCap.rotateX(-0.45);
  hairCap.translate(0, 0.01, -0.01);
  const tuft = new THREE.SphereGeometry(0.07, S[0], S[1]);
  tuft.scale(1.4, 0.55, 1);
  placed(tuft, 0.05, 0.14, 0.06, 0, 0, -0.3);
  const ring = new THREE.TorusGeometry(0.15, 0.032, Math.max(4, S[1]), t.head[0] >> 1, Math.PI * 1.25);
  ring.rotateX(-Math.PI / 2);
  ring.rotateY(-0.39);
  ring.translate(0, 0.02, 0);
  const mug = new THREE.CylinderGeometry(0.035, 0.032, 0.075, L);
  mug.translate(0, 0.0375, 0);
  const handle = placed(new THREE.TorusGeometry(0.022, 0.007, 5, 10, Math.PI), 0.034, 0.04, 0, 0, 0, -Math.PI / 2);
  const deskH = DESK_Y - 0.035;
  const cube = (w: number, h: number, d: number, x: number, y: number, z: number): THREE.BufferGeometry => placed(new THREE.BoxGeometry(w, h, d), x, y, z);
  const lines = new THREE.BufferGeometry();
  const ty = 0.652;
  lines.setAttribute("position", new THREE.Float32BufferAttribute([
    -0.62, ty, -0.52, 0.62, ty, -0.52, -0.62, ty, -0.52, -0.62, ty, 0.32, 0.62, ty, -0.52, 0.62, ty, 0.32,
  ], 3));
  const codeTex = canvasTex(codeCanvas(t.codeScale));
  codeTex.wrapS = codeTex.wrapT = THREE.RepeatWrapping;
  return {
    refs: 0,
    pelvis: (() => { const g = new THREE.SphereGeometry(0.13, t.head[0] >> 1, t.head[1] >> 1); g.scale(1.15, 0.6, 1); return g; })(),
    torso: new THREE.LatheGeometry([...TORSO].map(([r, y]) => new THREE.Vector2(r, y)), Math.max(8, t.head[0] >> 1)),
    belt: t.extras ? placed(new THREE.TorusGeometry(0.128, 0.014, 4, Math.max(10, L + 4)), 0, 0, 0, Math.PI / 2) : null,
    collar: t.extras ? placed(new THREE.TorusGeometry(0.062, 0.018, 4, Math.max(10, L)), 0, 0.18, 0, Math.PI / 2) : null,
    tieKnot: box(0.032, 0.03, 0.02, Math.min(1, B), 0.006),
    tieBlade: new THREE.ExtrudeGeometry(tieShape, { depth: 0.01, bevelEnabled: false, curveSegments: 1 }),
    vee: new THREE.ConeGeometry(0.075, 0.2, 3),
    neck: new THREE.CylinderGeometry(0.05, 0.053, 0.1, L),
    head: new THREE.SphereGeometry(0.155, t.head[0], t.head[1]),
    // a patch of the head sphere just outside it, front centered: the face canvas (512 x 380) maps onto it as seen
    face: new THREE.SphereGeometry(0.1575, t.head[0], t.head[1], Math.PI / 2 - 0.9, 1.8, Math.PI * 0.3, Math.PI * 0.42),
    ear: t.extras ? (() => { const g = new THREE.SphereGeometry(0.035, S[0], S[1]); g.scale(0.5, 1, 0.8); return g; })() : null,
    nose: (() => { const g = new THREE.SphereGeometry(0.042, S[0], S[1]); g.scale(0.9, 0.8, 1.1); return g; })(),
    hair: merge([hairCap, tuft]),
    bossHair: ring,
    shoulderCap: new THREE.SphereGeometry(0.062, S[0], S[1]),
    sleeve: placed(new THREE.CylinderGeometry(0.062, 0.056, 0.1, L), 0, -0.04, 0),
    upperArm: placed(new THREE.CylinderGeometry(0.042, 0.038, 0.2, L), 0, -0.1, 0),
    foreArm: placed(new THREE.CylinderGeometry(0.038, 0.034, 0.19, L), 0, -0.095, 0),
    jacketCap: new THREE.SphereGeometry(0.07, S[0], S[1]),
    jacketUpper: placed(new THREE.CylinderGeometry(0.055, 0.05, 0.2, L), 0, -0.1, 0),
    jacketFore: placed(new THREE.CylinderGeometry(0.05, 0.046, 0.19, L), 0, -0.095, 0),
    hand,
    thigh: placed(new THREE.CylinderGeometry(0.07, 0.062, 0.3, L), 0, -0.15, 0),
    shin: placed(new THREE.CylinderGeometry(0.058, 0.05, 0.33, L), 0, -0.165, 0),
    shoe: box(0.085, 0.055, 0.17, B, 0.022),
    seat: box(0.36, 0.06, 0.34, B, 0.025),
    back: placed(box(0.34, 0.34, 0.05, B, 0.022), 0, 0.21, 0),
    bossBack: placed(box(0.4, 0.5, 0.06, B, 0.025), 0, 0.29, 0),
    chairBase: merge(star),
    deskTop: placed(box(1.05, 0.035, 0.4, B, 0.012), 0.025, DESK_Y - 0.0175, 0.38),
    deskFrame: merge([cube(0.03, deskH, 0.36, -0.49, deskH / 2, 0.38), cube(0.03, deskH, 0.36, 0.54, deskH / 2, 0.38), cube(1.0, 0.26, 0.02, 0.025, 0.32, 0.565)]),
    bossTop: placed(box(1.24, 0.045, 0.46, B, 0.014), 0, DESK_Y - 0.0225, 0.4),
    bossFrame: merge([cube(0.3, DESK_Y - 0.045, 0.42, -0.45, (DESK_Y - 0.045) / 2, 0.4), cube(0.3, DESK_Y - 0.045, 0.42, 0.45, (DESK_Y - 0.045) / 2, 0.4), cube(0.6, 0.3, 0.02, 0, 0.3, 0.62)]),
    monitor: merge([placed(box(0.34, 0.25, 0.04, B, 0.012), 0, SCREEN_Y, 0), cube(0.04, 0.1, 0.03, 0, 0.07, -0.01), cube(0.15, 0.014, 0.11, 0, 0.007, -0.005)]),
    screen: new THREE.PlaneGeometry(0.3, 0.21),
    keyboard: box(0.3, 0.02, 0.1, Math.min(1, B), 0.006),
    mug: merge([mug, handle]),
    coffee: placed(new THREE.CircleGeometry(0.031, L), 0, 0.066, 0, -Math.PI / 2),
    pile: box(0.15, 0.03, 0.19, 0, 0),
    sheet: new THREE.PlaneGeometry(0.14, 0.18),
    report: box(0.15, 0.21, 0.014, 0, 0),
    // the turning page hangs from its top edge (the staple), so its pivot is the edge
    page: placed(new THREE.PlaneGeometry(0.15, 0.21), 0, -0.105, 0, 0, Math.PI),
    board: box(0.16, 0.22, 0.01, 0, 0),
    clip: box(0.06, 0.02, 0.02, 0, 0),
    pen: new THREE.CylinderGeometry(0.006, 0.004, 0.11, 6),
    nameplate: box(0.18, 0.045, 0.03, Math.min(1, B), 0.008),
    walls: merge([cube(1.24, 0.62, 0.04, 0, 0.31, -0.52), cube(0.04, 0.62, 0.86, -0.62, 0.31, -0.11), cube(0.04, 0.62, 0.86, 0.62, 0.31, -0.11)]),
    trim: merge([cube(1.28, 0.03, 0.06, 0, 0.635, -0.52), cube(0.06, 0.03, 0.89, -0.62, 0.635, -0.11), cube(0.06, 0.03, 0.89, 0.62, 0.635, -0.11)]),
    statusLines: lines,
    puff: new THREE.SphereGeometry(1, S[0], S[1]),
    codeTex,
    checkTex: canvasTex(checklistCanvas()),
    zedTex: canvasTex(zedCanvas()),
  };
}

const GEO_CACHE = new Map<OfficeDetail, GeoSet>();

function acquireGeo(detail: OfficeDetail): GeoSet {
  let set = GEO_CACHE.get(detail);
  if (!set) {
    set = buildGeo(TIERS[detail]);
    GEO_CACHE.set(detail, set);
  }
  set.refs++;
  return set;
}

function releaseGeo(detail: OfficeDetail): void {
  const set = GEO_CACHE.get(detail);
  if (!set || --set.refs > 0) return;
  for (const v of Object.values(set)) if (v instanceof THREE.BufferGeometry || v instanceof THREE.Texture) v.dispose();
  GEO_CACHE.delete(detail);
}

// ------------------------------------------------------------------------------------------ the figure

const O_ROOT = officeJointOffset("root");
const O_SPINE = officeJointOffset("spine");
const O_CHEST = officeJointOffset("chest");
const O_NECK = officeJointOffset("neck");
const O_HEAD = officeJointOffset("head");
const O_SHL = officeJointOffset("shL");
const O_ELL = officeJointOffset("elL");
const O_SHR = officeJointOffset("shR");
const O_ELR = officeJointOffset("elR");
const DEAD_GRAY = new THREE.Color("#5a5f6a");
const RAGE = new THREE.Color("#ff4a3a");
let instanceSeed = 1;

function approach(w: number, target: number, rate: number): number {
  return w < target ? Math.min(target, w + rate) : Math.max(target, w - rate);
}

class Office implements OfficeFigure {
  readonly group = new THREE.Group();
  /** The diorama (turned and scaled); `body` inside it is the figure frame every pose and effect lives in. */
  private readonly rig = new THREE.Group();
  private readonly body = new THREE.Group();
  private readonly detail: OfficeDetail;
  private readonly tier: Tier;
  private readonly geo: GeoSet;
  private readonly role: OfficeRole;
  private readonly seed: number;
  private readonly mats: THREE.Material[] = [];
  private disposed = false;

  // materials
  private readonly mShirt: THREE.MeshToonMaterial;
  private readonly mTie: THREE.MeshToonMaterial;
  private readonly mSlacks: THREE.MeshToonMaterial;
  private readonly mJacket: THREE.MeshToonMaterial;
  private readonly mSkin: THREE.MeshToonMaterial;
  private readonly mHair: THREE.MeshToonMaterial;
  private readonly mWall: THREE.MeshToonMaterial;
  private readonly mTrim: THREE.MeshToonMaterial;
  private readonly mInk: THREE.MeshBasicMaterial;
  private readonly mInkThin: THREE.MeshBasicMaterial;
  private readonly mScreen: THREE.MeshBasicMaterial;
  private readonly mCrt: THREE.MeshBasicMaterial;
  private readonly mSmoke: THREE.MeshBasicMaterial;
  private readonly mSteam: THREE.MeshBasicMaterial;
  private readonly mSweat: THREE.MeshBasicMaterial;
  private readonly mCoffeeDrop: THREE.MeshBasicMaterial;
  private readonly mZed: THREE.SpriteMaterial;

  // look
  private lookNow: OfficeLook;
  private readonly cTie = new THREE.Color();
  private readonly cSkin = new THREE.Color();
  private readonly face: FacePaint;
  private readonly faceCtx: CanvasRenderingContext2D | null;
  private readonly faceTex: THREE.CanvasTexture;
  private readonly screenTex: THREE.Texture;
  private faceKeyNow = -1;

  // rig (OFFICE_JOINTS order)
  private readonly joints: THREE.Group[] = [];
  private readonly root: THREE.Group;
  private readonly skull = new THREE.Group();
  private readonly backPivot = new THREE.Group();
  private readonly handL: THREE.Group;
  private readonly handR: THREE.Group;

  // props and effects
  private readonly desk = new THREE.Group();
  private readonly keyboard: THREE.Mesh | null = null;
  private readonly screen: THREE.Mesh | null = null;
  private readonly crt: THREE.Mesh | null = null;
  private readonly deskMug = new THREE.Group();
  private readonly handMug = new THREE.Group();
  private readonly coffee: THREE.Mesh;
  private readonly printout: THREE.Mesh | null = null;
  private readonly report: THREE.Group | null = null;
  private readonly pagePivot = new THREE.Group();
  private readonly clipboard: THREE.Group | null = null;
  private readonly deskClipboard: THREE.Group | null = null;
  private readonly pen: THREE.Mesh | null = null;
  private readonly smoke = new THREE.Group();
  private readonly puffs: THREE.Mesh[] = [];
  private readonly puffR: Float32Array;
  private readonly steam = new THREE.Group();
  private readonly steamPuffs: THREE.Mesh[] = [];
  private readonly papers = new THREE.Group();
  private readonly paperMeshes: THREE.Mesh[] = [];
  private readonly drops = new THREE.Group();
  private readonly dropMeshes: THREE.Mesh[] = [];
  private readonly sweat = new THREE.Group();
  private readonly sweatMeshes: THREE.Mesh[] = [];
  private readonly zeds: THREE.Sprite[] = [];
  private readonly pileAt = new THREE.Vector3();
  private readonly smokeAt = new THREE.Vector3();

  // animation state
  private activity: MiniActivity = "typing";
  private state: OfficeState = "idle";
  private idleSec = 0;
  private base: OfficeClipName | null = null;
  private clipT = 0;
  private shot: "frantic" | "done" | null = null;
  private shotT = 0;
  private reactKind: ReactKind | null = null;
  private reactT = 0;
  private reactHold = 2;
  private reactCam: THREE.Camera | null = null;
  private k = 0.5;
  private kS = 0.5;
  private life = 0;
  private stateT = 0;
  private tapPh = 0;
  private tickPh = 0;
  private blendT = BLEND_S;
  private blendDur = BLEND_S;
  private blendSnap = false;
  private readonly from = new Float32Array(OFFICE_POSE_LEN);
  private readonly cur = new Float32Array(OFFICE_POSE_LEN);
  private readonly tgt = new Float32Array(OFFICE_POSE_LEN);
  private readonly out = new Float32Array(OFFICE_POSE_LEN);
  private readonly rpose = new Float32Array(OFFICE_POSE_LEN);
  private readonly info: OfficeClipSample = { emotion: "neutral", gaze: 0 };
  private readonly rinfo: OfficeClipSample = { emotion: "neutral", gaze: 0 };
  private readonly rs: ReactSample = { body: 0, look: 0, lift: 0, emotion: null, red: 0, steam: 0, shake: 0, papers: -1, slosh: 0, done: true };
  private readonly look: LookAngles = { yaw: 0, pitch: 0 };
  private readonly crtS: Crt = { sx: 0, sy: 0, a: 0 };
  private readonly paperS: Paper = { x: 0, y: 0, z: 0, rx: 0, rz: 0 };
  private readonly zedS: Zed = { x: 0, y: 0, s: 0, a: 0 };
  private readonly v1 = new THREE.Vector3();
  private readonly v2 = new THREE.Vector3();
  private readonly q1 = new THREE.Quaternion();
  private readonly q2 = new THREE.Quaternion();
  private readonly q3 = new THREE.Quaternion();
  private readonly e1 = new THREE.Euler();
  private wType = 0;
  private wTick = 0;
  private wSmoke = 0;
  private wSweat = 0;
  private wZed = 0;
  private scr = 0.25;
  private scroll = 0;
  private flash = 0;
  private kbHit = 0;
  private dead = 0;
  private glow = 0.2;
  private blinkIn: number;
  private blinkAge = 99;
  private rng: number;
  private readonly phase: number;

  constructor(o: OfficeFigureOptions) {
    this.detail = Object.prototype.hasOwnProperty.call(TIERS, o.detail) ? o.detail : "full";
    this.role = o.role === "boss" ? "boss" : "worker";
    this.seed = Number.isFinite(o.seed) ? o.seed : 0;
    const t = (this.tier = TIERS[this.detail]);
    const g = (this.geo = acquireGeo(this.detail));
    const boss = this.role === "boss";
    const flat = o.flat;
    this.rng = (instanceSeed++ * 2654435761) >>> 0 || 1;
    this.phase = this.random() * TAU;
    this.blinkIn = nextBlinkDelay(this.random());
    this.group.name = boss ? "office-boss" : "office-worker";
    this.lookNow = officeLook(o.look, this.seed, this.role);

    // ---- materials (untoned like the anime figure, so the persona color stays itself)
    const grad = toonGrad(flat ? 2 : 3);
    const toon = (p: THREE.MeshToonMaterialParameters = {}) => this.own(new THREE.MeshToonMaterial({ gradientMap: grad, toneMapped: false, ...p }));
    const basic = (p: THREE.MeshBasicMaterialParameters) => this.own(new THREE.MeshBasicMaterial({ toneMapped: false, ...p }));
    this.mShirt = toon();
    this.mTie = toon({ emissiveIntensity: 0.15 });
    this.mSlacks = toon();
    this.mJacket = toon();
    this.mSkin = toon();
    this.mHair = toon();
    this.mWall = toon();
    this.mTrim = toon({ emissiveIntensity: 0.25 });
    const mShoe = toon({ color: "#1d1a19" });
    const mChair = toon({ color: "#2a2e36" });
    const mMetal = toon({ color: "#8d939c" });
    const mDesk = toon({ color: boss ? "#7a4e2d" : "#bfc3ca" });
    const mDeskFrame = toon({ color: boss ? "#5a3820" : "#6b7079" });
    const mMonitor = toon({ color: "#cfcab9" });
    const mKeyboard = toon({ color: "#dcd8cc" });
    const mMug = toon({ color: "#f1f1ee" });
    const mCoffee = toon({ color: "#3b2314" });
    const mPaper = toon({ color: "#fbfaf4", side: THREE.DoubleSide });
    const mBoard = toon({ color: "#9a6a3a" });
    const mCheck = toon({ map: g.checkTex, side: THREE.DoubleSide });
    const mPen = toon({ color: "#1d3c8a" });
    const cv = document.createElement("canvas");
    cv.width = Math.round(FW * t.faceScale);
    cv.height = Math.round(FH * t.faceScale);
    this.faceCtx = cv.getContext("2d");
    this.faceTex = new THREE.CanvasTexture(cv);
    this.faceTex.colorSpace = THREE.SRGBColorSpace;
    this.faceTex.anisotropy = 4;
    const mFace = toon({ map: this.faceTex, transparent: true });
    const ink = flat ? INK_FLAT : INK_3D;
    this.mInk = this.own(inkMat(ink));
    this.mInkThin = this.own(inkMat(ink * 0.6));
    this.screenTex = g.codeTex.clone(); // shares the code canvas's GPU upload, keeps its own scroll offset
    this.screenTex.repeat.set(1, 0.5);
    this.screenTex.offset.y = this.random();
    this.mScreen = basic({ map: this.screenTex });
    this.mCrt = basic({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false });
    this.mSmoke = basic({ color: 0x4a4f5c, transparent: true, opacity: 0.35, depthWrite: false });
    this.mSteam = basic({ color: 0xf4f6ff, transparent: true, opacity: 0, depthWrite: false });
    this.mSweat = basic({ color: 0xbfe7ff });
    this.mCoffeeDrop = basic({ color: 0x5a3a20 });
    this.mZed = this.own(new THREE.SpriteMaterial({ map: g.zedTex, transparent: true, depthWrite: false, toneMapped: false }));
    this.face = { glasses: this.lookNow.glasses, boss, brow: boss ? this.lookNow.hair : INK, mustache: this.lookNow.mustache ? this.lookNow.hair : null };
    this.setLook(o.look);

    // ---- the frame: turned in 3D so the camera sees his face and the monitor (see the header)
    this.group.add(this.rig);
    this.rig.scale.setScalar(OFFICE_SCALE);
    this.rig.rotation.y = flat || boss ? 0 : OFFICE_YAW_3D;
    this.rig.add(this.body);
    const thin: 0 | 2 = t.smallInk ? 2 : 0;
    const G = () => new THREE.Group();

    // ---- the desk set (static)
    this.body.add(this.desk);
    this.add(this.desk, boss ? g.bossTop : g.deskTop, mDesk, 1);
    this.add(this.desk, boss ? g.bossFrame : g.deskFrame, mDeskFrame, 1);
    const pile = this.add(this.desk, g.pile, mPaper, thin);
    pile.position.set(boss ? 0.36 : -0.36, DESK_Y + 0.015, 0.44);
    pile.rotation.y = 0.12;
    this.pileAt.copy(pile.position);
    const loose = this.add(this.desk, g.sheet, mPaper, 0);
    loose.position.set(boss ? 0.16 : -0.14, DESK_Y + 0.002, 0.5);
    loose.rotation.set(-Math.PI / 2, 0, 0.3);
    this.desk.add(this.deskMug);
    this.deskMug.position.set(-0.27, DESK_Y, 0.3);
    this.add(this.deskMug, g.mug, mMug, thin);
    this.coffee = new THREE.Mesh(g.coffee, mCoffee);
    this.deskMug.add(this.coffee);
    if (boss) {
      const plate = this.add(this.desk, g.nameplate, this.mTie, thin);
      plate.position.set(0, DESK_Y + 0.0225, 0.6);
      const dc = (this.deskClipboard = G());
      this.desk.add(dc);
      dc.position.set(0.12, DESK_Y + 0.006, 0.36);
      dc.rotation.set(-Math.PI / 2, 0, 0.2);
      this.buildClipboard(dc, mBoard, mCheck, mMetal, thin);
      this.smokeAt.set(0, DESK_Y + 0.05, 0.4);
    } else {
      const mon = G();
      this.desk.add(mon);
      mon.position.set(MONITOR_POS[0], MONITOR_POS[1], MONITOR_POS[2]);
      mon.rotation.y = flat ? MONITOR_YAW_FLAT : MONITOR_YAW_3D;
      this.add(mon, g.monitor, mMonitor, 1);
      const scr = (this.screen = new THREE.Mesh(g.screen, this.mScreen));
      scr.position.set(0, SCREEN_Y, 0.0205);
      mon.add(scr);
      const crt = (this.crt = new THREE.Mesh(g.screen, this.mCrt));
      crt.position.set(0, SCREEN_Y, 0.022);
      crt.visible = false;
      mon.add(crt);
      const kb = (this.keyboard = this.add(this.desk, g.keyboard, mKeyboard, thin));
      kb.position.set(0.03, DESK_Y + 0.01, 0.32);
      kb.rotation.y = 0.15;
      this.smokeAt.set(MONITOR_POS[0], MONITOR_POS[1] + SCREEN_Y + 0.14, MONITOR_POS[2]);
    }

    // ---- the cubicle (3D): low fabric partitions, persona trim, the status line on top
    if (o.cubicle && !flat) {
      this.add(this.body, g.walls, this.mWall, 1);
      this.add(this.body, g.trim, this.mTrim, thin);
      this.body.add(new THREE.LineSegments(g.statusLines, o.cubicle.status));
      const memo = this.add(this.body, g.sheet, mPaper, 0);
      memo.position.set(-0.3, 0.42, -0.497);
      memo.rotation.z = 0.06;
    }

    // ---- the chair (rides the root: it rolls and swivels with him)
    const root = (this.root = G());
    this.body.add(root);
    this.add(root, g.chairBase, mMetal, thin);
    this.add(root, g.seat, mChair, 1).position.set(0, SEAT_Y - 0.03, -0.02);
    root.add(this.backPivot);
    this.backPivot.position.set(0, SEAT_Y, -0.19);
    this.add(this.backPivot, boss ? g.bossBack : g.back, mChair, 1);

    // ---- the body
    const hips = G(), spine = G(), chest = G(), neck = G(), head = G();
    root.add(hips); hips.position.y = HIP_Y; hips.add(spine); spine.add(chest); chest.position.y = 0.16; chest.add(neck); neck.position.y = 0.17; neck.add(head); head.position.y = 0.05;
    this.add(hips, g.pelvis, this.mSlacks, 1);
    const torso = this.add(spine, g.torso, boss ? this.mJacket : this.mShirt, 1);
    torso.scale.set(boss ? 1.12 : 1, 1, boss ? 0.86 : 0.78);
    if (g.belt && !boss) this.add(spine, g.belt, mShoe, 0).scale.set(1, 0.8, 1);
    if (g.collar) this.add(chest, g.collar, this.mShirt, thin).scale.set(1, 0.85, 1);
    if (boss) {
      const vee = this.add(chest, g.vee, this.mShirt, 0);
      vee.rotation.set(Math.PI, Math.PI / 6 + Math.PI, 0);
      vee.position.set(0, 0.1, 0.118);
      vee.scale.set(1, 1, 0.2);
    }
    const front = boss ? 0.012 : 0;
    this.add(chest, g.tieKnot, this.mTie, thin).position.set(0, 0.162, 0.108 + front);
    const blade = this.add(chest, g.tieBlade, this.mTie, 0);
    blade.position.set(0, 0.152, 0.114 + front);
    blade.rotation.x = -0.08;
    this.add(neck, g.neck, this.mSkin, 1).position.y = 0.02;

    // head: the skull, the face patch, the nose, ears, hair (boss: the gray ring)
    head.add(this.skull);
    this.skull.position.y = 0.15;
    this.skull.scale.set(1, 1.06, 0.98);
    this.add(this.skull, g.head, this.mSkin, 1);
    const faceMesh = new THREE.Mesh(g.face, mFace);
    faceMesh.renderOrder = 1;
    this.skull.add(faceMesh);
    this.add(this.skull, g.nose, this.mSkin, thin).position.set(0, -0.025, 0.148);
    if (g.ear) for (let s = -1; s <= 1; s += 2) this.add(this.skull, g.ear, this.mSkin, thin).position.set(s * 0.153, -0.01, 0);
    this.add(this.skull, boss ? g.bossHair : g.hair, this.mHair, 1);

    // arms (L is -X): the worker's short sleeves and bare forearms, the boss's jacket sleeves
    const arm = (side: number): [THREE.Group, THREE.Group, THREE.Group] => {
      const sh = G(); chest.add(sh); sh.position.set(side * (boss ? 0.19 : 0.17), 0.14, 0);
      if (boss) {
        this.add(sh, g.jacketCap, this.mJacket, 1);
        this.add(sh, g.jacketUpper, this.mJacket, 1);
      } else {
        this.add(sh, g.shoulderCap, this.mShirt, 1);
        this.add(sh, g.upperArm, this.mSkin, 1);
        this.add(sh, g.sleeve, this.mShirt, 1);
      }
      const el = G(); sh.add(el); el.position.y = -0.2;
      this.add(el, boss ? g.jacketFore : g.foreArm, boss ? this.mJacket : this.mSkin, 1);
      const hand = G(); el.add(hand); hand.position.y = -0.19;
      this.add(hand, g.hand, this.mSkin, thin).position.y = -0.035;
      return [sh, el, hand];
    };
    const leg = (side: number): [THREE.Group, THREE.Group] => {
      const hip = G(); hips.add(hip); hip.position.set(side * 0.09, -0.02, 0);
      this.add(hip, g.thigh, this.mSlacks, 1);
      const knee = G(); hip.add(knee); knee.position.y = -0.3;
      this.add(knee, g.shin, this.mSlacks, 1);
      this.add(knee, g.shoe, mShoe, thin).position.set(0, -0.35, 0.035);
      return [hip, knee];
    };
    const [shL, elL, handL] = arm(-1), [shR, elR, handR] = arm(1), [hipL, kneeL] = leg(-1), [hipR, kneeR] = leg(1);
    this.handL = handL;
    this.handR = handR;
    const byName: Record<(typeof OFFICE_JOINTS)[number], THREE.Group> = { root, hips, spine, chest, neck, head, shL, elL, shR, elR, hipL, kneeL, hipR, kneeR };
    for (const j of OFFICE_JOINTS) this.joints.push(byName[j]);

    // ---- props in hand
    handL.add(this.handMug);
    this.handMug.position.y = -0.045;
    this.handMug.visible = false;
    this.add(this.handMug, g.mug, mMug, thin);
    this.handMug.add(new THREE.Mesh(g.coffee, mCoffee));
    if (boss) {
      // the report and the clipboard are held in front of the chest (the hands are posed onto them)
      const rep = (this.report = G());
      chest.add(rep);
      rep.position.set(0, 0.16, 0.3);
      rep.rotation.x = 0.94;
      this.add(rep, g.report, mPaper, thin);
      const cover = this.add(rep, g.board, this.mTie, 0);
      cover.position.z = 0.009;
      cover.scale.set(0.95, 0.97, 0.4);
      rep.add(this.pagePivot);
      this.pagePivot.position.set(0, 0.105, -0.008);
      this.pagePivot.add(new THREE.Mesh(g.page, mPaper));
      this.pagePivot.visible = false;
      rep.visible = false;
      const cb = (this.clipboard = G());
      chest.add(cb);
      cb.position.set(-0.02, 0.1, 0.28);
      cb.rotation.x = 0.8;
      this.buildClipboard(cb, mBoard, mCheck, mMetal, thin);
      cb.visible = false;
      const pen = (this.pen = this.add(handR, g.pen, mPen, 0));
      pen.position.set(0, -0.06, 0.02);
      pen.rotation.x = 1.1;
      pen.visible = false;
    } else {
      const pr = (this.printout = this.add(handL, g.sheet, mPaper, 0));
      pr.visible = false;
    }

    // ---- effects
    this.body.add(this.smoke);
    this.puffR = new Float32Array(t.puffs);
    for (let i = 0; i < t.puffs; i++) {
      this.puffR[i] = 0.03 + this.random() * 0.03;
      const p = new THREE.Mesh(g.puff, this.mSmoke);
      p.position.set(this.smokeAt.x + (this.random() - 0.5) * 0.12, this.smokeAt.y, this.smokeAt.z + (this.random() - 0.5) * 0.08);
      this.smoke.add(p);
      this.puffs.push(p);
    }
    this.smoke.visible = false;
    head.add(this.steam);
    for (let i = 0; i < t.steam * 2; i++) {
      const p = new THREE.Mesh(g.puff, this.mSteam);
      this.steam.add(p);
      this.steamPuffs.push(p);
    }
    this.steam.visible = false;
    this.body.add(this.papers);
    for (let i = 0; i < t.papers; i++) {
      const p = new THREE.Mesh(g.sheet, mPaper);
      p.scale.setScalar(0.8);
      this.papers.add(p);
      this.paperMeshes.push(p);
    }
    this.papers.visible = false;
    this.desk.add(this.drops);
    for (let i = 0; i < t.drops; i++) {
      const p = new THREE.Mesh(g.puff, this.mCoffeeDrop);
      p.scale.setScalar(0.009);
      this.drops.add(p);
      this.dropMeshes.push(p);
    }
    this.drops.visible = false;
    head.add(this.sweat);
    for (let i = 0; i < t.drops; i++) {
      const p = new THREE.Mesh(g.puff, this.mSweat);
      p.scale.set(0.011, 0.016, 0.011);
      this.sweat.add(p);
      this.sweatMeshes.push(p);
    }
    this.sweat.visible = false;
    for (let i = 0; i < t.zeds; i++) {
      const z = new THREE.Sprite(this.mZed);
      z.visible = false;
      this.body.add(z);
      this.zeds.push(z);
    }

    this.update(0, 0, false);
  }

  // ------------------------------------------------------------------------------------------ API

  setActivity(a: MiniActivity): void {
    if (a === this.activity || !MINI_ACTIVITIES.includes(a)) return;
    this.activity = a;
  }

  setIntensity(x: number): void {
    this.k = Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
  }

  setState(s: OfficeState): void {
    if (s === this.state || !OFFICE_STATES.includes(s)) return;
    const prev = this.state;
    this.state = s;
    this.stateT = 0;
    const shot = officeTransitionShot(prev, s);
    if (shot) {
      this.shot = shot;
      this.shotT = 0;
      this.snapshot(BLEND_S, false);
    } else if (s !== "working" && s !== "idle") this.shot = null;
  }

  burst(): void {
    if (this.state === "paused" || this.state === "ended" || this.state === "killed") return;
    if (this.shot === "frantic" && this.shotT < 0.6) return;
    this.shot = "frantic";
    this.shotT = 0;
    this.flash = 0.6;
    this.snapshot(SNAP_BLEND_S, true);
  }

  setLook(l: MiniLook): void {
    const lk = (this.lookNow = officeLook(l, this.seed, this.role));
    this.mShirt.color.set(lk.shirt);
    this.cTie.set(lk.tie);
    this.mSlacks.color.set(lk.slacks);
    this.mJacket.color.set(lk.jacket);
    this.cSkin.set(lk.skin);
    this.mSkin.color.copy(this.cSkin);
    this.mHair.color.set(lk.hair);
    // the cubicle fabric: office blue-gray with a hint of the persona; the trim is the persona color
    this.mWall.color.set("#76839a").lerp(this.cTie, 0.12);
    this.mTrim.color.copy(this.cTie);
    this.mTrim.emissive.copy(this.cTie);
    this.faceKeyNow = -1;
  }

  react(kind: ReactKind, camera: THREE.Camera): void {
    if (this.disposed || this.state === "killed" || (kind !== "stare" && kind !== "outburst")) return;
    if (this.reactKind === "outburst" && kind === "stare") return; // never cut an outburst short
    if (this.reactKind === kind && this.reactT < 0.4) return;
    this.reactKind = kind;
    this.reactT = 0;
    this.reactHold = stareHold(this.random());
    this.reactCam = camera;
  }

  setIdleSeconds(sec: number): void {
    this.idleSec = Number.isFinite(sec) ? Math.max(0, sec) : 0;
  }

  update(_tSec: number, dt: number, motion: boolean): void {
    if (this.disposed) return;
    const d = motion && Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.1) : 0;
    this.life += d;
    this.stateT += d;
    this.blendT += d;
    this.kS = motion ? this.kS + (this.k - this.kS) * (1 - Math.exp(-d * 3)) : this.k;
    const tempo = officeTempo(this.state, this.kS);
    if (!motion) { this.shot = null; this.reactKind = null; }
    if (this.shot) {
      this.shotT += d;
      if (officeClipDone(OFFICE_CLIPS[this.shot], this.shotT)) {
        this.shot = null;
        this.snapshot(BLEND_S, false);
      }
    }

    // ---- the clip: the state's, the activity's, or the idle behavior; a change blends from the last pose
    const base = officeClipFor(this.role, this.state, this.activity, this.idleSec);
    if (base !== this.base) {
      const prev = this.base;
      this.base = base;
      this.clipT = 0;
      if (prev !== null) this.snapshot(base === "facepalm" ? SNAP_BLEND_S : prev === "facepalm" ? 0.45 : BLEND_S, base === "facepalm");
    }
    const prevClipT = this.clipT;
    this.clipT += d * tempo;
    const clip = OFFICE_CLIPS[base];
    const info = this.info;
    if (!motion) {
      sampleOfficeClip(clip, OFFICE_STILL_T[base], this.tgt, info);
      this.cur.set(this.tgt);
      this.blendT = this.blendDur;
    } else {
      if (this.shot) sampleOfficeClip(OFFICE_CLIPS[this.shot], this.shotT, this.tgt, info);
      else sampleOfficeClip(clip, this.clipT, this.tgt, info);
      if (this.blendT >= this.blendDur) this.cur.set(this.tgt);
      else {
        const u = this.blendT / this.blendDur;
        const w = this.blendSnap ? 1 - (1 - u) * (1 - u) * (1 - u) : u * u * (3 - 2 * u);
        for (let i = 0; i < OFFICE_POSE_LEN; i++) this.cur[i] = this.from[i]! + (this.tgt[i]! - this.from[i]!) * w;
      }
    }
    const baseT = officeClipTime(clip, motion ? this.clipT : OFFICE_STILL_T[base]);
    const live = this.shot === null;
    const frantic = this.shot === "frantic";

    // ---- the reaction on top
    let rs: ReactSample | null = null;
    if (this.reactKind) {
      this.reactT += d;
      rs = reactAt(this.reactKind, this.reactT, this.reactHold, this.rs);
      if (rs.done) { this.reactKind = null; this.reactCam = null; rs = null; }
    }

    // ---- procedural layers
    const o = this.out;
    o.set(this.cur);
    const br = motion ? Math.sin((this.life * TAU) / (base === "sleep" ? 4.2 : 3.2)) : 0;
    if (motion) {
      const amp = this.state === "killed" ? 0.2 : 1;
      o[O_CHEST] += 0.025 * br * amp;
      o[O_HEAD] -= 0.015 * br * amp;
      if (base === "sleep") o[O_SPINE] += 0.03 * br;
      o[O_HEAD + 1] += 0.02 * Math.sin(this.life * 0.9 + this.phase) * amp;
      // typing: alternating taps, quicker with the intensity, accelerating into the Enter slam, frantic on a surge
      const boost = live && base === "enter" ? enterTapBoost(baseT) : 1;
      const typing = frantic || (live && boost > 0 && (base === "type" || base === "enter" || base === "squint"));
      this.wType = approach(this.wType, typing ? (base === "squint" && !frantic ? 0.35 : 1) : 0, d / FX_S);
      this.tapPh += (d * tempo * tapRate(this.kS, frantic) * (boost || 1)) / 2;
      if (this.wType > 0.001) {
        const tl = tapCurve(fract(this.tapPh)) * this.wType;
        const tr = tapCurve(fract(this.tapPh + 0.5)) * this.wType;
        o[O_ELL] += 0.22 * tl; o[O_SHL] += 0.05 * tl;
        o[O_ELR] += 0.22 * tr; o[O_SHR] += 0.05 * tr;
      }
      // the boss's pen ticking boxes
      this.wTick = approach(this.wTick, live && base === "clipboard" ? 1 : 0, d / FX_S);
      this.tickPh += d * tempo * (1.4 + 2.2 * this.kS);
      if (this.wTick > 0.001) {
        const tick = tapCurve(fract(this.tickPh)) * this.wTick;
        o[O_ELR] += 0.16 * tick;
        o[O_SHR + 2] -= 0.07 * tick;
      }
      if (live && base === "enter" && officeClipTime(clip, prevClipT) < ENTER_SLAM_S && baseT >= ENTER_SLAM_S) { this.flash = 1; this.kbHit = 1; }
    }
    if (rs && rs.body > 0.001) {
      sampleOfficeClip(OFFICE_CLIPS.outburst, Math.min(this.reactT, OUTBURST_S), this.rpose, this.rinfo);
      const w = rs.body;
      for (let i = 0; i < OFFICE_POSE_LEN; i++) o[i] = o[i]! + (this.rpose[i]! - o[i]!) * w;
    }
    if (rs && motion && rs.shake > 0) o[0] += 0.018 * Math.sin(this.life * 90) * rs.shake;
    if (rs && rs.look > 0.001) this.lookAtCamera(o, rs);
    this.apply(o);
    this.backPivot.rotation.x = Math.min(0, o[O_SPINE]!) * 0.8;

    // ---- the face: redrawn only when the emotion, the blink step or the gaze bucket changes
    const emotion = rs?.emotion ?? info.emotion;
    if (motion) {
      this.blinkIn -= d;
      this.blinkAge += d;
      if (this.blinkIn <= 0) {
        this.blinkAge = 0;
        this.blinkIn = nextBlinkDelay(this.random());
      }
    } else this.blinkAge = 99;
    const emo = OFFICE_EMOTIONS[emotion];
    const staring = rs !== null && rs.look > 0.5;
    const bl = emo.shape === "open" && !staring ? blinkStep(this.blinkAge) : 0; // a stare never blinks
    const gb = gazeBucket(info.gaze * (1 - (rs?.look ?? 0)));
    const key = officeFaceKey(emotion, bl, gb);
    if (key !== this.faceKeyNow) {
      this.faceKeyNow = key;
      if (this.faceCtx) drawFace(this.faceCtx, this.face, emo, BLINK_LEVELS[bl]!, gazeOfBucket(gb), this.tier.faceScale);
      this.faceTex.needsUpdate = true;
    }

    this.updateColors(d, motion, rs);
    this.updateProps(d, motion, base, baseT, live, rs);
    this.updateFx(d, motion, base, live, frantic, rs);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.group.removeFromParent();
    for (const m of this.mats) m.dispose();
    this.faceTex.dispose();
    this.screenTex.dispose();
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

  /** A clipboard in its own XY plane: the checklist faces -Z (the reader), the board's back faces +Z. */
  private buildClipboard(parent: THREE.Group, mBoard: THREE.Material, mCheck: THREE.Material, mMetal: THREE.Material, thin: 0 | 2): void {
    const g = this.geo;
    this.add(parent, g.board, mBoard, thin);
    const sheet = new THREE.Mesh(g.sheet, mCheck);
    sheet.position.z = -0.006;
    sheet.rotation.y = Math.PI;
    parent.add(sheet);
    this.add(parent, g.clip, mMetal, 0).position.set(0, 0.105, -0.008);
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

  /** Turn the neck and head to the camera (last frame's matrices, in the body frame), lifting a slumped torso.
   *  The parents' turn is subtracted so the face, not the neck, ends up on the camera. */
  private lookAtCamera(o: Float32Array, rs: ReactSample): void {
    const lift = 1 - 0.7 * rs.lift;
    o[O_SPINE] = o[O_SPINE]! * lift;
    o[O_CHEST] = o[O_CHEST]! * lift;
    const cam = this.reactCam;
    if (!cam) return;
    this.skull.getWorldPosition(this.v2); // refreshes the body's world matrix too (its ancestors are updated)
    this.body.worldToLocal(this.v2);
    cam.getWorldPosition(this.v1);
    this.body.worldToLocal(this.v1);
    lookAngles(this.v1.x - this.v2.x, this.v1.y - this.v2.y, this.v1.z - this.v2.z, this.look);
    const yaw = this.look.yaw - (o[O_ROOT + 1]! + o[O_SPINE + 1]! + o[O_CHEST + 1]!);
    const pitch = this.look.pitch - (o[O_SPINE]! + o[O_CHEST]!);
    const w = rs.look;
    o[O_NECK] = o[O_NECK]! + (pitch * 0.35 - o[O_NECK]!) * w;
    o[O_NECK + 1] = o[O_NECK + 1]! + (yaw * 0.35 - o[O_NECK + 1]!) * w;
    o[O_NECK + 2] = o[O_NECK + 2]! * (1 - w);
    o[O_HEAD] = o[O_HEAD]! + (pitch * 0.65 - o[O_HEAD]!) * w;
    o[O_HEAD + 1] = o[O_HEAD + 1]! + (yaw * 0.65 - o[O_HEAD + 1]!) * w;
    o[O_HEAD + 2] = o[O_HEAD + 2]! * (1 - w);
  }

  /** Keep a hand-held prop upright in the body frame (tilted by `rx`), whatever the hand's own angle. */
  private orient(prop: THREE.Object3D, rx: number): void {
    prop.parent!.getWorldQuaternion(this.q1).invert();
    this.body.getWorldQuaternion(this.q2);
    this.q3.setFromEuler(this.e1.set(rx, 0, 0));
    prop.quaternion.copy(this.q1).multiply(this.q2).multiply(this.q3);
  }

  private updateColors(d: number, motion: boolean, rs: ReactSample | null): void {
    const st = this.state;
    const r = motion ? 1 - Math.exp(-d * 4) : 1;
    this.dead = approach(this.dead, st === "killed" && this.stateT > 0.4 ? 1 : 0, motion ? d : 1);
    const glowT = st === "killed" ? 0 : st === "working" ? 0.12 + 0.2 * this.kS : 0.08;
    this.glow += (glowT - this.glow) * r;
    this.mTie.color.copy(this.cTie).lerp(DEAD_GRAY, 0.75 * this.dead);
    this.mTie.emissive.copy(this.mTie.color);
    this.mTie.emissiveIntensity = this.glow;
    this.mTrim.emissiveIntensity = (0.12 + this.glow) * (1 - 0.8 * this.dead);
    // the outburst's red face; the worker's face catches the screen's glow while he works
    this.mSkin.color.copy(this.cSkin).lerp(RAGE, 0.55 * (rs?.red ?? 0));
    if (this.screen) {
      this.mSkin.emissive.copy(this.cTie);
      this.mSkin.emissiveIntensity = 0.06 * this.scr * (1 - this.dead);
    }
  }

  private updateProps(d: number, motion: boolean, base: OfficeClipName, baseT: number, live: boolean, rs: ReactSample | null): void {
    // coffee: in the hand while sipping, on the desk otherwise; it sloshes when the desk is slammed
    const held = live && mugHeld(base, baseT);
    this.handMug.visible = held;
    this.deskMug.visible = !held;
    if (held) this.orient(this.handMug, -0.9 * bump(baseT, 1.2, 1.5, 2.5, 2.9));
    const slosh = rs?.slosh ?? 0;
    this.deskMug.rotation.z = slosh > 0 && motion ? 0.22 * Math.sin(this.life * 28) * slosh : 0;
    this.coffee.rotation.z = -this.deskMug.rotation.z * 1.6;
    if (this.printout) {
      this.printout.visible = live && printHeld(base, baseT);
      if (this.printout.visible) {
        this.printout.position.set(0, -0.07, 0);
        this.orient(this.printout, 0.9);
      }
    }
    if (this.report) {
      this.report.visible = live && base === "reports";
      const f = this.report.visible ? pageFlipAt(baseT) : -1;
      this.pagePivot.visible = f >= 0;
      if (f >= 0) this.pagePivot.rotation.x = f * Math.PI * 0.95;
    }
    if (this.clipboard && this.deskClipboard && this.pen) {
      const inHand = live && (base === "clipboard" || base === "supervise");
      this.clipboard.visible = inHand;
      this.deskClipboard.visible = !inHand;
      this.pen.visible = inHand;
    }
    // the Enter slam: the keyboard hops
    this.kbHit = motion ? this.kbHit * Math.exp(-d * 9) : 0;
    if (this.keyboard) this.keyboard.position.y = DESK_Y + 0.01 + 0.012 * this.kbHit * Math.abs(Math.sin(this.life * 40));
    // the outburst's slams shake the desk
    this.desk.position.x = rs && motion ? 0.008 * Math.sin(this.life * 80) * rs.shake : 0;
  }

  private updateFx(d: number, motion: boolean, base: OfficeClipName, live: boolean, frantic: boolean, rs: ReactSample | null): void {
    const st = this.state;
    const rate = motion ? d / FX_S : 1;

    // the monitor: bright persona code while working (faster with the intensity), dim when idle, frozen when
    // paused; killed: a CRT power-off line, then dark, then smoke
    if (this.screen && this.crt) {
      const killed = st === "killed";
      const scrT = killed ? 0 : st === "paused" ? 0.3 : st === "working" ? 0.75 + 0.35 * this.kS : st === "ended" ? 0.12 : 0.22;
      this.scr += (scrT - this.scr) * (killed ? 1 : motion ? 1 - Math.exp(-d * 3) : 1);
      this.flash = motion ? this.flash * Math.exp(-d * 6) : 0;
      this.mScreen.color.copy(this.cTie).multiplyScalar(Math.min(1.6, this.scr + 0.8 * this.flash));
      const speed = st === "working" ? (0.08 + 0.35 * this.kS) * (frantic ? 4 : 1) : st === "idle" ? 0.01 : 0;
      this.scroll += d * speed;
      this.screenTex.offset.y = 1 - fract(this.scroll);
      const c = killed ? crtOff(this.stateT - 0.15, this.crtS) : null;
      this.crt.visible = c !== null && c.a > 0.001;
      if (c && this.crt.visible) {
        this.crt.scale.set(Math.max(0.001, c.sx), Math.max(0.001, c.sy), 1);
        this.mCrt.opacity = c.a;
      }
    } else this.flash = motion ? this.flash * Math.exp(-d * 6) : 0;
    this.wSmoke = approach(this.wSmoke, st === "killed" && this.stateT > 0.8 ? 1 : 0, motion ? d / 1.2 : 1);
    this.smoke.visible = this.wSmoke > 0.01;
    if (this.smoke.visible) {
      this.mSmoke.opacity = 0.4 * this.wSmoke;
      const n = this.puffs.length;
      for (let i = 0; i < n; i++) {
        const p = this.puffs[i]!;
        const f = fract((motion ? this.life * 0.3 : 0.5) + i / n);
        p.position.y = this.smokeAt.y + f * 0.45;
        p.scale.setScalar(this.puffR[i]! * (0.6 + 1.6 * f) * (1 - 0.5 * f * f));
      }
    }

    // outburst steam from both sides of the head
    const steam = rs?.steam ?? 0;
    this.steam.visible = steam > 0.01;
    if (this.steam.visible) {
      this.mSteam.opacity = 0.75 * steam;
      const n = this.steamPuffs.length >> 1;
      for (let i = 0; i < this.steamPuffs.length; i++) {
        const side = i < n ? -1 : 1, k = i % Math.max(1, n);
        const f = fract(this.life * 1.8 + k / Math.max(1, n));
        const p = this.steamPuffs[i]!;
        p.position.set(side * (0.17 + 0.08 * f), 0.17 + 0.18 * f, 0);
        p.scale.setScalar((0.018 + 0.03 * f) * steam);
      }
    }

    // outburst papers flying off the pile
    const pu = rs?.papers ?? -1;
    this.papers.visible = pu >= 0 && motion;
    if (this.papers.visible) {
      const n = this.paperMeshes.length;
      for (let i = 0; i < n; i++) {
        const fl = paperFlight(i, n, pu, DESK_Y, this.paperS);
        const p = this.paperMeshes[i]!;
        p.position.set(this.pileAt.x + fl.x, this.pileAt.y + 0.02 + fl.y, this.pileAt.z + fl.z);
        p.rotation.set(-Math.PI / 2 + fl.rx, 0, fl.rz);
      }
    }

    // coffee drops jumping out of the desk mug on a slam
    const slosh = rs?.slosh ?? 0;
    this.drops.visible = slosh > 0.05 && this.deskMug.visible && motion;
    if (this.drops.visible) {
      const s = (1 - slosh) * 0.8;
      for (let i = 0; i < this.dropMeshes.length; i++) {
        const p = this.dropMeshes[i]!;
        const a = (i / this.dropMeshes.length) * TAU + 0.6;
        p.position.set(this.deskMug.position.x + Math.cos(a) * 0.25 * s, DESK_Y + 0.07 + 0.9 * s - 3.2 * s * s, this.deskMug.position.z + Math.sin(a) * 0.25 * s);
      }
    }

    // frantic sweat flicking off the temples
    this.wSweat = approach(this.wSweat, frantic ? 1 : 0, rate);
    this.sweat.visible = this.wSweat > 0.01 && motion;
    if (this.sweat.visible) {
      const n = this.sweatMeshes.length;
      for (let i = 0; i < n; i++) {
        const f = fract(this.life * 1.6 + i / n);
        const side = i % 2 === 0 ? 1 : -1;
        this.sweatMeshes[i]!.position.set(side * (0.16 + 0.12 * f), 0.24 + 0.1 * f - 0.3 * f * f, 0.03);
      }
    }

    // asleep: z z z rising from his head
    this.wZed = approach(this.wZed, live && base === "sleep" ? 1 : 0, motion ? d / 0.8 : 1);
    const zOn = this.wZed > 0.01;
    if (zOn) {
      this.skull.getWorldPosition(this.v1);
      this.body.worldToLocal(this.v1);
    }
    for (let i = 0; i < this.zeds.length; i++) {
      const z = this.zeds[i]!;
      z.visible = zOn;
      if (!zOn) continue;
      const s = zedAt(i, this.zeds.length, motion ? this.life : 0.6, this.zedS);
      z.position.set(this.v1.x + 0.12 + s.x, this.v1.y + 0.12 + s.y, this.v1.z);
      z.scale.setScalar(s.s);
    }
    if (zOn) this.mZed.opacity = this.wZed;
  }
}

export function createOfficeFigure(o: OfficeFigureOptions): OfficeFigure {
  return new Office(o);
}
