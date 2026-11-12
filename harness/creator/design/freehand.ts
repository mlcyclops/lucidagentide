// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

/*
Portions ported from perfect-freehand (https://github.com/steveruizok/perfect-freehand,
packages/perfect-freehand/src: getStroke.ts, getStrokePoints.ts, getStrokeOutlinePoints.ts,
getStrokeRadius.ts, simulatePressure.ts, vec.ts, constants.ts, types.ts), MIT License:

MIT License

Copyright (c) 2021 Stephen Ruiz Ltd

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
*/

// harness/creator/design/freehand.ts - pressure-sensitive freehand stroke outlines (perfect-freehand).
//
// The upstream modules are merged into this one file with the algorithm unchanged. Our changes: input is
// capped at DESIGN_MAX_POINTS_PER_STROKE and every coordinate must be finite (throws otherwise), each
// point is normalized individually (upstream decides array-vs-object from the first point only), the
// start cap is skipped when no right-side point exists (upstream would emit NaN there), and the native
// strokeToPath turns the outline into PathCmd[] like the upstream README's getSvgPathFromStroke.

import { DESIGN_LIMITS, DESIGN_MAX_POINTS_PER_STROKE } from "./limits.ts";
import type { PathCmd } from "./types.ts";

// ---------------------------------------------------------------------------------------- types.ts

/** A 2D vector represented as a fixed-length tuple [x, y]. */
export type Vec2 = [number, number];

/** The options object for `getStroke` or `getStrokePoints` (upstream shape). */
export interface StrokeOptions {
  size?: number;
  thinning?: number;
  smoothing?: number;
  streamline?: number;
  easing?: (pressure: number) => number;
  simulatePressure?: boolean;
  start?: { cap?: boolean; taper?: number | boolean; easing?: (distance: number) => number };
  end?: { cap?: boolean; taper?: number | boolean; easing?: (distance: number) => number };
  /** Whether to handle the points as a completed stroke. */
  last?: boolean;
}

/** The points returned by `getStrokePoints`, and the input for `getStrokeOutlinePoints`. */
export interface StrokePoint {
  point: Vec2;
  pressure: number;
  distance: number;
  vector: Vec2;
  runningLength: number;
}

export type StrokeInputPoint = number[] | { x: number; y: number; pressure?: number };

// ------------------------------------------------------------------------------------ constants.ts

const RATE_OF_PRESSURE_CHANGE = 0.275;
/** PI with a tiny offset to fix browser rendering artifacts. */
const FIXED_PI = Math.PI + 0.0001;
const START_CAP_SEGMENTS = 13;
const END_CAP_SEGMENTS = 29;
const CORNER_CAP_SEGMENTS = 13;
const END_NOISE_THRESHOLD = 3;
const MIN_STREAMLINE_T = 0.15;
const STREAMLINE_T_RANGE = 0.85;
const MIN_RADIUS = 0.01;
const DEFAULT_FIRST_PRESSURE = 0.25;
const DEFAULT_PRESSURE = 0.5;
const UNIT_OFFSET: Vec2 = [1, 1];

// ------------------------------------------------------------------------------------------ vec.ts

function neg(A: Vec2): Vec2 { return [-A[0], -A[1]]; }
function add(A: Vec2, B: Vec2): Vec2 { return [A[0] + B[0], A[1] + B[1]]; }
function addInto(out: Vec2, A: Vec2, B: Vec2): Vec2 { out[0] = A[0] + B[0]; out[1] = A[1] + B[1]; return out; }
function sub(A: Vec2, B: Vec2): Vec2 { return [A[0] - B[0], A[1] - B[1]]; }
function subInto(out: Vec2, A: Vec2, B: Vec2): Vec2 { out[0] = A[0] - B[0]; out[1] = A[1] - B[1]; return out; }
function mul(A: Vec2, n: number): Vec2 { return [A[0] * n, A[1] * n]; }
function mulInto(out: Vec2, A: Vec2, n: number): Vec2 { out[0] = A[0] * n; out[1] = A[1] * n; return out; }
function div(A: Vec2, n: number): Vec2 { return [A[0] / n, A[1] / n]; }
function per(A: Vec2): Vec2 { return [A[1], -A[0]]; }
function perInto(out: Vec2, A: Vec2): Vec2 { const temp = A[0]; out[0] = A[1]; out[1] = -temp; return out; }
function dpr(A: Vec2, B: Vec2): number { return A[0] * B[0] + A[1] * B[1]; }
function isEqual(A: Vec2, B: Vec2): boolean { return A[0] === B[0] && A[1] === B[1]; }
function len(A: Vec2): number { return Math.hypot(A[0], A[1]); }
function dist2(A: Vec2, B: Vec2): number { const dx = A[0] - B[0]; const dy = A[1] - B[1]; return dx * dx + dy * dy; }
function uni(A: Vec2): Vec2 { return div(A, len(A)); }
function dist(A: Vec2, B: Vec2): number { return Math.hypot(A[1] - B[1], A[0] - B[0]); }
/** Rotate a vector around another vector by r (radians). */
function rotAround(A: Vec2, C: Vec2, r: number): Vec2 {
  const s = Math.sin(r);
  const c = Math.cos(r);
  const px = A[0] - C[0];
  const py = A[1] - C[1];
  return [px * c - py * s + C[0], px * s + py * c + C[1]];
}
function rotAroundInto(out: Vec2, A: Vec2, C: Vec2, r: number): Vec2 {
  const s = Math.sin(r);
  const c = Math.cos(r);
  const px = A[0] - C[0];
  const py = A[1] - C[1];
  out[0] = px * c - py * s + C[0];
  out[1] = px * s + py * c + C[1];
  return out;
}
function lrp(A: Vec2, B: Vec2, t: number): Vec2 { return add(A, mul(sub(B, A), t)); }
function lrpInto(out: Vec2, A: Vec2, B: Vec2, t: number): Vec2 {
  const dx = B[0] - A[0];
  const dy = B[1] - A[1];
  out[0] = A[0] + dx * t;
  out[1] = A[1] + dy * t;
  return out;
}
/** Project a point A in the direction B by a scalar c. */
function prj(A: Vec2, B: Vec2, c: number): Vec2 { return add(A, mul(B, c)); }

// ------------------------------------------------------------------- getStrokeRadius / simulatePressure

/** Compute a radius based on the pressure. */
function getStrokeRadius(size: number, thinning: number, pressure: number, easing: (t: number) => number = (t) => t): number {
  return size * easing(0.5 - thinning * (0.5 - pressure));
}

/** Simulate pressure based on the distance between points and stroke size. */
function simulatePressure(prevPressure: number, distance: number, size: number): number {
  const sp = Math.min(1, distance / size);
  const rp = Math.min(1, 1 - sp);
  return Math.min(1, prevPressure + (rp - prevPressure) * (sp * RATE_OF_PRESSURE_CHANGE));
}

// ------------------------------------------------------------------------------- getStrokePoints.ts

const isValidPressure = (pressure: number | undefined): pressure is number => pressure != null && pressure >= 0;

/** Normalize one input point to [x, y, pressure?]; throws on non-finite coordinates. */
function toTuple(p: StrokeInputPoint): number[] {
  let x: unknown, y: unknown, pr: unknown;
  if (Array.isArray(p)) { x = p[0]; y = p[1]; pr = p[2]; }
  else if (p !== null && typeof p === "object") { x = p.x; y = p.y; pr = p.pressure ?? DEFAULT_PRESSURE; }
  if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new TypeError("freehand: every point needs finite x and y");
  }
  return typeof pr === "number" && Number.isFinite(pr) ? [x, y, pr] : [x, y];
}

/**
 * Get an array of points as objects with an adjusted point, pressure, vector, distance, and runningLength.
 * Throws when more than DESIGN_MAX_POINTS_PER_STROKE points are given.
 */
export function getStrokePoints(points: StrokeInputPoint[], options: StrokeOptions = {}): StrokePoint[] {
  const { streamline = 0.5, size = 16, last: isComplete = false } = options;
  if (points.length === 0) return [];
  if (points.length > DESIGN_MAX_POINTS_PER_STROKE) {
    throw new Error(`freehand: more than ${DESIGN_MAX_POINTS_PER_STROKE} points`);
  }

  // Find the interpolation level between points.
  const t = MIN_STREAMLINE_T + (1 - streamline) * STREAMLINE_T_RANGE;

  let pts: number[][] = points.map(toTuple);

  // Add extra points between the two, to help avoid "dash" lines for strokes with tapered start and ends.
  if (pts.length === 2) {
    const last = pts[1]!;
    pts = pts.slice(0, -1);
    const p0 = pts[0]!;
    for (let i = 1; i < 5; i++) pts.push(lrp([p0[0]!, p0[1]!], [last[0]!, last[1]!], i / 4));
  }

  // If there's only one point, add another point at a 1pt offset.
  if (pts.length === 1) {
    const p0 = pts[0]!;
    pts = [...pts, [...add([p0[0]!, p0[1]!], UNIT_OFFSET), ...p0.slice(2)]];
  }

  const p0 = pts[0]!;
  const strokePoints: StrokePoint[] = [{
    point: [p0[0]!, p0[1]!],
    pressure: isValidPressure(p0[2]) ? p0[2] : DEFAULT_FIRST_PRESSURE,
    vector: [UNIT_OFFSET[0], UNIT_OFFSET[1]],
    distance: 0,
    runningLength: 0,
  }];

  let hasReachedMinimumLength = false;
  let runningLength = 0;
  let prev = strokePoints[0]!;
  const max = pts.length - 1;
  const vectorDiff: Vec2 = [0, 0];

  for (let i = 1; i < pts.length; i++) {
    const pi = pts[i]!;
    const point: Vec2 = isComplete && i === max
      ? [pi[0]!, pi[1]!] // the last point of a completed stroke is the actual input point
      : lrp(prev.point, [pi[0]!, pi[1]!], t); // otherwise streamline toward it

    // If the new point is the same as the previous point, skip ahead.
    if (isEqual(prev.point, point)) continue;

    const distance = dist(point, prev.point);
    runningLength += distance;

    // At the start of the line, wait until the new point is a certain distance away, to avoid noise
    if (i < max && !hasReachedMinimumLength) {
      if (runningLength < size) continue;
      hasReachedMinimumLength = true;
    }
    subInto(vectorDiff, prev.point, point);
    prev = {
      point,
      pressure: isValidPressure(pi[2]) ? pi[2] : DEFAULT_PRESSURE,
      vector: uni(vectorDiff),
      distance,
      runningLength,
    };
    strokePoints.push(prev);
  }

  // Set the vector of the first point to be the same as the second point.
  strokePoints[0]!.vector = strokePoints[1]?.vector ?? [0, 0];
  return strokePoints;
}

// ------------------------------------------------------------------------ getStrokeOutlinePoints.ts

/** Draw a dot (circle) for very short strokes. */
function drawDot(center: Vec2, radius: number): Vec2[] {
  const offsetPoint = add(center, [1, 1]);
  const start = prj(center, uni(per(sub(center, offsetPoint))), -radius);
  const dotPts: Vec2[] = [];
  const step = 1 / START_CAP_SEGMENTS;
  for (let t = step; t <= 1; t += step) dotPts.push(rotAround(start, center, FIXED_PI * 2 * t));
  return dotPts;
}

/** Draw a rounded start cap by rotating points from right to left around the start point. */
function drawRoundStartCap(center: Vec2, rightPoint: Vec2, segments: number): Vec2[] {
  const cap: Vec2[] = [];
  const step = 1 / segments;
  for (let t = step; t <= 1; t += step) cap.push(rotAround(rightPoint, center, FIXED_PI * t));
  return cap;
}

/** Draw a flat start cap with squared-off edges. */
function drawFlatStartCap(center: Vec2, leftPoint: Vec2, rightPoint: Vec2): Vec2[] {
  const cornersVector = sub(leftPoint, rightPoint);
  const offsetA = mul(cornersVector, 0.5);
  const offsetB = mul(cornersVector, 0.51);
  return [sub(center, offsetA), sub(center, offsetB), add(center, offsetB), add(center, offsetA)];
}

/** Draw a rounded end cap (1.5 turns to handle sharp end turns correctly). */
function drawRoundEndCap(center: Vec2, direction: Vec2, radius: number, segments: number): Vec2[] {
  const cap: Vec2[] = [];
  const start = prj(center, direction, radius);
  const step = 1 / segments;
  for (let t = step; t < 1; t += step) cap.push(rotAround(start, center, FIXED_PI * 3 * t));
  return cap;
}

/** Draw a flat end cap with squared-off edges. */
function drawFlatEndCap(center: Vec2, direction: Vec2, radius: number): Vec2[] {
  return [
    add(center, mul(direction, radius)),
    add(center, mul(direction, radius * 0.99)),
    sub(center, mul(direction, radius * 0.99)),
    sub(center, mul(direction, radius)),
  ];
}

/** Taper distance: false/undefined -> 0, true -> max(size, totalLength), number -> that distance. */
function computeTaperDistance(taper: boolean | number | undefined, size: number, totalLength: number): number {
  if (taper === false || taper === undefined) return 0;
  if (taper === true) return Math.max(size, totalLength);
  return taper;
}

/** Initial pressure averaged over the first few points, to prevent "fat starts". */
function computeInitialPressure(points: StrokePoint[], shouldSimulatePressure: boolean, size: number): number {
  let acc = points[0]!.pressure;
  const n = Math.min(10, points.length);
  for (let i = 0; i < n; i++) {
    const curr = points[i]!;
    const pressure = shouldSimulatePressure ? simulatePressure(acc, curr.distance, size) : curr.pressure;
    acc = (acc + pressure) / 2;
  }
  return acc;
}

/** Get an array of points (as [x, y]) representing the outline of a stroke. */
export function getStrokeOutlinePoints(points: StrokePoint[], options: Partial<StrokeOptions> = {}): Vec2[] {
  const {
    size = 16,
    smoothing = 0.5,
    thinning = 0.5,
    simulatePressure: shouldSimulatePressure = true,
    easing = (t: number): number => t,
    start = {},
    end = {},
    last: isComplete = false,
  } = options;
  const { cap: capStart = true, easing: taperStartEase = (t: number): number => t * (2 - t) } = start;
  const { cap: capEnd = true, easing: taperEndEase = (t: number): number => --t * t * t + 1 } = end;

  // We can't do anything with an empty array or a stroke with negative size.
  if (points.length === 0 || !(size > 0)) return [];

  const lastSp = points[points.length - 1]!;
  const totalLength = lastSp.runningLength;
  const taperStart = computeTaperDistance(start.taper, size, totalLength);
  const taperEnd = computeTaperDistance(end.taper, size, totalLength);

  // The minimum allowed distance between points (squared)
  const minDistance = Math.pow(size * smoothing, 2);

  const leftPts: Vec2[] = [];
  const rightPts: Vec2[] = [];

  let prevPressure = computeInitialPressure(points, shouldSimulatePressure, size);
  let radius = getStrokeRadius(size, thinning, lastSp.pressure, easing);
  let firstRadius: number | undefined = undefined;
  let prevVector = points[0]!.vector;
  let prevLeftPoint = points[0]!.point;
  let prevRightPoint = prevLeftPoint;
  let tempLeftPoint: Vec2 = prevLeftPoint;
  let tempRightPoint: Vec2 = prevRightPoint;
  let isPrevPointSharpCorner = false;

  const offset: Vec2 = [0, 0];
  const tl: Vec2 = [0, 0];
  const tr: Vec2 = [0, 0];

  // Find the outline's left and right points (the first and last points get caps later on).
  for (let i = 0; i < points.length; i++) {
    const sp = points[i]!;
    let { pressure } = sp;
    const { point, vector, distance, runningLength } = sp;
    const isLastPoint = i === points.length - 1;

    // Removes noise from the end of the line
    if (!isLastPoint && totalLength - runningLength < END_NOISE_THRESHOLD) continue;

    // Radius: half the size without thinning, else from the real or simulated pressure
    if (thinning) {
      if (shouldSimulatePressure) pressure = simulatePressure(prevPressure, distance, size);
      radius = getStrokeRadius(size, thinning, pressure, easing);
    } else {
      radius = size / 2;
    }
    if (firstRadius === undefined) firstRadius = radius;

    // Apply tapering: the smaller of the start and end taper strengths
    const taperStartStrength = runningLength < taperStart ? taperStartEase(runningLength / taperStart) : 1;
    const taperEndStrength = totalLength - runningLength < taperEnd
      ? taperEndEase((totalLength - runningLength) / taperEnd)
      : 1;
    radius = Math.max(MIN_RADIUS, radius * Math.min(taperStartStrength, taperEndStrength));

    // Sharp corners: if the next vector is at more than a right angle, draw a cap at the current point
    const nextVector = (!isLastPoint ? points[i + 1]! : sp).vector;
    const nextDpr = !isLastPoint ? dpr(vector, nextVector) : 1.0;
    const prevDpr = dpr(vector, prevVector);
    const isPointSharpCorner = prevDpr < 0 && !isPrevPointSharpCorner;
    const isNextPointSharpCorner = nextDpr < 0;

    if (isPointSharpCorner || isNextPointSharpCorner) {
      perInto(offset, prevVector);
      mulInto(offset, offset, radius);
      const step = 1 / CORNER_CAP_SEGMENTS;
      for (let t = 0; t <= 1; t += step) {
        subInto(tl, point, offset);
        rotAroundInto(tl, tl, point, FIXED_PI * t);
        tempLeftPoint = [tl[0], tl[1]];
        leftPts.push(tempLeftPoint);
        addInto(tr, point, offset);
        rotAroundInto(tr, tr, point, FIXED_PI * -t);
        tempRightPoint = [tr[0], tr[1]];
        rightPts.push(tempRightPoint);
      }
      prevLeftPoint = tempLeftPoint;
      prevRightPoint = tempRightPoint;
      if (isNextPointSharpCorner) isPrevPointSharpCorner = true;
      continue;
    }

    isPrevPointSharpCorner = false;

    // Handle the last point
    if (isLastPoint) {
      perInto(offset, vector);
      mulInto(offset, offset, radius);
      leftPts.push(sub(point, offset));
      rightPts.push(add(point, offset));
      continue;
    }

    // Regular points: project to either side; keep when far enough from the previous side point
    lrpInto(offset, nextVector, vector, nextDpr);
    perInto(offset, offset);
    mulInto(offset, offset, radius);

    subInto(tl, point, offset);
    tempLeftPoint = [tl[0], tl[1]];
    if (i <= 1 || dist2(prevLeftPoint, tempLeftPoint) > minDistance) {
      leftPts.push(tempLeftPoint);
      prevLeftPoint = tempLeftPoint;
    }

    addInto(tr, point, offset);
    tempRightPoint = [tr[0], tr[1]];
    if (i <= 1 || dist2(prevRightPoint, tempRightPoint) > minDistance) {
      rightPts.push(tempRightPoint);
      prevRightPoint = tempRightPoint;
    }

    prevPressure = pressure;
    prevVector = vector;
  }

  // Caps: tapered lines have none, very short lines may become dots.
  const firstPoint: Vec2 = [points[0]!.point[0], points[0]!.point[1]];
  const lastPoint: Vec2 = points.length > 1 ? [lastSp.point[0], lastSp.point[1]] : add(points[0]!.point, [1, 1]);
  const startCap: Vec2[] = [];
  const endCap: Vec2[] = [];

  if (points.length === 1) {
    if (!(taperStart || taperEnd) || isComplete) return drawDot(firstPoint, firstRadius || radius);
  } else {
    const right0 = rightPts[0];
    const left0 = leftPts[0];
    if (taperStart || (taperEnd && points.length === 1)) {
      // The start point is tapered, noop
    } else if (capStart) {
      if (right0) startCap.push(...drawRoundStartCap(firstPoint, right0, START_CAP_SEGMENTS));
    } else if (right0 && left0) {
      startCap.push(...drawFlatStartCap(firstPoint, left0, right0));
    }

    const direction = per(neg(lastSp.vector));
    if (taperEnd || (taperStart && points.length === 1)) {
      endCap.push(lastPoint); // tapered end: push the last point to the line
    } else if (capEnd) {
      endCap.push(...drawRoundEndCap(lastPoint, direction, radius, END_CAP_SEGMENTS));
    } else {
      endCap.push(...drawFlatEndCap(lastPoint, direction, radius));
    }
  }

  // Winding order: left side, end cap, right side back, start cap.
  return leftPts.concat(endCap, rightPts.reverse(), startCap);
}

// ------------------------------------------------------------------------------------- getStroke.ts

/** Get an array of points describing a polygon that surrounds the input points. */
export function getStroke(points: StrokeInputPoint[], options: StrokeOptions = {}): Vec2[] {
  return getStrokeOutlinePoints(getStrokePoints(points, options), options);
}

// ------------------------------------------------------------------------------------------ native

/**
 * Closed smooth path through an outline, like the upstream README's getSvgPathFromStroke: M at the first
 * point, then one Q per point with that point as control and the midpoint to the next point (wrapping)
 * as anchor, then Z. Non-finite points are skipped; empty outline -> [].
 */
export function strokeToPath(outline: readonly (readonly number[])[]): PathCmd[] {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const p of outline) {
    const x = p[0], y = p[1];
    if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    xs.push(x); ys.push(y);
  }
  const n = xs.length;
  if (n === 0) return [];
  if (n + 2 > DESIGN_LIMITS.maxPathCmds) throw new Error("strokeToPath: outline exceeds maxPathCmds");
  const cmds: PathCmd[] = [{ c: "M", x: xs[0]!, y: ys[0]! }];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const x0 = xs[i]!, y0 = ys[i]!;
    cmds.push({ c: "Q", x1: x0, y1: y0, x: (x0 + xs[j]!) / 2, y: (y0 + ys[j]!) / 2 });
  }
  cmds.push({ c: "Z" });
  return cmds;
}
