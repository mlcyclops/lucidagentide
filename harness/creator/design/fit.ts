// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

/*
Portions ported from fit-curve (https://github.com/soswow/fit-curve, src/fit-curve.js), MIT License:

The MIT License (MIT)

Copyright (c) 2014 Volker Poplawski

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

fit-curve implements: Philip J. Schneider, "An Algorithm for Automatically Fitting Digitized Curves",
Graphics Gems, Academic Press, 1990 (Graphics Gems code license:
https://github.com/erich666/GraphicsGems/blob/master/LICENSE.md: "Using the code is permitted in any
program, product, or library, non-commercial or commercial.").
*/

// harness/creator/design/fit.ts - least-squares cubic bezier fitting of a polyline (Schneider 1990).
//
// Changes from upstream: typed TS on flat Float64Array coordinates instead of [x, y] arrays; fitCubic's
// divide-and-conquer recursion runs on an explicit work stack (left half first, so output order is
// unchanged) so hostile input cannot overflow the call stack; input is capped and validated; the split
// point is kept strictly inside the range so every split makes progress; degenerate curves (zero arc
// length) keep the chord parameter instead of producing NaN.

import type { PathCmd } from "./types.ts";

/** Input cap: fitting is O(n log n) per pass, beyond this the caller should decimate first. */
export const FIT_MAX_POINTS = 100_000;

/** Upstream MaxIterations: reparameterize attempts before splitting. */
const MAX_ITERATIONS = 20;
/** Upstream B_parts: samples used to map relative arc length to t in computeMaxError. */
const B_PARTS = 10;

/** A cubic as 8 numbers: p0x p0y c1x c1y c2x c2y p3x p3y. */
type Bez = Float64Array;

/** Evaluate the cubic at t (upstream bezier.q); writes into out[0], out[1]. */
function bezQ(b: Bez, t: number, out: Float64Array): void {
  const tx = 1 - t;
  const a = tx * tx * tx, bb = 3 * tx * tx * t, c = 3 * tx * t * t, d = t * t * t;
  out[0] = a * b[0]! + bb * b[2]! + c * b[4]! + d * b[6]!;
  out[1] = a * b[1]! + bb * b[3]! + c * b[5]! + d * b[7]!;
}

/** First derivative (upstream bezier.qprime). */
function bezQPrime(b: Bez, t: number, out: Float64Array): void {
  const tx = 1 - t;
  const a = 3 * tx * tx, bb = 6 * tx * t, c = 3 * t * t;
  out[0] = a * (b[2]! - b[0]!) + bb * (b[4]! - b[2]!) + c * (b[6]! - b[4]!);
  out[1] = a * (b[3]! - b[1]!) + bb * (b[5]! - b[3]!) + c * (b[7]! - b[5]!);
}

/** Second derivative (upstream bezier.qprimeprime). */
function bezQPrimePrime(b: Bez, t: number, out: Float64Array): void {
  const a = 6 * (1 - t), c = 6 * t;
  out[0] = a * (b[4]! - 2 * b[2]! + b[0]!) + c * (b[6]! - 2 * b[4]! + b[2]!);
  out[1] = a * (b[5]! - 2 * b[3]! + b[1]!) + c * (b[7]! - 2 * b[5]! + b[3]!);
}

/** Shared state for one fit: flat coordinates and scratch vectors. */
interface FitCtx { xs: Float64Array; ys: Float64Array; s0: Float64Array; s1: Float64Array; s2: Float64Array }

/** Upstream chordLengthParameterize over points [start..end]. */
function chordLengthParameterize(ctx: FitCtx, start: number, end: number): Float64Array {
  const len = end - start + 1;
  const u = new Float64Array(len);
  for (let i = 1; i < len; i++) {
    const p = start + i;
    u[i] = u[i - 1]! + Math.hypot(ctx.xs[p]! - ctx.xs[p - 1]!, ctx.ys[p]! - ctx.ys[p - 1]!);
  }
  const total = u[len - 1]!;
  if (total > 0) for (let i = 0; i < len; i++) u[i] = u[i]! / total;
  return u;
}

/** Upstream generateBezier: least-squares alpha values along the end tangents. */
function generateBezier(
  ctx: FitCtx, start: number, end: number, params: Float64Array,
  ltx: number, lty: number, rtx: number, rty: number,
): Bez {
  const fx = ctx.xs[start]!, fy = ctx.ys[start]!, lx = ctx.xs[end]!, ly = ctx.ys[end]!;
  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
  for (let i = 0; i < params.length; i++) {
    const u = params[i]!;
    const ux = 1 - u;
    const b1 = 3 * u * ux * ux;
    const b2 = 3 * ux * u * u;
    // A[i][0] = leftTangent * b1, A[i][1] = rightTangent * b2
    const a0x = ltx * b1, a0y = lty * b1, a1x = rtx * b2, a1y = rty * b2;
    c00 += a0x * a0x + a0y * a0y;
    c01 += a0x * a1x + a0y * a1y;
    c11 += a1x * a1x + a1y * a1y;
    // tmp = point - q([first, first, last, last], u)
    const h0 = ux * ux * ux + 3 * ux * ux * u;
    const h1 = 3 * ux * u * u + u * u * u;
    const tx = ctx.xs[start + i]! - (h0 * fx + h1 * lx);
    const ty = ctx.ys[start + i]! - (h0 * fy + h1 * ly);
    x0 += a0x * tx + a0y * ty;
    x1 += a1x * tx + a1y * ty;
  }
  const c10 = c01;
  const detC0C1 = c00 * c11 - c10 * c01;
  const detC0X = c00 * x1 - c10 * x0;
  const detXC1 = x0 * c11 - x1 * c01;
  const alphaL = detC0C1 === 0 ? 0 : detXC1 / detC0C1;
  const alphaR = detC0C1 === 0 ? 0 : detC0X / detC0C1;
  const segLength = Math.hypot(fx - lx, fy - ly);
  const epsilon = 1.0e-6 * segLength;
  const bez: Bez = new Float64Array(8);
  bez[0] = fx; bez[1] = fy; bez[6] = lx; bez[7] = ly;
  if (alphaL < epsilon || alphaR < epsilon || !Number.isFinite(alphaL) || !Number.isFinite(alphaR)) {
    // Wu/Barsky heuristic: fall back on a third of the chord, subdivide further if needed
    bez[2] = fx + ltx * (segLength / 3); bez[3] = fy + lty * (segLength / 3);
    bez[4] = lx + rtx * (segLength / 3); bez[5] = ly + rty * (segLength / 3);
  } else {
    bez[2] = fx + ltx * alphaL; bez[3] = fy + lty * alphaL;
    bez[4] = lx + rtx * alphaR; bez[5] = ly + rty * alphaR;
  }
  return bez;
}

/** Upstream newtonRaphsonRootFind, applied to every parameter (upstream reparameterize). */
function reparameterize(ctx: FitCtx, bez: Bez, start: number, params: Float64Array): Float64Array {
  const out = new Float64Array(params.length);
  for (let i = 0; i < params.length; i++) {
    const u = params[i]!;
    bezQ(bez, u, ctx.s0);
    bezQPrime(bez, u, ctx.s1);
    bezQPrimePrime(bez, u, ctx.s2);
    const dx = ctx.s0[0]! - ctx.xs[start + i]!, dy = ctx.s0[1]! - ctx.ys[start + i]!;
    const qpx = ctx.s1[0]!, qpy = ctx.s1[1]!;
    const numerator = dx * qpx + dy * qpy;
    const denominator = qpx * qpx + qpy * qpy + 2 * (dx * ctx.s2[0]! + dy * ctx.s2[1]!);
    const next = denominator === 0 ? u : u - numerator / denominator;
    out[i] = Number.isFinite(next) ? next : u;
  }
  return out;
}

/** Upstream mapTtoRelativeDistances: cumulative sampled arc length, normalized to 0..1. */
function mapTtoRelativeDistances(ctx: FitCtx, bez: Bez, out: Float64Array): void {
  let px = bez[0]!, py = bez[1]!, sum = 0;
  out[0] = 0;
  for (let i = 1; i <= B_PARTS; i++) {
    bezQ(bez, i / B_PARTS, ctx.s0);
    sum += Math.hypot(ctx.s0[0]! - px, ctx.s0[1]! - py);
    out[i] = sum;
    px = ctx.s0[0]!; py = ctx.s0[1]!;
  }
  for (let i = 0; i <= B_PARTS; i++) out[i] = sum > 0 ? out[i]! / sum : i / B_PARTS;
}

/** Upstream find_t: t on the curve at the same relative arc length as `param` on the polyline. */
function findT(param: number, distMap: Float64Array): number {
  if (param < 0) return 0;
  if (param > 1) return 1;
  for (let i = 1; i <= B_PARTS; i++) {
    const lenMax = distMap[i]!;
    if (param <= lenMax) {
      const tMin = (i - 1) / B_PARTS;
      const tMax = i / B_PARTS;
      const lenMin = distMap[i - 1]!;
      const span = lenMax - lenMin;
      return span > 0 ? ((param - lenMin) / span) * (tMax - tMin) + tMin : tMin;
    }
  }
  return 1;
}

/** Upstream computeMaxError: max squared distance and the index (relative to start) where it occurs. */
function computeMaxError(
  ctx: FitCtx, bez: Bez, start: number, params: Float64Array, distMap: Float64Array,
): { maxDist: number; split: number } {
  let maxDist = 0;
  let split = Math.floor(params.length / 2);
  mapTtoRelativeDistances(ctx, bez, distMap);
  for (let i = 0; i < params.length; i++) {
    const t = findT(params[i]!, distMap);
    bezQ(bez, t, ctx.s0);
    const vx = ctx.s0[0]! - ctx.xs[start + i]!, vy = ctx.s0[1]! - ctx.ys[start + i]!;
    const dist = vx * vx + vy * vy;
    if (dist > maxDist) { maxDist = dist; split = i; }
  }
  return { maxDist, split };
}

interface FitTask { start: number; end: number; ltx: number; lty: number; rtx: number; rty: number }

function normalizeInto(x: number, y: number, out: Float64Array): void {
  const l = Math.hypot(x, y);
  out[0] = l > 0 ? x / l : 0;
  out[1] = l > 0 ? y / l : 0;
}

/** Points may be {x, y} objects or [x, y] tuples; every coordinate must be finite. */
function readPoints(points: readonly ({ x: number; y: number } | readonly [number, number])[]): { xs: Float64Array; ys: Float64Array; n: number } {
  if (!Array.isArray(points)) throw new TypeError("fitBezier: points must be an array");
  if (points.length > FIT_MAX_POINTS) throw new Error(`fitBezier: more than ${FIT_MAX_POINTS} points`);
  const xs = new Float64Array(points.length);
  const ys = new Float64Array(points.length);
  let n = 0;
  for (const p of points) {
    let x: unknown, y: unknown;
    if (Array.isArray(p)) { x = p[0]; y = p[1]; }
    else if (p !== null && typeof p === "object" && "x" in p && "y" in p) { x = p.x; y = p.y; }
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) {
      throw new TypeError("fitBezier: every point needs finite x and y");
    }
    // upstream: remove consecutive duplicate points
    if (n > 0 && xs[n - 1] === x && ys[n - 1] === y) continue;
    xs[n] = x; ys[n] = y; n++;
  }
  return { xs, ys, n };
}

/**
 * Fit one or more cubic beziers to digitized points (upstream fitCurve). `maxError` is the squared
 * distance tolerance. Returns [M, C, C, ...], or [] for fewer than 2 distinct points.
 */
export function fitBezier(points: { x: number; y: number }[] | [number, number][], maxError: number): PathCmd[] {
  const { xs, ys, n } = readPoints(points);
  if (n < 2) return [];
  const error = Number.isFinite(maxError) && maxError > 0 ? maxError : 0;
  const ctx: FitCtx = { xs, ys, s0: new Float64Array(2), s1: new Float64Array(2), s2: new Float64Array(2) };
  const distMap = new Float64Array(B_PARTS + 1);
  const tan = new Float64Array(2);
  const out: PathCmd[] = [{ c: "M", x: xs[0]!, y: ys[0]! }];
  const emit = (b: Bez): void => {
    out.push({ c: "C", x1: b[2]!, y1: b[3]!, x2: b[4]!, y2: b[5]!, x: b[6]!, y: b[7]! });
  };

  normalizeInto(xs[1]! - xs[0]!, ys[1]! - ys[0]!, tan);
  const ltx = tan[0]!, lty = tan[1]!;
  normalizeInto(xs[n - 2]! - xs[n - 1]!, ys[n - 2]! - ys[n - 1]!, tan);
  const stack: FitTask[] = [{ start: 0, end: n - 1, ltx, lty, rtx: tan[0]!, rty: tan[1]! }];

  // Upstream fitCubic, with the two recursive calls replaced by pushes (right half first so the left
  // half is fitted and emitted first, preserving upstream output order).
  while (stack.length > 0) {
    const task = stack.pop()!;
    const { start, end } = task;
    const len = end - start + 1;

    // Use heuristic if region only has two points in it
    if (len === 2) {
      const dist = Math.hypot(xs[start]! - xs[end]!, ys[start]! - ys[end]!) / 3;
      const bez: Bez = new Float64Array(8);
      bez[0] = xs[start]!; bez[1] = ys[start]!;
      bez[2] = xs[start]! + task.ltx * dist; bez[3] = ys[start]! + task.lty * dist;
      bez[4] = xs[end]! + task.rtx * dist; bez[5] = ys[end]! + task.rty * dist;
      bez[6] = xs[end]!; bez[7] = ys[end]!;
      emit(bez);
      continue;
    }

    // Parameterize points, and attempt to fit curve
    const u = chordLengthParameterize(ctx, start, end);
    let bez = generateBezier(ctx, start, end, u, task.ltx, task.lty, task.rtx, task.rty);
    let { maxDist, split } = computeMaxError(ctx, bez, start, u, distMap);
    if (maxDist === 0 || maxDist < error) { emit(bez); continue; }

    // If error not too large, try some reparameterization and iteration
    let done = false;
    if (maxDist < error * error) {
      let uPrime = u;
      let prevErr = maxDist;
      let prevSplit = split;
      for (let i = 0; i < MAX_ITERATIONS; i++) {
        uPrime = reparameterize(ctx, bez, start, uPrime);
        bez = generateBezier(ctx, start, end, uPrime, task.ltx, task.lty, task.rtx, task.rty);
        // always measure against the original chord parameters (upstream generateAndReport)
        ({ maxDist, split } = computeMaxError(ctx, bez, start, u, distMap));
        if (maxDist < error) { done = true; break; }
        if (split === prevSplit) {
          // the fit grinds to a halt: abort this attempt and try a shorter curve
          const errChange = maxDist / prevErr;
          if (errChange > 0.9999 && errChange < 1.0001) break;
        }
        prevErr = maxDist;
        prevSplit = split;
      }
    }
    if (done) { emit(bez); continue; }

    // Fitting failed: split at the max error point. Kept strictly inside so both halves shrink.
    if (split < 1) split = 1;
    if (split > len - 2) split = len - 2;
    const sp = start + split;
    // Tangent at the split: line between the neighbours, or the perpendicular of the incoming segment
    // when the neighbours coincide.
    let cvx = xs[sp - 1]! - xs[sp + 1]!;
    let cvy = ys[sp - 1]! - ys[sp + 1]!;
    if (cvx === 0 && cvy === 0) {
      const ix = xs[sp - 1]! - xs[sp]!, iy = ys[sp - 1]! - ys[sp]!;
      cvx = -iy; cvy = ix;
    }
    normalizeInto(cvx, cvy, tan);
    const toX = tan[0]!, toY = tan[1]!;
    stack.push({ start: sp, end, ltx: -toX, lty: -toY, rtx: task.rtx, rty: task.rty });
    stack.push({ start, end: sp, ltx: task.ltx, lty: task.lty, rtx: toX, rty: toY });
  }
  return out;
}
