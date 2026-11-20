// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_plasma.ts - P-VIZ.4 (ADR-0626): the Visualize edges, drawn in one of two styles.
//
//   plasma (the anime scene): a glowing plasma conduit along the edge's curve. A tube with its own shader
//     (additive, a fresnel edge glow, domain-warped noise flowing from the producer to its parent, and two
//     counter-rotating helical bands, so it visibly spins). Always there: calm at idle (slim, dim, desaturated,
//     drifting slowly), scaling continuously with the edge's est. tok/s intensity (thicker, brighter, faster
//     spin and flow, a saturated body with a white-hot filament). The color runs from the source's persona
//     color into the target's. Spinning plasma pulses (an orb with a rotating three-lobed corona) travel
//     from source to target, their rate and size following the intensity. A surge fires a big burst pulse
//     (with spokes) and a flare along the whole conduit (a bright wave front crossing it, which the full
//     tier's bloom turns into a flash); the scene keeps its lightning arcs on top.
//   fiber (the professional scene): a reflective silver fiber-optic cable (a metal MeshPhysicalMaterial with
//     low roughness, the room environment's reflections and a bump-mapped sheathing segment every 0.3 units)
//     carrying rapid red light pulses: short bright red streaks with a soft glow, aligned with the cable on
//     screen, their rate following the intensity. Idle shows an occasional faint red flicker. A surge sends
//     a burst train of red pulses and a brief red glow along the cable.
// 2D draws the same tube squashed flat (a ribbon that reads from the top-down camera); the plasma shader
// derives its fresnel analytically there.
//
// Budgets (viz_plasma_math.edgeBudget): the tier sets rings, sides, noise octaves, the warp, the halo shell and
// the pulse pool. Reduced motion freezes the shader's phases and spawns no pulses: the conduits hold a static
// glow and say what is happening by brightness and color only.
//
// Allocation: one geometry per edge, rewritten in place only when its curve moves; one instanced draw for
// every pulse; nothing allocated per frame. remove() and dispose() free every geometry, material and texture.

import * as THREE from "three";
import {
  arcLengths, edgeBudget, FIBER_R, FIBER_TRAIN, FIBER_TRAIN_MS, FLAT_SQUASH, flareFront, flareLevel, IDLE_I, plasmaLook,
  pointAt, pulseRate, pulseSize, pulseSpeed, raySegment, sampleCircle, sampleQuadratic, smoothK, tubeIndex, writeTube,
  type EdgeDetail, type EdgeStyle, type PlasmaLook, type TubeOut,
} from "./viz_plasma_math.ts";

export interface EdgeFxOpts {
  detail: EdgeDetail;
  /** The tier's flow budget (viz_model.VizTierOpts.particles); the pulse pool is sized from it. */
  particles: number;
  motion: boolean;
  /** The light theme: normal blending instead of additive, no halo shell. */
  light: boolean;
  /** 2D (the flat ribbon) or 3D. */
  flat: boolean;
  style: EdgeStyle;
}

/** One edge's conduit. */
export interface EdgeConduit {
  /** The drawn mesh, for the scene's pick list: its raycast tests the edge's center line (userData is free). */
  readonly mesh: THREE.Mesh;
  /** Reshape along the quadratic bezier p0, p1, p2; `side` is the chord's horizontal side (the frame's
   *  fallback where the curve runs vertical). The geometry is rewritten only when the curve moved. */
  bezier(p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, side: THREE.Vector3): void;
  /** Reshape as a closed horizontal loop (the hub's own stream). */
  loop(center: THREE.Vector3, radius: number, lift: number): void;
  /** The edge's state: est. tok/s intensity (0..1), paused, dead, and its source and target colors. */
  set(intensity: number, frozen: boolean, dead: boolean, from: THREE.Color, to: THREE.Color): void;
  /** A surge on this edge (now). */
  surge(): void;
}

export interface EdgeFx {
  add(closed: boolean): EdgeConduit;
  remove(c: EdgeConduit): void;
  setStyle(style: EdgeStyle): void;
  setFlat(flat: boolean): void;
  /** One frame at `t` ms; returns true while anything moves (an active edge, a pulse in flight, a flare). */
  update(t: number, dt: number): boolean;
  dispose(): void;
}

// ------------------------------------------------------------------------------------------ shaders

const CONDUIT_VS = /* glsl */ `
attribute vec3 aDir;
uniform float uRadius;
uniform float uRef;
uniform float uLen;
uniform float uFlat;
uniform float uClosed;
varying vec2 vUv;
varying float vFres;
void main() {
  vUv = uv;
  float u = clamp(uv.x / max(uLen, 1e-4), 0.0, 1.0);
  float pinch = uClosed > 0.5 ? 1.0 : mix(0.4, 1.0, smoothstep(0.0, 0.08, u) * smoothstep(1.0, 0.92, u));
  float r = uRadius * pinch;
#if HALO == 1
  r *= 2.7;
#endif
  vec3 center = position - aDir * uRef;
  vec4 mv = modelViewMatrix * vec4(center + aDir * r, 1.0);
  gl_Position = projectionMatrix * mv;
  float ndv;
  if (uFlat > 0.5) ndv = abs(sin(uv.y * 6.2831853)); // the flat ribbon: the round tube's fresnel, analytically
  else ndv = abs(dot(normalize(normalMatrix * aDir), normalize(-mv.xyz)));
  vFres = 1.0 - ndv;
}`;

// Value noise, periodic around the tube (4 cells, so no seam) and along it (64 cells, so the CPU can wrap the
// flow phases without a jump).
const CONDUIT_FS = /* glsl */ `
uniform float uLen;
uniform float uI;
uniform float uFlow;
uniform float uDrift;
uniform float uSpin;
uniform float uFlare;
uniform float uFront;
uniform float uGain;
uniform float uClosed;
uniform float uLight;
uniform vec3 uColA;
uniform vec3 uColB;
varying vec2 vUv;
varying float vFres;
float hash(vec2 p) {
  p = fract(p * vec2(0.1031, 0.1030));
  p += dot(p, p.yx + 33.33);
  return fract((p.x + p.y) * p.x);
}
float vnoise(vec2 p, vec2 per) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  vec2 i0 = mod(i, per);
  vec2 i1 = mod(i + 1.0, per);
  return mix(mix(hash(i0), hash(vec2(i1.x, i0.y)), u.x), mix(hash(vec2(i0.x, i1.y)), hash(i1), u.x), u.y);
}
float fbm(vec2 p) {
  vec2 per = vec2(64.0, 4.0);
  float s = 0.0;
  float a = 0.5;
  for (int k = 0; k < OCTAVES; k++) {
    s += a * vnoise(p, per);
    p = p * 2.0 + vec2(1.7, 0.0);
    per *= 2.0;
    a *= 0.5;
  }
  return s / (1.0 - pow(0.5, float(OCTAVES)));
}
void main() {
  float u = clamp(vUv.x / max(uLen, 1e-4), 0.0, 1.0);
  float th = vUv.y * 6.2831853;
  vec3 col = mix(uColA, uColB, smoothstep(0.05, 0.95, u));
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(lum), col, 0.45 + 0.55 * uI); // calm reads pale, a burst reads saturated
  vec2 q = vec2(vUv.x * 1.4 - uFlow, vUv.y * 4.0);
#if WARP == 1
  vec2 w = vec2(fbm(q + vec2(uDrift, 0.0)), fbm(q + vec2(5.2 - uDrift, 0.0)));
  float n = fbm(q + 1.6 * w);
#else
  float n = fbm(q + vec2(uDrift, 0.0));
#endif
  float core = 1.0 - vFres;
#if HALO == 1
  float glow = core * core * (0.05 + 0.4 * uI + 0.9 * uFlare) * (0.6 + 0.6 * n);
  vec3 c = col * glow;
  float a = glow;
#else
  float h1 = 0.5 + 0.5 * sin(th * 2.0 - vUv.x * 6.0 - uSpin);
  float h2 = 0.5 + 0.5 * sin(th * 3.0 + vUv.x * 4.5 + uSpin * 1.35);
  float sharp = 9.0 - 4.0 * uI;
  float bands = pow(h1, sharp) + 0.7 * pow(h2, sharp + 2.0);
  float rim = pow(vFres, 2.2);
  float glow = rim * (0.3 + 0.7 * uI)
    + core * (0.06 + 0.45 * uI) * (0.35 + n)
    + bands * (0.12 + 0.8 * uI) * (0.5 + 0.7 * n)
    + uFlare * (0.8 + 0.6 * n);
  float fil = pow(core, 7.0) * (0.03 + 0.9 * uI * uI) * (0.7 + 0.6 * n);
  float wave = exp(-pow((u - uFront) * 7.0, 2.0)) * uFlare;
  vec3 c = col * (glow + wave) + vec3(1.0) * (fil + wave * 1.8);
  float a = glow + fil + wave;
#endif
  float ends = uClosed > 0.5 ? 1.0 : smoothstep(0.0, 0.04, u) * smoothstep(1.0, 0.96, u);
  float g = uGain * ends;
  if (uLight > 0.5) gl_FragColor = vec4(col * 0.85, clamp(a * g, 0.0, 0.95));
  else gl_FragColor = vec4(c * g, 1.0);
  gl_FragColor = linearToOutputTexel(gl_FragColor);
}`;

// Pulses: camera-facing quads (view space, so the same in perspective and orthographic). A plasma orb spins its
// corona (iP.z); a fiber streak stretches along the cable's on-screen direction, its head leading.
const PULSE_VS = /* glsl */ `
attribute vec3 iPos;
attribute vec3 iTan;
attribute vec3 iCol;
attribute vec4 iP;
varying vec2 vQ;
varying vec3 vCol;
varying float vA;
varying float vSpin;
varying float vKind;
void main() {
  vQ = position.xy;
  vCol = iCol;
  vA = iP.y;
  vSpin = iP.z;
  vKind = iP.w;
  vec4 c = modelViewMatrix * vec4(iPos, 1.0);
  vec4 c2 = modelViewMatrix * vec4(iPos + iTan, 1.0);
  vec2 d = c2.xy - c.xy;
  float dl = length(d);
  vec2 ax = dl > 1e-5 ? d / dl : vec2(1.0, 0.0);
  vec2 ay = vec2(-ax.y, ax.x);
  float stretch = abs(iP.w - 1.0) < 0.5 ? 3.6 : 1.0;
  c.xy += ax * position.x * iP.x * stretch + ay * position.y * iP.x;
  gl_Position = projectionMatrix * c;
}`;

const PULSE_FS = /* glsl */ `
uniform float uLight;
varying vec2 vQ;
varying vec3 vCol;
varying float vA;
varying float vSpin;
varying float vKind;
void main() {
  vec3 c;
  float a;
  if (abs(vKind - 1.0) < 0.5) {
    float along = vQ.x * 0.5 + 0.5;
    float body = smoothstep(0.0, 0.85, along) * (1.0 - smoothstep(0.9, 1.0, along));
    float w = exp(-vQ.y * vQ.y * 9.0);
    float core = exp(-vQ.y * vQ.y * 70.0) * body;
    a = body * w + core;
    c = vCol * body * w * 1.3 + vec3(1.0, 0.82, 0.78) * core * 1.4;
  } else {
    float cs = cos(vSpin);
    float sn = sin(vSpin);
    vec2 p = vec2(cs * vQ.x - sn * vQ.y, sn * vQ.x + cs * vQ.y);
    float r = length(p);
    if (r > 1.0) discard;
    float ang = atan(p.y, p.x);
    float core = exp(-r * r * 16.0);
    float glow = exp(-r * r * 4.5) * 0.55;
    float lobes = 0.5 + 0.5 * sin(ang * 3.0);
    float ring = exp(-pow((r - 0.6) * 10.0, 2.0)) * (0.35 + 0.65 * lobes * lobes);
    float spokes = vKind > 1.5 ? pow(max(0.0, sin(ang * 7.0)), 10.0) * (1.0 - r) * 0.9 : 0.0;
    a = glow + ring + spokes + core;
    c = vCol * (glow + ring * 1.4 + spokes) + vec3(1.0) * core * 1.5;
  }
  if (uLight > 0.5) gl_FragColor = vec4(vCol, clamp(a * vA, 0.0, 1.0));
  else gl_FragColor = vec4(c * vA, 1.0);
  gl_FragColor = linearToOutputTexel(gl_FragColor);
}`;

// ------------------------------------------------------------------------------------------ constants

const ICE = new THREE.Color("#9ad8ff");
const DEAD = new THREE.Color("#2a2d33");
const WHITE = new THREE.Color("#ffffff");
/** The fiber's light: a hot red, pushed past 1 in the dark theme so the full tier's bloom catches it. */
const FIBER_RED = new THREE.Color("#ff2a1a");
const SILVER = new THREE.Color("#c9ced6");
const DEAD_SILVER = new THREE.Color("#3a3d42");
/** The noise repeats every 64 cells along the conduit, so the flow phases wrap there without a jump. */
const WRAP_FLOW = 64;
/** The helices use uSpin and 1.35 * uSpin: 20 turns is a whole number of turns for both. */
const WRAP_SPIN = Math.PI * 2 * 20;
const SHEATH_PERIOD = 0.3;
const KIND_ORB = 0, KIND_STREAK = 1, KIND_BURST = 2;

interface Rec extends EdgeConduit {
  slot: number;
  closed: boolean;
  n: number;
  geom: THREE.BufferGeometry;
  attrs: THREE.BufferAttribute[];
  tube: TubeOut;
  centers: Float32Array;
  arc: Float32Array;
  len: number;
  shape: Float32Array;
  side: Float32Array;
  plasma: THREE.ShaderMaterial;
  halo: THREE.Mesh | null;
  fiber: THREE.MeshPhysicalMaterial;
  target: number; lvl: number; frozen: boolean; dead: boolean;
  colA: THREE.Color; colB: THREE.Color;
  flow: number; drift: number; spin: number; breath: number; radius: number;
  surgeAt: number; acc: number; train: number; trainNext: number;
}

export function createEdgeFx(parent: THREE.Object3D, opts: EdgeFxOpts): EdgeFx {
  const B = edgeBudget(opts.detail, opts.particles, opts.motion);
  const motion = opts.motion;
  const light = opts.light;
  const blending = light ? THREE.NormalBlending : THREE.AdditiveBlending;
  let style: EdgeStyle = opts.style;
  let flat = opts.flat;
  const flatU = { value: flat ? 1 : 0 };
  const lightU = { value: light ? 1 : 0 };
  const slots: (Rec | null)[] = [];
  const indexCache = new Map<number, Uint16Array>();
  let now = performance.now();

  // The sheathing: a groove every SHEATH_PERIOD along the cable (uv.x is arc length), as a bump map.
  const sheathPx = new Uint8Array(16 * 4);
  for (let i = 0; i < 16; i++) {
    const v = i < 2 ? 40 : i < 3 ? 150 : 255;
    sheathPx.set([v, v, v, 255], i * 4);
  }
  const sheath = new THREE.DataTexture(sheathPx, 16, 1);
  sheath.wrapS = sheath.wrapT = THREE.RepeatWrapping;
  sheath.magFilter = sheath.minFilter = THREE.LinearFilter;
  sheath.repeat.set(1 / SHEATH_PERIOD, 1);
  sheath.needsUpdate = true;

  // ---------------------------------------------------------------- the pulse pool (one instanced draw)
  const P = B.pulses;
  const pEdge = new Int32Array(P), pU = new Float32Array(P), pV = new Float32Array(P), pSize = new Float32Array(P);
  const pKind = new Uint8Array(P), pSpin = new Float32Array(P), pSpinV = new Float32Array(P), pA = new Float32Array(P);
  let live = 0;
  let pulses: THREE.Mesh | null = null;
  let iPos: THREE.InstancedBufferAttribute | null = null, iTan: THREE.InstancedBufferAttribute | null = null;
  let iCol: THREE.InstancedBufferAttribute | null = null, iP: THREE.InstancedBufferAttribute | null = null;
  let pulseGeom: THREE.InstancedBufferGeometry | null = null;
  if (P > 0) {
    pulseGeom = new THREE.InstancedBufferGeometry();
    pulseGeom.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    pulseGeom.setIndex([0, 1, 2, 0, 2, 3]);
    iPos = new THREE.InstancedBufferAttribute(new Float32Array(P * 3), 3).setUsage(THREE.DynamicDrawUsage);
    iTan = new THREE.InstancedBufferAttribute(new Float32Array(P * 3), 3).setUsage(THREE.DynamicDrawUsage);
    iCol = new THREE.InstancedBufferAttribute(new Float32Array(P * 3), 3).setUsage(THREE.DynamicDrawUsage);
    iP = new THREE.InstancedBufferAttribute(new Float32Array(P * 4), 4).setUsage(THREE.DynamicDrawUsage);
    pulseGeom.setAttribute("iPos", iPos);
    pulseGeom.setAttribute("iTan", iTan);
    pulseGeom.setAttribute("iCol", iCol);
    pulseGeom.setAttribute("iP", iP);
    pulseGeom.instanceCount = 0;
    const mat = new THREE.ShaderMaterial({
      uniforms: { uLight: lightU },
      vertexShader: PULSE_VS, fragmentShader: PULSE_FS, transparent: true, depthWrite: false, blending,
    });
    pulses = new THREE.Mesh(pulseGeom, mat);
    pulses.frustumCulled = false;
    pulses.renderOrder = 5;
    pulses.visible = false;
    parent.add(pulses);
  }

  function spawn(r: Rec, kind: number, size: number, speed: number, alpha: number): void {
    if (live >= P) return;
    const i = live++;
    pEdge[i] = r.slot; pU[i] = 0; pV[i] = speed; pSize[i] = size; pKind[i] = kind; pA[i] = alpha;
    pSpin[i] = Math.random() * Math.PI * 2;
    pSpinV[i] = (Math.random() < 0.5 ? -1 : 1) * (2.5 + 9 * r.lvl);
  }

  /** Swap-remove pulse i (the last live one takes its place). */
  function kill(i: number): void {
    const j = --live;
    if (i === j) return;
    pEdge[i] = pEdge[j]!; pU[i] = pU[j]!; pV[i] = pV[j]!; pSize[i] = pSize[j]!;
    pKind[i] = pKind[j]!; pSpin[i] = pSpin[j]!; pSpinV[i] = pSpinV[j]!; pA[i] = pA[j]!;
  }

  // ---------------------------------------------------------------- edges
  /** The index array is shared per ring count; each geometry wraps it in its own attribute, because disposing a
   *  geometry frees its index buffer on the GPU. */
  function indexFor(n: number): THREE.BufferAttribute {
    let a = indexCache.get(n);
    if (!a) { a = tubeIndex(n, B.radial); indexCache.set(n, a); }
    return new THREE.BufferAttribute(a, 1);
  }

  function reshape(r: Rec): void {
    r.len = arcLengths(r.centers, r.n, r.arc);
    writeTube(r.centers, r.arc, r.n, B.radial, FIBER_R, flat ? FLAT_SQUASH : 1, r.closed, r.side, r.tube);
    for (const a of r.attrs) a.needsUpdate = true;
    r.plasma.uniforms.uLen!.value = r.len;
  }

  /** True (and the cache updated) when the 9 shape numbers differ from the last ones. */
  function moved(r: Rec, a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, k: number): boolean {
    const s = r.shape;
    if (Math.abs(s[0]! - a) + Math.abs(s[1]! - b) + Math.abs(s[2]! - c) + Math.abs(s[3]! - d) + Math.abs(s[4]! - e)
      + Math.abs(s[5]! - f) + Math.abs(s[6]! - g) + Math.abs(s[7]! - h) + Math.abs(s[8]! - k) < 1e-5) return false;
    s[0] = a; s[1] = b; s[2] = c; s[3] = d; s[4] = e; s[5] = f; s[6] = g; s[7] = h; s[8] = k;
    return true;
  }

  function applyStyle(r: Rec): void {
    const plasma = style === "plasma";
    r.mesh.material = plasma ? r.plasma : r.fiber;
    r.mesh.renderOrder = plasma ? 4 : 0;
    if (r.halo) r.halo.visible = plasma;
  }

  const rayO = new Float64Array(3), rayD = new Float64Array(3), segA = new Float64Array(3), segB = new Float64Array(3);
  const rayHit = new Float64Array(2);

  function add(closed: boolean): EdgeConduit {
    const n = closed ? B.loopRings : B.rings;
    const verts = n * (B.radial + 1);
    const tube: TubeOut = {
      pos: new Float32Array(verts * 3), nrm: new Float32Array(verts * 3), dir: new Float32Array(verts * 3), uv: new Float32Array(verts * 2),
    };
    const geom = new THREE.BufferGeometry();
    const attrs = [
      new THREE.BufferAttribute(tube.pos, 3), new THREE.BufferAttribute(tube.nrm, 3), new THREE.BufferAttribute(tube.dir, 3), new THREE.BufferAttribute(tube.uv, 2),
    ];
    for (const a of attrs) a.setUsage(THREE.DynamicDrawUsage);
    geom.setAttribute("position", attrs[0]!);
    geom.setAttribute("normal", attrs[1]!);
    geom.setAttribute("aDir", attrs[2]!);
    geom.setAttribute("uv", attrs[3]!);
    geom.setIndex(indexFor(n));
    const uniforms = {
      uRadius: { value: 0.05 }, uRef: { value: FIBER_R }, uLen: { value: 1 }, uFlat: flatU, uClosed: { value: closed ? 1 : 0 },
      uI: { value: 0 }, uFlow: { value: 0 }, uDrift: { value: 0 }, uSpin: { value: 0 }, uFlare: { value: 0 }, uFront: { value: 0 },
      uGain: { value: 1 }, uLight: lightU, uColA: { value: new THREE.Color() }, uColB: { value: new THREE.Color() },
    };
    const plasmaMat = (halo: boolean): THREE.ShaderMaterial => new THREE.ShaderMaterial({
      defines: { OCTAVES: B.octaves, WARP: B.warp ? 1 : 0, HALO: halo ? 1 : 0 },
      uniforms, // shared by the conduit and its halo shell
      vertexShader: CONDUIT_VS, fragmentShader: CONDUIT_FS, transparent: true, depthWrite: false, blending,
      side: halo ? THREE.FrontSide : THREE.DoubleSide,
    });
    const plasma = plasmaMat(false);
    const fiber = new THREE.MeshPhysicalMaterial({
      color: SILVER, metalness: 1, roughness: 0.16, clearcoat: 0.5, clearcoatRoughness: 0.08, envMapIntensity: 1.25,
      bumpMap: sheath, bumpScale: 0.8, emissive: FIBER_RED, emissiveIntensity: 0,
    });
    const mesh: THREE.Mesh = new THREE.Mesh(geom, plasma);
    mesh.frustumCulled = false;
    let halo: THREE.Mesh | null = null;
    if (B.halo && !light) {
      halo = new THREE.Mesh(geom, plasmaMat(true));
      halo.frustumCulled = false;
      halo.renderOrder = 3;
      halo.raycast = () => {};
      mesh.add(halo);
    }
    let slot = slots.indexOf(null);
    if (slot < 0) { slot = slots.length; slots.push(null); }
    const r: Rec = {
      mesh, slot, closed, n, geom, attrs, tube,
      centers: new Float32Array(n * 3), arc: new Float32Array(n), len: 1,
      shape: new Float32Array(9).fill(Number.NaN), side: new Float32Array([1, 0, 0]),
      plasma, halo, fiber,
      target: 0, lvl: 0, frozen: false, dead: false, colA: new THREE.Color(), colB: new THREE.Color(),
      flow: 0, drift: Math.random() * WRAP_FLOW, spin: Math.random() * Math.PI * 2, breath: 0, radius: 0.05,
      surgeAt: -1e9, acc: 0, train: 0, trainNext: 0,
      bezier(p0, p1, p2, side) {
        if (!moved(r, p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, p2.x, p2.y, p2.z)) return;
        r.side[0] = side.x; r.side[1] = side.y; r.side[2] = side.z;
        sampleQuadratic(r.shape, r.n, r.centers);
        reshape(r);
      },
      loop(center, radius, lift) {
        if (!moved(r, center.x, center.y, center.z, radius, lift, 0, 0, 0, 0)) return;
        sampleCircle(center.x, center.y + lift, center.z, radius, r.n, r.centers);
        reshape(r);
      },
      set(intensity, frozen, dead, from, to) {
        r.target = intensity; r.frozen = frozen; r.dead = dead;
        r.colA.copy(from); r.colB.copy(to);
      },
      surge() {
        // events arrive between frames (the loop may be parked): the rAF timeline is performance.now()'s
        r.surgeAt = performance.now();
        if (!motion || r.frozen || r.dead) return;
        if (style === "plasma") spawn(r, KIND_BURST, 0.62, pulseSpeed("plasma", 1, r.len) * 1.3, 1.6);
        else { r.train = FIBER_TRAIN; r.trainNext = r.surgeAt; }
      },
    };
    // Picking: the distance from the ray to the center line, within the scene's line threshold plus the radius.
    mesh.raycast = (rc, hits) => {
      rayO[0] = rc.ray.origin.x; rayO[1] = rc.ray.origin.y; rayO[2] = rc.ray.origin.z;
      rayD[0] = rc.ray.direction.x; rayD[1] = rc.ray.direction.y; rayD[2] = rc.ray.direction.z;
      let best = Infinity, bestT = 0;
      for (let i = 0; i < r.n - 1; i++) {
        segA[0] = r.centers[i * 3]!; segA[1] = r.centers[i * 3 + 1]!; segA[2] = r.centers[i * 3 + 2]!;
        segB[0] = r.centers[i * 3 + 3]!; segB[1] = r.centers[i * 3 + 4]!; segB[2] = r.centers[i * 3 + 5]!;
        raySegment(rayO, rayD, segA, segB, rayHit);
        if (rayHit[0]! < best) { best = rayHit[0]!; bestT = rayHit[1]!; }
      }
      const thr = (rc.params.Line?.threshold ?? 0.12) + (style === "plasma" ? r.radius : FIBER_R);
      if (best <= thr * thr) hits.push({ distance: bestT, point: rc.ray.at(bestT, new THREE.Vector3()), object: mesh });
    };
    applyStyle(r);
    slots[slot] = r;
    parent.add(mesh);
    return r;
  }

  function remove(c: EdgeConduit): void {
    const r = c as Rec;
    if (slots[r.slot] !== r) return;
    for (let i = live - 1; i >= 0; i--) if (pEdge[i] === r.slot) kill(i);
    slots[r.slot] = null;
    parent.remove(r.mesh);
    r.geom.dispose();
    r.plasma.dispose();
    (r.halo?.material as THREE.Material | undefined)?.dispose();
    r.fiber.dispose();
  }

  // ---------------------------------------------------------------- per frame
  const look: PlasmaLook = { radius: 0, spin: 0, flow: 0, breath: 0 };
  const at = new Float32Array(3), tan = new Float32Array(3);
  const tint = new THREE.Color();

  function updateEdge(r: Rec, dt: number): boolean {
    const want = r.dead ? 0 : r.frozen ? Math.min(r.target, 0.12) : r.target;
    r.lvl += (want - r.lvl) * (motion ? smoothK(dt, 0.35) : 1);
    const moving = motion && !r.frozen && !r.dead;
    plasmaLook(r.lvl, look);
    const age = now - r.surgeAt;
    const flare = flareLevel(age);
    if (moving) {
      r.flow = (r.flow + look.flow * 1.4 * dt) % WRAP_FLOW;
      r.drift = (r.drift + (0.08 + 0.5 * r.lvl) * dt) % WRAP_FLOW;
      r.spin = (r.spin + look.spin * dt) % WRAP_SPIN;
      r.breath = (r.breath + look.breath * dt) % (Math.PI * 2);
    }
    r.radius = look.radius * (1 + (moving ? 0.07 * Math.sin(r.breath) : 0)) + flare * 0.07;
    const plasma = style === "plasma";
    if (plasma) {
      const u = r.plasma.uniforms;
      u.uRadius!.value = r.radius;
      u.uI!.value = r.lvl;
      u.uFlow!.value = r.flow;
      u.uDrift!.value = r.drift;
      u.uSpin!.value = r.spin;
      u.uFlare!.value = flare;
      u.uFront!.value = flareFront(age);
      u.uGain!.value = r.dead ? 0.35 : light ? 0.9 : 1;
      const a = u.uColA!.value as THREE.Color, b = u.uColB!.value as THREE.Color;
      if (r.dead) { a.copy(DEAD); b.copy(DEAD); }
      else if (r.frozen) { a.copy(ICE); b.copy(ICE); }
      else { a.copy(r.colA); b.copy(r.colB); }
    } else {
      const f = r.fiber;
      f.color.copy(r.dead ? DEAD_SILVER : SILVER);
      f.roughness = r.dead ? 0.55 : 0.16;
      f.emissive.copy(r.frozen ? ICE : FIBER_RED);
      f.emissiveIntensity = r.dead ? 0 : r.frozen ? 0.12 : 0.03 + 0.25 * r.lvl * r.lvl + flare * 1.2;
    }
    if (moving && P > 0) {
      r.acc += pulseRate(style, r.lvl) * dt;
      while (r.acc >= 1) {
        r.acc -= 1;
        if (plasma) spawn(r, KIND_ORB, pulseSize("plasma", r.lvl), pulseSpeed("plasma", r.lvl, r.len), 1);
        else if (r.lvl < IDLE_I) spawn(r, KIND_STREAK, pulseSize("fiber", 0), pulseSpeed("fiber", 0, r.len), 0.3);
        else spawn(r, KIND_STREAK, pulseSize("fiber", r.lvl), pulseSpeed("fiber", r.lvl, r.len), 1);
      }
      while (r.train > 0 && now >= r.trainNext) {
        r.train--;
        r.trainNext += FIBER_TRAIN_MS;
        spawn(r, KIND_STREAK, pulseSize("fiber", 1) * 1.2, pulseSpeed("fiber", 1, r.len), 1.5);
      }
    }
    return (moving && r.lvl > IDLE_I) || flare > 0 || r.train > 0;
  }

  function updatePulses(dt: number): boolean {
    if (!pulses || !iPos || !iTan || !iCol || !iP || !pulseGeom) return false;
    const pos = iPos.array as Float32Array, tg = iTan.array as Float32Array, col = iCol.array as Float32Array, prm = iP.array as Float32Array;
    for (let i = 0; i < live;) {
      const r = slots[pEdge[i]!];
      if (!r) { kill(i); continue; }
      if (r.dead) {
        pA[i] = pA[i]! * Math.exp(-dt * 8);
        if (pA[i]! < 0.02) { kill(i); continue; }
      } else if (!r.frozen) pU[i] = pU[i]! + pV[i]! * dt;
      const u = pU[i]!;
      if (u >= 1) { kill(i); continue; }
      pSpin[i] = (pSpin[i]! + pSpinV[i]! * dt) % (Math.PI * 2);
      pointAt(r.centers, r.arc, r.n, u * r.len, r.closed, at, tan);
      const env = r.closed ? Math.sqrt(Math.sin(Math.PI * u)) : smoothstepJs(0, 0.06, u) * (1 - smoothstepJs(0.9, 1, u));
      const kind = pKind[i]!;
      if (kind === KIND_STREAK) tint.copy(r.frozen ? ICE : FIBER_RED).multiplyScalar(light ? 1 : 2.2);
      else tint.copy(r.frozen ? ICE : r.colA).lerp(r.frozen ? ICE : r.colB, u).lerp(WHITE, 0.3).multiplyScalar(light ? 1 : 1.6);
      pos[i * 3] = at[0]!; pos[i * 3 + 1] = at[1]!; pos[i * 3 + 2] = at[2]!;
      tg[i * 3] = tan[0]!; tg[i * 3 + 1] = tan[1]!; tg[i * 3 + 2] = tan[2]!;
      col[i * 3] = tint.r; col[i * 3 + 1] = tint.g; col[i * 3 + 2] = tint.b;
      prm[i * 4] = pSize[i]!;
      prm[i * 4 + 1] = pA[i]! * env;
      prm[i * 4 + 2] = pSpin[i]!;
      prm[i * 4 + 3] = kind;
      i++;
    }
    pulseGeom.instanceCount = live;
    pulses.visible = live > 0;
    if (live > 0) {
      upload(iPos, live * 3);
      upload(iTan, live * 3);
      upload(iCol, live * 3);
      upload(iP, live * 4);
    }
    return live > 0;
  }

  /** Upload only the live part of an instance attribute. */
  function upload(a: THREE.InstancedBufferAttribute, count: number): void {
    a.clearUpdateRanges();
    a.addUpdateRange(0, count);
    a.needsUpdate = true;
  }

  return {
    add,
    remove,
    setStyle(next) {
      if (next === style) return;
      style = next;
      live = 0;
      for (const r of slots) if (r) { r.acc = 0; r.train = 0; applyStyle(r); }
    },
    setFlat(next) {
      if (next === flat) return;
      flat = next;
      flatU.value = flat ? 1 : 0;
      for (const r of slots) if (r && !Number.isNaN(r.shape[0]!)) reshape(r);
    },
    update(t, dt) {
      now = t;
      let busy = false;
      for (const r of slots) if (r && updateEdge(r, dt)) busy = true;
      if (updatePulses(dt)) busy = true;
      return busy;
    },
    dispose() {
      for (const r of slots) if (r) remove(r);
      slots.length = 0;
      live = 0;
      if (pulses) { parent.remove(pulses); pulseGeom?.dispose(); (pulses.material as THREE.Material).dispose(); }
      sheath.dispose();
      indexCache.clear();
    },
  };
}

function smoothstepJs(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
