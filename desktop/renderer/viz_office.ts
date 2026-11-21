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
//   Boss (the hub), at a larger wooden desk with a report pile, a clipboard, a mug and a nameplate, is one of two
//     managers on the same rig (P-VIZ.5, ADR-0631), both with a full head of salt-and-pepper hair (a dark base
//     with grey strands, greyer at the temples, from a shared canvas texture on a sculpted hair mesh):
//     the man: a charcoal suit, white shirt, persona tie, side-parted hair swept over, reading glasses (usually);
//     the woman: a navy blazer, cream blouse, a persona scarf knotted at the throat, a chin-length bob with a
//     side-swept fringe, small gold earrings, lashes, rose lips, rounded glasses (sometimes).
//     They alternate (viz_office_pose's cast: a coin flip per open, a handover every 8 to 15 minutes, never
//     mid-reaction): the one on duty stands, walks off to the side and dissolves (alpha-hash, so no sorting),
//     the other walks in and sits down; reduced motion swaps in place. The second manager's own parts (hair,
//     tie or scarf and earrings) are built the first time he or she takes the desk.
// The face is a canvas texture on a patch of the head sphere (eyes, brows, mouth, glasses, lashes, a sweat drop)
// drawn from an OfficeEmotion and redrawn only when the emotion, the blink step or the gaze bucket changes.
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
//
// P-VIZ.6 (ADR-0637): the workers are men and women (viz_office_pose.workerCast, seeded per node): a hairstyle
// from four per gender (crop, swept, curly, buzz; bob, ponytail, bun, long; each built once per detail tier,
// shared and ref-counted), a short-sleeve shirt or blouse, or long sleeves (a sweater, cardigan or blazer over a
// shirt or blouse, on the boss's jacket rig), the persona tie for the men and a persona necklace for the women,
// lashes and a lip color for the women, slightly narrower shoulders. hit() plays the throw tray's reactions over
// the activity (turning toward the throw; the drink in hand; the Storm's papers off the pile) and the energy
// drink's charge speeds the work up and warms the tie, trim and screen until it decays.
//
// P-VIZ.7 (ADR-0641): every figure is a sponsored athlete. The node's model picks a VizBrand (viz_brand): its
// emblem spins on a coin orbiting the desk at monitor height (held still under reduced motion) and hangs on a
// lanyard ID badge with the sponsor's word (TL187 for a private model; no brand, no emblem); its size class scales
// the person and the chair (the desk set stays); its variant 0..3 (else the seed's) picks the worker's outfit (the
// cast's own top, a vest, rolled-up sleeves or a cardigan, a hoodie), the desk set (a plant, a framed photo,
// headphones on a stand, a nameplate, a second monitor, a desk lamp, a desk phone) and the variant's own actions
// (viz_office_pose.activityClip). The hands are solved onto their props per build (viz_office_pose's IK), so the
// sip brings the rim to the lips and back to the coaster, and the typing palms rest on the keys. Every desk has a
// short stack of TPS reports (a cover sheet canvas) with a glossy red stapler on it, "NORM's" in black marker on
// its top (a decal canvas lifted off the body with a polygon offset, so a close zoom never z-fights). setCommit()
// plays a git commit or push: the desk set shrinks away, a copier slides in, he stands at it, presses the button
// and copies slide out one after another onto the tray (a pooled set of sheets with a chart-and-text canvas),
// sipping his coffee and glancing around, a "TPS Reports" bubble over his head; it holds until setCommit(false)
// and blends back (COMMIT_BLEND_S).

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  BLINK_LEVELS, blinkStep, bump, chargeLevel, chargeTempo, decayCharge, fract, gazeBucket, gazeOfBucket, HIT_KINDS, newCharge, nextBlinkDelay,
  tapCurve,
} from "./viz_anime_pose.ts";
import {
  crtOff, ENTER_SLAM_S, enterTapBoost, lookAngles, mugHeld, OFFICE_CLIPS, OFFICE_EMOTIONS, OFFICE_POSE_LEN, OFFICE_STATES, OFFICE_STILL_T,
  officeClipDone, officeClipFor, officeClipTime, officeFaceKey, officeJointOffset, OFFICE_JOINTS, officeLook, officeTempo, officeTransitionShot,
  OUTBURST_S, pageFlipAt, paperFlight, printHeld, reactAt, sampleOfficeClip, stareHold, tapRate, zedAt,
  applyManagerSwap, MANAGER_HAIR, MANAGER_VARIANTS, managerSwapAt, managerSwapDue, managerSwapReady, openManagerCast, otherManager, recastManager,
  clearOfficeHit, longSleeves, newOfficeHitSample, officeHitCharge, planOfficeHit, sampleOfficeHit, workerCast,
  applyTyping, buttonPress, COMMIT_BLEND_S, commitLook, COPIER, COPY_HIPS, copiesStarted, copyProgress, DESK_MUG, DESK_PHONE, flickAt,
  HANDSET_AT, handsetHeld, HEADPHONE_STAND, HEADPHONE_STAND_H, KEYBOARD, MUG_GRIP, mugTilt, OFFICE_DESK_Y, OFFICE_RIG, officeDeskSet,
  officeFacing, OFFICE_POSE_VECTORS, officePoseTable, officeVariant, PHONE_DROP_S, PHONE_GRAB_S, PHONES_BACK_S, PHONES_GRAB_S, PHONES_OFF_S,
  PHONES_ON_S, phonesAt, phonesGroove, SHOULDER_X, TRAY_TILT, workerOutfit,
  type Crt, type DeskItem, type LookAngles, type ManagerCast, type ManagerMemo, type ManagerVariant, type MouthShape, type OfficeClipName,
  type OfficeClipSample, type OfficeEmotion, type OfficeHitPlan, type OfficePoseTable, type OfficeRole, type OfficeState, type Paper,
  type ReactKind, type ReactSample, type SwapSample, type WorkerCast, type WorkerHair, type WorkerOutfit, type Zed,
} from "./viz_office_pose.ts";
import { emblemCanvas, type VizBrand } from "./viz_brand.ts";
import { MINI_ACTIVITIES, type MiniActivity, type MiniLook } from "./viz_mini_look.ts";
import type { HitKind } from "./viz_throw_kinds.ts";

export type { ManagerVariant, OfficeRole, OfficeState } from "./viz_office_pose.ts";
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
  /** Something reached him (P-VIZ.6): a paper ball, a rubber band, an energy drink or the Storm (the anime
   *  throwables are a generic flinch). `from` is the world point the throw came from (he turns toward it);
   *  `strength` 0..1 scales the effect. A hit replaces any reaction or hit playing; a no-op once disposed, when
   *  killed, or mid-handover. */
  hit(kind: HitKind, from: THREE.Vector3, camera: THREE.Camera, strength?: number): void;
  /** 0..1: how energized he is right now (the energy drink); decays inside update(). */
  readonly charge: number;
  /** The boss only (a worker ignores it): "man" or "woman" pins that manager (handed over at the next quiet
   *  moment, animated under motion), "auto" (the default) alternates them every 8 to 15 minutes. */
  setManagerVariant(v: ManagerVariant | "auto"): void;
  /** The manager at the desk (the incoming one once a handover passes its midpoint); null for a worker. */
  readonly managerVariant: ManagerVariant | null;
  /** True while a handover animates: the caller should keep drawing at its busy cadence. */
  readonly handingOver: boolean;
  /** P-VIZ.7 (ADR-0641): a git commit or push is running (true) or done (false). While on, the desk set gives way
   *  to a copier and he runs off TPS reports at it (pressing the button, copies sliding onto the tray, sipping
   *  coffee, glancing around, a "TPS Reports" bubble) for as long as it lasts; off blends back to the desk over
   *  about 0.6 s. Reduced motion shows the copier scene still. A no-op once disposed. */
  setCommit(on: boolean): void;
  /** `tSec` is on the performance.now() timeline in seconds (rAF time / 1000): the handover schedule runs on it. */
  update(tSec: number, dt: number, motion: boolean): void;
  dispose(): void;
}

export interface OfficeFigureOptions {
  look: MiniLook;
  detail: OfficeDetail;
  flat: boolean;
  role: OfficeRole;
  /** Picks a worker's gender, hairstyle, top, skin, hair color and glasses, stably per node (viz_scene passes the
   *  node's id hash). */
  seed: number;
  /** P-VIZ.7 (ADR-0641): the sponsor (viz_brand.vizBrandFor of the node's model): the emblem and lanyard, the
   *  person's scale and the variant (outfit, desk set, actions). null (the model is not known yet): no emblem,
   *  scale 1, the variant from the seed. Constructor-only (viz_scene rebuilds the figure when it changes). */
  brand?: VizBrand | null;
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
const HIP_Y = OFFICE_RIG.hipY;
const DESK_Y = OFFICE_DESK_Y;
const MONITOR_POS = [0.33, DESK_Y, 0.38] as const;
const MONITOR_YAW_3D = -1.4;
const MONITOR_YAW_FLAT = -0.6;
const SCREEN_Y = 0.2;

// ------------------------------------------------------------------------------------------ the face

const FW = 512, FH = 380;
const EYE_Y = 148, EYE_DX = 78;
/** `readers`: the man's half-moon reading glasses; `frames`: rounded rectangles (workers, the woman). */
interface FacePaint { glasses: "none" | "readers" | "frames"; brow: string; browW: number; lashes: boolean; lip: string }

function drawEye(c: CanvasRenderingContext2D, cx: number, cy: number, inner: number, emo: OfficeEmotion, blink: number, gaze: number, lashes: boolean): void {
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
  if (lashes && open > 0.3) {
    // two lashes flicking out from the outer end of the upper lid (or the rim, when the lid is up)
    const o = -inner;
    c.lineWidth = 6;
    c.beginPath();
    for (const [k, len, dx, dy] of [[0.8, 16, 0.8, -0.6], [0.45, 13, 0.4, -0.92]] as const) {
      const lx = cx + o * rx * k;
      const ly = Math.max(cy - ry * Math.sqrt(1 - k * k), top + tilt * (((lx - cx) * inner) / rx));
      c.moveTo(lx, ly); c.lineTo(lx + o * dx * len, ly + dy * len);
    }
    c.stroke();
  }
}

function drawMouth(c: CanvasRenderingContext2D, m: MouthShape, x: number, y: number, lip: string): void {
  c.save();
  c.translate(x, y);
  c.strokeStyle = lip; c.lineWidth = 7;
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
    drawEye(c, cx, EYE_Y, inner, emo, blink, gaze, p.lashes);
    // the brow's angle is the emotion: a positive brow pulls the inner end down
    c.save();
    c.translate(cx + inner * 4, EYE_Y - 66 - emo.browY * 34);
    c.rotate(inner * emo.brow * 0.5);
    c.strokeStyle = p.brow; c.lineWidth = p.browW;
    c.beginPath(); c.moveTo(-36, 0); c.quadraticCurveTo(0, p.lashes ? -14 : -8, 36, 0); c.stroke();
    c.restore();
  }
  drawMouth(c, emo.mouth, FW / 2, 292, p.lip);
  if (p.glasses !== "none") {
    const readers = p.glasses === "readers";
    c.strokeStyle = INK; c.lineWidth = 7;
    for (let side = -1; side <= 1; side += 2) {
      const cx = FW / 2 + side * EYE_DX;
      c.beginPath();
      if (readers) { c.moveTo(cx - 50, EYE_Y + 6); c.lineTo(cx + 50, EYE_Y + 6); c.quadraticCurveTo(cx + 48, EYE_Y + 52, cx, EYE_Y + 52); c.quadraticCurveTo(cx - 48, EYE_Y + 52, cx - 50, EYE_Y + 6); }
      else {
        const x = cx - 52, y = EYE_Y - 46, w = 104, h = 92, r = 18;
        c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
      }
      c.fillStyle = "rgba(170,210,255,0.16)"; c.fill(); c.stroke();
      c.strokeStyle = "rgba(255,255,255,0.75)"; c.lineWidth = 5;
      c.beginPath(); c.moveTo(cx + 18, EYE_Y + (readers ? 14 : -32)); c.lineTo(cx + 34, EYE_Y + (readers ? 2 : -16)); c.stroke();
      c.strokeStyle = INK; c.lineWidth = 7;
      // the temple arm runs from the outer rim toward the ear
      c.beginPath(); c.moveTo(cx + side * 52, EYE_Y - 20); c.lineTo(FW / 2 + side * 200, EYE_Y - 26); c.stroke();
    }
    const by = readers ? EYE_Y + 10 : EYE_Y - 8;
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

// P-VIZ.7 (ADR-0641): the Office Space paperwork, shared per tier like the code canvas. Sized for a close zoom.
const MARKER_FONT = "\"Segoe Print\", \"Bradley Hand\", \"Marker Felt\", \"Comic Sans MS\", cursive";
const FORM_FONT = "system-ui, -apple-system, \"Segoe UI\", sans-serif";

/** The stapler's top decal (transparent: the red body shows through): a gloss streak along its length and
 *  "NORM's" hand-lettered in black marker. A generic stapler: no maker's wordmark. */
function staplerCanvas(): HTMLCanvasElement {
  const cv = document.createElement("canvas");
  cv.width = 512; cv.height = 128;
  const c = cv.getContext("2d");
  if (!c) return cv;
  const gloss = c.createLinearGradient(0, 0, 0, 128);
  gloss.addColorStop(0, "rgba(255,255,255,0)");
  gloss.addColorStop(0.16, "rgba(255,255,255,0.6)");
  gloss.addColorStop(0.3, "rgba(255,255,255,0)");
  c.fillStyle = gloss;
  c.beginPath(); c.roundRect(20, 4, 472, 120, 40); c.fill();
  // the name in fat black marker filling most of the top, slanted like a hurried hand
  c.save();
  c.translate(256, 70);
  c.rotate(-0.04);
  c.transform(1, 0, -0.2, 1, 0, 0);
  c.font = `900 112px ${MARKER_FONT}`;
  c.textAlign = "center"; c.textBaseline = "middle";
  c.lineJoin = "round"; c.lineCap = "round";
  const sx = Math.min(1.6, 440 / Math.max(1, c.measureText("NORM's").width));
  c.scale(sx, 1);
  // a marker's stroke: the bleed and the body of the ink in one heavy pass, then the solid fill
  c.strokeStyle = "#08080c"; c.lineWidth = 12 / sx; c.strokeText("NORM's", 0, 0);
  c.fillStyle = "#08080c"; c.fillText("NORM's", 0, 0);
  c.restore();
  return cv;
}

/** The TPS report's cover sheet: the title, form fields and a routing grid. */
function tpsCanvas(): HTMLCanvasElement {
  const W = 320, H = 400;
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const c = cv.getContext("2d");
  if (!c) return cv;
  c.fillStyle = "#fbfaf4"; c.fillRect(0, 0, W, H);
  c.strokeStyle = "#2a2e38"; c.lineWidth = 3; c.strokeRect(10, 10, W - 20, H - 20);
  // the title as large as the sheet allows, solid black with a stroke so it reads from across the office
  c.fillStyle = "#050508";
  c.strokeStyle = "#050508";
  c.textAlign = "center"; c.textBaseline = "alphabetic";
  let px = 72;
  c.font = `900 ${px}px ${FORM_FONT}`;
  while (px > 30 && c.measureText("TPS REPORT").width > W - 44) c.font = `900 ${--px}px ${FORM_FONT}`;
  c.lineWidth = 3;
  c.strokeText("TPS REPORT", W / 2, 82);
  c.fillText("TPS REPORT", W / 2, 82);
  c.fillRect(24, 94, W - 48, 6);
  c.font = `800 15px ${FORM_FONT}`;
  c.fillText("TESTING PROCEDURE SPECIFICATION", W / 2, 118);
  c.textAlign = "left";
  c.font = `700 14px ${FORM_FONT}`;
  c.lineWidth = 1.5;
  const field = (label: string, y: number): void => {
    c.fillText(label, 28, y);
    c.beginPath(); c.moveTo(28 + c.measureText(label).width + 8, y + 2); c.lineTo(W - 28, y + 2); c.stroke();
  };
  field("NAME", 150); field("DEPT", 176); field("DATE", 202); field("PROJECT CODE", 228);
  // the routing grid
  const gx = 28, gy = 246, gw = W - 56, rows = 4, cols = 3, rh = 22;
  c.strokeRect(gx, gy, gw, rows * rh);
  for (let r = 1; r < rows; r++) { c.beginPath(); c.moveTo(gx, gy + r * rh); c.lineTo(gx + gw, gy + r * rh); c.stroke(); }
  for (let k = 1; k < cols; k++) { c.beginPath(); c.moveTo(gx + (k * gw) / cols, gy); c.lineTo(gx + (k * gw) / cols, gy + rows * rh); c.stroke(); }
  c.font = `700 11px ${FORM_FONT}`;
  ["ROUTE TO", "INITIALS", "DATE"].forEach((s, k) => c.fillText(s, gx + 6 + (k * gw) / cols, gy + 15));
  c.fillStyle = "#2a2e38";
  c.font = `800 13px ${FORM_FONT}`;
  c.textAlign = "center";
  c.fillText("COVER SHEET REQUIRED ON ALL REPORTS", W / 2, 356);
  c.strokeRect(40, 340, W - 80, 24);
  return cv;
}

/** A fresh copy off the copier: a heading, lines of tiny text, a bar chart and a pie chart. */
function copyCanvas(): HTMLCanvasElement {
  const W = 256, H = 320;
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const c = cv.getContext("2d");
  if (!c) return cv;
  c.fillStyle = "#fcfcf8"; c.fillRect(0, 0, W, H);
  c.fillStyle = "#1a1d24";
  c.font = `900 22px ${FORM_FONT}`;
  c.textBaseline = "alphabetic";
  c.fillText("TPS", 18, 34);
  c.fillRect(18, 42, W - 36, 3);
  let seed = 7;
  const rnd = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;
  c.fillStyle = "#8e939d";
  for (let r = 0; r < 5; r++) c.fillRect(18, 56 + r * 11, 80 + rnd() * (W - 116), 4);
  // the bar chart
  const bx = 22, by = 210, bh = 96;
  c.strokeStyle = "#1a1d24"; c.lineWidth = 2;
  c.beginPath(); c.moveTo(bx, by - bh); c.lineTo(bx, by); c.lineTo(bx + 112, by); c.stroke();
  const bars = ["#3b6fd8", "#e0a030", "#3ba86a", "#d24a4a"];
  for (let k = 0; k < 4; k++) {
    const h = 26 + ((k * 37 + 19) % 64);
    c.fillStyle = bars[k]!;
    c.fillRect(bx + 10 + k * 25, by - h, 17, h);
  }
  // the pie chart
  const px = 190, py = 166, pr = 40;
  let a0 = -Math.PI / 2;
  [0.45, 0.3, 0.25].forEach((f, k) => {
    c.fillStyle = bars[k]!;
    c.beginPath(); c.moveTo(px, py); c.arc(px, py, pr, a0, a0 + f * Math.PI * 2); c.closePath(); c.fill();
    a0 += f * Math.PI * 2;
  });
  c.strokeStyle = "#1a1d24"; c.beginPath(); c.arc(px, py, pr, 0, Math.PI * 2); c.stroke();
  c.fillStyle = "#8e939d";
  for (let r = 0; r < 6; r++) c.fillRect(18, 232 + r * 12, 60 + rnd() * (W - 96), 4);
  return cv;
}

/** The speech bubble over the copier: "TPS Reports". */
function bubbleCanvas(): HTMLCanvasElement {
  const W = 320, H = 136;
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const c = cv.getContext("2d");
  if (!c) return cv;
  c.lineJoin = "round";
  c.fillStyle = "#ffffff"; c.strokeStyle = INK; c.lineWidth = 7;
  c.beginPath();
  c.roundRect(8, 8, W - 16, H - 44, 36);
  c.moveTo(96, H - 37); c.lineTo(80, H - 8); c.lineTo(126, H - 37);
  c.fill(); c.stroke();
  // close the tail's seam
  c.fillRect(99, H - 42, 24, 8);
  // heavy ink lettering with a stroke, so the scene's bloom on the white bubble never washes it out
  c.font = `900 40px ${FORM_FONT}`;
  c.textAlign = "center"; c.textBaseline = "middle";
  c.lineJoin = "round";
  c.strokeStyle = INK; c.lineWidth = 3;
  c.strokeText("TPS Reports", W / 2, (H - 36) / 2 + 4);
  c.fillStyle = INK;
  c.fillText("TPS Reports", W / 2, (H - 36) / 2 + 4);
  return cv;
}

/** The framed photo: a toon snapshot of two people and a dog in a park. */
function photoCanvas(): HTMLCanvasElement {
  const W = 128, H = 96;
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const c = cv.getContext("2d");
  if (!c) return cv;
  const sky = c.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, "#8fc8f0"); sky.addColorStop(0.62, "#d9f0ff"); sky.addColorStop(0.63, "#7cc06a"); sky.addColorStop(1, "#4f9a48");
  c.fillStyle = sky; c.fillRect(0, 0, W, H);
  c.fillStyle = "#ffe27a"; c.beginPath(); c.arc(104, 18, 10, 0, Math.PI * 2); c.fill();
  const person = (x: number, h: number, shirt: string): void => {
    c.fillStyle = shirt; c.fillRect(x - 9, 82 - h, 18, h - 14);
    c.fillStyle = "#f0c49c"; c.beginPath(); c.arc(x, 82 - h - 6, 9, 0, Math.PI * 2); c.fill();
    c.strokeStyle = INK; c.lineWidth = 1.5; c.beginPath(); c.arc(x, 82 - h - 5, 4, 0.2, Math.PI - 0.2); c.stroke();
  };
  person(44, 46, "#d04a5a");
  person(70, 40, "#3a6fd0");
  c.fillStyle = "#a86c43"; c.fillRect(88, 72, 18, 9); c.beginPath(); c.arc(106, 70, 6, 0, Math.PI * 2); c.fill();
  return cv;
}

/** Salt-and-pepper hair: the base with thin grey strands running from the crown down, denser toward the temples
 *  (u 0 and 1 are the ears, u 0.5 the front and the back; see hairUv). */
function saltPepperCanvas(base: string, grey: string): HTMLCanvasElement {
  const W = 256, H = 128;
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const c = cv.getContext("2d");
  if (!c) return cv;
  c.fillStyle = base; c.fillRect(0, 0, W, H);
  let seed = 29;
  const rnd = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;
  c.strokeStyle = grey;
  c.lineCap = "round";
  for (let i = 0; i < 520; i++) {
    const u = rnd();
    const temple = (2 * u - 1) * (2 * u - 1);
    if (rnd() > 0.3 + 0.7 * temple) continue;
    const x = u * W, y = rnd() * H * 0.7, len = 18 + rnd() * 50;
    c.globalAlpha = 0.3 + 0.55 * rnd() * (0.5 + 0.5 * temple);
    c.lineWidth = 1 + rnd() * 1.5;
    c.beginPath(); c.moveTo(x, y); c.quadraticCurveTo(x + (rnd() - 0.5) * 6, y + len / 2, x + (rnd() - 0.5) * 9, y + len); c.stroke();
  }
  c.globalAlpha = 1;
  return cv;
}

/** Hair UVs from the position (skull frame) so every hair part maps the strands the same way and seamlessly:
 *  u is the angle from the left ear around to the right (front and back meet at 0.5), v the height. */
function hairUv(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const p = g.getAttribute("position");
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    uv[i * 2] = Math.abs(Math.atan2(z, -x)) / Math.PI;
    uv[i * 2 + 1] = Math.min(1, Math.max(0, (y + 0.13) / 0.36));
  }
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  return g;
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
    // (an alpha-hashed hull, the boss's dissolve, still needs vPosition, which begin_vertex would have set)
    s.vertexShader = "uniform float uW;\n" + s.vertexShader.replace("#include <begin_vertex>", "vec3 transformed = position + normal * uW;\n#ifdef USE_ALPHAHASH\n\tvPosition = vec3( position );\n#endif");
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
  /** P-VIZ.7: the copier's pooled copies; `deskSet` builds the variant's desk items and actions (not at minimal). */
  copies: number; deskSet: boolean;
}

const TIERS: Record<OfficeDetail, Tier> = {
  full: { head: [32, 24], small: [12, 10], limb: 14, box: 2, smallInk: true, extras: true, faceScale: 1, codeScale: 1, papers: 6, puffs: 8, steam: 4, drops: 3, zeds: 3, copies: 8, deskSet: true },
  reduced: { head: [22, 16], small: [8, 6], limb: 10, box: 1, smallInk: true, extras: true, faceScale: 1, codeScale: 1, papers: 4, puffs: 6, steam: 3, drops: 3, zeds: 3, copies: 6, deskSet: true },
  minimal: { head: [14, 10], small: [6, 4], limb: 6, box: 0, smallInk: false, extras: false, faceScale: 0.5, codeScale: 0.5, papers: 3, puffs: 4, steam: 2, drops: 2, zeds: 2, copies: 4, deskSet: false },
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
  /** The women workers' persona necklace (chest frame) and the energy drink can (in the right hand). */
  necklace: THREE.BufferGeometry; can: THREE.BufferGeometry;
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
  // P-VIZ.7 (ADR-0641): the stapler (black base and hinge, red body, the NORM's decal) and the TPS cover sheet
  staplerBase: THREE.BufferGeometry; staplerBody: THREE.BufferGeometry; staplerTop: THREE.BufferGeometry; tpsTop: THREE.BufferGeometry;
  // the sponsor: the coin (rim and a face per side), the lanyard (cord), the badge card and its face; the nameplate's
  coinRim: THREE.BufferGeometry; coinFace: THREE.BufferGeometry; lanyard: THREE.BufferGeometry; badge: THREE.BufferGeometry;
  badgeFace: THREE.BufferGeometry; plateFace: THREE.BufferGeometry;
  // outfits: a rolled cuff, the hoodie's hood and pocket, its drawstrings
  cuff: THREE.BufferGeometry; hoodie: THREE.BufferGeometry; strings: THREE.BufferGeometry;
  // the desk sets
  pot: THREE.BufferGeometry; leaves: THREE.BufferGeometry; frame: THREE.BufferGeometry; picture: THREE.BufferGeometry;
  phonesStand: THREE.BufferGeometry; headphones: THREE.BufferGeometry; screenBox: THREE.BufferGeometry; monitorArm: THREE.BufferGeometry;
  lamp: THREE.BufferGeometry; shade: THREE.BufferGeometry; bulb: THREE.BufferGeometry; phoneBase: THREE.BufferGeometry; handset: THREE.BufferGeometry;
  // the copier: the light body (lid, tray), the dark parts (plinth, slot, drawer pulls), the panel, its button and display
  copierBody: THREE.BufferGeometry; copierDark: THREE.BufferGeometry; copierPanel: THREE.BufferGeometry; copierButton: THREE.BufferGeometry;
  copierDisplay: THREE.BufferGeometry;
  staplerTex: THREE.CanvasTexture; tpsTex: THREE.CanvasTexture; copyTex: THREE.CanvasTexture; bubbleTex: THREE.CanvasTexture; photoTex: THREE.CanvasTexture;
}

/** A round rod from a to b (build time only). */
function rod(a: readonly [number, number, number], b: readonly [number, number, number], r: number, seg: number): THREE.BufferGeometry {
  const from = new THREE.Vector3(...a), to = new THREE.Vector3(...b);
  const dir = to.clone().sub(from);
  const g = new THREE.CylinderGeometry(r, r, dir.length(), seg, 1);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize()));
  g.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
  return g;
}

/** Stapler measures (its frame: the long axis +X toward the business end, the floor of its base at y 0). */
const STAPLER = { len: 0.145, w: 0.042, baseH: 0.012, bodyH: 0.026, tilt: -0.03 } as const;
/** The TPS stack (the desk's pile): its box and where the stapler sits on it (the pile's frame). */
const PILE = { w: 0.15, h: 0.03, d: 0.19 } as const;
const STAPLER_ON_PILE = { x: 0.012, z: 0.038, yaw: 0.55 } as const;
/** The coin: radius and thickness; the orbit around the desk (radius and height per role), its period, the spin's. */
const COIN_R = 0.09;
const COIN_T = 0.008;
const ORBIT = { worker: { r: 0.62, y: 0.88 }, boss: { r: 0.76, y: 0.92 } } as const;
const ORBIT_S = 16;
const SPIN_S = 3;
/** The copier's sheets: where a copy starts (in the slot) and lands (on the tray), copier frame; the stack's step. */
const SHEET_FROM = [0, 0.415, 0.12] as const;
const SHEET_TO = [0, 0.412, 0.31] as const;
const SHEET_STEP = 0.0022;
/** The "TPS Reports" bubble's width (its canvas is 320 x 136): readable from the overview camera. */
const BUBBLE_W = 0.72;
/** Reduced motion: the copies already on the tray. */
const STILL_COPIES = 3;
/** The headphones on the stand and in the hand are this much smaller than on the head. */
const PHONES_SMALL = 0.72;
/** The headphones' band radius on the head (skull frame). */
const PHONES_R = 0.18;
/** Where each desk item stands (x, z on the desk top, yaw), clear of the keyboard, the monitor, the TPS stack, the
 *  mug and the person's view; the phone and the worker's headphone stand where the solved hands reach for them. */
const DESK_SPOTS: Readonly<Record<OfficeRole, Partial<Record<DeskItem, readonly [number, number, number]>>>> = {
  worker: {
    plant: [0.47, 0.25, 0], photo: [0.1, 0.54, Math.PI - 0.9], headphones: [HEADPHONE_STAND[0], HEADPHONE_STAND[2], Math.PI / 2],
    nameplate: [0.24, 0.555, 0], phone: [DESK_PHONE[0], DESK_PHONE[2], 0],
  },
  boss: {
    plant: [0.53, 0.27, 0], photo: [-0.42, 0.58, Math.PI + 0.5], headphones: [-0.52, 0.42, Math.PI / 2], lamp: [0.53, 0.56, -0.7],
    phone: [DESK_PHONE[0], DESK_PHONE[2], 0],
  },
};

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
  // the necklace: a fine loop around the collar, dipping in front onto the blouse, with a pendant
  const chain = new THREE.TorusGeometry(0.072, 0.0055, 4, Math.max(12, L + 4));
  chain.rotateX(Math.PI / 2 + 0.5);
  chain.scale(1, 1, 1.85);
  chain.translate(0, 0.185, 0);
  const pendant = placed(new THREE.SphereGeometry(0.014, S[0], S[1]), 0, 0.137, 0.12);
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

  // ---- P-VIZ.7 (ADR-0641)
  const B1 = Math.min(1, B), R16 = Math.max(16, L * 2);
  const ST = STAPLER;
  const bodyY = ST.baseH + 0.003 + ST.bodyH / 2;
  // the decal on the body's flat top, lifted 1.2 mm along its normal (plus a polygon offset): no z-fighting up close
  const topX = 0.003 + (ST.bodyH / 2 + 0.0012) * Math.sin(-ST.tilt), topY = bodyY + (ST.bodyH / 2 + 0.0012) * Math.cos(ST.tilt);
  const zoomTex = (cv: HTMLCanvasElement): THREE.CanvasTexture => {
    const tex = canvasTex(cv);
    tex.anisotropy = 8;
    return tex;
  };
  // the lanyard (chest frame at the reference torso depth; the figure scales it to its own)
  const cord = 0.0042, cs = Math.max(4, L >> 1);
  const behind = new THREE.TorusGeometry(0.058, cord, 4, Math.max(8, L), Math.PI);
  behind.rotateX(-Math.PI / 2);
  behind.translate(0, 0.205, 0);
  // the hoodie's hood: a thick open ring bunched behind the neck, its gap at the front
  const hood = new THREE.TorusGeometry(0.088, 0.034, Math.max(5, S[1]), Math.max(10, L + 4), Math.PI * 1.3);
  hood.rotateX(-Math.PI / 2);
  hood.rotateY(-0.15 * Math.PI);
  hood.scale(1, 1.25, 0.9);
  hood.translate(0, 0.19, -0.035);
  // (flat leaves need few segments: a fraction of the small parts' tessellation)
  const leafSeg: Seg = [Math.max(6, S[0] >> 1), Math.max(4, S[1] >> 1)];
  const leaves: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 7; k++) {
    const leaf = new THREE.SphereGeometry(0.018, leafSeg[0], leafSeg[1]);
    leaf.scale(0.55, 2.4, 0.22);
    const a = (k / 7) * TAU;
    leaves.push(placed(leaf, Math.sin(a) * 0.016, 0.1, Math.cos(a) * 0.016, 0.55, a));
  }
  const tall = new THREE.SphereGeometry(0.018, leafSeg[0], leafSeg[1]);
  tall.scale(0.6, 2.9, 0.24);
  leaves.push(placed(tall, 0, 0.11, 0, 0.1, 0.4));
  const H = HEADPHONE_STAND_H;
  const shade = new THREE.ConeGeometry(0.05, 0.065, L, 1, true);
  const CW = COPIER.w, CD = COPIER.d, CH = COPIER.h;

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
    necklace: merge([chain, pendant]),
    can: new THREE.CylinderGeometry(0.024, 0.024, 0.085, L),
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
    staplerBase: merge([
      placed(box(ST.len, ST.baseH, ST.w * 0.94, B1, 0.004), 0, ST.baseH / 2, 0),
      placed(new THREE.CylinderGeometry(0.007, 0.007, ST.w * 0.9, L), -ST.len / 2 + 0.008, ST.baseH + 0.005, 0, Math.PI / 2),
    ]),
    staplerBody: placed(box(ST.len - 0.006, ST.bodyH, ST.w, B, 0.009), 0.003, bodyY, 0, 0, 0, ST.tilt),
    staplerTop: placed(new THREE.PlaneGeometry(ST.len - 0.02, ST.w - 0.008), topX, topY, 0, -Math.PI / 2, 0, ST.tilt),
    tpsTop: placed(new THREE.PlaneGeometry(PILE.w - 0.004, PILE.d - 0.004), 0, PILE.h / 2 + 0.0008, 0, -Math.PI / 2),
    coinRim: placed(new THREE.CylinderGeometry(COIN_R, COIN_R, COIN_T, R16, 1, true), 0, 0, 0, Math.PI / 2),
    coinFace: new THREE.CircleGeometry(COIN_R - 0.001, R16),
    lanyard: merge([
      behind,
      rod([-0.058, 0.205, 0], [-0.05, 0.15, 0.122], cord, cs), rod([-0.05, 0.15, 0.122], [0.026, 0.05, 0.148], cord, cs),
      rod([0.058, 0.205, 0], [0.05, 0.15, 0.122], cord, cs), rod([0.05, 0.15, 0.122], [0.044, 0.05, 0.148], cord, cs),
      placed(new THREE.BoxGeometry(0.016, 0.012, 0.006), 0.035, 0.046, 0.149),
    ]),
    badge: placed(box(0.05, 0.07, 0.003, 0, 0), 0.035, 0.005, 0.152),
    badgeFace: placed(new THREE.PlaneGeometry(0.046, 0.066), 0.035, 0.005, 0.1545),
    plateFace: placed(new THREE.PlaneGeometry(0.17, 0.037), 0, 0, 0.0158),
    cuff: placed(new THREE.TorusGeometry(0.044, 0.013, 5, Math.max(8, L)), 0, -0.012, 0, Math.PI / 2),
    hoodie: merge([hood, placed(box(0.15, 0.065, 0.02, B1, 0.008), 0, -0.1, 0.1, 0.12)]),
    strings: merge([-1, 1].map((s) => rod([s * 0.025, 0.165, 0.11], [s * 0.03, 0.075, 0.138], 0.0035, cs))),
    pot: merge([placed(new THREE.CylinderGeometry(0.036, 0.027, 0.06, L), 0, 0.03, 0), placed(new THREE.CylinderGeometry(0.039, 0.039, 0.01, L), 0, 0.058, 0)]),
    leaves: merge(leaves),
    frame: merge([placed(box(0.078, 0.062, 0.008, B1, 0.003), 0, 0.031, 0, -0.2), placed(new THREE.BoxGeometry(0.01, 0.05, 0.004), 0, 0.024, -0.02, 0.45)]),
    picture: placed(new THREE.PlaneGeometry(0.064, 0.048), 0, 0.031 + 0.0009, 0.0045, -0.2),
    phonesStand: merge([
      placed(new THREE.CylinderGeometry(0.04, 0.045, 0.01, L), 0, 0.005, 0),
      placed(new THREE.CylinderGeometry(0.007, 0.007, H, Math.max(6, L >> 1)), 0, H / 2, 0),
      placed(new THREE.BoxGeometry(0.06, 0.01, 0.014), 0, H, 0),
    ]),
    headphones: merge([
      new THREE.TorusGeometry(PHONES_R, 0.012, 5, Math.max(12, L + 2), Math.PI),
      ...[-1, 1].map((s) => placed(new THREE.CylinderGeometry(0.05, 0.05, 0.03, L), s * PHONES_R, -0.01, 0, 0, 0, Math.PI / 2)),
    ]),
    screenBox: box(0.34, 0.25, 0.04, B, 0.012),
    monitorArm: new THREE.BoxGeometry(0.025, 0.2, 0.02),
    lamp: merge([
      placed(new THREE.CylinderGeometry(0.045, 0.05, 0.012, L), 0, 0.006, 0),
      rod([0, 0.012, 0], [0, 0.2, -0.05], 0.007, cs),
      rod([0, 0.2, -0.05], [-0.15, 0.24, 0], 0.006, cs),
      placed(new THREE.SphereGeometry(0.011, S[0], S[1]), 0, 0.2, -0.05),
    ]),
    shade: placed(shade, -0.16, 0.215, 0, 0, 0, -0.6),
    bulb: placed(new THREE.SphereGeometry(0.016, S[0], S[1]), -0.17, 0.2, 0),
    phoneBase: merge([
      placed(box(0.095, 0.03, 0.085, B1, 0.008), 0, 0.015, 0),
      ...[-1, 1].map((s) => placed(new THREE.BoxGeometry(0.02, 0.008, 0.03), s * 0.04, 0.03, 0)),
      ...[-1, 0, 1].map((k) => placed(new THREE.BoxGeometry(0.012, 0.004, 0.01), k * 0.02, 0.031, 0.031)),
    ]),
    handset: merge([placed(box(0.11, 0.016, 0.026, B1, 0.006), 0, 0, 0), ...[-1, 1].map((s) => placed(box(0.026, 0.024, 0.03, B1, 0.007), s * 0.045, -0.002, 0))]),
    copierBody: merge([
      placed(box(CW, CH - 0.05, CD, B, 0.015), 0, 0.05 + (CH - 0.05) / 2, 0),
      placed(box(CW + 0.006, COPIER.lid, CD - 0.01, B1, 0.008), 0, CH + COPIER.lid / 2, 0),
      placed(new THREE.BoxGeometry(0.2, 0.008, 0.2), 0, 0.4, 0.31, TRAY_TILT),
    ]),
    copierDark: merge([
      placed(new THREE.BoxGeometry(CW + 0.02, 0.05, CD + 0.02), 0, 0.025, 0),
      placed(new THREE.BoxGeometry(0.22, 0.02, 0.006), 0, 0.42, CD / 2 + 0.001),
      ...[0.2, 0.36].map((y) => placed(new THREE.BoxGeometry(0.006, 0.014, 0.16), -CW / 2 - 0.003, y, 0)),
    ]),
    copierPanel: box(0.08, 0.03, 0.22, B1, 0.008),
    copierButton: new THREE.CylinderGeometry(0.014, 0.014, 0.008, L),
    copierDisplay: placed(new THREE.PlaneGeometry(0.05, 0.08), 0, 0, 0, -Math.PI / 2),
    staplerTex: zoomTex(staplerCanvas()),
    tpsTex: zoomTex(tpsCanvas()),
    copyTex: zoomTex(copyCanvas()),
    bubbleTex: canvasTex(bubbleCanvas()),
    photoTex: canvasTex(photoCanvas()),
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

/** One manager's own parts per detail tier, built the first time that manager takes the desk and ref-counted
 *  like GeoSet: the hair (skull frame) and its salt-and-pepper texture; the woman's scarf (chest frame) and
 *  earrings (skull frame). The man's tie is the shared GeoSet's. */
interface ManagerGeo {
  refs: number;
  hair: THREE.BufferGeometry; hairTex: THREE.CanvasTexture;
  scarf: THREE.BufferGeometry | null; earrings: THREE.BufferGeometry | null;
}

/** Hair building blocks (skull frame) at a tier's resolution: a ball for volume, a shell band around the head
 *  open over the face by `open` on each side (from polar angle `from`, `len` long), and the top cap. */
function hairBall(t: Tier, r: number): THREE.SphereGeometry {
  return new THREE.SphereGeometry(r, Math.max(8, t.head[0] >> 1), Math.max(6, t.head[1] >> 1));
}
function hairBand(t: Tier, r: number, open: number, from: number, len: number): THREE.SphereGeometry {
  return new THREE.SphereGeometry(r, t.head[0], Math.max(4, t.head[1] >> 1), Math.PI / 2 + open, TAU - 2 * open, from, len);
}
function hairCap(t: Tier, r: number): THREE.SphereGeometry {
  return new THREE.SphereGeometry(r, t.head[0], Math.max(4, t.head[1] >> 1), 0, TAU, 0, Math.PI / 2);
}

function buildManagerGeo(t: Tier, v: ManagerVariant): ManagerGeo {
  const S = t.small, L = t.limb;
  const cap = hairCap(t, v === "man" ? 0.168 : 0.17);
  let hair: THREE.BufferGeometry;
  if (v === "man") {
    // a full head: the cap swept up off the forehead, combed over from the part on his left (-X) with volume at
    // the front, trimmed behind the ears down to the nape
    cap.scale(1.03, 1.1, 1.04);
    cap.rotateX(-0.38);
    cap.translate(0, 0.012, -0.012);
    const sweep = hairBall(t, 0.1);
    sweep.scale(1.35, 0.5, 1.05);
    placed(sweep, 0.035, 0.13, 0.05, -0.2, 0, -0.22);
    const side = hairBall(t, 0.07);
    side.scale(0.9, 0.5, 1.25);
    placed(side, -0.1, 0.115, 0.02, -0.1, 0, 0.55);
    hair = merge([cap, sweep, side, hairBand(t, 0.171, 1.75, Math.PI * 0.42, Math.PI * 0.22)]);
  } else {
    // a chin-length bob, open over the face, its hem curving under at the jaw, and a side-swept fringe
    cap.scale(1.05, 1.1, 1.05);
    cap.rotateX(-0.3);
    cap.translate(0, 0.01, -0.008);
    const bob = hairBand(t, 0.178, 0.95, Math.PI * 0.28, Math.PI * 0.42);
    bob.scale(1.06, 1, 1.02);
    const fringe = hairBall(t, 0.085);
    fringe.scale(1.55, 0.42, 0.9);
    placed(fringe, 0.03, 0.118, 0.09, -0.32, 0, -0.3);
    hair = merge([cap, bob, fringe]);
  }
  hairUv(hair);
  const hairTex = canvasTex(saltPepperCanvas(MANAGER_HAIR[v].base, MANAGER_HAIR[v].grey));
  if (v === "man") return { refs: 0, hair, hairTex, scarf: null, earrings: null };
  // the scarf: a loop around the collar, a knot at the throat and two short tails over the blouse
  const loop = new THREE.TorusGeometry(0.068, 0.022, Math.max(4, S[1]), Math.max(10, L + 4));
  loop.rotateX(Math.PI / 2);
  loop.scale(1, 1, 0.92);
  loop.translate(0, 0.185, 0.006);
  const knot = new THREE.SphereGeometry(0.026, S[0], S[1]);
  knot.scale(1.1, 0.9, 0.8);
  knot.translate(0.016, 0.168, 0.1);
  const scarf = merge([
    loop, knot,
    placed(new THREE.BoxGeometry(0.034, 0.085, 0.012), 0.032, 0.12, 0.142, -0.18, 0, 0.22),
    placed(new THREE.BoxGeometry(0.03, 0.075, 0.012), 0.004, 0.126, 0.144, -0.18, 0, -0.12),
  ]);
  const earrings = merge([-1, 1].map((s) => placed(new THREE.SphereGeometry(0.013, S[0], S[1]), s * 0.128, -0.118, 0.035)));
  return { refs: 0, hair, hairTex, scarf, earrings };
}

const MANAGER_GEO = new Map<string, ManagerGeo>();

function acquireManagerGeo(detail: OfficeDetail, v: ManagerVariant): ManagerGeo {
  const key = `${detail}:${v}`;
  let set = MANAGER_GEO.get(key);
  if (!set) {
    set = buildManagerGeo(TIERS[detail], v);
    MANAGER_GEO.set(key, set);
  }
  set.refs++;
  return set;
}

function releaseManagerGeo(detail: OfficeDetail, v: ManagerVariant): void {
  const key = `${detail}:${v}`;
  const set = MANAGER_GEO.get(key);
  if (!set || --set.refs > 0) return;
  for (const x of Object.values(set)) if (x instanceof THREE.BufferGeometry || x instanceof THREE.Texture) x.dispose();
  MANAGER_GEO.delete(key);
}

/** A worker's hairstyle (skull frame, a plain toon color; see viz_office_pose.workerCast). Original toon cuts:
 *  crop (short with a tuft swept up at the front), swept (combed over the other way), curly (a crown of curls),
 *  buzz (close-cropped); bob (chin length with a side fringe), ponytail (a high tie, the tail down the back),
 *  bun (a round bun at the crown), long (past the jaw, center fringe). */
function buildWorkerHair(t: Tier, style: WorkerHair): THREE.BufferGeometry {
  const S = t.small;
  const small = (r: number): THREE.SphereGeometry => new THREE.SphereGeometry(r, S[0], S[1]);
  const female = (r: number): THREE.SphereGeometry => {
    const cap = hairCap(t, r);
    cap.scale(1.04, 1.09, 1.04);
    cap.rotateX(-0.32);
    cap.translate(0, 0.01, -0.008);
    return cap;
  };
  switch (style) {
    case "crop": {
      const cap = hairCap(t, 0.163);
      cap.rotateX(-0.45);
      cap.translate(0, 0.01, -0.01);
      const tuft = small(0.07);
      tuft.scale(1.4, 0.55, 1);
      return merge([cap, placed(tuft, 0.05, 0.14, 0.06, 0, 0, -0.3)]);
    }
    case "swept": {
      const cap = hairCap(t, 0.165);
      cap.rotateX(-0.4);
      cap.translate(0, 0.012, -0.01);
      const sweep = hairBall(t, 0.095);
      sweep.scale(1.45, 0.5, 1.05);
      return merge([cap, placed(sweep, -0.03, 0.128, 0.05, -0.2, 0, 0.25)]);
    }
    case "curly": {
      const cap = hairCap(t, 0.166);
      cap.rotateX(-0.42);
      cap.translate(0, 0.012, -0.012);
      const parts: THREE.BufferGeometry[] = [cap, placed(small(0.05), 0, 0.175, -0.01)];
      for (let k = 0; k < 7; k++) {
        const az = (k / 7) * TAU;
        parts.push(placed(small(0.046), Math.sin(az) * 0.093, 0.147, Math.cos(az) * 0.093 - 0.01));
      }
      for (const x of [-0.06, 0, 0.06]) parts.push(placed(small(0.036), x, 0.13 + (x === 0 ? 0.01 : 0), 0.11));
      return merge(parts);
    }
    case "buzz": {
      const cap = hairCap(t, 0.159);
      cap.rotateX(-0.5);
      cap.translate(0, 0.008, -0.012);
      return cap;
    }
    case "bob": {
      const bob = hairBand(t, 0.178, 0.95, Math.PI * 0.28, Math.PI * 0.42);
      bob.scale(1.06, 1, 1.02);
      const fringe = hairBall(t, 0.085);
      fringe.scale(1.55, 0.42, 0.9);
      return merge([female(0.17), bob, placed(fringe, -0.03, 0.118, 0.09, -0.32, 0, 0.3)]);
    }
    case "ponytail": {
      const fringe = hairBall(t, 0.08);
      fringe.scale(1.6, 0.38, 0.85);
      const tail = new THREE.CapsuleGeometry(0.042, 0.2, Math.max(2, S[1] >> 1), Math.max(6, S[0]));
      tail.scale(1, 1, 0.75);
      return merge([female(0.168), placed(fringe, 0, 0.122, 0.095, -0.35), placed(small(0.026), 0, 0.07, -0.165), placed(tail, 0, -0.06, -0.19, 0.22)]);
    }
    case "bun": {
      const fringe = hairBall(t, 0.08);
      fringe.scale(1.6, 0.38, 0.85);
      const bun = hairBall(t, 0.062);
      bun.scale(1, 0.9, 1);
      return merge([female(0.168), placed(fringe, 0.02, 0.12, 0.095, -0.35, 0, -0.2), placed(bun, 0, 0.13, -0.12)]);
    }
    case "long": {
      const back = hairBand(t, 0.178, 1.1, Math.PI * 0.3, Math.PI * 0.5);
      back.scale(1.06, 1.45, 1.03);
      const parts: THREE.BufferGeometry[] = [female(0.17), back];
      for (const s of [-1, 1]) {
        const f = hairBall(t, 0.065);
        f.scale(1.3, 0.4, 0.85);
        parts.push(placed(f, s * 0.05, 0.12, 0.1, -0.32, 0, s * 0.3));
      }
      return merge(parts);
    }
  }
}

const WORKER_HAIR = new Map<string, { refs: number; geo: THREE.BufferGeometry }>();

function acquireWorkerHair(detail: OfficeDetail, style: WorkerHair): THREE.BufferGeometry {
  const key = `${detail}:${style}`;
  let set = WORKER_HAIR.get(key);
  if (!set) {
    set = { refs: 0, geo: buildWorkerHair(TIERS[detail], style) };
    WORKER_HAIR.set(key, set);
  }
  set.refs++;
  return set.geo;
}

function releaseWorkerHair(detail: OfficeDetail, style: WorkerHair): void {
  const key = `${detail}:${style}`;
  const set = WORKER_HAIR.get(key);
  if (!set || --set.refs > 0) return;
  set.geo.dispose();
  WORKER_HAIR.delete(key);
}

/** The cast the last boss left with, so a rebuild (a style, 2D/3D or detail switch) keeps the manager; while a
 *  boss lives it is that boss's cast, so a second live boss shows the same manager. */
let castMemo: (ManagerMemo & { auto: boolean }) | null = null;
let liveBosses = 0;

// ------------------------------------------------------------------------------------------ the figure

const O_ROOT = officeJointOffset("root");
const O_HIPS = officeJointOffset("hips");
const O_SPINE = officeJointOffset("spine");
const O_CHEST = officeJointOffset("chest");
const O_NECK = officeJointOffset("neck");
const O_HEAD = officeJointOffset("head");
const O_SHR = officeJointOffset("shR");
const O_ELR = officeJointOffset("elR");
const J_SHL = OFFICE_JOINTS.indexOf("shL");
const J_SHR = OFFICE_JOINTS.indexOf("shR");
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
  private readonly boss: boolean;
  private readonly grad: THREE.DataTexture;

  // materials
  private readonly mShirt: THREE.MeshToonMaterial;
  private readonly mTie: THREE.MeshToonMaterial;
  private readonly mSlacks: THREE.MeshToonMaterial;
  private readonly mJacket: THREE.MeshToonMaterial;
  private readonly mSkin: THREE.MeshToonMaterial;
  private readonly mHair: THREE.MeshToonMaterial;
  private readonly mShoe: THREE.MeshToonMaterial;
  /** The boss's nameplate: the tie's color, but its own material so it never dissolves with the manager. */
  private readonly mPlate: THREE.MeshToonMaterial | null;
  private readonly mWall: THREE.MeshToonMaterial;
  private readonly mTrim: THREE.MeshToonMaterial;
  private readonly mInk: THREE.MeshBasicMaterial;
  private readonly mInkThin: THREE.MeshBasicMaterial;
  /** The ink hulls add() gives a part: the boss's person (body and manager parts) gets its own, alpha-hashed
   *  pair so it dissolves without the desk's and chair's ink. */
  private hull: THREE.MeshBasicMaterial;
  private hullThin: THREE.MeshBasicMaterial;
  private readonly personInk: readonly [THREE.MeshBasicMaterial, THREE.MeshBasicMaterial] | null;
  /** Everything that dissolves in a handover (the boss only). */
  private readonly personMats: THREE.Material[] = [];
  private readonly mScreen: THREE.MeshBasicMaterial;
  private readonly mCrt: THREE.MeshBasicMaterial;
  private readonly mSmoke: THREE.MeshBasicMaterial;
  private readonly mSteam: THREE.MeshBasicMaterial;
  private readonly mSweat: THREE.MeshBasicMaterial;
  private readonly mCoffeeDrop: THREE.MeshBasicMaterial;
  private readonly mZed: THREE.SpriteMaterial;

  // look
  private mini: MiniLook;
  private readonly cTie = new THREE.Color();
  private readonly cSkin = new THREE.Color();
  private readonly face: FacePaint = { glasses: "none", brow: INK, browW: 11, lashes: false, lip: INK };
  private readonly faceCtx: CanvasRenderingContext2D | null;
  private readonly faceTex: THREE.CanvasTexture;
  private readonly screenTex: THREE.Texture;
  private faceKeyNow = -1;

  // rig (OFFICE_JOINTS order)
  private readonly joints: THREE.Group[] = [];
  private readonly root: THREE.Group;
  private readonly hips: THREE.Group;
  private readonly chest: THREE.Group;
  private readonly torso: THREE.Mesh;
  private readonly skull = new THREE.Group();
  private readonly backPivot = new THREE.Group();
  private readonly handL: THREE.Group;
  private readonly handR: THREE.Group;

  // the manager on duty (the boss only; see viz_office_pose's cast)
  private variant: ManagerVariant = "man";
  private cast: ManagerCast = { variant: "man", seed: 0, swaps: 0, nextAt: Infinity };
  private auto = true;
  /** A manager waiting for a quiet moment to take the desk (pinned, or the automatic handover due). */
  private want: ManagerVariant | null = null;
  private swapTo: ManagerVariant = "man";
  /** Seconds into the handover, or -1 when none plays. */
  private swapT = -1;
  private fade = 1;
  private clockNow = 0;
  private readonly sw: SwapSample = { stand: 0, x: 0, lift: 0, z: 0, turn: 0, gait: 0, phase: 0, alpha: 1, incoming: false, done: true };
  /** Each manager's own parts, built the first time he or she takes the desk. */
  private readonly managerParts: Partial<Record<ManagerVariant, THREE.Object3D[]>> = {};
  /** The shared ManagerGeo sets this boss holds a reference on (released by dispose()). */
  private readonly managerGeo: Partial<Record<ManagerVariant, ManagerGeo>> = {};

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
  /** The energy drink, in the right hand while a drink hit plays. */
  private readonly can: THREE.Mesh | null = null;

  // P-VIZ.7 (ADR-0641): the build, the variant and the commit
  /** The variant 0..3 (the outfit, the desk set) for the clips, or -1 at the lowest tier (the plain clips). */
  private readonly actVariant: number;
  /** The worker's outfit (null for the boss). */
  private readonly outfit: WorkerOutfit | null;
  /** The poses solved for this build (the boss: per manager, built on first need). */
  private poses: OfficePoseTable;
  private readonly bossPoses: Partial<Record<ManagerVariant, OfficePoseTable>> = {};
  private readonly scale: number;
  /** Per-figure textures (the emblem on the coin, the badge, the nameplate), freed by dispose(). */
  private readonly ownTex: THREE.Texture[] = [];
  /** The orbit (a pivot over the desk's center) and the coin on it. */
  private readonly orbit = new THREE.Group();
  private readonly coin = new THREE.Group();
  private readonly deskCenter = new THREE.Vector2();
  private readonly copier = new THREE.Group();
  private readonly copierButton: THREE.Mesh;
  private readonly mDisplay: THREE.MeshBasicMaterial;
  private readonly sheets: THREE.Mesh[] = [];
  private readonly bubble: THREE.Sprite;
  private readonly mBubble: THREE.SpriteMaterial;
  private commitOn = false;
  /** 0 at the desk .. 1 at the copier (eased in use); `commitT` the seconds since the copier scene began. */
  private commitW = 0;
  private commitT = 0;
  private readonly cpose = new Float32Array(OFFICE_POSE_LEN);
  private readonly cinfo: OfficeClipSample = { emotion: "neutral", gaze: 0 };
  /** The desk phone's handset on its cradle and in the left hand; the headphones on the stand, in the hand, on the
   *  head (null when the desk set has none). */
  private deskHandset: THREE.Object3D | null = null;
  private handHandset: THREE.Object3D | null = null;
  private phonesStand: THREE.Object3D | null = null;
  private phonesHand: THREE.Object3D | null = null;
  private phonesHead: THREE.Object3D | null = null;
  /** The headphones' and the handset's material (built with the first of them). */
  private mGear: THREE.MeshToonMaterial | null = null;
  /** The lanyard and badge (null without a brand), scaled to the torso's depth. */
  private lanyard: THREE.Group | null = null;

  // P-VIZ.6: who the worker is (null for the boss) and the hit layer (a one-shot over the activity) and charge
  private readonly worker: WorkerCast | null;
  private hitPlan: OfficeHitPlan | null = null;
  private hitT = 0;
  private readonly hs = newOfficeHitSample();
  private readonly hitPose = new Float32Array(OFFICE_POSE_LEN);
  /** The pose on screen when the hit landed: the hit blends in from it. */
  private readonly hitSnap = new Float32Array(OFFICE_POSE_LEN);
  private readonly hitFrom = new THREE.Vector3();
  /** The throw had no usable origin: turn toward `hitCam` instead. */
  private hitAtCam = false;
  private hitCam: THREE.Camera | null = null;
  private readonly chg = newCharge();
  private chargeNow = 0;
  private clockAt = Number.NaN;

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
    const boss = (this.boss = this.role === "boss");
    const flat = o.flat;
    this.rng = (instanceSeed++ * 2654435761) >>> 0 || 1;
    this.phase = this.random() * TAU;
    this.blinkIn = nextBlinkDelay(this.random());
    this.group.name = boss ? "office-boss" : "office-worker";
    this.mini = o.look;
    const worker = (this.worker = boss ? null : workerCast(this.seed));
    // P-VIZ.7: the sponsor, the size class's scale and the variant (outfit, desk set, actions)
    const brand = o.brand ?? null;
    this.scale = brand && Number.isFinite(brand.scale) && brand.scale > 0 ? brand.scale : 1;
    const dv = officeVariant(brand?.variant, this.seed);
    this.actVariant = t.deskSet ? dv : -1;
    const outfit = (this.outfit = worker ? workerOutfit(worker, dv) : null);
    const long = outfit !== null && longSleeves(outfit);
    const woman = worker?.gender === "female";
    // (the boss's: the manager on duty's, set by showVariant below)
    this.poses = boss ? OFFICE_POSE_VECTORS : officePoseTable({ shoulderX: woman ? SHOULDER_X.woman : SHOULDER_X.man, scale: this.scale });
    if (boss) {
      // who opens: the live or just-gone boss's cast (a rebuild), else a fresh seeded coin flip
      const now = performance.now() / 1000;
      this.clockNow = now;
      const memo = castMemo && liveBosses > 0 ? { ...castMemo, goneAt: now } : castMemo;
      this.cast = openManagerCast(Math.floor(Math.random() * 4294967296), now, memo);
      this.auto = memo !== null && this.cast === memo.cast ? memo.auto : true;
      this.variant = this.cast.variant;
      liveBosses++;
      this.remember(now);
    }

    // ---- materials (untoned like the anime figure, so the persona color stays itself)
    const grad = (this.grad = toonGrad(flat ? 2 : 3));
    const toon = (p: THREE.MeshToonMaterialParameters = {}) => this.own(new THREE.MeshToonMaterial({ gradientMap: grad, toneMapped: false, ...p }));
    const basic = (p: THREE.MeshBasicMaterialParameters) => this.own(new THREE.MeshBasicMaterial({ toneMapped: false, ...p }));
    // the boss's person dissolves in a handover: alpha-hashed (no sorting; fully opaque at opacity 1)
    const person = (p: THREE.MeshToonMaterialParameters = {}): THREE.MeshToonMaterial => {
      if (!boss) return toon(p);
      const m = toon({ alphaHash: true, ...p });
      this.personMats.push(m);
      return m;
    };
    this.mShirt = person();
    this.mTie = person({ emissiveIntensity: 0.15 });
    this.mSlacks = person();
    this.mJacket = person();
    this.mSkin = person();
    this.mHair = person({ side: THREE.DoubleSide }); // hair has open shells (the bobs, the long cut, the nape)
    this.mShoe = person({ color: "#1d1a19" });
    this.mPlate = boss ? toon({ emissiveIntensity: 0.15 }) : null;
    this.mWall = toon();
    this.mTrim = toon({ emissiveIntensity: 0.25 });
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
    const mCan = toon({ color: "#b9f227" });
    // P-VIZ.7: the glossy red stapler (black base, a decal on top lifted with a polygon offset), the TPS cover sheet
    const offset = { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 } as const;
    const mRed = toon({ color: "#d3151b", emissive: "#5a0306", emissiveIntensity: 0.35 });
    const mBlack = toon({ color: "#16171b" });
    const mDecal = basic({ map: g.staplerTex, transparent: true, depthWrite: false, ...offset });
    const mTps = toon({ map: g.tpsTex, ...offset });
    const cv = document.createElement("canvas");
    cv.width = Math.round(FW * t.faceScale);
    cv.height = Math.round(FH * t.faceScale);
    this.faceCtx = cv.getContext("2d");
    this.faceTex = new THREE.CanvasTexture(cv);
    this.faceTex.colorSpace = THREE.SRGBColorSpace;
    this.faceTex.anisotropy = 4;
    const mFace = toon({ map: this.faceTex, transparent: true });
    if (boss) this.personMats.push(mFace); // already transparent: it fades by opacity
    const ink = flat ? INK_FLAT : INK_3D;
    this.mInk = this.own(inkMat(ink));
    this.mInkThin = this.own(inkMat(ink * 0.6));
    this.hull = this.mInk;
    this.hullThin = this.mInkThin;
    this.personInk = boss ? [this.own(inkMat(ink)), this.own(inkMat(ink * 0.6))] : null;
    if (this.personInk) for (const m of this.personInk) { m.alphaHash = true; this.personMats.push(m); }
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
    // P-VIZ.7: the pile is a stack of TPS reports (the cover sheet on top), NORM's red stapler on it
    pile.add(new THREE.Mesh(g.tpsTop, mTps));
    const stapler = G();
    pile.add(stapler);
    stapler.position.set(STAPLER_ON_PILE.x, PILE.h / 2 + 0.0012, STAPLER_ON_PILE.z);
    stapler.rotation.y = STAPLER_ON_PILE.yaw;
    this.add(stapler, g.staplerBase, mBlack, thin);
    this.add(stapler, g.staplerBody, mRed, thin);
    const norm = new THREE.Mesh(g.staplerTop, mDecal);
    norm.renderOrder = 1;
    stapler.add(norm);
    const loose = this.add(this.desk, g.sheet, mPaper, 0);
    loose.position.set(boss ? 0.16 : -0.14, DESK_Y + 0.002, 0.5);
    loose.rotation.set(-Math.PI / 2, 0, 0.3);
    // the mug's handle faces its -X side, where the left hand takes it (viz_office_pose.MUG_GRIP)
    this.desk.add(this.deskMug);
    this.deskMug.position.set(DESK_MUG[0], DESK_MUG[1], DESK_MUG[2]);
    this.add(this.deskMug, g.mug, mMug, thin).rotation.y = Math.PI;
    this.coffee = new THREE.Mesh(g.coffee, mCoffee);
    this.deskMug.add(this.coffee);
    const deskSet: readonly DeskItem[] = t.deskSet ? officeDeskSet(this.role, dv) : [];
    const plateMat = brand ? basic({ map: this.brandTex(emblemCanvas(brand, 512, 112, { word: true })), transparent: true, ...offset }) : null;
    if (boss) {
      const plate = this.add(this.desk, g.nameplate, this.mPlate ?? this.mTie, thin);
      plate.position.set(0, DESK_Y + 0.0225, 0.6);
      if (plateMat) plate.add(new THREE.Mesh(g.plateFace, plateMat));
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
      if (deskSet.includes("monitor2")) {
        // P-VIZ.7: a second screen stacked over the first on a pole, tipped down a little (the same code scrolls)
        this.add(mon, g.monitorArm, mMonitor, thin).position.set(0, SCREEN_Y + 0.14, -0.035);
        const up = G();
        mon.add(up);
        up.position.set(0, SCREEN_Y + 0.27, -0.01);
        up.rotation.x = 0.12;
        this.add(up, g.screenBox, mMonitor, 1);
        const scr2 = new THREE.Mesh(g.screen, this.mScreen);
        scr2.position.z = 0.0205;
        up.add(scr2);
      }
      const kb = (this.keyboard = this.add(this.desk, g.keyboard, mKeyboard, thin));
      kb.position.set(KEYBOARD.x, KEYBOARD.y, KEYBOARD.z);
      kb.rotation.y = KEYBOARD.yaw;
      this.smokeAt.set(MONITOR_POS[0], MONITOR_POS[1] + SCREEN_Y + 0.14, MONITOR_POS[2]);
    }
    // P-VIZ.7: the variant's desk items (DESK_SPOTS), not at the lowest tier
    for (const item of deskSet) if (item !== "monitor2") this.buildDeskItem(item, plateMat, thin);
    this.deskCenter.set(boss ? 0 : 0.025, boss ? 0.4 : 0.38);

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
    // P-VIZ.7: the brand's size class scales him and his chair about the floor (the desk set stays put; the hands are
    // solved for this scale, see `poses`)
    root.scale.setScalar(this.scale);
    this.add(root, g.chairBase, mMetal, thin);
    this.add(root, g.seat, mChair, 1).position.set(0, SEAT_Y - 0.03, -0.02);
    root.add(this.backPivot);
    this.backPivot.position.set(0, SEAT_Y, -0.19);
    this.add(this.backPivot, boss ? g.bossBack : g.back, mChair, 1);

    // ---- the body (the boss's person takes the dissolving ink, see `hull`)
    if (this.personInk) [this.hull, this.hullThin] = this.personInk;
    const hips = (this.hips = G()), spine = G(), chest = (this.chest = G()), neck = G(), head = G();
    const R = OFFICE_RIG;
    root.add(hips); hips.position.y = HIP_Y; hips.add(spine); spine.add(chest); chest.position.y = R.chestY; chest.add(neck); neck.position.y = R.neckY; neck.add(head); head.position.y = R.headY;
    this.add(hips, g.pelvis, this.mSlacks, 1);
    // the boss's suit and blazer and a worker's sweater, cardigan, blazer, hoodie or vest are the jacket (P-VIZ.7: a
    // vest is the jacket over short shirt sleeves); a shirt or blouse alone (or with rolled-up sleeves)
    const hoodie = outfit === "hoodie", vest = outfit === "vest", rolled = outfit === "rolled";
    this.torso = this.add(spine, g.torso, boss || long || vest ? this.mJacket : this.mShirt, 1);
    if (woman) this.torso.scale.set(0.95, 1, 0.76);
    else this.torso.scale.set(1, 1, 0.78); // the boss's: showVariant()
    if (g.belt && !boss && !long && !vest) this.add(spine, g.belt, this.mShoe, 0).scale.set(1, 0.8, 1);
    if (g.collar && !hoodie) this.add(chest, g.collar, this.mShirt, thin).scale.set(1, 0.85, 1);
    if ((boss || long || vest) && !hoodie) {
      const vee = this.add(chest, g.vee, this.mShirt, 0);
      vee.rotation.set(Math.PI, Math.PI / 6 + Math.PI, 0);
      vee.position.set(0, 0.1, 0.118);
      vee.scale.set(1, 1, 0.2);
    }
    if (hoodie) {
      this.add(chest, g.hoodie, this.mJacket, thin);
      this.add(chest, g.strings, this.toonMat({ color: "#f2f1ec" }), 0);
    } else if (woman) this.add(chest, g.necklace, this.mTie, 0);
    else if (!boss) {
      // the boss's tie is the man's own part (buildManager); rolled-up sleeves come with the tie loosened
      const knot = this.add(chest, g.tieKnot, this.mTie, thin);
      knot.position.set(rolled ? 0.004 : 0, rolled ? 0.142 : 0.162, rolled ? 0.113 : 0.108);
      knot.rotation.z = rolled ? 0.18 : 0;
      const blade = this.add(chest, g.tieBlade, this.mTie, 0);
      blade.position.set(rolled ? 0.005 : 0, rolled ? 0.132 : 0.152, rolled ? 0.118 : 0.114);
      blade.rotation.set(-0.08, 0, rolled ? 0.07 : 0);
    }
    this.add(neck, g.neck, this.mSkin, 1).position.y = 0.02;

    // head: the skull, the face patch, the nose, ears, hair (the boss's hair is the manager's own part)
    head.add(this.skull);
    this.skull.position.y = 0.15;
    this.skull.scale.set(1, 1.06, 0.98);
    this.add(this.skull, g.head, this.mSkin, 1);
    const faceMesh = new THREE.Mesh(g.face, mFace);
    faceMesh.renderOrder = 1;
    this.skull.add(faceMesh);
    this.add(this.skull, g.nose, this.mSkin, thin).position.set(0, -0.025, 0.148);
    if (g.ear) for (let s = -1; s <= 1; s += 2) this.add(this.skull, g.ear, this.mSkin, thin).position.set(s * 0.153, -0.01, 0);
    if (worker) this.add(this.skull, acquireWorkerHair(this.detail, worker.hair), this.mHair, 1);

    // arms (L is -X): short sleeves and bare forearms, or the jacket's sleeves (the boss, a long top); P-VIZ.7:
    // rolled-up shirt sleeves are long to the elbow with a cuff, the forearms bare
    const sleeves = boss || long;
    const arm = (side: number): [THREE.Group, THREE.Group, THREE.Group] => {
      const sh = G(); chest.add(sh); sh.position.set(side * (boss ? SHOULDER_X.bossMan : woman ? SHOULDER_X.woman : SHOULDER_X.man), R.shoulderY, 0);
      if (sleeves || rolled) {
        const m = rolled ? this.mShirt : this.mJacket;
        this.add(sh, g.jacketCap, m, 1);
        this.add(sh, g.jacketUpper, m, 1);
      } else {
        this.add(sh, g.shoulderCap, this.mShirt, 1);
        this.add(sh, g.upperArm, this.mSkin, 1);
        this.add(sh, g.sleeve, this.mShirt, 1);
      }
      const el = G(); sh.add(el); el.position.y = -R.upperArm;
      this.add(el, sleeves ? g.jacketFore : g.foreArm, sleeves ? this.mJacket : this.mSkin, 1);
      if (rolled) this.add(el, g.cuff, this.mShirt, thin);
      const hand = G(); el.add(hand); hand.position.y = -R.foreArm;
      this.add(hand, g.hand, this.mSkin, thin).position.y = -R.palm;
      return [sh, el, hand];
    };
    const leg = (side: number): [THREE.Group, THREE.Group] => {
      const hip = G(); hips.add(hip); hip.position.set(side * 0.09, -0.02, 0);
      this.add(hip, g.thigh, this.mSlacks, 1);
      const knee = G(); hip.add(knee); knee.position.y = -0.3;
      this.add(knee, g.shin, this.mSlacks, 1);
      this.add(knee, g.shoe, this.mShoe, thin).position.set(0, -0.35, 0.035);
      return [hip, knee];
    };
    const [shL, elL, handL] = arm(-1), [shR, elR, handR] = arm(1), [hipL, kneeL] = leg(-1), [hipR, kneeR] = leg(1);
    this.handL = handL;
    this.handR = handR;
    const byName: Record<(typeof OFFICE_JOINTS)[number], THREE.Group> = { root, hips, spine, chest, neck, head, shL, elL, shR, elR, hipL, kneeL, hipR, kneeR };
    for (const j of OFFICE_JOINTS) this.joints.push(byName[j]);

    // ---- props in hand (P-VIZ.7: the mug hangs from the palm by its handle, placed per frame, see updateProps)
    handL.add(this.handMug);
    this.handMug.visible = false;
    this.handMug.scale.setScalar(1 / this.scale);
    this.add(this.handMug, g.mug, mMug, thin).rotation.y = Math.PI;
    this.handMug.add(new THREE.Mesh(g.coffee, mCoffee));
    if (this.deskHandset) {
      const hh = (this.handHandset = new THREE.Group());
      handL.add(hh);
      hh.scale.setScalar(1 / this.scale);
      hh.visible = false;
      this.add(hh, g.handset, this.mGear!, thin);
    }
    if (this.phonesStand && !boss) {
      const ph = (this.phonesHand = new THREE.Group());
      handL.add(ph);
      ph.scale.setScalar(PHONES_SMALL / this.scale);
      ph.visible = false;
      this.add(ph, g.headphones, this.mGear!, thin);
      const pd = (this.phonesHead = new THREE.Group());
      this.skull.add(pd);
      pd.visible = false;
      this.add(pd, g.headphones, this.mGear!, thin);
    }
    // P-VIZ.7: the sponsor's lanyard and ID badge (the emblem and the word), at this torso's depth
    if (brand) {
      const lan = G();
      chest.add(lan);
      lan.scale.set(this.torso.scale.x, 1, this.torso.scale.z / 0.78);
      this.add(lan, g.lanyard, person({ color: brand.primary }), 0);
      this.add(lan, g.badge, person({ color: "#f6f6f2" }), thin);
      // (the patch's rounded corners are clear: blended on a worker, alpha-hashed on the dissolving boss)
      const face = basic({ map: this.brandTex(emblemCanvas(brand, 184, 264, { word: true })), transparent: !boss, alphaHash: boss, ...offset });
      if (boss) this.personMats.push(face);
      lan.add(new THREE.Mesh(g.badgeFace, face));
      this.lanyard = lan;
    }
    const can = (this.can = this.add(handR, g.can, mCan, thin));
    can.position.y = -0.05;
    can.visible = false;
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
    this.hull = this.mInk;
    this.hullThin = this.mInkThin;
    if (boss) this.showVariant(this.variant);

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

    // ---- P-VIZ.7: the sponsor's coin orbiting the desk (both faces the emblem, the rim the second color)
    this.body.add(this.orbit);
    this.orbit.position.set(this.deskCenter.x, (boss ? ORBIT.boss : ORBIT.worker).y, this.deskCenter.y);
    this.orbit.add(this.coin);
    this.coin.position.x = (boss ? ORBIT.boss : ORBIT.worker).r;
    this.orbit.visible = brand !== null;
    if (brand) {
      // (transparent: the round badge's margin shows the rim's color inside the coin, not black)
      const mEmblem = basic({ map: this.brandTex(emblemCanvas(brand, 256, 256, { word: false })), transparent: true });
      this.add(this.coin, g.coinRim, toon({ color: brand.secondary, side: THREE.DoubleSide }), thin);
      const front = new THREE.Mesh(g.coinFace, mEmblem);
      front.position.z = COIN_T / 2 + 0.0002;
      const back = new THREE.Mesh(g.coinFace, mEmblem);
      back.position.z = -COIN_T / 2 - 0.0002;
      back.rotation.y = Math.PI;
      this.coin.add(front, back);
    }

    // ---- P-VIZ.7: the copier (the commit), its pooled copies and the "TPS Reports" bubble
    this.body.add(this.copier);
    this.copier.visible = false;
    this.add(this.copier, g.copierBody, toon({ color: "#d9dbe0" }), 1);
    this.add(this.copier, g.copierDark, toon({ color: "#3b4049" }), thin);
    const panel = this.add(this.copier, g.copierPanel, toon({ color: "#3b4049" }), thin);
    panel.position.set(COPIER.panel[0], COPIER.panel[1], COPIER.panel[2]);
    panel.rotation.z = COPIER.panelTilt;
    const btn = (this.copierButton = this.add(panel, g.copierButton, toon({ color: "#2fbf5a", emissive: "#2fbf5a", emissiveIntensity: 0.4 }), 0));
    btn.position.set(COPIER.button[0], COPIER.button[1] + 0.004, COPIER.button[2]);
    this.mDisplay = basic({ color: 0x7cf3b0 });
    const display = new THREE.Mesh(g.copierDisplay, this.mDisplay);
    display.position.set(0, 0.0156, 0.045);
    panel.add(display);
    const mCopy = toon({ map: g.copyTex, side: THREE.DoubleSide });
    for (let i = 0; i < t.copies; i++) {
      const s = new THREE.Mesh(g.sheet, mCopy);
      s.rotation.x = -Math.PI / 2 + TRAY_TILT;
      s.visible = false;
      this.copier.add(s);
      this.sheets.push(s);
    }
    // (a touch under white: the scene's bloom otherwise haloes the bubble over its lettering)
    this.mBubble = this.own(new THREE.SpriteMaterial({ map: g.bubbleTex, color: 0xd6d6d2, transparent: true, depthWrite: false, toneMapped: false }));
    this.bubble = new THREE.Sprite(this.mBubble);
    this.bubble.scale.set(BUBBLE_W, BUBBLE_W * 0.425, 1);
    this.bubble.visible = false;
    this.body.add(this.bubble);

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
    if (this.state === "paused" || this.state === "ended" || this.state === "killed" || this.swapT >= 0) return;
    if (this.shot === "frantic" && this.shotT < 0.6) return;
    this.shot = "frantic";
    this.shotT = 0;
    this.flash = 0.6;
    this.snapshot(SNAP_BLEND_S, true);
  }

  setLook(l: MiniLook): void {
    this.mini = l;
    const lk = officeLook(l, this.seed, this.role, this.variant, this.outfit ?? undefined);
    this.mShirt.color.set(lk.shirt);
    this.cTie.set(lk.tie);
    this.mSlacks.color.set(lk.slacks);
    this.mJacket.color.set(lk.jacket);
    this.mShoe.color.set(lk.shoe);
    this.cSkin.set(lk.skin);
    this.mSkin.color.copy(this.cSkin);
    // the managers' hair is their salt-and-pepper texture (white keeps it as painted)
    this.mHair.color.set(lk.grey ? "#ffffff" : lk.hair);
    const f = this.face, woman = this.boss ? this.variant === "woman" : this.worker?.gender === "female";
    f.glasses = !lk.glasses ? "none" : this.boss && !woman ? "readers" : "frames";
    f.brow = !this.boss ? INK : woman ? "#4a3a30" : "#4b4540";
    f.browW = !this.boss ? (woman ? 9 : 11) : woman ? 10 : 15;
    f.lashes = woman;
    f.lip = lk.lip;
    // the cubicle fabric: office blue-gray with a hint of the persona; the trim is the persona color
    this.mWall.color.set("#76839a").lerp(this.cTie, 0.12);
    this.mTrim.color.copy(this.cTie);
    this.mTrim.emissive.copy(this.cTie);
    this.faceKeyNow = -1;
  }

  react(kind: ReactKind, camera: THREE.Camera): void {
    // (mid-handover there is nobody at the desk to react)
    if (this.disposed || this.state === "killed" || this.swapT >= 0 || (kind !== "stare" && kind !== "outburst")) return;
    if (this.reactKind === "outburst" && kind === "stare") return; // never cut an outburst short
    if (this.reactKind === kind && this.reactT < 0.4) return;
    this.reactKind = kind;
    this.reactT = 0;
    this.reactHold = stareHold(this.random());
    this.reactCam = camera;
  }

  hit(kind: HitKind, from: THREE.Vector3, camera: THREE.Camera, strength = 1): void {
    // (mid-handover there is nobody at the desk to hit)
    if (this.disposed || this.state === "killed" || this.swapT >= 0 || !HIT_KINDS.includes(kind)) return;
    officeHitCharge(this.chg, kind, strength);
    this.chargeNow = chargeLevel(this.chg);
    // the new hit turns on from the weight already on and blends in from the pose on screen, so nothing pops
    this.hitPlan = planOfficeHit(kind, strength, this.hitPlan ? this.hs.turn : 0);
    this.hitT = 0;
    this.hitSnap.set(this.out);
    this.hitAtCam = !(from && Number.isFinite(from.x) && Number.isFinite(from.y) && Number.isFinite(from.z));
    if (!this.hitAtCam) this.hitFrom.copy(from);
    this.hitCam = camera ?? null;
    // a hit replaces a stare or an outburst
    this.reactKind = null;
    this.reactCam = null;
  }

  get charge(): number {
    return this.chargeNow;
  }

  setIdleSeconds(sec: number): void {
    this.idleSec = Number.isFinite(sec) ? Math.max(0, sec) : 0;
  }

  setManagerVariant(v: ManagerVariant | "auto"): void {
    if (!this.boss || this.disposed) return;
    if (v === "auto") {
      if (this.auto) return;
      // back to alternating: the next handover a fresh delay from now, not one long overdue
      this.auto = true;
      this.want = null;
      this.cast = recastManager(this.cast, this.swapT >= 0 ? this.swapTo : this.variant, this.clockNow);
      this.remember(this.clockNow);
      return;
    }
    if (!MANAGER_VARIANTS.includes(v)) return;
    this.auto = false;
    this.want = v;
    this.remember(this.clockNow);
  }

  setCommit(on: boolean): void {
    if (this.disposed) return;
    this.commitOn = on === true;
  }

  get managerVariant(): ManagerVariant | null {
    return this.boss ? this.variant : null;
  }

  get handingOver(): boolean {
    return this.swapT >= 0;
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
    // energized (the energy drink): the work runs faster
    const tempo = officeTempo(this.state, this.kS) * chargeTempo(this.chargeNow);
    if (!motion) { this.shot = null; this.reactKind = null; this.endHit(); }
    if (this.shot) {
      this.shotT += d;
      if (officeClipDone(OFFICE_CLIPS[this.shot], this.shotT)) {
        this.shot = null;
        this.snapshot(BLEND_S, false);
      }
    }
    // ---- the manager on duty: a due or pinned handover starts at a quiet moment and plays over everything
    const sw = this.boss ? this.manage(tSec, d, motion) : null;
    // ---- P-VIZ.7: the commit: the desk set and the copier trade places over COMMIT_BLEND_S (never mid-handover);
    // the copy clip runs from the start of the copier scene, a still of it under reduced motion
    const cTarget = this.commitOn && sw === null && this.state !== "killed" ? 1 : 0;
    this.commitW = motion ? approach(this.commitW, cTarget, d / COMMIT_BLEND_S) : cTarget;
    this.commitT = this.commitW > 0 ? this.commitT + d : 0;
    const cw = this.commitW * this.commitW * (3 - 2 * this.commitW);
    const copyT = officeClipTime(OFFICE_CLIPS.copy, motion ? this.commitT : OFFICE_STILL_T.copy);

    // ---- the clip: the state's, the activity's (the variant's own take on it), or the idle behavior; a change
    // blends from the last pose
    const base = officeClipFor(this.role, this.state, this.activity, this.idleSec, this.actVariant);
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
      sampleOfficeClip(clip, OFFICE_STILL_T[base], this.tgt, info, this.poses);
      this.cur.set(this.tgt);
      this.blendT = this.blendDur;
    } else {
      if (this.shot) sampleOfficeClip(OFFICE_CLIPS[this.shot], this.shotT, this.tgt, info, this.poses);
      else sampleOfficeClip(clip, this.clipT, this.tgt, info, this.poses);
      if (this.blendT >= this.blendDur) this.cur.set(this.tgt);
      else {
        const u = this.blendT / this.blendDur;
        const w = this.blendSnap ? 1 - (1 - u) * (1 - u) * (1 - u) : u * u * (3 - 2 * u);
        for (let i = 0; i < OFFICE_POSE_LEN; i++) this.cur[i] = this.from[i]! + (this.tgt[i]! - this.from[i]!) * w;
      }
    }
    const baseT = officeClipTime(clip, motion ? this.clipT : OFFICE_STILL_T[base]);
    // ---- a hit plays over everything (P-VIZ.6); while it holds the body the activity's props are put away
    const hs = this.hs;
    if (this.hitPlan) {
      this.hitT += d;
      if (sampleOfficeHit(this.hitPlan, this.hitT, hs, this.hitPose).done) this.endHit();
    }
    // (at the copier the desk's activity and its props are put away too)
    const live = this.shot === null && sw === null && hs.body < 0.5 && this.commitW < 0.5;
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
    // P-VIZ.7: at the copier (blended in and out by the commit's weight), glancing around the office
    if (cw > 0) {
      sampleOfficeClip(OFFICE_CLIPS.copy, copyT, this.cpose, this.cinfo, this.poses);
      for (let i = 0; i < OFFICE_POSE_LEN; i++) o[i] = o[i]! + (this.cpose[i]! - o[i]!) * cw;
      if (motion) {
        const look = commitLook(this.commitT, copyT) * cw;
        o[O_CHEST + 1] += 0.2 * look;
        o[O_NECK + 1] += 0.3 * look;
        o[O_HEAD + 1] += 0.5 * look;
      }
    }
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
      // P-VIZ.7: small taps down onto the keys, the hands wandering a little across them (viz_office_pose)
      applyTyping(o, this.tapPh, this.wType);
      // P-VIZ.7: nodding to the music with the headphones on
      if (live && base === "headphones") o[O_HEAD] += 0.07 * Math.sin(this.life * TAU * 1.8) * phonesGroove(baseT);
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
    if (hs.body > 0.001) this.layerHit(o, motion);
    if (sw) applyManagerSwap(o, sw);
    this.apply(o);
    if (sw) this.hips.position.set(sw.x, HIP_Y + sw.lift, sw.z);
    // P-VIZ.7: standing at the copier, stepped out of the chair (the hands were solved with this offset)
    else this.hips.position.set(COPY_HIPS[0] * cw, HIP_Y + (COPY_HIPS[1] - HIP_Y) * cw, COPY_HIPS[2] * cw);
    this.backPivot.rotation.x = Math.min(0, o[O_SPINE]!) * 0.8;

    // ---- the face: redrawn only when the emotion, the blink step or the gaze bucket changes
    const own = cw > 0.5 ? this.cinfo : info;
    const emotion = sw ? "content" : hs.emotion ?? rs?.emotion ?? own.emotion;
    if (motion) {
      this.blinkIn -= d;
      this.blinkAge += d;
      if (this.blinkIn <= 0) {
        this.blinkAge = 0;
        this.blinkIn = nextBlinkDelay(this.random());
      }
    } else this.blinkAge = 99;
    const emo = OFFICE_EMOTIONS[emotion];
    const staring = (rs !== null && rs.look > 0.5) || hs.emotion !== null;
    const bl = emo.shape === "open" && !staring ? blinkStep(this.blinkAge) : 0; // a stare (or a hit) never blinks
    const gb = gazeBucket(sw ? 0 : own.gaze * (1 - Math.max(rs?.look ?? 0, hs.turn * hs.body)));
    const key = officeFaceKey(emotion, bl, gb);
    if (key !== this.faceKeyNow) {
      this.faceKeyNow = key;
      if (this.faceCtx) drawFace(this.faceCtx, this.face, emo, BLINK_LEVELS[bl]!, gazeOfBucket(gb), this.tier.faceScale);
      this.faceTex.needsUpdate = true;
    }

    this.updateColors(d, motion, rs);
    this.updateProps(d, motion, base, baseT, live, rs, cw, copyT);
    this.updateFx(d, motion, base, live, frantic, rs);
    this.updateCommit(motion, cw, copyT);
    this.updateEmblem(motion);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.group.removeFromParent();
    for (const m of this.mats) m.dispose();
    this.faceTex.dispose();
    this.screenTex.dispose();
    for (const tex of this.ownTex) tex.dispose(); // P-VIZ.7: the emblem, badge and nameplate canvases
    this.hitPlan = null;
    this.hitCam = null;
    this.reactCam = null;
    releaseGeo(this.detail);
    if (this.worker) releaseWorkerHair(this.detail, this.worker.hair);
    if (this.boss) {
      liveBosses = Math.max(0, liveBosses - 1);
      this.remember(performance.now() / 1000);
      for (const v of MANAGER_VARIANTS) if (this.managerGeo[v]) releaseManagerGeo(this.detail, v);
    }
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
    if (ink !== 0) m.add(new THREE.Mesh(geo, ink === 1 ? this.hull : this.hullThin));
    return m;
  }

  /** Remember this boss's cast (a pinned manager still waiting counts as on duty), for a rebuild or a second boss. */
  private remember(now: number): void {
    const cast = !this.auto && this.want ? { ...this.cast, variant: this.want } : this.cast;
    castMemo = { cast, goneAt: now, auto: this.auto };
  }

  /** The boss's schedule and handover: returns this frame's handover sample, or null when none plays. */
  private manage(tSec: number, d: number, motion: boolean): SwapSample | null {
    const now = Number.isFinite(tSec) && tSec > 0 ? (this.clockNow = tSec) : this.clockNow;
    if (this.swapT >= 0) {
      if (!motion) { this.finishSwap(); return null; } // reduced motion mid-handover: done at once
      this.swapT += d;
      const s = managerSwapAt(this.swapT, this.sw);
      if (s.incoming && this.variant !== this.swapTo) this.showVariant(this.swapTo);
      if (s.done) { this.finishSwap(); return null; }
      this.setFade(s.alpha);
      return s;
    }
    if (this.auto && managerSwapDue(this.cast, now)) this.want = otherManager(this.variant);
    const to = this.want;
    if (to === null) return null;
    if (to === this.variant) { this.want = null; return null; }
    // (P-VIZ.7: nor while he is at the copier)
    if (!managerSwapReady(this.state, this.reactKind !== null || this.hitPlan !== null, this.shot !== null || this.commitOn || this.commitW > 0)) return null;
    this.want = null;
    this.cast = recastManager(this.cast, to, now);
    this.remember(now);
    if (!motion) { this.showVariant(to); return null; } // reduced motion: a plain swap
    this.swapTo = to;
    this.swapT = 0;
    return managerSwapAt(0, this.sw);
  }

  private finishSwap(): void {
    if (this.variant !== this.swapTo) this.showVariant(this.swapTo);
    this.swapT = -1;
    this.setFade(1);
    this.hips.position.set(0, HIP_Y, 0);
  }

  private setFade(a: number): void {
    if (a === this.fade) return;
    this.fade = a;
    for (const m of this.personMats) m.opacity = a;
  }

  /** Put manager `v` at the desk: his or her own parts (built on first need), the cut of the suit, the hair's
   *  texture, the colors and the face. */
  private showVariant(v: ManagerVariant): void {
    const parts = (this.managerParts[v] ??= this.buildManager(v));
    for (const m of MANAGER_VARIANTS) for (const p of this.managerParts[m] ?? []) p.visible = false;
    for (const p of parts) p.visible = true;
    this.variant = v;
    const woman = v === "woman";
    this.torso.scale.set(woman ? 1.05 : 1.12, 1, 0.86);
    const sx = woman ? SHOULDER_X.bossWoman : SHOULDER_X.bossMan;
    this.joints[J_SHL]!.position.x = -sx;
    this.joints[J_SHR]!.position.x = sx;
    // P-VIZ.7: this manager's solved hands (the shoulders differ) and the lanyard at this torso's depth
    this.poses = this.bossPoses[v] ??= officePoseTable({ shoulderX: sx, scale: this.scale });
    this.lanyard?.scale.set(this.torso.scale.x, 1, this.torso.scale.z / 0.78);
    this.mHair.map = this.managerGeo[v]!.hairTex;
    this.setLook(this.mini);
  }

  /** Manager `v`'s own parts on the shared rig: the hair; the man's tie, or the woman's scarf and earrings. They
   *  take the dissolving ink, and the shared geometry stays acquired until dispose(). */
  private buildManager(v: ManagerVariant): THREE.Object3D[] {
    const mg = (this.managerGeo[v] = acquireManagerGeo(this.detail, v));
    const g = this.geo, thin: 0 | 2 = this.tier.smallInk ? 2 : 0;
    if (this.personInk) [this.hull, this.hullThin] = this.personInk;
    const parts: THREE.Object3D[] = [this.add(this.skull, mg.hair, this.mHair, 1)];
    if (mg.scarf && mg.earrings) {
      const gold = this.own(new THREE.MeshToonMaterial({ gradientMap: this.grad, toneMapped: false, color: "#d9b24c", alphaHash: true, opacity: this.fade }));
      this.personMats.push(gold);
      parts.push(this.add(this.chest, mg.scarf, this.mTie, thin), this.add(this.skull, mg.earrings, gold, 0));
    } else {
      const knot = this.add(this.chest, g.tieKnot, this.mTie, thin);
      knot.position.set(0, 0.162, 0.12);
      const blade = this.add(this.chest, g.tieBlade, this.mTie, 0);
      blade.position.set(0, 0.152, 0.126);
      blade.rotation.x = -0.08;
      parts.push(knot, blade);
    }
    this.hull = this.mInk;
    this.hullThin = this.mInkThin;
    return parts;
  }

  /** P-VIZ.7 (ADR-0641): a material owned by this figure on its toon ramp. */
  private toonMat(p: THREE.MeshToonMaterialParameters): THREE.MeshToonMaterial {
    return this.own(new THREE.MeshToonMaterial({ gradientMap: this.grad, toneMapped: false, ...p }));
  }

  /** P-VIZ.7: a texture this figure owns (the brand's emblem canvases), freed by dispose(). */
  private brandTex(cv: HTMLCanvasElement): THREE.CanvasTexture {
    const tex = canvasTex(cv);
    tex.anisotropy = 4;
    this.ownTex.push(tex);
    return tex;
  }

  /** P-VIZ.7: one of the variant's desk items at its DESK_SPOTS place (the second monitor is the monitor's own).
   *  The handset and the headphones also get the copies the hands and the head take (attached with the rig). */
  private buildDeskItem(item: DeskItem, plateMat: THREE.Material | null, thin: 0 | 2): void {
    const spot = DESK_SPOTS[this.role][item];
    if (!spot) return;
    const g = this.geo;
    const at = new THREE.Group();
    this.desk.add(at);
    at.position.set(spot[0], DESK_Y, spot[1]);
    at.rotation.y = spot[2];
    const gear = (): THREE.MeshToonMaterial => (this.mGear ??= this.toonMat({ color: "#26282e" }));
    switch (item) {
      case "plant":
        this.add(at, g.pot, this.toonMat({ color: "#c0623b" }), thin);
        this.add(at, g.leaves, this.toonMat({ color: "#3e9a4a" }), thin);
        break;
      case "photo":
        this.add(at, g.frame, this.toonMat({ color: "#5b3a22" }), thin);
        at.add(new THREE.Mesh(g.picture, this.toonMat({ map: g.photoTex })));
        break;
      case "nameplate": {
        const plate = this.add(at, g.nameplate, this.mTie, thin);
        plate.position.y = 0.0225;
        if (plateMat) plate.add(new THREE.Mesh(g.plateFace, plateMat));
        break;
      }
      case "lamp":
        this.add(at, g.lamp, this.toonMat({ color: "#2f5f52" }), thin);
        this.add(at, g.shade, this.toonMat({ color: "#2f5f52", side: THREE.DoubleSide }), 0);
        at.add(new THREE.Mesh(g.bulb, this.own(new THREE.MeshBasicMaterial({ color: 0xfff1b8, toneMapped: false }))));
        break;
      case "headphones": {
        this.add(at, g.phonesStand, this.toonMat({ color: "#8d939c" }), thin);
        const hp = (this.phonesStand = new THREE.Group());
        at.add(hp);
        hp.position.y = HEADPHONE_STAND_H - (PHONES_R + 0.012) * PHONES_SMALL;
        hp.scale.setScalar(PHONES_SMALL);
        this.add(hp, g.headphones, gear(), thin);
        break;
      }
      case "phone": {
        this.add(at, g.phoneBase, gear(), thin);
        const hs = (this.deskHandset = new THREE.Group());
        at.add(hs);
        hs.position.y = HANDSET_AT[1] - DESK_Y;
        this.add(hs, g.handset, gear(), thin);
        break;
      }
      case "monitor2":
        break;
    }
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
    const cam = this.reactCam;
    if (cam) cam.getWorldPosition(this.v1);
    this.lookToward(o, cam ? rs.look : 0, rs.lift);
  }

  /** Turn the neck and head by weight `w` toward the world point in `v1` (last frame's matrices, in the body frame),
   *  lifting a slumped torso by `lift`. The parents' turn is subtracted so the face, not the neck, ends up on it. */
  private lookToward(o: Float32Array, w: number, lift: number): void {
    const k = 1 - 0.7 * lift;
    o[O_SPINE] = o[O_SPINE]! * k;
    o[O_CHEST] = o[O_CHEST]! * k;
    if (w <= 0) return;
    this.skull.getWorldPosition(this.v2); // refreshes the body's world matrix too (its ancestors are updated)
    this.body.worldToLocal(this.v2);
    this.body.worldToLocal(this.v1);
    lookAngles(this.v1.x - this.v2.x, this.v1.y - this.v2.y, this.v1.z - this.v2.z, this.look);
    // (the hips turn too: a handover's walk, the stand at the copier)
    const yaw = this.look.yaw - (o[O_ROOT + 1]! + o[O_HIPS + 1]! + o[O_SPINE + 1]! + o[O_CHEST + 1]!);
    const pitch = this.look.pitch - (o[O_SPINE]! + o[O_CHEST]!);
    o[O_NECK] = o[O_NECK]! + (pitch * 0.35 - o[O_NECK]!) * w;
    o[O_NECK + 1] = o[O_NECK + 1]! + (yaw * 0.35 - o[O_NECK + 1]!) * w;
    o[O_NECK + 2] = o[O_NECK + 2]! * (1 - w);
    o[O_HEAD] = o[O_HEAD]! + (pitch * 0.65 - o[O_HEAD]!) * w;
    o[O_HEAD + 1] = o[O_HEAD + 1]! + (yaw * 0.65 - o[O_HEAD + 1]!) * w;
    o[O_HEAD + 2] = o[O_HEAD + 2]! * (1 - w);
  }

  private endHit(): void {
    this.hitPlan = null;
    this.hitCam = null;
    clearOfficeHit(this.hs);
  }

  /** The hit over the pose: the hit clip's pose (already in hitPose) with the head turned toward the throw, blended
   *  in from the pose on screen when it landed, then laid over the activity by the hit's weight. */
  private layerHit(o: Float32Array, motion: boolean): void {
    const hs = this.hs, hp = this.hitPose, snap = this.hitSnap;
    const cam = this.hitAtCam ? this.hitCam : null;
    if (hs.turn > 0.001 && (cam || !this.hitAtCam)) {
      if (cam) cam.getWorldPosition(this.v1);
      else this.v1.copy(this.hitFrom);
      this.lookToward(hp, hs.turn, 0);
    }
    if (hs.blend < 1) for (let i = 0; i < OFFICE_POSE_LEN; i++) hp[i] = snap[i]! + (hp[i]! - snap[i]!) * hs.blend;
    const w = hs.body;
    for (let i = 0; i < OFFICE_POSE_LEN; i++) o[i] = o[i]! + (hp[i]! - o[i]!) * w;
    if (motion && hs.shake > 0) o[0] += 0.02 * Math.sin(this.life * 90) * hs.shake;
  }

  /** Keep a hand-held prop upright in the body frame (tilted by `rx`), whatever the hand's own angle. P-VIZ.7:
   *  turned to `yaw` (the way he faces) and rolled by `rz` first (three's Euler "YXZ", viz_office_pose.mugFrame). */
  private orient(prop: THREE.Object3D, rx: number, yaw = 0, rz = 0): void {
    prop.parent!.getWorldQuaternion(this.q1).invert();
    this.body.getWorldQuaternion(this.q2);
    this.q3.setFromEuler(this.e1.set(rx, yaw, rz, "YXZ"));
    prop.quaternion.copy(this.q1).multiply(this.q2).multiply(this.q3);
  }

  /** P-VIZ.7: a prop held at the palm by its grip point (the prop's frame, figure units): oriented as orient()
   *  does, then placed so the grip sits on the palm. The prop's own scale undoes the person's (the brand's size
   *  class), so it is the same size in the hand as on the desk. */
  private hang(prop: THREE.Object3D, rx: number, yaw: number, rz: number, gx: number, gy: number, gz: number): void {
    this.orient(prop, rx, yaw, rz);
    const s = this.scale;
    this.v2.set(-gx / s, -gy / s, -gz / s).applyQuaternion(prop.quaternion);
    prop.position.set(this.v2.x, this.v2.y - OFFICE_RIG.palm, this.v2.z);
  }

  private updateColors(d: number, motion: boolean, rs: ReactSample | null): void {
    const st = this.state;
    const r = motion ? 1 - Math.exp(-d * 4) : 1;
    this.dead = approach(this.dead, st === "killed" && this.stateT > 0.4 ? 1 : 0, motion ? d : 1);
    const glowT = st === "killed" ? 0 : st === "working" ? 0.12 + 0.2 * this.kS : 0.08;
    this.glow += (glowT - this.glow) * r;
    // energized (the energy drink): the tie, the nameplate and the cubicle trim burn brighter while it lasts
    const lit = this.glow + 0.45 * this.chargeNow * (1 - this.dead);
    this.mTie.color.copy(this.cTie).lerp(DEAD_GRAY, 0.75 * this.dead);
    this.mTie.emissive.copy(this.mTie.color);
    this.mTie.emissiveIntensity = lit;
    if (this.mPlate) {
      this.mPlate.color.copy(this.mTie.color);
      this.mPlate.emissive.copy(this.mTie.color);
      this.mPlate.emissiveIntensity = lit;
    }
    this.mTrim.emissiveIntensity = (0.12 + lit) * (1 - 0.8 * this.dead);
    // the outburst's red face; the worker's face catches the screen's glow while he works, and everyone a faint
    // persona glow while energized
    this.mSkin.color.copy(this.cSkin).lerp(RAGE, 0.55 * (rs?.red ?? 0));
    this.mSkin.emissive.copy(this.cTie);
    this.mSkin.emissiveIntensity = ((this.screen ? 0.06 * this.scr : 0) + 0.1 * this.chargeNow) * (1 - this.dead);
  }

  private updateProps(d: number, motion: boolean, base: OfficeClipName, baseT: number, live: boolean, rs: ReactSample | null, cw: number, copyT: number): void {
    // coffee: in the hand while sipping (and all through the copier scene), on the desk otherwise; held by the
    // handle, kept upright in the way he faces and tipped to the lips (P-VIZ.7); it sloshes when the desk is slammed
    const atCopier = this.commitW >= 0.5;
    const held = atCopier || (live && mugHeld(base, baseT));
    const yaw = officeFacing(this.out);
    this.handMug.visible = held;
    this.deskMug.visible = !held;
    if (held) this.hang(this.handMug, atCopier ? mugTilt("copy", copyT) : mugTilt(base, baseT), yaw, 0, MUG_GRIP[0], MUG_GRIP[1], MUG_GRIP[2]);
    // P-VIZ.7: the handset off the cradle to the ear (turning upright on the way) and back
    if (this.deskHandset && this.handHandset) {
      const inHand = live && handsetHeld(base, baseT);
      this.handHandset.visible = inHand;
      this.deskHandset.visible = !inHand;
      if (inHand) {
        const up = bump(baseT, PHONE_GRAB_S, 1.2, 4.7, PHONE_DROP_S);
        this.hang(this.handHandset, -0.4 * up, yaw, (Math.PI / 2) * up, 0, 0, 0);
      }
    }
    // P-VIZ.7: the headphones off the stand, on the head, back (turning from the stand's angle to the head's)
    if (this.phonesStand) {
      const where = live ? phonesAt(base, baseT) : "stand";
      this.phonesStand.visible = where === "stand";
      if (this.phonesHead) this.phonesHead.visible = where === "head";
      if (this.phonesHand) {
        this.phonesHand.visible = where === "hand";
        if (where === "hand") {
          const on = bump(baseT, PHONES_GRAB_S, PHONES_ON_S, PHONES_OFF_S, PHONES_BACK_S);
          this.hang(this.phonesHand, 0, yaw + (Math.PI / 2) * (1 - on), 0, 0, (PHONES_R + 0.012) * PHONES_SMALL, 0);
        }
      }
    }
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
      this.report.visible = live && (base === "reports" || base === "flip");
      const f = !this.report.visible ? -1 : base === "flip" ? flickAt(baseT) : pageFlipAt(baseT);
      this.pagePivot.visible = f >= 0;
      if (f >= 0) this.pagePivot.rotation.x = f * Math.PI * 0.95;
    }
    if (this.clipboard && this.deskClipboard && this.pen) {
      const inHand = live && (base === "clipboard" || base === "supervise");
      this.clipboard.visible = inHand;
      this.deskClipboard.visible = !inHand;
      this.pen.visible = inHand;
    }
    // the energy drink: in the right hand from the catch to the fist pump, tipped up to chug it
    if (this.can) {
      this.can.visible = motion && this.hs.can;
      if (this.can.visible) this.orient(this.can, -1.4 * this.hs.tilt);
    }
    // the Enter slam: the keyboard hops
    this.kbHit = motion ? this.kbHit * Math.exp(-d * 9) : 0;
    if (this.keyboard) this.keyboard.position.y = DESK_Y + 0.01 + 0.012 * this.kbHit * Math.abs(Math.sin(this.life * 40));
    // the outburst's slams shake the desk; P-VIZ.7: at the copier the desk set shrinks down toward the floor under
    // its center and slides off toward -X
    const shake = rs && motion ? 0.008 * Math.sin(this.life * 80) * rs.shake : 0;
    // (squared: it is mostly gone by the time the copier has grown in, never a toy desk left on the floor)
    const k = (1 - cw) * (1 - cw);
    this.desk.visible = k > 0.002;
    this.desk.scale.setScalar(Math.max(0.002, k));
    this.desk.position.set(this.deskCenter.x * (1 - k) - 0.35 * cw + shake, 0, this.deskCenter.y * (1 - k));
  }

  /** P-VIZ.7: the copier scene: the copier grows in from +X as the desk goes, its start button pressed on the
   *  beat, the display blinking while a copy runs, the pooled copies sliding out of the slot onto the tray and
   *  stacking up (the oldest recycled), the "TPS Reports" bubble over his head. Reduced motion: a still copier with
   *  a short stack on the tray and the bubble. */
  private updateCommit(motion: boolean, cw: number, copyT: number): void {
    const on = cw > 0.002;
    this.copier.visible = on;
    this.bubble.visible = on && cw > 0.5;
    if (!on) return;
    this.copier.scale.setScalar(cw);
    this.copier.position.set(COPIER.x + 0.35 * (1 - cw), 0, COPIER.z);
    this.copierButton.position.y = COPIER.button[1] + 0.004 - 0.005 * (motion ? buttonPress(copyT) : 0);
    const started = motion ? copiesStarted(this.commitT) : STILL_COPIES;
    const n = this.sheets.length;
    const oldest = Math.max(0, started - n);
    let running = false;
    for (let i = 0; i < n; i++) {
      const s = this.sheets[i]!;
      const j = started - 1 - i; // i 0 is the newest copy
      s.visible = j >= 0;
      if (j < 0) continue;
      const u = motion ? copyProgress(j, this.commitT) : 1;
      if (u < 1) running = true;
      const e = u * u * (3 - 2 * u);
      s.position.set(
        SHEET_FROM[0] + (SHEET_TO[0] - SHEET_FROM[0]) * e,
        SHEET_FROM[1] + (SHEET_TO[1] - SHEET_FROM[1]) * e + (j - oldest) * SHEET_STEP + 0.012 * Math.sin(Math.PI * u),
        SHEET_FROM[2] + (SHEET_TO[2] - SHEET_FROM[2]) * e,
      );
    }
    // the display: steady green, pulsing while it copies
    const lit = running ? 0.65 + 0.35 * Math.sin(this.life * 14) : 1;
    this.mDisplay.color.setRGB(0.49 * lit, 0.95 * lit, 0.69 * lit);
    if (this.bubble.visible) {
      this.skull.getWorldPosition(this.v1);
      this.body.worldToLocal(this.v1);
      const pop = motion ? Math.min(1, (cw - 0.5) * 2) : 1;
      this.bubble.position.set(this.v1.x, this.v1.y + 0.42 * this.scale, this.v1.z);
      this.bubble.scale.set(BUBBLE_W * (0.6 + 0.4 * pop), BUBBLE_W * 0.425 * (0.6 + 0.4 * pop), 1);
      this.mBubble.opacity = pop;
    }
  }

  /** P-VIZ.7: the sponsor's coin: a slow orbit around the desk and a spin about its own axis; still (facing the
   *  camera side, front right of the desk) under reduced motion. */
  private updateEmblem(motion: boolean): void {
    if (!this.orbit.visible) return;
    if (motion) {
      this.orbit.rotation.y = this.phase - (this.life / ORBIT_S) * TAU;
      this.coin.rotation.y = (this.life / SPIN_S) * TAU;
    } else {
      this.orbit.rotation.y = -0.7;
      this.coin.rotation.y = 0.7;
    }
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
      this.scroll += d * speed * chargeTempo(this.chargeNow);
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

    // papers flying off the pile: the outburst's slams, the Storm's gust
    const pu = Math.max(rs?.papers ?? -1, this.hs.papers);
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
