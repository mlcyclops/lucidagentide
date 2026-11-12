// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/creator/design/resample.ts - Lanczos-3 resize, resize planning, unsharp mask, box blur.
//
// Resizing is separable (horizontal pass into a Float32 intermediate, then vertical) on premultiplied
// color so transparent pixels never bleed dark fringes. When shrinking, the kernel is stretched by the
// downscale factor, which makes it an area (anti-aliasing) filter instead of a point sampler.

import { DESIGN_LIMITS } from "./limits.ts";
import type { RasterData } from "./types.ts";

const LANCZOS_A = 3;

function lanczos3(x: number): number {
  if (x === 0) return 1;
  if (x <= -LANCZOS_A || x >= LANCZOS_A) return 0;
  const px = Math.PI * x;
  return (LANCZOS_A * Math.sin(px) * Math.sin(px / LANCZOS_A)) / (px * px);
}

interface WeightTable { start: Int32Array; count: Int32Array; weights: Float32Array; taps: number }

/** Normalized Lanczos-3 weights mapping srcN samples to dstN samples (pixel centers aligned). */
function buildWeights(srcN: number, dstN: number): WeightTable {
  const scale = srcN / dstN;
  const filterScale = Math.max(1, scale);
  const support = LANCZOS_A * filterScale;
  const taps = Math.ceil(support * 2) + 1;
  const start = new Int32Array(dstN);
  const count = new Int32Array(dstN);
  const weights = new Float32Array(dstN * taps);
  for (let i = 0; i < dstN; i++) {
    const center = (i + 0.5) * scale - 0.5;
    const lo = Math.max(0, Math.ceil(center - support));
    const hi = Math.min(srcN - 1, Math.floor(center + support));
    let n = 0, sum = 0;
    const base = i * taps;
    for (let j = lo; j <= hi && n < taps; j++, n++) {
      const w = lanczos3((j - center) / filterScale);
      weights[base + n] = w;
      sum += w;
    }
    if (sum !== 0) for (let k = 0; k < n; k++) weights[base + k] = weights[base + k]! / sum;
    start[i] = lo;
    count[i] = n;
  }
  return { start, count, weights, taps };
}

function checkTarget(w: number, h: number): void {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > DESIGN_LIMITS.maxSide || h > DESIGN_LIMITS.maxSide) {
    throw new Error("resize target must be integers 1..maxSide");
  }
  if (w * h > DESIGN_LIMITS.maxRasterPixels) throw new Error("resize target exceeds the pixel limit");
}

function checkSource(src: RasterData): void {
  if (!Number.isInteger(src.width) || !Number.isInteger(src.height) || src.width < 1 || src.height < 1 || src.rgba.length !== src.width * src.height * 4) {
    throw new Error("source raster is malformed");
  }
}

/** Separable Lanczos-3 resample of a straight RGBA raster to w x h. Identity size returns an exact copy. */
export function resampleLanczos3(src: RasterData, w: number, h: number): RasterData {
  checkSource(src);
  checkTarget(w, h);
  const sw = src.width, sh = src.height;
  if (sw === w && sh === h) return { width: w, height: h, rgba: new Uint8ClampedArray(src.rgba) };
  const s = src.rgba;
  // Premultiply (color scaled by alpha / 255, still in 0..255 units).
  const pre = new Float32Array(sw * sh * 4);
  for (let i = 0; i < pre.length; i += 4) {
    const a = s[i + 3]!;
    const k = a / 255;
    pre[i] = s[i]! * k;
    pre[i + 1] = s[i + 1]! * k;
    pre[i + 2] = s[i + 2]! * k;
    pre[i + 3] = a;
  }
  // Horizontal pass: sw x sh -> w x sh.
  const hx = buildWeights(sw, w);
  const mid = new Float32Array(w * sh * 4);
  for (let y = 0; y < sh; y++) {
    const row = y * sw * 4;
    for (let x = 0; x < w; x++) {
      const base = x * hx.taps, n = hx.count[x]!;
      let si = row + hx.start[x]! * 4;
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = 0; k < n; k++, si += 4) {
        const wt = hx.weights[base + k]!;
        r += pre[si]! * wt; g += pre[si + 1]! * wt; b += pre[si + 2]! * wt; a += pre[si + 3]! * wt;
      }
      const di = (y * w + x) * 4;
      mid[di] = r; mid[di + 1] = g; mid[di + 2] = b; mid[di + 3] = a;
    }
  }
  // Vertical pass: w x sh -> w x h, then un-premultiply and clamp.
  const vy = buildWeights(sh, h);
  const out = new Uint8ClampedArray(w * h * 4);
  const stride = w * 4;
  for (let y = 0; y < h; y++) {
    const base = y * vy.taps, n = vy.count[y]!, y0 = vy.start[y]!;
    for (let x = 0; x < w; x++) {
      let si = y0 * stride + x * 4;
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = 0; k < n; k++, si += stride) {
        const wt = vy.weights[base + k]!;
        r += mid[si]! * wt; g += mid[si + 1]! * wt; b += mid[si + 2]! * wt; a += mid[si + 3]! * wt;
      }
      const di = (y * w + x) * 4;
      const a8 = Math.round(a < 0 ? 0 : a > 255 ? 255 : a);
      if (a8 === 0) continue; // fully transparent: leave 0,0,0,0
      const inv = 255 / (a > 255 ? 255 : a);
      out[di] = Math.round(r * inv);
      out[di + 1] = Math.round(g * inv);
      out[di + 2] = Math.round(b * inv);
      out[di + 3] = a8;
    }
  }
  return { width: w, height: h, rgba: out };
}

export type ResizeRequest = { width?: number; height?: number; scale?: number; keepAspect: boolean };

/**
 * Turn a resize request into target dimensions. `scale` wins when given. With keepAspect and only one of
 * width/height, the other is derived with Math.round (min 1). Refuses non-finite, <= 0, sides over
 * maxSide, and areas over maxRasterPixels.
 */
export function planResize(srcW: number, srcH: number, req: ResizeRequest): { width: number; height: number } | { error: string } {
  if (!Number.isInteger(srcW) || !Number.isInteger(srcH) || srcW < 1 || srcH < 1) return { error: "source size must be positive integers" };
  const positive = (v: number | undefined): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
  let width: number, height: number;
  if (req.scale !== undefined) {
    if (!positive(req.scale)) return { error: "scale must be a finite number > 0" };
    width = Math.max(1, Math.round(srcW * req.scale));
    height = Math.max(1, Math.round(srcH * req.scale));
  } else {
    const hasW = req.width !== undefined, hasH = req.height !== undefined;
    if (!hasW && !hasH) return { error: "width, height, or scale is required" };
    if (hasW && !positive(req.width)) return { error: "width must be a finite number > 0" };
    if (hasH && !positive(req.height)) return { error: "height must be a finite number > 0" };
    if (hasW && hasH) {
      width = Math.round(req.width!);
      height = Math.round(req.height!);
    } else if (hasW) {
      width = Math.round(req.width!);
      height = req.keepAspect ? Math.round((width * srcH) / srcW) : srcH;
    } else {
      height = Math.round(req.height!);
      width = req.keepAspect ? Math.round((height * srcW) / srcH) : srcW;
    }
    width = Math.max(1, width);
    height = Math.max(1, height);
  }
  if (width > DESIGN_LIMITS.maxSide || height > DESIGN_LIMITS.maxSide) return { error: `side exceeds ${DESIGN_LIMITS.maxSide}` };
  if (width * height > DESIGN_LIMITS.maxRasterPixels) return { error: "area exceeds the pixel limit" };
  return { width, height };
}

/** Sliding-window box average of n samples (stride apart) with half-width k, clamp-to-edge. */
function boxLine(plane: Float32Array, off: number, stride: number, n: number, k: number, line: Float32Array): void {
  for (let i = 0, p = off; i < n; i++, p += stride) line[i] = plane[p]!;
  const last = n - 1;
  let sum = 0;
  for (let j = -k; j <= k; j++) sum += line[j < 0 ? 0 : j > last ? last : j]!;
  const inv = 1 / (2 * k + 1);
  for (let i = 0, p = off; i < n; i++, p += stride) {
    plane[p] = sum * inv;
    const add = i + k + 1, sub = i - k;
    sum += line[add > last ? last : add]! - line[sub < 0 ? 0 : sub]!;
  }
}

/**
 * Three passes of a separable box blur (approximates a gaussian) over a w x h float plane in place.
 * `radius` is the total support in pixels: each pass uses half-width max(1, round(radius / 3)).
 * Edges clamp (replicate). radius <= 0 leaves the plane unchanged.
 */
export function boxBlur3(plane: Float32Array, w: number, h: number, radius: number): void {
  if (!(radius > 0) || w < 1 || h < 1) return;
  const k = Math.min(Math.max(1, Math.round(radius / 3)), Math.max(w, h));
  const line = new Float32Array(Math.max(w, h));
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < h; y++) boxLine(plane, y * w, 1, w, k, line);
    for (let x = 0; x < w; x++) boxLine(plane, x, w, h, k, line);
  }
}

/** Unsharp mask: out = src + amount * (src - blur(src)) on RGB (3-box blur of `radius`); alpha untouched. */
export function unsharp(src: RasterData, amount: number, radius: number): RasterData {
  checkSource(src);
  if (!Number.isFinite(amount) || !Number.isFinite(radius) || radius < 0) throw new Error("unsharp amount and radius must be finite (radius >= 0)");
  const out = new Uint8ClampedArray(src.rgba);
  if (amount === 0 || radius === 0) return { width: src.width, height: src.height, rgba: out };
  const n = src.width * src.height;
  const plane = new Float32Array(n);
  const s = src.rgba;
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < n; i++) plane[i] = s[i * 4 + c]!;
    boxBlur3(plane, src.width, src.height, radius);
    for (let i = 0; i < n; i++) {
      const v = s[i * 4 + c]!;
      out[i * 4 + c] = Math.round(v + amount * (v - plane[i]!)); // Uint8ClampedArray clamps 0..255
    }
  }
  return { width: src.width, height: src.height, rgba: out };
}
