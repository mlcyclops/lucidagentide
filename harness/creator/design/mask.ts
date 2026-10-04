// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/creator/design/mask.ts - brush mask tracing, mask morphology, contours, and SAM prompts.
//
// Masks are 0..255 coverage planes (MaskData). A mask pixel (px, py) covers the doc point
// (px + offX + 0.5, py + offY + 0.5), so strokes are recorded in DOC coordinates and the mask can sit
// anywhere in the document. Hints built here are the user's own words and traces: the agent's instruction
// source, so every string is cleaned and every array capped.

import { DESIGN_LIMITS, DESIGN_MAX_POINTS_PER_STROKE, DESIGN_MAX_STROKES_PER_HINT } from "./limits.ts";
import { boxBlur3 } from "./resample.ts";
import { HINT_INTENTS } from "./types.ts";
import type { BrushStroke, MaskData, MaskHint, RasterData, Rect } from "./types.ts";
import { cleanText, isValidId } from "./util.ts";

type Pt = { x: number; y: number };

export const MAX_BRUSH_RADIUS = 4096;

function checkMask(mask: MaskData, what = "mask"): void {
  if (!Number.isInteger(mask.width) || !Number.isInteger(mask.height) || mask.width < 0 || mask.height < 0 || mask.alpha.length !== mask.width * mask.height) {
    throw new Error(`${what} is malformed`);
  }
}

const finitePoint = (p: { x: number; y: number }): boolean => Number.isFinite(p.x) && Number.isFinite(p.y);

/** Per-point radius factor: pressure clamped to 0..1 when present and finite, else 1. */
function pressure(p: { p?: number }): number {
  const v = p.p;
  if (typeof v !== "number" || !Number.isFinite(v)) return 1;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Stamp one capsule (segment a-b, radius ra at a and rb at b, linear in between) into the mask. */
function stampCapsule(mask: MaskData, ax: number, ay: number, ra: number, bx: number, by: number, rb: number, hardness: number, add: boolean): void {
  const rMax = Math.max(ra, rb);
  if (!(rMax > 0)) return;
  const w = mask.width, h = mask.height, alpha = mask.alpha;
  // Pixel centers are at (px + 0.5, py + 0.5) in the mask-local frame used here.
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - rMax - 0.5));
  const x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx) + rMax - 0.5));
  const y0 = Math.max(0, Math.floor(Math.min(ay, by) - rMax - 0.5));
  const y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by) + rMax - 0.5));
  if (x0 > x1 || y0 > y1) return;
  const vx = bx - ax, vy = by - ay;
  const len2 = vx * vx + vy * vy;
  const rMax2 = rMax * rMax;
  for (let py = y0; py <= y1; py++) {
    const cy = py + 0.5 - ay;
    const row = py * w;
    for (let px = x0; px <= x1; px++) {
      const cx = px + 0.5 - ax;
      let t = len2 > 0 ? (cx * vx + cy * vy) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = cx - t * vx, ey = cy - t * vy;
      const d2 = ex * ex + ey * ey;
      if (d2 >= rMax2) continue;
      const r = ra + (rb - ra) * t;
      const d = Math.sqrt(d2);
      if (d >= r) continue;
      // Falloff band: r * (1 - hardness), at least ~1px (or the whole radius when smaller) for antialiasing.
      const band = Math.min(r, Math.max(r * (1 - hardness), 1));
      const inner = r - band;
      let cov: number;
      if (d <= inner) cov = 1;
      else {
        const u = (r - d) / band;
        cov = u * u * (3 - 2 * u);
      }
      const v = Math.round(cov * 255);
      const i = row + px;
      if (add) {
        if (v > alpha[i]!) alpha[i] = v;
      } else {
        const keep = 255 - v;
        if (keep < alpha[i]!) alpha[i] = keep;
      }
    }
  }
}

/**
 * Rasterize a brush stroke (DOC coords) into `mask`, whose pixel (px, py) covers doc point
 * (px + offX + 0.5, py + offY + 0.5). The polyline is resampled by arc length at spacing <= radius / 4
 * (min 0.5px), keeping the first and last points, and capsules are stamped between consecutive samples
 * (radius interpolated linearly). A single point is a disc. add = max(existing, cov), subtract =
 * min(existing, 1 - cov). Non-finite points are ignored; radius must be finite, > 0, <= 4096.
 */
export function rasterizeStroke(mask: MaskData, stroke: BrushStroke, offX: number, offY: number): void {
  checkMask(mask);
  const R = stroke.radius;
  if (typeof R !== "number" || !Number.isFinite(R) || R <= 0 || R > MAX_BRUSH_RADIUS) throw new Error(`brush radius must be finite, > 0 and <= ${MAX_BRUSH_RADIUS}`);
  if (stroke.mode !== "add" && stroke.mode !== "subtract") throw new Error("brush mode must be add or subtract");
  if (!Number.isFinite(offX) || !Number.isFinite(offY)) throw new Error("mask offset must be finite");
  const hardness = Number.isFinite(stroke.hardness) ? Math.min(1, Math.max(0, stroke.hardness)) : 1;
  const add = stroke.mode === "add";
  const pts = Array.isArray(stroke.points) ? stroke.points.filter((p) => p && finitePoint(p)) : [];
  if (pts.length === 0 || mask.width === 0 || mask.height === 0) return;
  // Mask-local coordinates: doc point minus the mask offset.
  const first = pts[0]!;
  let px = first.x - offX, py = first.y - offY, pr = R * pressure(first);
  if (pts.length === 1) {
    stampCapsule(mask, px, py, pr, px, py, pr, hardness, add);
    return;
  }
  // Walk the polyline, emitting a sample every `step` of arc length (step tracks the local radius).
  let carry = 0; // arc length travelled since the last emitted sample
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!, b = pts[i]!;
    const axl = a.x - offX, ayl = a.y - offY, ra = R * pressure(a);
    const bxl = b.x - offX, byl = b.y - offY, rb = R * pressure(b);
    const segLen = Math.hypot(bxl - axl, byl - ayl);
    let pos = 0;
    while (true) {
      const rHere = ra + (rb - ra) * (segLen > 0 ? pos / segLen : 0);
      // segLen / 1024 bounds the work on a single huge segment with varying radius.
      const step = Math.max(0.5, Math.min(rHere, pr) / 4, segLen / 1024);
      const need = Math.max(0, step - carry);
      if (pos + need > segLen) {
        carry += segLen - pos;
        break;
      }
      pos += need;
      carry = 0;
      let t = segLen > 0 ? pos / segLen : 0;
      let nx = axl + (bxl - axl) * t, ny = ayl + (byl - ayl) * t, nr = ra + (rb - ra) * t;
      stampCapsule(mask, px, py, pr, nx, ny, nr, hardness, add);
      px = nx; py = ny; pr = nr;
      if (ra === rb && segLen > 0) {
        // Constant radius: one capsule to the last on-grid sample of this segment is exact, so jump there.
        const m = Math.floor((segLen - pos) / step);
        if (m >= 1) {
          pos += m * step;
          t = pos / segLen;
          nx = axl + (bxl - axl) * t; ny = ayl + (byl - ayl) * t; nr = ra;
          stampCapsule(mask, px, py, pr, nx, ny, nr, hardness, add);
          px = nx; py = ny; pr = nr;
        }
      }
    }
  }
  const last = pts[pts.length - 1]!;
  const lx = last.x - offX, ly = last.y - offY, lr = R * pressure(last);
  stampCapsule(mask, px, py, pr, lx, ly, lr, hardness, add);
}

/** Feathered copy of `mask`: three separable box-blur passes (gaussian approximation) with total support `radius`. radius 0 copies. */
export function featherMask(mask: MaskData, radius: number): MaskData {
  checkMask(mask);
  if (!Number.isFinite(radius) || radius < 0) throw new Error("feather radius must be finite and >= 0");
  const n = mask.width * mask.height;
  if (radius === 0 || n === 0) return { width: mask.width, height: mask.height, alpha: new Uint8Array(mask.alpha) };
  const plane = new Float32Array(n);
  for (let i = 0; i < n; i++) plane[i] = mask.alpha[i]!;
  boxBlur3(plane, mask.width, mask.height, radius);
  const alpha = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const v = Math.round(plane[i]!);
    alpha[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  return { width: mask.width, height: mask.height, alpha };
}

/**
 * 1-D van Herk / Gil-Werman running max (or min) over a window of 2k + 1, centered. `line` holds n values;
 * out-of-range samples act as the identity (0 for max, 255 for min) so borders neither grow nor erode.
 * g/hb are scratch buffers of at least n + 2k rounded up to a multiple of the window.
 */
function vhgwLine(line: Uint8Array, n: number, k: number, isMax: boolean, g: Uint8Array, hb: Uint8Array): void {
  const win = 2 * k + 1;
  const pad = isMax ? 0 : 255;
  const total = Math.ceil((n + 2 * k) / win) * win;
  // Padded sample p maps to line[p - k].
  for (let p = 0; p < total; p++) {
    const q = p - k;
    const v = q >= 0 && q < n ? line[q]! : pad;
    if (p % win === 0) g[p] = v;
    else {
      const prev = g[p - 1]!;
      g[p] = isMax ? (v > prev ? v : prev) : (v < prev ? v : prev);
    }
  }
  for (let p = total - 1; p >= 0; p--) {
    const q = p - k;
    const v = q >= 0 && q < n ? line[q]! : pad;
    if (p % win === win - 1) hb[p] = v;
    else {
      const next = hb[p + 1]!;
      hb[p] = isMax ? (v > next ? v : next) : (v < next ? v : next);
    }
  }
  // Window centered at x covers padded p = x .. x + 2k.
  for (let x = 0; x < n; x++) {
    const a = hb[x]!, b = g[x + 2 * k]!;
    line[x] = isMax ? (a > b ? a : b) : (a < b ? a : b);
  }
}

/**
 * Dilate (px > 0) or erode (px < 0) coverage by a (2k + 1)-square structuring element, k = round(|px|),
 * using the separable van Herk / Gil-Werman max/min filter (O(1) per pixel regardless of k). Grey-level:
 * operates on coverage values, so soft edges stay soft. Pixels outside the mask are the identity element.
 */
export function growShrinkMask(mask: MaskData, px: number): MaskData {
  checkMask(mask);
  if (!Number.isFinite(px)) throw new Error("grow/shrink amount must be finite");
  const w = mask.width, h = mask.height;
  const alpha = new Uint8Array(mask.alpha);
  const k = Math.min(Math.round(Math.abs(px)), Math.max(w, h));
  if (k === 0 || w === 0 || h === 0) return { width: w, height: h, alpha };
  const isMax = px > 0;
  const longest = Math.max(w, h);
  const cap = Math.ceil((longest + 2 * k) / (2 * k + 1)) * (2 * k + 1);
  const g = new Uint8Array(cap), hb = new Uint8Array(cap), line = new Uint8Array(longest);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    line.set(alpha.subarray(row, row + w));
    vhgwLine(line, w, k, isMax, g, hb);
    alpha.set(line.subarray(0, w), row);
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) line[y] = alpha[y * w + x]!;
    vhgwLine(line, h, k, isMax, g, hb);
    for (let y = 0; y < h; y++) alpha[y * w + x] = line[y]!;
  }
  return { width: w, height: h, alpha };
}

/** Bounding box (mask pixels) of alpha >= threshold, or null when none. */
export function maskBBox(mask: MaskData, threshold = 1): Rect | null {
  checkMask(mask);
  const w = mask.width, h = mask.height, a = mask.alpha;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (a[row + x]! >= threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Number of pixels with alpha >= threshold. */
export function maskArea(mask: MaskData, threshold = 128): number {
  checkMask(mask);
  let n = 0;
  const a = mask.alpha;
  for (let i = 0; i < a.length; i++) if (a[i]! >= threshold) n++;
  return n;
}

/**
 * Marching squares over the binarized mask (alpha >= threshold) padded with a 0 border, so every contour
 * closes. Samples sit at pixel centers; contour points are edge midpoints, i.e. (integer x, half y) or
 * (half x, integer y): a filled rectangle of pixels [x0, x0 + w) traces at x = x0 .. x0 + w. Saddles keep
 * diagonal foreground pixels separate (4-connected foreground). Contours run with the inside on the right
 * (y down), outer boundaries and holes alike, each a closed loop listed once without a repeated closing
 * point, ordered by the scan position of their first cell. Total points are capped at maxPathCmds: only
 * complete loops are returned.
 */
export function traceContours(mask: MaskData, threshold = 128): { x: number; y: number }[][] {
  checkMask(mask);
  const W = mask.width, H = mask.height, A = mask.alpha;
  const cap = DESIGN_LIMITS.maxPathCmds;
  const segCap = cap * 4;
  const GW = W + 2; // padded sample columns (index I = i + 1 for i in -1..W)
  const inside = (i: number, j: number): number => (i < 0 || j < 0 || i >= W || j >= H ? 0 : A[j * W + i]! >= threshold ? 1 : 0);
  // Crossing ids: horizontal crossing between samples (i, j) and (i + 1, j) -> even; vertical between
  // (i, j) and (i, j + 1) -> odd. Keyed by the first sample's padded index.
  const hId = (i: number, j: number): number => ((j + 1) * GW + (i + 1)) * 2;
  const vId = (i: number, j: number): number => ((j + 1) * GW + (i + 1)) * 2 + 1;
  const next = new Map<number, number>();
  outer: for (let j = -1; j < H; j++) {
    for (let i = -1; i < W; i++) {
      const code = inside(i, j) * 8 + inside(i + 1, j) * 4 + inside(i + 1, j + 1) * 2 + inside(i, j + 1);
      if (code === 0 || code === 15) continue;
      const T = hId(i, j), B = hId(i, j + 1), L = vId(i, j), R = vId(i + 1, j);
      switch (code) {
        case 1: next.set(L, B); break;
        case 2: next.set(B, R); break;
        case 3: next.set(L, R); break;
        case 4: next.set(R, T); break;
        case 5: next.set(R, T); next.set(L, B); break;
        case 6: next.set(B, T); break;
        case 7: next.set(L, T); break;
        case 8: next.set(T, L); break;
        case 9: next.set(T, B); break;
        case 10: next.set(T, L); next.set(B, R); break;
        case 11: next.set(T, R); break;
        case 12: next.set(R, L); break;
        case 13: next.set(R, B); break;
        case 14: next.set(B, L); break;
      }
      if (next.size > segCap) break outer;
    }
  }
  const out: Pt[][] = [];
  let total = 0;
  for (const start of next.keys()) {
    if (!next.has(start)) continue;
    const loop: Pt[] = [];
    let cur = start, closed = false;
    while (true) {
      const cell = Math.floor(cur / 2);
      const I = cell % GW, J = Math.floor(cell / GW);
      if (cur % 2 === 0) loop.push({ x: I, y: J - 0.5 });
      else loop.push({ x: I - 0.5, y: J });
      const nx = next.get(cur);
      next.delete(cur);
      if (nx === undefined) break;
      if (nx === start) { closed = true; break; }
      cur = nx;
    }
    if (!closed) continue; // truncated by the segment cap
    if (total + loop.length > cap) break;
    total += loop.length;
    out.push(loop);
  }
  return out;
}

/** Ramer-Douglas-Peucker simplification, iterative (explicit stack). Keeps the first and last points. */
export function simplifyPolyline(pts: { x: number; y: number }[], tolerance: number): { x: number; y: number }[] {
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error("tolerance must be finite and >= 0");
  const n = pts.length;
  if (n <= 2) return pts.map((p) => ({ x: p.x, y: p.y }));
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const tol2 = tolerance * tolerance;
  const stack: number[] = [0, n - 1];
  while (stack.length > 0) {
    const hi = stack.pop()!, lo = stack.pop()!;
    if (hi - lo < 2) continue;
    const a = pts[lo]!, b = pts[hi]!;
    const vx = b.x - a.x, vy = b.y - a.y;
    const len2 = vx * vx + vy * vy;
    let best = -1, bestD = -1;
    for (let i = lo + 1; i < hi; i++) {
      const p = pts[i]!;
      const wx = p.x - a.x, wy = p.y - a.y;
      let d2: number;
      if (len2 === 0) d2 = wx * wx + wy * wy;
      else {
        const cross = vx * wy - vy * wx;
        d2 = (cross * cross) / len2; // squared distance to the infinite line, per classic RDP
      }
      if (d2 > bestD) { bestD = d2; best = i; }
    }
    if (bestD > tol2) {
      keep[best] = 1;
      stack.push(lo, best, best, hi);
    }
  }
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push({ x: pts[i]!.x, y: pts[i]!.y });
  return out;
}

/** New raster with alpha multiplied by mask coverage; the mask sits at integer (dx, dy) in raster space and outside it alpha is 0. */
export function applyMask(raster: RasterData, mask: MaskData, dx: number, dy: number): RasterData {
  checkMask(mask);
  if (!Number.isInteger(raster.width) || !Number.isInteger(raster.height) || raster.rgba.length !== raster.width * raster.height * 4) throw new Error("raster is malformed");
  if (!Number.isInteger(dx) || !Number.isInteger(dy)) throw new Error("mask offset must be integers");
  const w = raster.width, h = raster.height;
  const rgba = new Uint8ClampedArray(raster.rgba);
  for (let y = 0; y < h; y++) {
    const my = y - dy;
    const rowIn = my >= 0 && my < mask.height;
    for (let x = 0; x < w; x++) {
      const ai = (y * w + x) * 4 + 3;
      const mx = x - dx;
      const cov = rowIn && mx >= 0 && mx < mask.width ? mask.alpha[my * mask.width + mx]! : 0;
      rgba[ai] = Math.round((rgba[ai]! * cov) / 255);
    }
  }
  return { width: w, height: h, rgba };
}

export function invertMask(mask: MaskData): MaskData {
  checkMask(mask);
  const alpha = new Uint8Array(mask.alpha.length);
  for (let i = 0; i < alpha.length; i++) alpha[i] = 255 - mask.alpha[i]!;
  return { width: mask.width, height: mask.height, alpha };
}

/** Same-size masks only. add = max(a, b), subtract = min(a, 255 - b), intersect = min(a, b). */
export function combineMasks(a: MaskData, b: MaskData, op: "add" | "subtract" | "intersect"): MaskData {
  checkMask(a, "first mask");
  checkMask(b, "second mask");
  if (a.width !== b.width || a.height !== b.height) throw new Error("masks must have the same dimensions");
  if (op !== "add" && op !== "subtract" && op !== "intersect") throw new Error("unknown mask op");
  const n = a.alpha.length;
  const alpha = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const va = a.alpha[i]!, vb = b.alpha[i]!;
    if (op === "add") alpha[i] = va > vb ? va : vb;
    else if (op === "subtract") alpha[i] = Math.min(va, 255 - vb);
    else alpha[i] = va < vb ? va : vb;
  }
  return { width: a.width, height: a.height, alpha };
}

function randomSuffix(): string {
  const bytes = new Uint8Array(8);
  const c = globalThis.crypto;
  if (typeof c?.getRandomValues === "function") c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += (bytes[i]! % 36).toString(36);
  return s;
}

/** Deep copy of strokes with caps: finite points only, radius clamped to (0, 4096], hardness and pressure to 0..1. */
function sanitizeStrokes(strokes: BrushStroke[]): BrushStroke[] {
  const out: BrushStroke[] = [];
  if (!Array.isArray(strokes)) return out;
  for (const s of strokes) {
    if (out.length >= DESIGN_MAX_STROKES_PER_HINT) break;
    if (!s || (s.mode !== "add" && s.mode !== "subtract")) continue;
    if (typeof s.radius !== "number" || !Number.isFinite(s.radius) || s.radius <= 0) continue;
    if (!Array.isArray(s.points)) continue;
    const points: BrushStroke["points"] = [];
    for (const p of s.points) {
      if (points.length >= DESIGN_MAX_POINTS_PER_STROKE) break;
      if (!p || typeof p.x !== "number" || typeof p.y !== "number" || !finitePoint(p)) continue;
      const q: BrushStroke["points"][number] = { x: p.x, y: p.y };
      if (typeof p.p === "number" && Number.isFinite(p.p)) q.p = Math.min(1, Math.max(0, p.p));
      points.push(q);
    }
    if (points.length === 0) continue;
    const hardness = typeof s.hardness === "number" && Number.isFinite(s.hardness) ? Math.min(1, Math.max(0, s.hardness)) : 1;
    out.push({ points, radius: Math.min(MAX_BRUSH_RADIUS, s.radius), hardness, mode: s.mode });
  }
  return out;
}

/**
 * Build a MaskHint from the user's traced strokes and typed label. The mask sits at (offX, offY) in DOC
 * coords; bbox is reported in DOC coords ({0,0,0,0} when the mask is empty). Throws on a bad maskId or intent.
 */
export function hintFromStrokes(maskId: string, strokes: BrushStroke[], label: string, intent: MaskHint["intent"], mask: MaskData, offX: number, offY: number): MaskHint {
  if (!isValidId(maskId)) throw new Error("invalid mask id");
  if (!HINT_INTENTS.includes(intent)) throw new Error("invalid hint intent");
  if (!Number.isFinite(offX) || !Number.isFinite(offY)) throw new Error("mask offset must be finite");
  const id = `hint_${randomSuffix()}`;
  if (!isValidId(id)) throw new Error("hint id generation failed");
  const box = maskBBox(mask);
  return {
    id,
    maskId,
    label: cleanText(label, DESIGN_LIMITS.maxLabel),
    intent,
    strokes: sanitizeStrokes(strokes),
    bbox: box ? { x: box.x + offX, y: box.y + offY, w: box.w, h: box.h } : { x: 0, y: 0, w: 0, h: 0 },
    area: maskArea(mask),
    createdAt: Date.now(),
  };
}

/** Point at arc length `s` along a polyline with cumulative lengths `cum`. */
function pointAt(pts: Pt[], cum: Float64Array, s: number): [number, number] {
  let lo = 0, hi = pts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid]! <= s) lo = mid; else hi = mid;
  }
  const a = pts[lo]!, b = pts[hi]!;
  const segLen = cum[hi]! - cum[lo]!;
  const t = segLen > 0 ? Math.min(1, Math.max(0, (s - cum[lo]!) / segLen)) : 0;
  return [Math.round(a.x + (b.x - a.x) * t), Math.round(a.y + (b.y - a.y) * t)];
}

/**
 * SAM point/box prompts from brush strokes (DOC coords, rounded to ints). Each stroke is sampled evenly by
 * arc length with spacing >= its radius; add strokes give positive points, subtract strokes negative. The
 * total is capped at `max`: every non-empty stroke gets one point while the budget allows, the rest is
 * split proportionally to each stroke's remaining demand. box = union of ADD strokes expanded by their
 * radius (all strokes when there is no add stroke), [x0, y0, x1, y1]; [0, 0, 0, 0] when nothing is usable.
 */
export function strokesToPrompts(strokes: BrushStroke[], max = 64): { positive: [number, number][]; negative: [number, number][]; box: [number, number, number, number] } {
  const budgetMax = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 0;
  const usable: { pts: Pt[]; cum: Float64Array; radius: number; add: boolean; demand: number }[] = [];
  for (const s of Array.isArray(strokes) ? strokes : []) {
    if (!s || (s.mode !== "add" && s.mode !== "subtract") || !Array.isArray(s.points)) continue;
    const pts: Pt[] = [];
    for (const p of s.points) {
      if (pts.length >= DESIGN_MAX_POINTS_PER_STROKE) break;
      if (p && typeof p.x === "number" && typeof p.y === "number" && finitePoint(p)) pts.push({ x: p.x, y: p.y });
    }
    if (pts.length === 0) continue;
    const radius = typeof s.radius === "number" && Number.isFinite(s.radius) && s.radius > 0 ? Math.min(MAX_BRUSH_RADIUS, s.radius) : 0;
    const cum = new Float64Array(pts.length);
    for (let i = 1; i < pts.length; i++) cum[i] = cum[i - 1]! + Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
    const len = cum[pts.length - 1]!;
    const demand = Math.floor(len / Math.max(1, radius)) + 1;
    usable.push({ pts, cum, radius, add: s.mode === "add", demand });
  }
  // Allocate the point budget.
  const alloc = new Array<number>(usable.length).fill(0);
  let budget = budgetMax;
  for (let i = 0; i < usable.length && budget > 0; i++) { alloc[i] = 1; budget--; }
  let extra = 0;
  for (let i = 0; i < usable.length; i++) if (alloc[i]) extra += usable[i]!.demand - 1;
  if (extra <= budget) {
    for (let i = 0; i < usable.length; i++) if (alloc[i]) alloc[i] = usable[i]!.demand;
  } else if (budget > 0) {
    let given = 0;
    for (let i = 0; i < usable.length; i++) {
      if (!alloc[i]) continue;
      const share = Math.floor(((usable[i]!.demand - 1) * budget) / extra);
      alloc[i] = alloc[i]! + share;
      given += share;
    }
    for (let i = 0; i < usable.length && given < budget; i++) {
      if (alloc[i] && alloc[i]! < usable[i]!.demand) { alloc[i] = alloc[i]! + 1; given++; }
    }
  }
  const positive: [number, number][] = [];
  const negative: [number, number][] = [];
  for (let i = 0; i < usable.length; i++) {
    const k = alloc[i]!;
    if (k === 0) continue;
    const u = usable[i]!;
    const len = u.cum[u.pts.length - 1]!;
    const target = u.add ? positive : negative;
    if (k === 1) target.push(pointAt(u.pts, u.cum, len / 2));
    else for (let j = 0; j < k; j++) target.push(pointAt(u.pts, u.cum, (len * j) / (k - 1)));
  }
  const anyAdd = usable.some((u) => u.add);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const u of usable) {
    if (anyAdd && !u.add) continue;
    for (const p of u.pts) {
      if (p.x - u.radius < x0) x0 = p.x - u.radius;
      if (p.y - u.radius < y0) y0 = p.y - u.radius;
      if (p.x + u.radius > x1) x1 = p.x + u.radius;
      if (p.y + u.radius > y1) y1 = p.y + u.radius;
    }
  }
  const box: [number, number, number, number] = x0 === Infinity ? [0, 0, 0, 0] : [Math.floor(x0), Math.floor(y0), Math.ceil(x1), Math.ceil(y1)];
  return { positive, negative, box };
}
