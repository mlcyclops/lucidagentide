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
//   plasma-light (P-WORLDS.FX1, ADR-0652, worlds only): the plasma for LIGHT skies. Normal blending throughout:
//     a thicker core tube in a deep, saturated version of the edge's colors (bright helical bands and a light
//     filament flowing through it) inside a translucent outer sheath (from the reduced tier), and packets that
//     are solid discs with a bright rim and a soft dark edge, so they read on a pale sky the way the additive
//     plasma reads on a dark one. From ultra the packets shed short spark trails.
// 2D draws the conduit squashed flat (a ribbon that reads from the top-down camera; the plasma shader derives
// its fresnel analytically there) and flattens the token particles' swirl the same way; the line is flat.
//
// Tokens (ADR-0652, setTokens): a world's plasma packets may be an orb (the default dot), a coin, a petal, a
// snowflake, a spark or its own "custom" sprite. Petal, snowflake, spark and custom are camera-facing sprites in
// the same instanced draw (one canvas texture: the built-ins are painted white and tinted, custom is painted by
// the world's paintToken and drawn as painted). A coin is an instanced, spinning, lit disc: a face embossed by
// the world's tokenStamp (or a default star), a reeded edge (ridges per tier) and a glint (a brightening plus a
// four-point star quad as its face turns). `tokenColor` colors every packet; without it the packets follow the
// edge's two colors. The built-in styles call setTokens(null): the classic dot, untouched.
//
// Budgets (viz_plasma_math.edgeBudget): the tier sets rings, sides, noise octaves, the warp, the halo shell, the
// sheath, the coin cap and ridges, the spark trails and the one particle pool (orbs plus stream particles plus
// sparks). Reduced motion freezes the shader's phases and spawns no particles: the edges hold a static glow or
// line and say what is happening by brightness and color only.
//
// Allocation: one geometry per edge, rewritten in place only when its curve moves (the fiber line shares the
// center line's buffer); one instanced draw for every particle of every edge, one more for the coins; nothing
// allocated per frame. remove(), setTokens() and dispose() free every geometry, material and texture they drop.

import * as THREE from "three";
import {
  arcLengths, COIN_THICK, coinGlint, coinRadius, coinRim, coinSegments, edgeBudget, FIBER_TRAIN, FIBER_TRAIN_MS, FLAT_SQUASH,
  flareFront, flareLevel, IDLE_I, isPlasmaStyle, LINE_PICK_R, LITE_SHEATH, liteRadius, plasmaLook, pointAt, pulseRate, pulseSize, pulseSpeed,
  raySegment, sampleCircle, sampleQuadratic, smoothK, SPARK_FADE, sparkRate, TOKEN_SURGE, TOKEN_THROUGH_EVERY, tokenCap,
  tokenOrbit, tokenRate, tokenSize, tokenSpeed, TUBE_REF, tubeIndex, writeTube,
  type EdgeDetail, type EdgeStyle, type EdgeToken, type PlasmaLook, type TubeOut,
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
  /** The point at path fraction `u` (0 source .. 1 target) of the edge's center line, into `out`. */
  sample(u: number, out: THREE.Vector3): THREE.Vector3;
}

/** ADR-0652: a world's packet token. */
export interface EdgeTokens {
  token: EdgeToken;
  /** Every packet's color; null: the edge's two colors. */
  color: THREE.Color | null;
  /** token "custom": paints the sprite (transparent background, centered) into a square canvas. */
  paint?: ((ctx: CanvasRenderingContext2D, size: number) => void) | undefined;
  /** A built-in token's face stamp (a coin's emboss). */
  stamp?: ((ctx: CanvasRenderingContext2D, size: number) => void) | undefined;
}

/** What the edges drew on the last frame (the demo probe reads it). */
export interface EdgeFxStats {
  style: EdgeStyle;
  token: EdgeToken;
  tokenColor: string | null;
  /** Particles alive (orbs, packets, streaks, sparks). */
  live: number;
  /** Camera-facing quads drawn. */
  quads: number;
  coins: number;
  sparks: number;
  glints: number;
  /** The tier's caps for this token: stream packets, coins, sparks. */
  budget: { tokens: number; coins: number; sparks: number; coinRidges: number };
}

export interface EdgeFx {
  add(closed: boolean): EdgeConduit;
  remove(c: EdgeConduit): void;
  setStyle(style: EdgeStyle): void;
  /** ADR-0652: the packet token on the plasma styles; null restores the built-in dot (the anime look). Repaints
   *  the token art; the particles in flight are dropped only when the shape changes. */
  setTokens(t: EdgeTokens | null): void;
  stats(): EdgeFxStats;
  /** P-WORLDS.1 (ADR-0648): the fiber's line color and its light (a world's edge colors); null restores the
   *  built-in silver line and red light. The plasma takes its colors per edge (EdgeConduit.set). */
  setPalette(line: THREE.Color | null, glow: THREE.Color | null): void;
  setFlat(flat: boolean): void;
  /** One frame at `t` ms; returns true while anything moves fast (an active edge, its particles, a burst, a
   *  flare). An idle edge's slow trickle of particles alone keeps the scene on its idle cadence. */
  update(t: number, dt: number): boolean;
  dispose(): void;
}

// ------------------------------------------------------------------------------------------ shaders

// ADR-0652: the plasma-light and token outputs are sanitized: a NaN or Inf in one pixel would be spread over the
// whole frame by the ultra tier's bloom on light themes, and normal-blended colors never need to pass 4.
const SAFE_GLSL = /* glsl */ `
vec3 safeRgb(vec3 c) {
  if (any(isnan(c)) || any(isinf(c))) return vec3(0.0);
  return clamp(c, 0.0, 4.0);
}
float safeA(float a, float hi) {
  if (isnan(a) || isinf(a)) return 0.0;
  return clamp(a, 0.0, hi);
}`;

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
#elif HALO == 2
  r *= ${LITE_SHEATH.toFixed(2)};
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
${SAFE_GLSL}
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
#if LITE == 1
  vec3 raw = col;
#endif
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(lum), col, 0.45 + 0.55 * uI); // calm reads pale, a burst reads saturated
  vec2 q = vec2(vUv.x * 1.4 - uFlow, vUv.y * 4.0);
#if WARP == 1
  vec2 w = vec2(fbm(q + vec2(uDrift, 0.0)), fbm(q + vec2(5.2 - uDrift, 0.0)));
  float n = fbm(q + 1.6 * w);
#else
  float n = fbm(q + vec2(uDrift, 0.0));
#endif
  // the interpolated fresnel can dip a hair below 0 (|dot| of two normalized vectors rounding past 1): clamp it,
  // or pow() of it is NaN, which bloom spreads over the whole frame
  float fres = clamp(vFres, 0.0, 1.0);
  float core = 1.0 - fres;
#if LITE == 1
  // plasma-light (normal blending, for light skies): never washed out to gray, darker and denser at the center
  // line so it holds against a pale sky, with light bands and a light filament flowing through it.
  float dw = (u - uFront) * 7.0;
  float wave = exp(-dw * dw) * uFlare;
#if HALO == 2
  // the outer sheath: a translucent, lighter skin of the same color around the core
  vec3 c = mix(raw, vec3(1.0), 0.3);
  float a = (0.16 + 0.24 * uI + 0.4 * uFlare + 0.3 * wave) * smoothstep(0.0, 0.85, core) * (0.7 + 0.5 * n);
#else
  float h1 = clamp(0.5 + 0.5 * sin(th * 2.0 - vUv.x * 6.0 - uSpin), 0.0, 1.0);
  float h2 = clamp(0.5 + 0.5 * sin(th * 3.0 + vUv.x * 4.5 + uSpin * 1.35), 0.0, 1.0);
  float sharp = 9.0 - 4.0 * uI;
  float bands = pow(h1, sharp) + 0.7 * pow(h2, sharp + 2.0);
  float fil = pow(core, 6.0) * (0.2 + 0.6 * uI) * (0.6 + 0.6 * n);
  vec3 deep = raw * (0.5 + 0.25 * n);
  vec3 c = mix(deep, raw * 1.1, 0.6 * fres * sqrt(fres));
  c = mix(c, vec3(1.0), clamp(bands * (0.12 + 0.45 * uI) * (0.5 + 0.7 * n) + fil * 0.55 + wave * 0.8 + uFlare * 0.25, 0.0, 0.85));
  float a = 0.6 + 0.3 * uI + 0.1 * core + 0.2 * uFlare;
#endif
  float ends = uClosed > 0.5 ? 1.0 : smoothstep(0.0, 0.04, u) * smoothstep(1.0, 0.96, u);
  gl_FragColor = vec4(safeRgb(c), safeA(a * uGain * ends, 0.97));
#else
#if HALO == 1
  float glow = core * core * (0.05 + 0.4 * uI + 0.9 * uFlare) * (0.6 + 0.6 * n);
  vec3 c = col * glow;
  float a = glow;
#else
  float h1 = clamp(0.5 + 0.5 * sin(th * 2.0 - vUv.x * 6.0 - uSpin), 0.0, 1.0);
  float h2 = clamp(0.5 + 0.5 * sin(th * 3.0 + vUv.x * 4.5 + uSpin * 1.35), 0.0, 1.0);
  float sharp = 9.0 - 4.0 * uI;
  float bands = pow(h1, sharp) + 0.7 * pow(h2, sharp + 2.0);
  float rim = pow(fres, 2.2);
  float glow = rim * (0.3 + 0.7 * uI)
    + core * (0.06 + 0.45 * uI) * (0.35 + n)
    + bands * (0.12 + 0.8 * uI) * (0.5 + 0.7 * n)
    + uFlare * (0.8 + 0.6 * n);
  float fil = pow(core, 7.0) * (0.03 + 0.9 * uI * uI) * (0.7 + 0.6 * n);
  float dw = (u - uFront) * 7.0;
  float wave = exp(-dw * dw) * uFlare;
  vec3 c = col * (glow + wave) + vec3(1.0) * (fil + wave * 1.8);
  float a = glow + fil + wave;
#endif
  float ends = uClosed > 0.5 ? 1.0 : smoothstep(0.0, 0.04, u) * smoothstep(1.0, 0.96, u);
  float g = uGain * ends;
  if (uLight > 0.5) gl_FragColor = vec4(col * 0.85, clamp(a * g, 0.0, 0.95));
  else gl_FragColor = vec4(c * g, 1.0);
#endif
  gl_FragColor = linearToOutputTexel(gl_FragColor);
}`;

// Particles: camera-facing quads (view space, so the same in perspective and orthographic). iP.w is the kind:
// 0 orb, 1 fiber streak, 2 burst orb, 3 token, 4 spark trail, 5 coin glint. A plasma orb spins its corona
// (iP.z); a fiber streak stretches along the line's on-screen direction, its head leading; a token is a soft
// dot with a hot core, drawn out a little along its path. ADR-0652: uLite draws normal-blended packets with a
// bright rim (plasma-light); uTokMode 1 draws the token from the uTok sprite tinted by the packet color, 2 as
// painted (custom); kinds 4 and 5 and every sprite write straight alpha, which both blendings take as is.
const PULSE_VS = /* glsl */ `
attribute vec3 iPos;
attribute vec3 iTan;
attribute vec3 iCol;
attribute vec4 iP;
uniform float uTokMode;
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
  float stretch = abs(iP.w - 1.0) < 0.5 ? 3.6 : abs(iP.w - 3.0) < 0.5 ? (uTokMode > 0.5 ? 1.0 : 1.7) : abs(iP.w - 4.0) < 0.5 ? 3.2 : 1.0;
  c.xy += ax * position.x * iP.x * stretch + ay * position.y * iP.x;
  gl_Position = projectionMatrix * c;
}`;

const PULSE_FS = /* glsl */ `
${SAFE_GLSL}
uniform float uLight;
uniform float uLite;
uniform float uTokMode;
uniform sampler2D uTok;
varying vec2 vQ;
varying vec3 vCol;
varying float vA;
varying float vSpin;
varying float vKind;
void main() {
  vec3 c;
  float a;
  bool straight = uLite > 0.5;
  if (vKind > 4.5) {
    // a coin's glint: a white four-point star
    float sx = abs(vQ.x);
    float sy = abs(vQ.y);
    a = exp(-sy * 16.0) * exp(-sx * 2.4) + exp(-sx * 16.0) * exp(-sy * 2.4) + exp(-dot(vQ, vQ) * 18.0);
    if (a < 0.01) discard;
    c = vec3(1.0);
    straight = true;
  } else if (vKind > 3.5) {
    // a spark trail: a thin streak, hot at its head
    float along = vQ.x * 0.5 + 0.5;
    a = smoothstep(0.0, 1.0, along) * (1.0 - smoothstep(0.92, 1.0, along)) * exp(-vQ.y * vQ.y * 16.0);
    c = mix(vCol, vec3(1.0), 0.6 * along);
    straight = true;
  } else if (vKind > 2.5 && uTokMode > 0.5) {
    // a sprite token (petal, snowflake, spark, custom), turning slowly with its swirl
    float cs = cos(vSpin * 0.35);
    float sn = sin(vSpin * 0.35);
    vec4 t = texture2D(uTok, vec2(cs * vQ.x - sn * vQ.y, sn * vQ.x + cs * vQ.y) * 0.5 + 0.5);
    if (t.a < 0.02) discard;
    c = uTokMode > 1.5 ? t.rgb : t.rgb * vCol;
    a = t.a;
    straight = true;
  } else if (vKind > 2.5 && uLite > 0.5) {
    // a plasma-light packet: a solid saturated disc, a bright rim, a soft darker edge outside it
    float r = length(vQ);
    if (r > 1.0) discard;
    float body = 1.0 - smoothstep(0.58, 0.66, r);
    float dr = (r - 0.7) * 11.0;
    float rim = exp(-dr * dr);
    float edge = smoothstep(0.74, 0.8, r) * (1.0 - smoothstep(0.88, 1.0, r)) * 0.55;
    float hot = exp(-r * r * 9.0);
    float w = body + rim + edge;
    c = (vCol * (0.8 + 0.4 * hot) * body + vec3(1.0) * rim + vCol * 0.45 * edge) / max(w, 1e-3);
    a = clamp(w, 0.0, 1.0);
  } else if (abs(vKind - 1.0) < 0.5) {
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
    float ang = r > 1e-5 ? atan(p.y, p.x) : 0.0; // atan(0, 0) is undefined (NaN on some drivers)
    float core = exp(-r * r * 16.0);
    float glow = exp(-r * r * 4.5) * 0.55;
    float lobes = 0.5 + 0.5 * sin(ang * 3.0);
    float dr = (r - 0.6) * 10.0;
    float ring = exp(-dr * dr) * (0.35 + 0.65 * lobes * lobes);
    float spokes = vKind > 1.5 ? pow(max(0.0, sin(ang * 7.0)), 10.0) * (1.0 - r) * 0.9 : 0.0;
    a = glow + ring + spokes + core;
    c = vCol * (glow + ring * 1.4 + spokes) + vec3(1.0) * core * 1.5;
    if (straight) c /= max(a, 1e-3); // plasma-light: the orb's mean color, its core white
  }
  if (straight) gl_FragColor = vec4(safeRgb(c), safeA(a * vA, 1.0));
  else if (uLight > 0.5) gl_FragColor = vec4(vCol, clamp(a * vA, 0.0, 1.0));
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
const KIND_ORB = 0, KIND_STREAK = 1, KIND_BURST = 2, KIND_TOKEN = 3, KIND_SPARK = 4, KIND_GLINT = 5;
/** A coin's face when the world sets no tokenColor: a neutral metal, tinted per coin by the edge's colors. */
const COIN_NEUTRAL = "#e4e4e4";
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
  /** The conduit's uniforms, shared by every material drawn on its geometry. */
  uni: Record<string, THREE.IUniform>;
  /** ADR-0652: the plasma-light core and its sheath, built the first time the edge shows that style. */
  lite: THREE.ShaderMaterial | null;
  sheath: THREE.Mesh | null;
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
  const detail = opts.detail;
  const B = edgeBudget(detail, opts.particles, opts.motion);
  const motion = opts.motion;
  const light = opts.light;
  const blending = light ? THREE.NormalBlending : THREE.AdditiveBlending;
  let style: EdgeStyle = opts.style;
  let flat = opts.flat;
  /** P-WORLDS.1 (ADR-0648): the fiber's line and light colors (a world's two edge colors; the built-ins' by default). */
  const lineBase = new THREE.Color().copy(light ? LINE_LIGHT : LINE_DARK);
  const fiberLight = new THREE.Color().copy(FIBER_RED);
  const flatU = { value: flat ? 1 : 0 };
  const lightU = { value: light ? 1 : 0 };
  const slots: (Rec | null)[] = [];
  const indexCache = new Map<number, Uint16Array>();
  let now = performance.now();
  /** The plasma conduit's material in the fiber style: draws nothing, so the mesh stays the edge's pick target. */
  const hidden = new THREE.MeshBasicMaterial({ visible: false });

  // ---------------------------------------------------------------- the particle pool (one instanced draw)
  // Stream particles (tokens, fiber streaks) spawn only while fewer than B.tokens (a coin token: the coin cap)
  // are alive besides the sparks, and sparks only while fewer than B.sparks are, so B.pulses of the pool always
  // stay free for the orbs, the surge bursts and the fiber's surge train.
  const P = B.pulses + B.tokens + B.sparks;
  /** ADR-0652: the packet token, its color (when the world sets one) and the stream cap that goes with it. */
  let token: EdgeToken = "orb";
  let hasTokCol = false;
  const tokCol = new THREE.Color();
  let streamCap = B.tokens;
  let sparkLive = 0;
  const liteU = { value: style === "plasma-light" ? 1 : 0 };
  const tokModeU = { value: 0 };
  const tokTexU: THREE.IUniform<THREE.Texture | null> = { value: null };
  let tokTex: THREE.CanvasTexture | null = null;
  let pulseMat: THREE.ShaderMaterial | null = null;
  let lastQuads = 0, lastCoins = 0, lastGlints = 0;
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
    pulseMat = new THREE.ShaderMaterial({
      uniforms: { uLight: lightU, uLite: liteU, uTokMode: tokModeU, uTok: tokTexU },
      vertexShader: PULSE_VS, fragmentShader: PULSE_FS, transparent: true, depthWrite: false, blending,
    });
    pulses = new THREE.Mesh(pulseGeom, pulseMat);
    pulses.frustumCulled = false;
    pulses.renderOrder = 5;
    pulses.visible = false;
    parent.add(pulses);
  }

  /** plasma-light draws its packets normal-blended on any theme; the other styles keep the theme's blending. */
  function syncPulseLook(): void {
    liteU.value = style === "plasma-light" ? 1 : 0;
    if (!pulseMat) return;
    const b = style === "plasma-light" ? THREE.NormalBlending : blending;
    if (pulseMat.blending !== b) { pulseMat.blending = b; pulseMat.needsUpdate = true; }
  }
  syncPulseLook();

  // ---------------------------------------------------------------- coins (ADR-0652: one instanced lit draw)
  let coins: THREE.InstancedMesh | null = null;
  let coinGeom: THREE.BufferGeometry | null = null;
  let coinFace: THREE.MeshStandardMaterial | null = null;
  let coinEdge: THREE.MeshStandardMaterial | null = null;
  let coinTex: THREE.CanvasTexture | null = null;
  let coinCol: THREE.InstancedBufferAttribute | null = null;
  /** A coin's radius over the packet's sprite size at this tier. */
  const coinK = coinRadius(1, detail) / tokenSize(1);

  /** The coin draw for the current token color and face stamp. Geometry: a short cylinder (axis y) whose rim is
   *  reeded (vertices alternate in and out, flat shaded), its caps mapped by the face texture. */
  function buildCoins(stamp: EdgeTokens["stamp"]): void {
    const cap = tokenCap(B, "coin");
    if (cap <= 0) return;
    const segs = coinSegments(B.coinRidges);
    const cyl = new THREE.CylinderGeometry(1, 1, COIN_THICK, segs, 1, false);
    const p = cyl.getAttribute("position") as THREE.BufferAttribute;
    for (let v = 0; v < p.count; v++) {
      const x = p.getX(v), z = p.getZ(v);
      if (Math.hypot(x, z) < 0.5) continue; // a cap's center
      const k = coinRim(Math.atan2(x, z), B.coinRidges);
      p.setX(v, x * k);
      p.setZ(v, z * k);
    }
    coinGeom = cyl.toNonIndexed();
    cyl.dispose();
    coinGeom.computeVertexNormals();
    const face = hasTokCol ? `#${tokCol.getHexString()}` : COIN_NEUTRAL;
    coinTex = paintTexture(B.tokenTex, (g, s) => paintCoinFace(g, s, face, stamp));
    const emissive = hasTokCol ? tokCol.clone().multiplyScalar(0.16) : new THREE.Color(0, 0, 0);
    // no bumpMap: the emboss is painted (shadow and highlight), and bump mapping normalizes screen-space
    // derivatives that are zero on a sub-pixel coin (a NaN that bloom spreads over the frame)
    coinFace = new THREE.MeshStandardMaterial({ color: 0xffffff, map: coinTex, metalness: 0.85, roughness: 0.32, emissive });
    coinEdge = new THREE.MeshStandardMaterial({ color: face, metalness: 0.9, roughness: 0.4, emissive });
    coins = new THREE.InstancedMesh(coinGeom, [coinEdge, coinFace, coinFace], cap);
    coins.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    coinCol = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage);
    coins.instanceColor = coinCol;
    coins.count = 0;
    coins.frustumCulled = false;
    coins.visible = false;
    coins.renderOrder = 5;
    coins.raycast = () => {};
    parent.add(coins);
  }

  function freeTokenArt(): void {
    if (coins) { parent.remove(coins); coins.dispose(); coins = null; }
    coinGeom?.dispose(); coinGeom = null;
    coinFace?.dispose(); coinFace = null;
    coinEdge?.dispose(); coinEdge = null;
    coinTex?.dispose(); coinTex = null;
    coinCol = null;
    tokTex?.dispose(); tokTex = null;
    tokTexU.value = null;
    tokModeU.value = 0;
  }

  function resetParticles(): void {
    live = 0;
    sparkLive = 0;
    for (const r of slots) if (r) { r.acc = 0; r.tokAcc = 0; r.train = 0; }
  }

  function setTokens(t: EdgeTokens | null): void {
    const prev = token;
    freeTokenArt();
    const next: EdgeToken = t?.token ?? "orb";
    token = next;
    hasTokCol = !!t?.color;
    if (t?.color) tokCol.copy(t.color);
    if (next === "coin") buildCoins(t?.stamp);
    else if (next !== "orb") {
      const paint = next === "custom" ? t?.paint : BUILTIN_SPRITES[next];
      tokTex = paint ? paintTexture(B.tokenTex, paint) : null;
      if (tokTex) { tokTexU.value = tokTex; tokModeU.value = next === "custom" ? 2 : 1; }
      else token = "orb"; // a custom token without a painter, or one whose painter threw: the default dot
    }
    syncCap();
    if (token !== prev) resetParticles();
  }

  /** The stream cap: a plasma style's token decides it (coins are capped); the fiber's streaks keep the budget. */
  function syncCap(): void {
    streamCap = isPlasmaStyle(style) ? tokenCap(B, token) : B.tokens;
  }

  /** A new particle at the edge's source, or -1 when the pool (or, for a stream particle, its share) is full. */
  function spawn(r: Rec, kind: number, size: number, speed: number, alpha: number, stream: boolean): number {
    if (live >= (stream ? sparkLive + streamCap : P)) return -1;
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

  /** ADR-0652: a spark shed by packet `i` (plasma-light from ultra): it starts where the packet is, lags behind
   *  it, drifts outward and fades. */
  function spawnSpark(i: number): void {
    if (sparkLive >= B.sparks || live >= P) return;
    const j = live++;
    sparkLive++;
    pEdge[j] = pEdge[i]!; pU[j] = pU[i]!; pV[j] = pV[i]! * 0.25; pSize[j] = pSize[i]! * 0.6; pKind[j] = KIND_SPARK; pA[j] = 0.95;
    pSpin[j] = pSpin[i]!; pSpinV[j] = pSpinV[i]! * 0.3; pR[j] = pR[i]!; pDR[j] = 0.12 + 0.3 * Math.random(); pE[j] = pE[i]!; pPsi[j] = pPsi[i]!;
  }

  /** Swap-remove particle i (the last live one takes its place). */
  function kill(i: number): void {
    if (pKind[i] === KIND_SPARK) sparkLive--;
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

  /** A conduit material on the edge's shared uniforms. halo: 0 the tube, 1 the plasma's glow shell, 2 the
   *  plasma-light sheath; lite: the plasma-light shading, always normal-blended. */
  function conduitMat(uni: Record<string, THREE.IUniform>, halo: 0 | 1 | 2, lite: boolean): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      defines: { OCTAVES: B.octaves, WARP: B.warp ? 1 : 0, HALO: halo, LITE: lite ? 1 : 0 },
      uniforms: uni,
      vertexShader: CONDUIT_VS, fragmentShader: CONDUIT_FS, transparent: true, depthWrite: false,
      blending: lite ? THREE.NormalBlending : blending,
      side: halo ? THREE.FrontSide : THREE.DoubleSide,
    });
  }

  function applyStyle(r: Rec): void {
    const plasma = style === "plasma", lite = style === "plasma-light";
    if (lite && !r.lite) {
      r.lite = conduitMat(r.uni, 0, true);
      if (B.sheath) {
        r.sheath = new THREE.Mesh(r.geom, conduitMat(r.uni, 2, true));
        r.sheath.frustumCulled = false;
        r.sheath.renderOrder = 3;
        r.sheath.raycast = () => {};
        r.mesh.add(r.sheath);
      }
    }
    r.mesh.material = plasma ? r.plasma : lite && r.lite ? r.lite : hidden;
    r.mesh.renderOrder = plasma || lite ? 4 : 0;
    if (r.halo) r.halo.visible = plasma;
    if (r.sheath) r.sheath.visible = lite;
    r.line.visible = !plasma && !lite;
  }

  const rayO = new Float64Array(3), rayD = new Float64Array(3), segA = new Float64Array(3), segB = new Float64Array(3);
  const rayHit = new Float64Array(2);
  const sampleAt = new Float32Array(3), sampleTan = new Float32Array(3);

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
    // shared by the conduit, its halo shell and (plasma-light) its core and sheath
    const uniforms: Record<string, THREE.IUniform> = {
      uRadius: { value: 0.02 }, uRef: { value: TUBE_REF }, uLen: { value: 1 }, uFlat: flatU, uClosed: { value: closed ? 1 : 0 },
      uI: { value: 0 }, uFlow: { value: 0 }, uDrift: { value: 0 }, uSpin: { value: 0 }, uFlare: { value: 0 }, uFront: { value: 0 },
      uGain: { value: 1 }, uLight: lightU, uColA: { value: new THREE.Color() }, uColB: { value: new THREE.Color() },
    };
    const plasma = conduitMat(uniforms, 0, false);
    const mesh: THREE.Mesh = new THREE.Mesh(geom, plasma);
    mesh.frustumCulled = false;
    // The fiber line draws the center line itself: its position attribute wraps the same samples.
    const centers = new Float32Array(n * 3);
    const lineGeom = new THREE.BufferGeometry();
    const lineAttr = new THREE.BufferAttribute(centers, 3).setUsage(THREE.DynamicDrawUsage);
    lineGeom.setAttribute("position", lineAttr);
    const lineMat = new THREE.LineBasicMaterial({ color: lineBase.clone(), transparent: true, opacity: 0.9, depthWrite: false });
    const line = new THREE.Line(lineGeom, lineMat);
    line.frustumCulled = false;
    line.raycast = () => {};
    mesh.add(line);
    let halo: THREE.Mesh | null = null;
    if (B.halo && !light) {
      halo = new THREE.Mesh(geom, conduitMat(uniforms, 1, false));
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
      plasma, halo, uni: uniforms, lite: null, sheath: null, line, lineGeom, lineAttr, lineMat,
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
        if (isPlasmaStyle(style)) {
          spawn(r, KIND_BURST, 0.34, pulseSpeed("plasma", 1, r.len) * 1.3, 1.6, false);
          for (let k = 0; k < TOKEN_SURGE; k++) spawnToken(r, true);
        } else { r.train = FIBER_TRAIN; r.trainNext = r.surgeAt; }
      },
      sample(u, out) {
        pointAt(r.centers, r.arc, r.n, Math.min(1, Math.max(0, u)) * r.len, r.closed, sampleAt, sampleTan);
        return out.set(sampleAt[0]!, sampleAt[1]!, sampleAt[2]!);
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
      const thr = (rc.params.Line?.threshold ?? 0.12) + (isPlasmaStyle(style) ? r.radius : LINE_PICK_R);
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
    r.lite?.dispose();
    (r.sheath?.material as THREE.Material | undefined)?.dispose();
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
    const lite = style === "plasma-light";
    r.radius = (lite ? liteRadius(r.lvl) : look.radius) * (1 + (moving ? 0.07 * Math.sin(r.breath) : 0)) + flare * 0.025;
    const plasma = isPlasmaStyle(style);
    if (plasma) {
      const u = r.uni;
      u.uRadius!.value = r.radius;
      u.uI!.value = r.lvl;
      u.uFlow!.value = r.flow;
      u.uDrift!.value = r.drift;
      u.uSpin!.value = r.spin;
      u.uFlare!.value = flare;
      u.uFront!.value = flareFront(age);
      u.uGain!.value = r.dead ? 0.35 : light && !lite ? 0.9 : 1;
      const a = u.uColA!.value as THREE.Color, b = u.uColB!.value as THREE.Color;
      if (r.dead) { a.copy(DEAD); b.copy(DEAD); }
      else if (r.frozen) { a.copy(ICE); b.copy(ICE); }
      else { a.copy(r.colA); b.copy(r.colB); }
    } else {
      // the line: neutral, a touch of red while busy, a red flash at a surge; frosty when paused, dim when dead
      const m = r.lineMat;
      if (r.dead) { m.color.copy(LINE_DEAD); m.opacity = 0.45; }
      else {
        m.color.copy(lineBase);
        if (r.frozen) m.color.lerp(ICE, 0.5);
        else m.color.lerp(fiberLight, Math.min(1, 0.12 * r.lvl + 0.85 * flare));
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

  /** A packet's base color: the world's token color, or the edge's two colors at `u`; ice while paused. */
  function packetTint(r: Rec, u: number): THREE.Color {
    if (r.frozen) return tint.copy(ICE);
    if (hasTokCol) return tint.copy(tokCol);
    return tint.copy(r.colA).lerp(r.colB, u);
  }

  /** One camera-facing quad into the pulse buffers at slot w. */
  function writeQuad(w: number, size: number, alpha: number, spin: number, kind: number): void {
    const pos = iPos!.array as Float32Array, tg = iTan!.array as Float32Array, col = iCol!.array as Float32Array, prm = iP!.array as Float32Array;
    pos[w * 3] = at[0]!; pos[w * 3 + 1] = at[1]!; pos[w * 3 + 2] = at[2]!;
    tg[w * 3] = tan[0]!; tg[w * 3 + 1] = tan[1]!; tg[w * 3 + 2] = tan[2]!;
    col[w * 3] = tint.r; col[w * 3 + 1] = tint.g; col[w * 3 + 2] = tint.b;
    prm[w * 4] = size;
    prm[w * 4 + 1] = alpha;
    prm[w * 4 + 2] = spin;
    prm[w * 4 + 3] = kind;
  }

  // a coin's transform (scratch)
  const cM = new THREE.Matrix4(), cQ = new THREE.Quaternion(), cAxis = new THREE.Vector3(), cPos = new THREE.Vector3(), cScale = new THREE.Vector3();

  function updatePulses(dt: number): boolean {
    if (!pulses || !iPos || !iTan || !iCol || !iP || !pulseGeom) return false;
    const squash = flat ? FLAT_SQUASH : 1;
    const lite = style === "plasma-light";
    const coinMesh = token === "coin" ? coins : null;
    const coinCap = coinMesh ? coinMesh.instanceMatrix.count : 0;
    const coinRgb = coinCol ? coinCol.array as Float32Array : null;
    const sparks = lite && B.sparks > 0;
    let busy = false;
    let w = 0, cw = 0, glints = 0;
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
      if (kind === KIND_SPARK && moving) {
        pA[i] = pA[i]! * Math.exp(-dt * SPARK_FADE);
        if (pA[i]! < 0.04) { kill(i); continue; }
      }
      if (moving) {
        pSpin[i] = (pSpin[i]! + pSpinV[i]! * dt) % (Math.PI * 2);
        if (pDR[i]! > 0) { pR[i] = pR[i]! + pDR[i]! * dt; pDR[i] = pDR[i]! * Math.exp(-dt * 2.5); }
        // an idle edge's slow trickle alone does not need the full frame rate
        if (r.lvl > IDLE_I || kind === KIND_BURST || pDR[i]! > 0.05 || r.train > 0) busy = true;
        // ADR-0652: plasma-light packets shed spark trails from ultra (appended: drawn later this frame)
        if (sparks && kind === KIND_TOKEN && Math.random() < sparkRate(r.lvl, detail) * dt) spawnSpark(i);
      }
      pointAt(r.centers, r.arc, r.n, u * r.len, r.closed, at, tan);
      const env = r.closed ? Math.sqrt(Math.sin(Math.PI * u)) : smoothstepJs(0, 0.06, u) * (1 - smoothstepJs(0.9, 1, u));
      if (kind === KIND_TOKEN || kind === KIND_SPARK) {
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
      // never hand the GPU a non-finite instance (bloom would spread one NaN pixel over the frame)
      if (!Number.isFinite(at[0]! + at[1]! + at[2]! + tan[0]! + tan[1]! + tan[2]! + pSize[i]! + pA[i]! + pSpin[i]!)) { kill(i); continue; }
      if (kind === KIND_TOKEN && coinMesh && coinRgb && cw < coinCap) {
        // ADR-0652: a coin, spinning about the path (its face turns to the viewer and away), shrinking into the
        // cube walls at the ends and as a dead edge fades; a glint when its face turns to the light. A coin too
        // small to see is not drawn (a near-singular instance matrix is no use to the lighting).
        const s = pSize[i]! * coinK * env * (r.dead ? Math.min(1, pA[i]! / 0.6) : 1);
        if (s < 1e-3) { i++; continue; }
        const ang = pSpin[i]! * 0.8 + pPsi[i]!;
        const glint = r.frozen ? 0 : coinGlint(ang);
        cAxis.set(tan[0]!, tan[1]!, tan[2]!);
        cQ.setFromAxisAngle(cAxis, ang);
        cPos.set(at[0]!, at[1]!, at[2]!);
        cScale.setScalar(s);
        coinMesh.setMatrixAt(cw, cM.compose(cPos, cQ, cScale));
        if (r.frozen) tint.copy(ICE); else if (hasTokCol) tint.setScalar(1); else packetTint(r, u);
        tint.multiplyScalar(1 + 1.3 * glint);
        coinRgb[cw * 3] = tint.r; coinRgb[cw * 3 + 1] = tint.g; coinRgb[cw * 3 + 2] = tint.b;
        cw++;
        if (glint > 0.05) {
          tint.copy(WHITE);
          writeQuad(w++, s * 1.9, glint * env, 0, KIND_GLINT);
          glints++;
        }
        i++;
        continue;
      }
      if (kind === KIND_STREAK) tint.copy(r.frozen ? ICE : fiberLight).multiplyScalar(light ? 1 : 2.2);
      else if (kind === KIND_TOKEN) {
        packetTint(r, u);
        if (!lite) tint.lerp(WHITE, 0.35).multiplyScalar(light ? 0.85 : 1.8);
      } else if (kind === KIND_SPARK) packetTint(r, u).lerp(WHITE, 0.45);
      else tint.copy(r.frozen ? ICE : r.colA).lerp(r.frozen ? ICE : r.colB, u).lerp(WHITE, 0.3).multiplyScalar(light || lite ? 1 : 1.6);
      writeQuad(w++, pSize[i]!, pA[i]! * env, pSpin[i]!, kind);
      i++;
    }
    pulseGeom.instanceCount = w;
    pulses.visible = w > 0;
    if (w > 0) {
      upload(iPos, w * 3);
      upload(iTan, w * 3);
      upload(iCol, w * 3);
      upload(iP, w * 4);
    }
    if (coinMesh && coinCol) {
      coinMesh.count = cw;
      coinMesh.visible = cw > 0;
      if (cw > 0) { upload(coinMesh.instanceMatrix, cw * 16); upload(coinCol, cw * 3); }
    }
    lastQuads = w; lastCoins = cw; lastGlints = glints;
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
      resetParticles();
      syncPulseLook();
      syncCap();
      for (const r of slots) if (r) applyStyle(r);
    },
    setTokens,
    stats() {
      return {
        style, token, tokenColor: hasTokCol ? `#${tokCol.getHexString()}` : null,
        live, quads: lastQuads, coins: lastCoins, sparks: sparkLive, glints: lastGlints,
        budget: { tokens: streamCap, coins: tokenCap(B, "coin"), sparks: B.sparks, coinRidges: B.coinRidges },
      };
    },
    setPalette(line, glow) {
      lineBase.copy(line ?? (light ? LINE_LIGHT : LINE_DARK));
      fiberLight.copy(glow ?? FIBER_RED);
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
      sparkLive = 0;
      if (pulses) { parent.remove(pulses); pulseGeom?.dispose(); (pulses.material as THREE.Material).dispose(); }
      freeTokenArt();
      hidden.dispose();
      indexCache.clear();
    },
  };
}

function smoothstepJs(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// ------------------------------------------------------------------------------------------ token art (ADR-0652)

type Painter = (g: CanvasRenderingContext2D, size: number) => void;
const TAU = Math.PI * 2;

/** A square canvas texture painted by `paint`; null when there is no 2D canvas or the painter throws (a world's
 *  painter is its own code: a failure falls back to the host's art, it never breaks the scene). */
function paintTexture(size: number, paint: Painter): THREE.CanvasTexture | null {
  const cv = document.createElement("canvas");
  cv.width = size;
  cv.height = size;
  const g = cv.getContext("2d");
  if (!g) return null;
  try { paint(g, size); } catch (e) { console.warn("[viz] a world's token painter failed", e); return null; }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.anisotropy = 4;
  return tex;
}

/** `hex` scaled by `k` (lighter above 1, darker below), as a CSS color. */
function shade(hex: string, k: number): string {
  return `#${SHADE.set(hex).multiplyScalar(k).getHexString()}`;
}
const SHADE = new THREE.Color();

/** A coin's face (both caps): a metal disc lit from the top left, a raised rim, and the world's stamp or a
 *  default embossed star (the relief is painted: a shadow down-right, a highlight up-left). */
function paintCoinFace(g: CanvasRenderingContext2D, s: number, color: string, stamp: Painter | undefined): void {
  const base = (): void => {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, s, s);
    const c = s / 2;
    const grd = g.createRadialGradient(c - s * 0.16, c - s * 0.16, s * 0.04, c, c, s * 0.5);
    grd.addColorStop(0, shade(color, 1.3));
    grd.addColorStop(0.65, color);
    grd.addColorStop(1, shade(color, 0.72));
    g.fillStyle = grd;
    g.fillRect(0, 0, s, s); // the caps map the inscribed circle; the corners are never seen
    g.lineWidth = s * 0.07;
    g.strokeStyle = shade(color, 1.25);
    g.beginPath(); g.arc(c, c, s * 0.43, 0, TAU); g.stroke();
    g.lineWidth = s * 0.02;
    g.strokeStyle = shade(color, 0.6);
    g.beginPath(); g.arc(c, c, s * 0.385, 0, TAU); g.stroke();
  };
  base();
  if (stamp) {
    g.save();
    try { stamp(g, s); g.restore(); return; } catch (e) {
      console.warn("[viz] a world's tokenStamp failed", e);
      g.restore();
      base(); // a half-painted stamp is worse than the default
    }
  }
  // the default emboss: a five-point star, its shadow down-right and its highlight up-left
  const star = (dx: number, dy: number, fill: string): void => {
    g.beginPath();
    for (let k = 0; k < 10; k++) {
      const r = (k % 2 === 0 ? 0.26 : 0.11) * s;
      const a = -Math.PI / 2 + (k * Math.PI) / 5;
      const x = s / 2 + dx + r * Math.cos(a), y = s / 2 + dy + r * Math.sin(a);
      if (k === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.closePath();
    g.fillStyle = fill;
    g.fill();
  };
  const o = s * 0.014;
  star(o, o, shade(color, 0.55));
  star(-o, -o, shade(color, 1.45));
  star(0, 0, shade(color, 1.08));
}

/** The built-in sprite tokens, painted white (the shader tints them by the packet color) with a soft gray
 *  outline so they hold on a light sky. */
const BUILTIN_SPRITES: Readonly<Record<"petal" | "snowflake" | "spark", Painter>> = {
  petal(g, s) {
    g.translate(s / 2, s / 2);
    g.beginPath();
    g.moveTo(0, -s * 0.44);
    g.bezierCurveTo(s * 0.3, -s * 0.2, s * 0.26, s * 0.3, 0, s * 0.44);
    g.bezierCurveTo(-s * 0.26, s * 0.3, -s * 0.3, -s * 0.2, 0, -s * 0.44);
    const grd = g.createLinearGradient(0, -s * 0.44, 0, s * 0.44);
    grd.addColorStop(0, "#ffffff");
    grd.addColorStop(1, "#d6d6d6");
    g.fillStyle = grd;
    g.fill();
    g.lineWidth = s * 0.035;
    g.strokeStyle = "rgba(70,70,70,0.55)";
    g.stroke();
    g.beginPath();
    g.moveTo(0, -s * 0.3);
    g.quadraticCurveTo(s * 0.04, 0, 0, s * 0.34);
    g.lineWidth = s * 0.02;
    g.strokeStyle = "rgba(120,120,120,0.5)";
    g.stroke();
  },
  snowflake(g, s) {
    g.translate(s / 2, s / 2);
    g.lineCap = "round";
    const arms = (width: number, color: string): void => {
      g.lineWidth = width;
      g.strokeStyle = color;
      for (let k = 0; k < 6; k++) {
        g.save();
        g.rotate((k * Math.PI) / 3);
        g.beginPath();
        g.moveTo(0, 0); g.lineTo(0, -s * 0.42);
        g.moveTo(0, -s * 0.2); g.lineTo(s * 0.1, -s * 0.3);
        g.moveTo(0, -s * 0.2); g.lineTo(-s * 0.1, -s * 0.3);
        g.moveTo(0, -s * 0.31); g.lineTo(s * 0.07, -s * 0.38);
        g.moveTo(0, -s * 0.31); g.lineTo(-s * 0.07, -s * 0.38);
        g.stroke();
        g.restore();
      }
    };
    arms(s * 0.09, "rgba(70,80,95,0.5)");
    arms(s * 0.05, "#ffffff");
  },
  spark(g, s) {
    g.translate(s / 2, s / 2);
    g.beginPath();
    for (let k = 0; k < 8; k++) {
      const r = (k % 2 === 0 ? 0.46 : 0.1) * s;
      const a = -Math.PI / 2 + (k * Math.PI) / 4;
      if (k === 0) g.moveTo(r * Math.cos(a), r * Math.sin(a)); else g.lineTo(r * Math.cos(a), r * Math.sin(a));
    }
    g.closePath();
    const grd = g.createRadialGradient(0, 0, 0, 0, 0, s * 0.46);
    grd.addColorStop(0, "#ffffff");
    grd.addColorStop(1, "#e0e0e0");
    g.fillStyle = grd;
    g.fill();
    g.lineWidth = s * 0.025;
    g.strokeStyle = "rgba(70,70,70,0.5)";
    g.stroke();
  },
};
