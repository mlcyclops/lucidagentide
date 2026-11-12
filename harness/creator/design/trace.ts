// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

/*
Portions ported from imagetracerjs 1.2.6 (https://github.com/jankovicsandras/imagetracerjs,
imagetracer_v1.2.6.js) by Andras Jankovics (andras@jankovics.net), The Unlicense:

The Unlicense / PUBLIC DOMAIN

This is free and unencumbered software released into the public domain.

Anyone is free to copy, modify, publish, use, compile, sell, or
distribute this software, either in source code form or as a compiled
binary, for any purpose, commercial or non-commercial, and by any
means.

In jurisdictions that recognize copyright laws, the author or authors
of this software dedicate any and all copyright interest in the
software to the public domain. We make this dedication for the benefit
of the public at large and to the detriment of our heirs and
successors. We intend this dedication to be an overt act of
relinquishment in perpetuity of all present and future rights to this
software under copyright law.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR
OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.

For more information, please refer to http://unlicense.org/
*/

// harness/creator/design/trace.ts - raster to vector tracing (imagetracerjs core, sequential layering).
//
// Pipeline as upstream imagedataToTracedata with layering 0: colorquantization (samplepalette2 grid
// seed + rectilinear k-means, 3 cycles), then per color layeringstep -> pathscan -> internodes (with
// rightangleenhance) -> tracepath/fitseq, and svgpathstring's hole handling (hole children appended as
// reversed subpaths). Our changes: typed arrays for the index grid and edge-node layers; no Math.random
// (an empty cluster is re-seeded with the pixel farthest from its center in the previous cycle, and a
// transparent grid sample is replaced by the next opaque pixel in scan order); pixels with alpha < 128
// form their own cluster that is never traced; fitseq's recursion runs on an explicit stack; wrapped
// sequences use wrapped parameters in the spline check; walks that hit an invalid lookup entry are
// discarded instead of looping; an orphan hole attaches to path 0 as upstream does, but only when path 0
// is not itself a hole (otherwise it is dropped); and the
// output is capped (pixels, paths per layer, shapes, commands).

import { toHex } from "./color.ts";
import { DESIGN_LIMITS } from "./limits.ts";
import type { PathCmd, RasterData, VShape } from "./types.ts";

export interface TraceOptions { colors: number; minArea: number; tolerance: number }

/** Tracing is O(pixels * colors); larger rasters must be downscaled first. */
export const TRACE_MAX_PIXELS = 4096 * 4096;

/** Upstream colorquantcycles default. */
const QUANT_CYCLES = 3;
/** Index-grid value for transparent pixels (padding is -1, palette entries are >= 0). */
const TRANSPARENT = -2;

// pathscan_combined_lookup[ value ][ dir ] = [next value, next dir, dx, dy], flattened (value*4+dir)*4.
// Walk directions: 0 > ; 1 ^ ; 2 < ; 3 v
const N = [-1, -1, -1, -1];
const LOOKUP = Int8Array.from([
  N, N, N, N, // 0 is invalid
  [0, 1, 0, -1], N, N, [0, 2, -1, 0],
  N, N, [0, 1, 0, -1], [0, 0, 1, 0],
  [0, 0, 1, 0], N, [0, 2, -1, 0], N,

  N, [0, 0, 1, 0], [0, 3, 0, 1], N,
  [13, 3, 0, 1], [13, 2, -1, 0], [7, 1, 0, -1], [7, 0, 1, 0],
  N, [0, 1, 0, -1], N, [0, 3, 0, 1],
  [0, 3, 0, 1], [0, 2, -1, 0], N, N,

  [0, 3, 0, 1], [0, 2, -1, 0], N, N,
  N, [0, 1, 0, -1], N, [0, 3, 0, 1],
  [11, 1, 0, -1], [14, 0, 1, 0], [14, 3, 0, 1], [11, 2, -1, 0],
  N, [0, 0, 1, 0], [0, 3, 0, 1], N,

  [0, 0, 1, 0], N, [0, 2, -1, 0], N,
  N, N, [0, 1, 0, -1], [0, 0, 1, 0],
  [0, 1, 0, -1], N, N, [0, 2, -1, 0],
  N, N, N, N, // 15 is invalid
].flat());

// ------------------------------------------------------------------------------------------------
// 1. Color quantization

interface Quantized { idx: Int16Array; palette: Int32Array; counts: Float64Array }

/** Upstream colorquantization with samplepalette2 seeding, made deterministic. */
function colorQuantization(src: RasterData, colors: number): Quantized | null {
  const { width: w, height: h, rgba } = src;
  const W = w + 2, H = h + 2;
  const pixelnum = w * h;
  const idx = new Int16Array(W * H).fill(-1);

  let firstOpaque = -1;
  for (let p = 0; p < pixelnum; p++) if (rgba[p * 4 + 3]! >= 128) { firstOpaque = p; break; }
  if (firstOpaque < 0) return null;

  // samplepalette2: rectangular sampling grid; a transparent sample takes the next opaque pixel
  const palette = new Int32Array(colors * 4);
  const ni = Math.ceil(Math.sqrt(colors)), nj = Math.ceil(colors / ni);
  const vx = w / (ni + 1), vy = h / (nj + 1);
  let count = 0;
  for (let j = 0; j < nj && count < colors; j++) {
    for (let i = 0; i < ni && count < colors; i++) {
      let p = Math.min(pixelnum - 1, Math.floor((j + 1) * vy * w + (i + 1) * vx));
      if (rgba[p * 4 + 3]! < 128) {
        let q = p + 1;
        while (q < pixelnum && rgba[q * 4 + 3]! < 128) q++;
        p = q < pixelnum ? q : firstOpaque;
      }
      palette[count * 4] = rgba[p * 4]!;
      palette[count * 4 + 1] = rgba[p * 4 + 1]!;
      palette[count * 4 + 2] = rgba[p * 4 + 2]!;
      palette[count * 4 + 3] = rgba[p * 4 + 3]!;
      count++;
    }
  }

  const acc = new Float64Array(colors * 5); // r g b a n
  let farPixel = -1;
  for (let cnt = 0; cnt < QUANT_CYCLES; cnt++) {
    // Average colors from the second iteration
    if (cnt > 0) {
      let reseedFrom = farPixel;
      for (let k = 0; k < colors; k++) {
        const n = acc[k * 5 + 4]!;
        if (n > 0) {
          palette[k * 4] = Math.floor(acc[k * 5]! / n);
          palette[k * 4 + 1] = Math.floor(acc[k * 5 + 1]! / n);
          palette[k * 4 + 2] = Math.floor(acc[k * 5 + 2]! / n);
          palette[k * 4 + 3] = Math.floor(acc[k * 5 + 3]! / n);
        } else if (cnt < QUANT_CYCLES - 1 && reseedFrom >= 0) {
          // upstream re-seeds starved clusters with Math.random(); we take the worst-fit pixel instead
          palette[k * 4] = rgba[reseedFrom * 4]!;
          palette[k * 4 + 1] = rgba[reseedFrom * 4 + 1]!;
          palette[k * 4 + 2] = rgba[reseedFrom * 4 + 2]!;
          palette[k * 4 + 3] = rgba[reseedFrom * 4 + 3]!;
          reseedFrom = -1;
        }
      }
    }
    acc.fill(0);
    let farDist = 0;
    farPixel = -1;
    for (let y = 0; y < h; y++) {
      const row = (y + 1) * W + 1;
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        const o = p * 4;
        const a = rgba[o + 3]!;
        if (a < 128) { idx[row + x] = TRANSPARENT; continue; }
        const r = rgba[o]!, g = rgba[o + 1]!, b = rgba[o + 2]!;
        // closest palette color by rectilinear RGBA distance
        let ci = 0, cdl = 1024;
        for (let k = 0; k < colors; k++) {
          const q = k * 4;
          const cd = Math.abs(palette[q]! - r) + Math.abs(palette[q + 1]! - g) +
            Math.abs(palette[q + 2]! - b) + Math.abs(palette[q + 3]! - a);
          if (cd < cdl) { cdl = cd; ci = k; }
        }
        const s = ci * 5;
        acc[s] = acc[s]! + r; acc[s + 1] = acc[s + 1]! + g; acc[s + 2] = acc[s + 2]! + b;
        acc[s + 3] = acc[s + 3]! + a; acc[s + 4] = acc[s + 4]! + 1;
        if (cdl > farDist) { farDist = cdl; farPixel = p; }
        idx[row + x] = ci;
      }
    }
  }
  const counts = new Float64Array(colors);
  for (let k = 0; k < colors; k++) counts[k] = acc[k * 5 + 4]!;
  return { idx, palette, counts };
}

// ------------------------------------------------------------------------------------------------
// 2. layeringstep: edge node types for one color ( 1 top-left, 2 top-right, 4 bottom-right, 8 bottom-left )

function layeringStep(idx: Int16Array, W: number, H: number, cnum: number, layer: Uint8Array): void {
  layer.fill(0);
  for (let j = 1; j < H; j++) {
    const r0 = (j - 1) * W, r1 = j * W;
    for (let i = 1; i < W; i++) {
      layer[r1 + i] =
        (idx[r0 + i - 1] === cnum ? 1 : 0) +
        (idx[r0 + i] === cnum ? 2 : 0) +
        (idx[r1 + i - 1] === cnum ? 8 : 0) +
        (idx[r1 + i] === cnum ? 4 : 0);
    }
  }
}

// ------------------------------------------------------------------------------------------------
// 3. pathscan

interface ScanPath {
  xs: number[]; ys: number[];
  bbox: [number, number, number, number];
  holes: number[];
  isHole: boolean;
}

function pointInPoly(px: number, py: number, xs: number[], ys: number[]): boolean {
  let isin = false;
  for (let i = 0, j = xs.length - 1; i < xs.length; j = i++) {
    const yi = ys[i]!, yj = ys[j]!, xi = xs[i]!, xj = xs[j]!;
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) isin = !isin;
  }
  return isin;
}

function bboxIncludes(p: readonly number[], c: readonly number[]): boolean {
  return p[0]! < c[0]! && p[1]! < c[1]! && p[2]! > c[2]! && p[3]! > c[3]!;
}

/** Walk the edge-node layer (mutated: visited nodes are cleared), collecting closed paths. */
function pathScan(layer: Uint8Array, W: number, H: number, pathomit: number, maxPaths: number): ScanPath[] {
  const paths: ScanPath[] = [];
  const maxSteps = 2 * W * H + 4;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const v = layer[j * W + i]!;
      if (v !== 4 && v !== 11) continue;
      if (paths.length >= maxPaths) return paths;
      let px = i, py = j, dir = 1;
      const xs: number[] = [], ys: number[] = [];
      const bbox: [number, number, number, number] = [px - 1, py - 1, px - 1, py - 1];
      const isHole = v === 11;
      let ok = false;
      for (let steps = 0; steps < maxSteps; steps++) {
        const x = px - 1, y = py - 1;
        xs.push(x); ys.push(y);
        if (x < bbox[0]) bbox[0] = x;
        if (x > bbox[2]) bbox[2] = x;
        if (y < bbox[1]) bbox[1] = y;
        if (y > bbox[3]) bbox[3] = y;
        // look up the replacement, direction and coordinate changes: clear this cell, turn, walk forward
        const k = (layer[py * W + px]! * 4 + dir) * 4;
        const nv = LOOKUP[k]!;
        if (nv < 0) break;
        layer[py * W + px] = nv;
        dir = LOOKUP[k + 1]!;
        px += LOOKUP[k + 2]!;
        py += LOOKUP[k + 3]!;
        if (px < 0 || py < 0 || px >= W || py >= H) break;
        if (px - 1 === xs[0] && py - 1 === ys[0]) { ok = true; break; }
      }
      // discard broken walks and paths shorter than pathomit
      if (!ok || xs.length < pathomit) continue;
      const path: ScanPath = { xs, ys, bbox, holes: [], isHole };
      const pacnt = paths.length;
      paths.push(path);
      if (isHole) {
        // finding the parent shape for this hole: the innermost enclosing non-hole path
        let parentidx = -1;
        let parentbbox: readonly number[] = [-1, -1, W + 1, H + 1];
        for (let pc = 0; pc < pacnt; pc++) {
          const cand = paths[pc]!;
          if (!cand.isHole && bboxIncludes(cand.bbox, bbox) && bboxIncludes(parentbbox, cand.bbox) &&
            pointInPoly(xs[0]!, ys[0]!, cand.xs, cand.ys)) {
            parentidx = pc;
            parentbbox = cand.bbox;
          }
        }
        if (parentidx < 0 && pacnt > 0 && !paths[0]!.isHole) parentidx = 0; // upstream default parent
        if (parentidx >= 0) paths[parentidx]!.holes.push(pacnt);
      }
    }
  }
  return paths;
}

// ------------------------------------------------------------------------------------------------
// 4. internodes (8 directions, with rightangleenhance)

interface Inter { xs: number[]; ys: number[]; seg: number[] }

function getDirection(x1: number, y1: number, x2: number, y2: number): number {
  if (x1 < x2) return y1 < y2 ? 1 : y1 > y2 ? 7 : 0; // SE, NE, E
  if (x1 > x2) return y1 < y2 ? 3 : y1 > y2 ? 5 : 4; // SW, NW, W
  return y1 < y2 ? 2 : y1 > y2 ? 6 : 8;               // S, N, center
}

function testRightAngle(p: ScanPath, i1: number, i2: number, i3: number, i4: number, i5: number): boolean {
  const xs = p.xs, ys = p.ys;
  const x3 = xs[i3]!, y3 = ys[i3]!;
  return (x3 === xs[i1] && x3 === xs[i2] && y3 === ys[i4] && y3 === ys[i5]) ||
    (y3 === ys[i1] && y3 === ys[i2] && x3 === xs[i4] && x3 === xs[i5]);
}

function interNodes(p: ScanPath): Inter {
  const out: Inter = { xs: [], ys: [], seg: [] };
  const palen = p.xs.length;
  for (let pcnt = 0; pcnt < palen; pcnt++) {
    const next = (pcnt + 1) % palen, next2 = (pcnt + 2) % palen;
    const prev = (pcnt - 1 + palen) % palen, prev2 = (pcnt - 2 + palen) % palen;
    const x = p.xs[pcnt]!, y = p.ys[pcnt]!;
    const mx = (x + p.xs[next]!) / 2, my = (y + p.ys[next]!) / 2;
    if (testRightAngle(p, prev2, prev, pcnt, next, next2)) {
      // fix previous direction, then add this corner point
      const last = out.xs.length - 1;
      if (last >= 0) out.seg[last] = getDirection(out.xs[last]!, out.ys[last]!, x, y);
      out.xs.push(x); out.ys.push(y); out.seg.push(getDirection(x, y, mx, my));
    }
    // interpolate between two path points
    const nmx = (p.xs[next]! + p.xs[next2]!) / 2, nmy = (p.ys[next]! + p.ys[next2]!) / 2;
    out.xs.push(mx); out.ys.push(my); out.seg.push(getDirection(mx, my, nmx, nmy));
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// 5. tracepath / fitseq: straight lines and quadratic splines on the internode path

interface Seg { q: boolean; x1: number; y1: number; x2: number; y2: number; x3: number; y3: number }

/** Upstream fitseq with its divide-and-conquer recursion on an explicit stack (output order kept). */
function fitSeq(out: Seg[], path: Inter, ltres: number, qtres: number, start: number, end: number): void {
  const plen = path.xs.length;
  const xs = path.xs, ys = path.ys;
  const stack: number[] = [start, end];
  while (stack.length > 0) {
    const seqend = stack.pop()!;
    const seqstart = stack.pop()!;
    if (seqend > plen || seqend < 0) continue;
    let tl = seqend - seqstart;
    if (tl <= 0) tl += plen; // a sequence ending where it starts covers the whole loop
    const sx = xs[seqstart]!, sy = ys[seqstart]!, ex = xs[seqend]!, ey = ys[seqend]!;
    const vx = (ex - sx) / tl, vy = (ey - sy) / tl;

    // 5.2. Fit a straight line on the sequence
    let errorpoint = seqstart, errorval = 0, curvepass = true;
    let pcnt = (seqstart + 1) % plen;
    while (pcnt !== seqend) {
      let pl = pcnt - seqstart;
      if (pl < 0) pl += plen;
      const px = sx + vx * pl, py = sy + vy * pl;
      const d2 = (xs[pcnt]! - px) * (xs[pcnt]! - px) + (ys[pcnt]! - py) * (ys[pcnt]! - py);
      if (d2 > ltres) curvepass = false;
      if (d2 > errorval) { errorpoint = pcnt; errorval = d2; }
      pcnt = (pcnt + 1) % plen;
    }
    if (curvepass) { out.push({ q: false, x1: sx, y1: sy, x2: ex, y2: ey, x3: 0, y3: 0 }); continue; }

    // 5.3./5.4. Fit a quadratic spline through the point with the biggest error
    const fitpoint = errorpoint;
    curvepass = true;
    let fl = fitpoint - seqstart;
    if (fl < 0) fl += plen;
    let t = fl / tl, t1 = (1 - t) * (1 - t), t2 = 2 * (1 - t) * t, t3 = t * t;
    const cpx = (t1 * sx + t3 * ex - xs[fitpoint]!) / -t2;
    const cpy = (t1 * sy + t3 * ey - ys[fitpoint]!) / -t2;
    pcnt = (seqstart + 1) % plen;
    while (pcnt !== seqend) {
      let pl = pcnt - seqstart;
      if (pl < 0) pl += plen;
      t = pl / tl; t1 = (1 - t) * (1 - t); t2 = 2 * (1 - t) * t; t3 = t * t;
      const px = t1 * sx + t2 * cpx + t3 * ex;
      const py = t1 * sy + t2 * cpy + t3 * ey;
      const d2 = (xs[pcnt]! - px) * (xs[pcnt]! - px) + (ys[pcnt]! - py) * (ys[pcnt]! - py);
      if (d2 > qtres) { curvepass = false; break; }
      pcnt = (pcnt + 1) % plen;
    }
    if (curvepass) { out.push({ q: true, x1: sx, y1: sy, x2: cpx, y2: cpy, x3: ex, y3: ey }); continue; }

    // 5.5./5.6. Split at the fit point; push the right half first so the left half is emitted first
    stack.push(fitpoint, seqend, seqstart, fitpoint);
  }
}

/** Upstream tracepath: split the internode path into sequences of at most 2 segment types. */
function tracePath(path: Inter, ltres: number, qtres: number): Seg[] {
  const segs: Seg[] = [];
  const plen = path.xs.length;
  if (plen < 2) return segs;
  let pcnt = 0;
  while (pcnt < plen) {
    const segtype1 = path.seg[pcnt]!;
    let segtype2 = -1;
    let seqend = pcnt + 1;
    while (seqend < plen - 1) {
      const s = path.seg[seqend]!;
      if (!(s === segtype1 || s === segtype2 || segtype2 === -1)) break;
      if (s !== segtype1 && segtype2 === -1) segtype2 = s;
      seqend++;
    }
    if (seqend === plen - 1) seqend = 0;
    fitSeq(segs, path, ltres, qtres, pcnt, seqend);
    pcnt = seqend > 0 ? seqend : plen;
  }
  return segs;
}

// ------------------------------------------------------------------------------------------------
// Output (upstream svgpathstring as PathCmd[])

function polyArea(xs: number[], ys: number[]): number {
  let a = 0;
  for (let i = 0, j = xs.length - 1; i < xs.length; j = i++) a += xs[j]! * ys[i]! - xs[i]! * ys[j]!;
  return Math.abs(a) / 2;
}

function appendOuter(d: PathCmd[], segs: Seg[]): void {
  const s0 = segs[0]!;
  d.push({ c: "M", x: s0.x1, y: s0.y1 });
  for (const s of segs) {
    d.push(s.q ? { c: "Q", x1: s.x2, y1: s.y2, x: s.x3, y: s.y3 } : { c: "L", x: s.x2, y: s.y2 });
  }
  d.push({ c: "Z" });
}

function appendHole(d: PathCmd[], segs: Seg[]): void {
  const last = segs[segs.length - 1]!;
  d.push(last.q ? { c: "M", x: last.x3, y: last.y3 } : { c: "M", x: last.x2, y: last.y2 });
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i]!;
    d.push(s.q ? { c: "Q", x1: s.x2, y1: s.y2, x: s.x1, y: s.y1 } : { c: "L", x: s.x1, y: s.y1 });
  }
  d.push({ c: "Z" });
}

const finiteOr = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

/**
 * Trace a raster into filled vector paths, one VShape per traced region (holes included as reversed
 * subpaths), in raster pixel coordinates. Ordered by palette index, then scan order. Pixels with
 * alpha < 128 are never traced. Throws for invalid rasters and rasters over TRACE_MAX_PIXELS.
 */
export function traceRaster(src: RasterData, opts: TraceOptions): VShape[] {
  const w = src?.width, h = src?.height;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) throw new Error("traceRaster: invalid raster size");
  if (w * h > TRACE_MAX_PIXELS) throw new Error(`traceRaster: raster over ${TRACE_MAX_PIXELS} pixels`);
  if (!(src.rgba instanceof Uint8ClampedArray) || src.rgba.length < w * h * 4) throw new Error("traceRaster: rgba buffer too small");

  const colors = Math.min(64, Math.max(2, Math.round(finiteOr(opts?.colors, 16))));
  const minArea = Math.min(1e12, Math.max(0, finiteOr(opts?.minArea, 0)));
  const tol = Math.min(20, Math.max(0.01, finiteOr(opts?.tolerance, 1)));
  const pathomit = Math.floor(minArea);

  const q = colorQuantization(src, colors);
  if (!q) return [];
  const W = w + 2, H = h + 2;
  const layer = new Uint8Array(W * H);
  const shapes: VShape[] = [];
  let totalCmds = 0;

  for (let c = 0; c < colors; c++) {
    if (q.counts[c]! === 0) continue;
    layeringStep(q.idx, W, H, c, layer);
    const paths = pathScan(layer, W, H, pathomit, DESIGN_LIMITS.maxShapes);
    const fill = toHex([q.palette[c * 4]!, q.palette[c * 4 + 1]!, q.palette[c * 4 + 2]!, 255]);
    const traced = new Map<number, Seg[]>();
    const segsOf = (k: number): Seg[] => {
      let s = traced.get(k);
      if (!s) { s = tracePath(interNodes(paths[k]!), tol, tol); traced.set(k, s); }
      return s;
    };
    for (let k = 0; k < paths.length; k++) {
      const p = paths[k]!;
      if (p.isHole) continue;
      if (polyArea(p.xs, p.ys) < minArea) continue;
      const outer = segsOf(k);
      if (outer.length === 0) continue;
      const d: PathCmd[] = [];
      appendOuter(d, outer);
      for (const hk of p.holes) {
        const hs = segsOf(hk);
        if (hs.length > 0) appendHole(d, hs);
      }
      if (shapes.length >= DESIGN_LIMITS.maxShapes || totalCmds + d.length > DESIGN_LIMITS.maxPathCmds) return shapes;
      totalCmds += d.length;
      shapes.push({
        id: `t${shapes.length}`,
        kind: "path",
        d,
        paint: { fill, stroke: null, strokeWidth: 0, opacity: 1 },
      });
    }
  }
  return shapes;
}
