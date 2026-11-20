// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_plasma.ts - P-VIZ.4 (ADR-0626), P-VIZ.5 (ADR-0630): the Visualize edges, drawn in one
// of two styles.
//
//   plasma (the anime scene): a thin glowing plasma conduit along the edge's curve. A tube with its own shader
//     (additive, a fresnel edge glow, domain-warped noise flowing from the producer to its parent, and two
//     counter-rotating helical bands, so it visibly spins). Always there: a hairline glow at idle (dim,
//     desaturated, drifting slowly), scaling continuously with the edge's est. tok/s intensity (a little
//     thicker, brighter, faster spin and flow, a saturated body with a white-hot filament). The color runs
//     from the source's persona color into the target's. Around it stream TOKEN PARTICLES: small bright
//     dots, most spiraling around the conduit, every third passing back and forth through its core, in the
//     same persona gradient; their rate, speed, size and swirl follow the intensity (a sparse trickle at idle).
//     Small spinning plasma pulses (an orb with a rotating three-lobed corona) travel among them. A surge
//     fires a burst pulse (with spokes), sprays a burst of token particles outward, and flares the whole
//     conduit (a bright wave front crossing it, which the full tier's bloom turns into a flash); the scene
//     keeps its lightning arcs on top.
//   fiber (the professional scene): a small thin line (a crisp 1 px gray-silver line, darker in the light
//     theme) carrying streaming red light particles: fast tight red streaks aligned with the line on screen,
//     their rate and speed following the intensity. Idle shows an occasional faint red particle. A surge sends
//     a burst train of red streaks and tints the line red for a moment.
// 2D draws the conduit squashed flat (a ribbon that reads from the top-down camera; the plasma shader derives
// its fresnel analytically there) and flattens the token particles' swirl the same way; the line is flat.
//
// Budgets (viz_plasma_math.edgeBudget): the tier sets rings, sides, noise octaves, the warp, the halo shell and
// the one particle pool (orbs plus stream particles). Reduced motion freezes the shader's phases and spawns no
// particles: the edges hold a static glow or line and say what is happening by brightness and color only.
//
// Allocation: one geometry per edge, rewritten in place only when its curve moves (the fiber line shares the
// center line's buffer); one instanced draw for every particle of every edge; nothing allocated per frame.
// remove() and dispose() free every geometry and material.

import * as THREE from "three";
import {
  arcLengths, edgeBudget, FIBER_TRAIN, FIBER_TRAIN_MS, FLAT_SQUASH, flareFront, flareLevel, IDLE_I, LINE_PICK_R, plasmaLook,
  pointAt, pulseRate, pulseSize, pulseSpeed, raySegment, sampleCircle, sampleQuadratic, smoothK, TOKEN_SURGE,
  TOKEN_THROUGH_EVERY, tokenOrbit, tokenRate, tokenSize, tokenSpeed, TUBE_REF, tubeIndex, writeTube,
  type EdgeDetail, type EdgeStyle, type PlasmaLook, type TubeOut,
} from "./viz_plasma_math.ts";

export interface EdgeFxOpts {
  detail: EdgeDetail;
  /** The tier's flow budget (viz_model.VizTierOpts.particles); the particle pool is sized from it. */
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
  /** One frame at `t` ms; returns true while anything moves fast (an active edge, its particles, a burst, a
   *  flare). An idle edge's slow trickle of particles alone keeps the scene on its idle cadence. */
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

// Particles: camera-facing quads (view space, so the same in perspective and orthographic). iP.w is the kind:
// 0 orb, 1 fiber streak, 2 burst orb, 3 token. A plasma orb spins its corona (iP.z); a fiber streak stretches
// along the line's on-screen direction, its head leading; a token is a soft dot with a hot core, drawn out a
// little along its path.
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
  float stretch = abs(iP.w - 1.0) < 0.5 ? 3.6 : iP.w > 2.5 ? 1.7 : 1.0;
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
  } else if (vKind > 2.5) {
    float r2 = dot(vQ, vQ);
    if (r2 > 1.0) discard;
    float glow = exp(-r2 * 5.0);
    float core = exp(-r2 * 28.0);
    a = glow + core;
    c = vCol * glow + vec3(1.0) * core * 0.9;
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
/** The fiber line: a neutral gray-silver, slightly darker in the light theme so it holds on a pale page. */
const LINE_DARK = new THREE.Color("#a7aeb8");
const LINE_LIGHT = new THREE.Color("#6a717a");
const LINE_DEAD = new THREE.Color("#4a4e55");
/** The noise repeats every 64 cells along the conduit, so the flow phases wrap there without a jump. */
const WRAP_FLOW = 64;
/** The helices use uSpin and 1.35 * uSpin: 20 turns is a whole number of turns for both. */
const WRAP_SPIN = Math.PI * 2 * 20;
const KIND_ORB = 0, KIND_STREAK = 1, KIND_BURST = 2, KIND_TOKEN = 3;
/** At most this many particles owed by one edge are spawned in a single frame (a long frame does not dump a
 *  clump of them at the source). */
const SPAWN_CAP = 8;

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
  line: THREE.Line;
  lineGeom: THREE.BufferGeometry;
  lineAttr: THREE.BufferAttribute;
  lineMat: THREE.LineBasicMaterial;
  target: number; lvl: number; frozen: boolean; dead: boolean;
  colA: THREE.Color; colB: THREE.Color;
  flow: number; drift: number; spin: number; breath: number; radius: number;
  surgeAt: number; acc: number; tokAcc: number; tokSeq: number; train: number; trainNext: number;
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
  /** The plasma conduit's material in the fiber style: draws nothing, so the mesh stays the edge's pick target. */
  const hidden = new THREE.MeshBasicMaterial({ visible: false });

  // ---------------------------------------------------------------- the particle pool (one instanced draw)
  // Stream particles (tokens, fiber streaks) spawn only while fewer than B.tokens are alive, so B.pulses of
  // the pool always stay free for the orbs, the surge bursts and the fiber's surge train.
  const P = B.pulses + B.tokens;
  const pEdge = new Int32Array(P), pU = new Float32Array(P), pV = new Float32Array(P), pSize = new Float32Array(P);
  const pKind = new Uint8Array(P), pSpin = new Float32Array(P), pSpinV = new Float32Array(P), pA = new Float32Array(P);
  // a token's swirl: orbit radius, its growth (a surge spray flies outward), ellipse (1 or -1 a spiral either
  // way round, 0 a pass back and forth through the core) and the axis it swings on
  const pR = new Float32Array(P), pDR = new Float32Array(P), pE = new Float32Array(P), pPsi = new Float32Array(P);
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

  /** A new particle at the edge's source, or -1 when the pool (or, for a stream particle, its share) is full. */
  function spawn(r: Rec, kind: number, size: number, speed: number, alpha: number, stream: boolean): number {
    if (live >= (stream ? B.tokens : P)) return -1;
    const i = live++;
    pEdge[i] = r.slot; pU[i] = 0; pV[i] = speed; pSize[i] = size; pKind[i] = kind; pA[i] = alpha;
    pSpin[i] = Math.random() * Math.PI * 2;
    pSpinV[i] = (Math.random() < 0.5 ? -1 : 1) * (2.5 + 9 * r.lvl);
    pR[i] = 0; pDR[i] = 0; pE[i] = 1; pPsi[i] = 0;
    return i;
  }

  /** A token particle: most spiral around the conduit (either way round), every TOKEN_THROUGH_EVERY-th swings
   *  back and forth through its core; a spray particle starts at the core and flies outward. */
  function spawnToken(r: Rec, spray: boolean): void {
    const k = spray ? Math.max(r.lvl, 0.6) : r.lvl;
    const speed = tokenSpeed(k, r.len) * (0.8 + 0.4 * Math.random()) * (spray ? 1.4 : 1);
    const i = spawn(r, KIND_TOKEN, tokenSize(k) * (0.7 + 0.6 * Math.random()), speed, spray ? 1.3 : 0.55 + 0.6 * r.lvl, true);
    if (i < 0) return;
    const through = r.tokSeq++ % TOKEN_THROUGH_EVERY === 0;
    const dir = Math.random() < 0.5 ? -1 : 1;
    pE[i] = through ? 0 : dir;
    pPsi[i] = Math.random() * Math.PI * 2;
    pSpinV[i] = dir * (through ? 3 + 7 * k : 4 + 14 * k);
    if (spray) { pR[i] = 0.02; pDR[i] = 0.5 + Math.random(); }
    else pR[i] = tokenOrbit(k) * (0.5 + 0.8 * Math.random());
  }

  /** Swap-remove particle i (the last live one takes its place). */
  function kill(i: number): void {
    const j = --live;
    if (i === j) return;
    pEdge[i] = pEdge[j]!; pU[i] = pU[j]!; pV[i] = pV[j]!; pSize[i] = pSize[j]!;
    pKind[i] = pKind[j]!; pSpin[i] = pSpin[j]!; pSpinV[i] = pSpinV[j]!; pA[i] = pA[j]!;
    pR[i] = pR[j]!; pDR[i] = pDR[j]!; pE[i] = pE[j]!; pPsi[i] = pPsi[j]!;
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
    writeTube(r.centers, r.arc, r.n, B.radial, TUBE_REF, flat ? FLAT_SQUASH : 1, r.closed, r.side, r.tube);
    for (const a of r.attrs) a.needsUpdate = true;
    r.lineAttr.needsUpdate = true;
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
    r.mesh.material = plasma ? r.plasma : hidden;
    r.mesh.renderOrder = plasma ? 4 : 0;
    if (r.halo) r.halo.visible = plasma;
    r.line.visible = !plasma;
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
      uRadius: { value: 0.02 }, uRef: { value: TUBE_REF }, uLen: { value: 1 }, uFlat: flatU, uClosed: { value: closed ? 1 : 0 },
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
    const mesh: THREE.Mesh = new THREE.Mesh(geom, plasma);
    mesh.frustumCulled = false;
    // The fiber line draws the center line itself: its position attribute wraps the same samples.
    const centers = new Float32Array(n * 3);
    const lineGeom = new THREE.BufferGeometry();
    const lineAttr = new THREE.BufferAttribute(centers, 3).setUsage(THREE.DynamicDrawUsage);
    lineGeom.setAttribute("position", lineAttr);
    const lineMat = new THREE.LineBasicMaterial({ color: light ? LINE_LIGHT : LINE_DARK, transparent: true, opacity: 0.9, depthWrite: false });
    const line = new THREE.Line(lineGeom, lineMat);
    line.frustumCulled = false;
    line.raycast = () => {};
    mesh.add(line);
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
      centers, arc: new Float32Array(n), len: 1,
      shape: new Float32Array(9).fill(Number.NaN), side: new Float32Array([1, 0, 0]),
      plasma, halo, line, lineGeom, lineAttr, lineMat,
      target: 0, lvl: 0, frozen: false, dead: false, colA: new THREE.Color(), colB: new THREE.Color(),
      flow: 0, drift: Math.random() * WRAP_FLOW, spin: Math.random() * Math.PI * 2, breath: 0, radius: 0.02,
      surgeAt: -1e9, acc: 0, tokAcc: 0, tokSeq: 0, train: 0, trainNext: 0,
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
        if (style === "plasma") {
          spawn(r, KIND_BURST, 0.34, pulseSpeed("plasma", 1, r.len) * 1.3, 1.6, false);
          for (let k = 0; k < TOKEN_SURGE; k++) spawnToken(r, true);
        } else { r.train = FIBER_TRAIN; r.trainNext = r.surgeAt; }
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
      const thr = (rc.params.Line?.threshold ?? 0.12) + (style === "plasma" ? r.radius : LINE_PICK_R);
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
    r.lineGeom.dispose();
    r.lineMat.dispose();
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
    r.radius = look.radius * (1 + (moving ? 0.07 * Math.sin(r.breath) : 0)) + flare * 0.025;
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
      // the line: neutral, a touch of red while busy, a red flash at a surge; frosty when paused, dim when dead
      const m = r.lineMat;
      if (r.dead) { m.color.copy(LINE_DEAD); m.opacity = 0.45; }
      else {
        m.color.copy(light ? LINE_LIGHT : LINE_DARK);
        if (r.frozen) m.color.lerp(ICE, 0.5);
        else m.color.lerp(FIBER_RED, Math.min(1, 0.12 * r.lvl + 0.85 * flare));
        m.opacity = 0.9;
      }
    }
    if (moving && P > 0) {
      r.acc = Math.min(SPAWN_CAP, r.acc + pulseRate(style, r.lvl) * dt);
      while (r.acc >= 1) {
        r.acc -= 1;
        if (plasma) spawn(r, KIND_ORB, pulseSize("plasma", r.lvl), pulseSpeed("plasma", r.lvl, r.len), 1, false);
        else if (r.lvl < IDLE_I) spawn(r, KIND_STREAK, pulseSize("fiber", 0), pulseSpeed("fiber", 0, r.len), 0.3, true);
        else spawn(r, KIND_STREAK, pulseSize("fiber", r.lvl), pulseSpeed("fiber", r.lvl, r.len), 1, true);
      }
      if (plasma) {
        r.tokAcc = Math.min(SPAWN_CAP, r.tokAcc + tokenRate(r.lvl) * dt);
        while (r.tokAcc >= 1) { r.tokAcc -= 1; spawnToken(r, false); }
      }
      while (r.train > 0 && now >= r.trainNext) {
        r.train--;
        r.trainNext += FIBER_TRAIN_MS;
        spawn(r, KIND_STREAK, pulseSize("fiber", 1) * 1.2, pulseSpeed("fiber", 1, r.len), 1.5, false);
      }
    }
    return (moving && r.lvl > IDLE_I) || flare > 0 || r.train > 0;
  }

  function updatePulses(dt: number): boolean {
    if (!pulses || !iPos || !iTan || !iCol || !iP || !pulseGeom) return false;
    const pos = iPos.array as Float32Array, tg = iTan.array as Float32Array, col = iCol.array as Float32Array, prm = iP.array as Float32Array;
    const squash = flat ? FLAT_SQUASH : 1;
    let busy = false;
    for (let i = 0; i < live;) {
      const r = slots[pEdge[i]!];
      if (!r) { kill(i); continue; }
      const moving = !r.dead && !r.frozen;
      if (r.dead) {
        pA[i] = pA[i]! * Math.exp(-dt * 8);
        if (pA[i]! < 0.02) { kill(i); continue; }
      } else if (moving) pU[i] = pU[i]! + pV[i]! * dt;
      const u = pU[i]!;
      if (u >= 1) { kill(i); continue; }
      const kind = pKind[i]!;
      if (moving) {
        pSpin[i] = (pSpin[i]! + pSpinV[i]! * dt) % (Math.PI * 2);
        if (pDR[i]! > 0) { pR[i] = pR[i]! + pDR[i]! * dt; pDR[i] = pDR[i]! * Math.exp(-dt * 2.5); }
        // an idle edge's slow trickle alone does not need the full frame rate
        if (r.lvl > IDLE_I || kind === KIND_BURST || pDR[i]! > 0.05 || r.train > 0) busy = true;
      }
      pointAt(r.centers, r.arc, r.n, u * r.len, r.closed, at, tan);
      const env = r.closed ? Math.sqrt(Math.sin(Math.PI * u)) : smoothstepJs(0, 0.06, u) * (1 - smoothstepJs(0.9, 1, u));
      if (kind === KIND_TOKEN) {
        // the swirl around the center line: side = T x up (horizontal), N = T x side; in 2D the N part (mostly
        // vertical) is squashed like the ribbon, so the swirl reads as a weave from the top-down camera. The
        // swirl narrows into the cube walls at an open edge's ends.
        const tx = tan[0]!, ty = tan[1]!, tz = tan[2]!;
        let sx = -tz, sz = tx;
        const hl = Math.hypot(sx, sz);
        if (hl > 1e-3) { sx /= hl; sz /= hl; } else { sx = r.side[0]!; sz = r.side[2]!; }
        const nx = ty * sz, ny = tz * sx - tx * sz, nz = -ty * sx;
        const taper = r.closed ? 1 : 0.25 + 0.75 * smoothstepJs(0, 0.12, u) * (1 - smoothstepJs(0.88, 1, u));
        const R = pR[i]! * taper, th = pSpin[i]!, psi = pPsi[i]!;
        const c1 = R * Math.cos(th), c2 = R * pE[i]! * Math.sin(th);
        const cp = Math.cos(psi), sp = Math.sin(psi);
        const a = c1 * cp - c2 * sp, b = (c1 * sp + c2 * cp) * squash;
        at[0] = at[0]! + sx * a + nx * b;
        at[1] = at[1]! + ny * b;
        at[2] = at[2]! + sz * a + nz * b;
      }
      if (kind === KIND_STREAK) tint.copy(r.frozen ? ICE : FIBER_RED).multiplyScalar(light ? 1 : 2.2);
      else if (kind === KIND_TOKEN) tint.copy(r.frozen ? ICE : r.colA).lerp(r.frozen ? ICE : r.colB, u).lerp(WHITE, 0.35).multiplyScalar(light ? 0.85 : 1.8);
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
    return busy;
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
      for (const r of slots) if (r) { r.acc = 0; r.tokAcc = 0; r.train = 0; applyStyle(r); }
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
      hidden.dispose();
      indexCache.clear();
    },
  };
}

function smoothstepJs(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
