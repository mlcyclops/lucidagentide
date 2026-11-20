// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_plasma_math.ts - P-VIZ.4 (ADR-0626): the pure math behind the Visualize edges
// (viz_plasma.ts draws them). How a conduit looks at a given est. tok/s intensity, how often and how fast its
// pulses travel, the per-tier budgets, and the allocation-free geometry: sampling an edge's path, the tube
// (or the flat 2D ribbon) around it, walking it by arc length, and the ray distance used for picking.
//
// Intensity is the edge's 0..1 value from viz_model.nodeIntensity (est. tok/s on a log scale), so every curve
// here is continuous in it: no thresholds that make a conduit jump when a stream speeds up.

/** The edge styles: an anime plasma conduit, or a professional silver fiber-optic cable with red light pulses. */
export type EdgeStyle = "plasma" | "fiber";

/** The scene style (viz_model.VizStyle) picks the edge style. */
export function edgeStyleFor(style: "anime" | "professional"): EdgeStyle {
  return style === "professional" ? "fiber" : "plasma";
}

// ------------------------------------------------------------------------------------ budgets

export type EdgeDetail = "full" | "reduced" | "minimal";

export interface EdgeBudget {
  /** Rings along an open edge (samples of its curve). */
  rings: number;
  /** Rings around the hub's closed loop. */
  loopRings: number;
  /** Vertices around the tube. */
  radial: number;
  /** Noise octaves in the plasma shader (a compile-time define). */
  octaves: number;
  /** Domain-warped noise (two extra fbm lookups) in the plasma shader. */
  warp: boolean;
  /** A soft outer glow shell around each plasma conduit (one extra draw per edge). */
  halo: boolean;
  /** Pulses alive at once across every edge (one instanced draw). */
  pulses: number;
}

/** The tier's edge budget. `particles` is the tier's flow budget (viz_model.VizTierOpts.particles): the pulses
 *  are its successor and take one fortieth of it; reduced motion (no motion) has no pulses at all. */
export function edgeBudget(detail: EdgeDetail, particles: number, motion: boolean): EdgeBudget {
  const pulses = motion ? Math.max(0, Math.round(particles / 40)) : 0;
  if (detail === "full") return { rings: 64, loopRings: 72, radial: 12, octaves: 4, warp: true, halo: true, pulses };
  if (detail === "reduced") return { rings: 40, loopRings: 48, radial: 8, octaves: 2, warp: true, halo: false, pulses };
  return { rings: 24, loopRings: 32, radial: 6, octaves: 1, warp: false, halo: false, pulses };
}

// ------------------------------------------------------------------------------------ looks

/** The fiber cable's radius (world units); the geometry is written at this radius, the plasma shader rescales. */
export const FIBER_R = 0.045;
/** In 2D the tube is squashed to a flat ribbon (its vertical half-axis over its horizontal one). */
export const FLAT_SQUASH = 0.22;

export interface PlasmaLook {
  /** Conduit radius (world units). */
  radius: number;
  /** Helix spin (radians per second). */
  spin: number;
  /** Noise flow along the conduit (world units per second). */
  flow: number;
  /** Breathing rate of the radius (radians per second). */
  breath: number;
}

/** The plasma conduit at intensity `i`: calm and slim at idle (a slow drift and a lazy spin), thicker and
 *  spinning hard at a burst. Writes into `out` (no allocation per frame). */
export function plasmaLook(i: number, out: PlasmaLook): PlasmaLook {
  const k = clamp01(i);
  out.radius = 0.05 + 0.11 * k;
  out.spin = 0.4 + 11 * Math.pow(k, 1.3);
  out.flow = 0.18 + 3.4 * k;
  out.breath = 0.9 + 6 * k;
  return out;
}

/** The faint red flicker an idle fiber shows now and then (pulses per second). */
export const FIBER_IDLE_RATE = 0.12;
/** A fiber surge: a train of this many red pulses, this far apart (ms). */
export const FIBER_TRAIN = 8;
export const FIBER_TRAIN_MS = 45;
/** Below this intensity an edge counts as idle. */
export const IDLE_I = 0.02;

/** Pulses per second leaving one edge's source. Plasma: none at idle (the conduit only drifts), a few orbs a
 *  second at a burst. Fiber: an occasional faint flicker at idle, a rapid stream at a burst. */
export function pulseRate(style: EdgeStyle, i: number): number {
  const k = clamp01(i);
  if (style === "plasma") return k < IDLE_I ? 0 : 0.3 + 4.2 * k * k;
  return k < IDLE_I ? FIBER_IDLE_RATE : 1.5 + 22 * k * k;
}

/** A pulse's speed in path fractions per second. Plasma orbs glide (about 2.4 s at a trickle down to 0.8 s at
 *  a burst on a 6 unit edge); fiber light is fast (7 to 21 world units per second). */
export function pulseSpeed(style: EdgeStyle, i: number, len: number): number {
  const k = clamp01(i);
  const L = Math.max(0.1, len);
  if (style === "plasma") return 1 / ((2.4 - 1.6 * k) * Math.min(1.6, Math.max(0.6, L / 6)));
  return Math.min(1 / 0.18, (7 + 14 * k) / L);
}

/** A pulse's billboard half-size (world units). */
export function pulseSize(style: EdgeStyle, i: number): number {
  const k = clamp01(i);
  return style === "plasma" ? 0.13 + 0.2 * k : 0.07 + 0.05 * k;
}

/** The surge flare along a whole conduit: 1 at the surge, decaying over about a second; 0 before it. */
export const FLARE_MS = 1100;
export function flareLevel(ageMs: number): number {
  if (ageMs < 0 || ageMs >= FLARE_MS) return 0;
  const u = ageMs / FLARE_MS;
  return Math.exp(-u * 3.2) * (1 - u);
}
/** Where the flare's bright wave front is along the path (0 source .. 1 target): it crosses in 0.45 s. */
export function flareFront(ageMs: number): number {
  return clamp01(ageMs / 450);
}

/** Exponential smoothing factor for time constant `tau` seconds over `dt` seconds. */
export function smoothK(dt: number, tau: number): number {
  return tau <= 0 ? 1 : 1 - Math.exp(-dt / tau);
}

// ------------------------------------------------------------------------------------ paths

/** `n` samples (t = i / (n - 1)) of the quadratic bezier p = [p0x,p0y,p0z, p1x,.., p2x,..] into `out` (n * 3). */
export function sampleQuadratic(p: ArrayLike<number>, n: number, out: Float32Array): void {
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? i / (n - 1) : 0, u = 1 - t;
    const a = u * u, b = 2 * u * t, c = t * t;
    out[i * 3] = a * p[0]! + b * p[3]! + c * p[6]!;
    out[i * 3 + 1] = a * p[1]! + b * p[4]! + c * p[7]!;
    out[i * 3 + 2] = a * p[2]! + b * p[5]! + c * p[8]!;
  }
}

/** `n` samples of a horizontal circle (center, radius); the last sample closes the loop onto the first. */
export function sampleCircle(cx: number, cy: number, cz: number, r: number, n: number, out: Float32Array): void {
  for (let i = 0; i < n; i++) {
    const a = n > 1 ? (i / (n - 1)) * Math.PI * 2 : 0;
    out[i * 3] = cx + Math.cos(a) * r;
    out[i * 3 + 1] = cy;
    out[i * 3 + 2] = cz + Math.sin(a) * r;
  }
  if (n > 1) { out[(n - 1) * 3] = out[0]!; out[(n - 1) * 3 + 1] = out[1]!; out[(n - 1) * 3 + 2] = out[2]!; }
}

/** Cumulative arc length at each sample into `arc` (n); returns the total length. */
export function arcLengths(c: Float32Array, n: number, arc: Float32Array): number {
  let s = 0;
  arc[0] = 0;
  for (let i = 1; i < n; i++) {
    const dx = c[i * 3]! - c[(i - 1) * 3]!, dy = c[i * 3 + 1]! - c[(i - 1) * 3 + 1]!, dz = c[i * 3 + 2]! - c[(i - 1) * 3 + 2]!;
    s += Math.sqrt(dx * dx + dy * dy + dz * dz);
    arc[i] = s;
  }
  return s;
}

/** The point and unit tangent at arc length `s` along the sampled path (clamped, or wrapped when `closed`). */
export function pointAt(c: Float32Array, arc: Float32Array, n: number, s: number, closed: boolean, pos: Float32Array, tan: Float32Array): void {
  const total = arc[n - 1]!;
  if (n < 2 || total <= 0) {
    pos[0] = c[0]!; pos[1] = c[1]!; pos[2] = c[2]!;
    tan[0] = 1; tan[1] = 0; tan[2] = 0;
    return;
  }
  const x = closed ? ((s % total) + total) % total : Math.min(total, Math.max(0, s));
  // binary search the segment [lo, lo + 1] holding x
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (arc[mid]! <= x) lo = mid; else hi = mid;
  }
  const seg = arc[hi]! - arc[lo]!;
  const f = seg > 0 ? (x - arc[lo]!) / seg : 0;
  const ax = c[lo * 3]!, ay = c[lo * 3 + 1]!, az = c[lo * 3 + 2]!;
  const dx = c[hi * 3]! - ax, dy = c[hi * 3 + 1]! - ay, dz = c[hi * 3 + 2]! - az;
  pos[0] = ax + dx * f; pos[1] = ay + dy * f; pos[2] = az + dz * f;
  const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (l > 1e-9) { tan[0] = dx / l; tan[1] = dy / l; tan[2] = dz / l; } else { tan[0] = 1; tan[1] = 0; tan[2] = 0; }
}

// ------------------------------------------------------------------------------------ the tube

export interface TubeOut {
  /** Surface positions at FIBER_R (n * (radial + 1) * 3). */
  pos: Float32Array;
  /** Lighting normals (the squashed ellipse's true normals). */
  nrm: Float32Array;
  /** The unnormalized offset from the center line per unit radius (the plasma shader rescales along it). */
  dir: Float32Array;
  /** u = arc length (world units), v = around (0..1). */
  uv: Float32Array;
}

/** Vertices for a tube of `radial` sides around the sampled center line `c` (n rings, a duplicated seam
 *  vertex per ring for the v wrap). The frame keeps one axis horizontal (side = tangent x up), so `squash`
 *  flattens the tube vertically into a ribbon that reads from the top-down 2D camera. A vertical tangent
 *  (no horizontal side) keeps the previous ring's side, or `fallback` for the first ring. */
export function writeTube(
  c: Float32Array, arc: Float32Array, n: number, radial: number, refR: number, squash: number, closed: boolean,
  fallback: ArrayLike<number>, out: TubeOut,
): void {
  let sx = fallback[0]!, sy = fallback[1]!, sz = fallback[2]!;
  const fl = Math.hypot(sx, sy, sz) || 1;
  sx /= fl; sy /= fl; sz /= fl;
  const R1 = radial + 1;
  for (let i = 0; i < n; i++) {
    // tangent by central difference (wrapping on a closed loop, one-sided at open ends)
    const ip = i > 0 ? i - 1 : closed ? n - 2 : 0;
    const iq = i < n - 1 ? i + 1 : closed ? 1 : n - 1;
    let tx = c[iq * 3]! - c[ip * 3]!, ty = c[iq * 3 + 1]! - c[ip * 3 + 1]!, tz = c[iq * 3 + 2]! - c[ip * 3 + 2]!;
    const tl = Math.hypot(tx, ty, tz);
    if (tl > 1e-9) { tx /= tl; ty /= tl; tz /= tl; } else { tx = 1; ty = 0; tz = 0; }
    // side = T x up = (-tz, 0, tx), horizontal and perpendicular to T
    const hl = Math.hypot(tz, tx);
    if (hl > 1e-3) { sx = -tz / hl; sy = 0; sz = tx / hl; }
    else { // keep the previous side, made perpendicular to T
      const d = sx * tx + sy * ty + sz * tz;
      sx -= d * tx; sy -= d * ty; sz -= d * tz;
      const l = Math.hypot(sx, sy, sz) || 1;
      sx /= l; sy /= l; sz /= l;
    }
    // B = T x side
    const bx = ty * sz - tz * sy, by = tz * sx - tx * sz, bz = tx * sy - ty * sx;
    const cx = c[i * 3]!, cy = c[i * 3 + 1]!, cz = c[i * 3 + 2]!;
    for (let j = 0; j <= radial; j++) {
      const th = (j / radial) * Math.PI * 2;
      const co = Math.cos(th), si = Math.sin(th);
      const k = (i * R1 + j) * 3;
      const dx = sx * co + bx * si * squash, dy = sy * co + by * si * squash, dz = sz * co + bz * si * squash;
      out.dir[k] = dx; out.dir[k + 1] = dy; out.dir[k + 2] = dz;
      out.pos[k] = cx + dx * refR; out.pos[k + 1] = cy + dy * refR; out.pos[k + 2] = cz + dz * refR;
      // the ellipse's normal is (b cos, a sin) in the (side, B) frame, a = 1 and b = squash
      let nx = sx * co * squash + bx * si, ny = sy * co * squash + by * si, nz = sz * co * squash + bz * si;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      out.nrm[k] = nx; out.nrm[k + 1] = ny; out.nrm[k + 2] = nz;
      const q = (i * R1 + j) * 2;
      out.uv[q] = arc[i]!;
      out.uv[q + 1] = j / radial;
    }
  }
}

/** Triangle indices for writeTube's layout, wound so the faces point outward. */
export function tubeIndex(n: number, radial: number): Uint16Array {
  const R1 = radial + 1;
  const idx = new Uint16Array((n - 1) * radial * 6);
  let k = 0;
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * R1 + j, b = (i + 1) * R1 + j, cc = b + 1, d = a + 1;
      idx[k++] = a; idx[k++] = d; idx[k++] = b;
      idx[k++] = b; idx[k++] = d; idx[k++] = cc;
    }
  }
  return idx;
}

// ------------------------------------------------------------------------------------ picking

/** The squared distance between the ray (origin o, unit direction d, t >= 0) and the segment a..b, and the
 *  ray parameter of the closest point, written to out[0] (dist2) and out[1] (t). */
export function raySegment(o: ArrayLike<number>, d: ArrayLike<number>, a: ArrayLike<number>, b: ArrayLike<number>, out: Float64Array): void {
  const ux = b[0]! - a[0]!, uy = b[1]! - a[1]!, uz = b[2]! - a[2]!;
  const wx = o[0]! - a[0]!, wy = o[1]! - a[1]!, wz = o[2]! - a[2]!;
  const A = ux * ux + uy * uy + uz * uz;
  const B = ux * d[0]! + uy * d[1]! + uz * d[2]!;
  const D = wx * d[0]! + wy * d[1]! + wz * d[2]!;
  const E = wx * ux + wy * uy + wz * uz;
  // minimize |o + t d - (a + s u)|^2 over t >= 0, s in [0, 1] (|d| = 1)
  const den = A - B * B;
  let s = den > 1e-12 ? (E - B * D) / den : 0;
  s = Math.min(1, Math.max(0, s));
  let t = s * B - D;
  if (t < 0) { t = 0; s = A > 1e-12 ? Math.min(1, Math.max(0, E / A)) : 0; }
  const px = o[0]! + t * d[0]! - (a[0]! + s * ux);
  const py = o[1]! + t * d[1]! - (a[1]! + s * uy);
  const pz = o[2]! + t * d[2]! - (a[2]! + s * uz);
  out[0] = px * px + py * py + pz * pz;
  out[1] = t;
}

function clamp01(x: number): number { return x < 0 ? 0 : x > 1 ? 1 : x; }
