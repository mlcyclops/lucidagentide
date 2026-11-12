// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/creator/design/blend.ts - W3C Compositing and Blending Level 1 on straight RGBA8 rasters.
//
// Formulas follow https://www.w3.org/TR/compositing-1/ : section 10.1 (separable blend modes), 10.2
// (non-separable modes via Lum / ClipColor / SetLum / Sat / SetSat with Lum weights 0.3, 0.59, 0.11),
// section 5.2 / 9.1.4 (the general blending formula Cs' = (1 - ab) * Cs + ab * B(Cb, Cs)) and the
// source-over Porter-Duff operator (co = cs + cb * (1 - as), ao = as + ab * (1 - as), premultiplied).

import type { BlendMode, MaskData, RasterData } from "./types.ts";

type Rgb = [number, number, number];

const NON_SEPARABLE: ReadonlySet<BlendMode> = new Set<BlendMode>(["hue", "saturation", "color", "luminosity"]);

function softLightD(cb: number): number {
  return cb <= 0.25 ? ((16 * cb - 12) * cb + 4) * cb : Math.sqrt(cb);
}

function hardLight(cb: number, cs: number): number {
  // Multiply(Cb, 2 * Cs) or Screen(Cb, 2 * Cs - 1).
  if (cs <= 0.5) return cb * 2 * cs;
  const s = 2 * cs - 1;
  return cb + s - cb * s;
}

/**
 * Separable blend function B(Cb, Cs) on normalized 0..1 channels (W3C section 10.1). The four
 * non-separable modes (hue, saturation, color, luminosity) operate on whole colors, so passing one here
 * throws: use blendNonSeparable instead.
 */
export function blendChannel(mode: BlendMode, cb: number, cs: number): number {
  switch (mode) {
    case "normal": return cs;
    case "multiply": return cb * cs;
    case "screen": return cb + cs - cb * cs;
    case "overlay": return hardLight(cs, cb);
    case "darken": return Math.min(cb, cs);
    case "lighten": return Math.max(cb, cs);
    case "color-dodge":
      if (cb === 0) return 0;
      if (cs >= 1) return 1;
      return Math.min(1, cb / (1 - cs));
    case "color-burn":
      if (cb >= 1) return 1;
      if (cs <= 0) return 0;
      return 1 - Math.min(1, (1 - cb) / cs);
    case "hard-light": return hardLight(cb, cs);
    case "soft-light":
      if (cs <= 0.5) return cb - (1 - 2 * cs) * cb * (1 - cb);
      return cb + (2 * cs - 1) * (softLightD(cb) - cb);
    case "difference": return Math.abs(cb - cs);
    case "exclusion": return cb + cs - 2 * cb * cs;
    default: throw new Error(`blendChannel: ${mode} is not a separable blend mode`);
  }
}

// In-place helpers on a 3-element scratch buffer (no allocation in the per-pixel loop).

function lum(r: number, g: number, b: number): number {
  return 0.3 * r + 0.59 * g + 0.11 * b;
}

/** ClipColor(C) exactly per spec: n and x are taken before either correction. */
function clipColorInto(c: Float64Array): void {
  const r = c[0]!, g = c[1]!, b = c[2]!;
  const l = lum(r, g, b);
  const n = Math.min(r, g, b);
  const x = Math.max(r, g, b);
  if (n < 0 && l - n > 0) {
    const k = l / (l - n);
    c[0] = l + (c[0]! - l) * k;
    c[1] = l + (c[1]! - l) * k;
    c[2] = l + (c[2]! - l) * k;
  }
  if (x > 1 && x - l > 0) {
    const k = (1 - l) / (x - l);
    c[0] = l + (c[0]! - l) * k;
    c[1] = l + (c[1]! - l) * k;
    c[2] = l + (c[2]! - l) * k;
  }
}

/** SetLum(C, l): shift by d = l - Lum(C), then ClipColor. */
function setLumInto(c: Float64Array, l: number): void {
  const d = l - lum(c[0]!, c[1]!, c[2]!);
  c[0] = c[0]! + d;
  c[1] = c[1]! + d;
  c[2] = c[2]! + d;
  clipColorInto(c);
}

/** SetSat(C, s): Cmid scaled into 0..s, Cmax = s, Cmin = 0 (all 0 when the color is gray). */
function setSatInto(c: Float64Array, s: number): void {
  const r = c[0]!, g = c[1]!, b = c[2]!;
  let iMax: number, iMid: number, iMin: number;
  if (r >= g) {
    if (g >= b) { iMax = 0; iMid = 1; iMin = 2; } else if (r >= b) { iMax = 0; iMid = 2; iMin = 1; } else { iMax = 2; iMid = 0; iMin = 1; }
  } else if (r >= b) { iMax = 1; iMid = 0; iMin = 2; } else if (g >= b) { iMax = 1; iMid = 2; iMin = 0; } else { iMax = 2; iMid = 1; iMin = 0; }
  const cMax = c[iMax]!, cMid = c[iMid]!, cMin = c[iMin]!;
  if (cMax > cMin) {
    c[iMid] = ((cMid - cMin) * s) / (cMax - cMin);
    c[iMax] = s;
  } else {
    c[iMid] = 0;
    c[iMax] = 0;
  }
  c[iMin] = 0;
}

/** Non-separable B(Cb, Cs) into `out` (W3C section 10.2). */
function nonSeparableInto(mode: BlendMode, br: number, bg: number, bb: number, sr: number, sg: number, sb: number, out: Float64Array): void {
  switch (mode) {
    case "hue": // SetLum(SetSat(Cs, Sat(Cb)), Lum(Cb))
      out[0] = sr; out[1] = sg; out[2] = sb;
      setSatInto(out, Math.max(br, bg, bb) - Math.min(br, bg, bb));
      setLumInto(out, lum(br, bg, bb));
      return;
    case "saturation": // SetLum(SetSat(Cb, Sat(Cs)), Lum(Cb))
      out[0] = br; out[1] = bg; out[2] = bb;
      setSatInto(out, Math.max(sr, sg, sb) - Math.min(sr, sg, sb));
      setLumInto(out, lum(br, bg, bb));
      return;
    case "color": // SetLum(Cs, Lum(Cb))
      out[0] = sr; out[1] = sg; out[2] = sb;
      setLumInto(out, lum(br, bg, bb));
      return;
    case "luminosity": // SetLum(Cb, Lum(Cs))
      out[0] = br; out[1] = bg; out[2] = bb;
      setLumInto(out, lum(sr, sg, sb));
      return;
    default: throw new Error(`blendNonSeparable: ${mode} is not a non-separable blend mode`);
  }
}

/** Non-separable blend (hue, saturation, color, luminosity) of backdrop `cb` and source `cs`, channels 0..1. */
export function blendNonSeparable(mode: BlendMode, cb: Rgb, cs: Rgb): Rgb {
  const out = new Float64Array(3);
  nonSeparableInto(mode, cb[0], cb[1], cb[2], cs[0], cs[1], cs[2], out);
  return [out[0]!, out[1]!, out[2]!];
}

export interface CompositeOptions {
  blend: BlendMode;
  opacity: number;
  dx: number;
  dy: number;
  mask?: MaskData;
  maskDx?: number;
  maskDy?: number;
}

function checkRaster(r: RasterData, what: string): void {
  if (!Number.isInteger(r.width) || !Number.isInteger(r.height) || r.width < 0 || r.height < 0 || r.rgba.length !== r.width * r.height * 4) {
    throw new Error(`${what} raster is malformed`);
  }
}

const to8 = (v: number): number => (v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255));

/**
 * Composite `src` (placed at integer dx, dy in dst space) onto `dst` in place: blend per the general
 * formula, then source-over. Effective source alpha = srcA * opacity * mask coverage; the mask is placed
 * at (maskDx, maskDy) in dst space (default 0, 0) and coverage outside it is 0.
 */
export function compositeInto(dst: RasterData, src: RasterData, opts: CompositeOptions): void {
  checkRaster(dst, "destination");
  checkRaster(src, "source");
  const { blend, dx, dy } = opts;
  const maskDx = opts.maskDx ?? 0, maskDy = opts.maskDy ?? 0;
  if (!Number.isInteger(dx) || !Number.isInteger(dy) || !Number.isInteger(maskDx) || !Number.isInteger(maskDy)) {
    throw new Error("composite offsets must be integers");
  }
  const mask = opts.mask;
  if (mask && (!Number.isInteger(mask.width) || !Number.isInteger(mask.height) || mask.width < 0 || mask.height < 0 || mask.alpha.length !== mask.width * mask.height)) {
    throw new Error("mask is malformed");
  }
  const opacity = Number.isFinite(opts.opacity) ? Math.min(1, Math.max(0, opts.opacity)) : 0;
  if (opacity === 0) return;
  const nonSep = NON_SEPARABLE.has(blend);
  if (!nonSep) blendChannel(blend, 0, 0); // throws for an unknown mode before touching pixels
  const isNormal = blend === "normal";
  const scratch = new Float64Array(3);
  const x0 = Math.max(0, dx), x1 = Math.min(dst.width, dx + src.width);
  const y0 = Math.max(0, dy), y1 = Math.min(dst.height, dy + src.height);
  const d = dst.rgba, s = src.rgba;
  const opa = opacity / 255;
  for (let y = y0; y < y1; y++) {
    const my = y - maskDy;
    const maskRowOk = !mask || (my >= 0 && my < mask.height);
    if (!maskRowOk) continue;
    for (let x = x0; x < x1; x++) {
      let as = s[((y - dy) * src.width + (x - dx)) * 4 + 3]! * opa;
      if (mask) {
        const mx = x - maskDx;
        if (mx < 0 || mx >= mask.width) continue;
        as *= mask.alpha[my * mask.width + mx]! / 255;
      }
      if (as <= 0) continue;
      const si = ((y - dy) * src.width + (x - dx)) * 4;
      const di = (y * dst.width + x) * 4;
      const ab = d[di + 3]! / 255;
      const sr = s[si]! / 255, sg = s[si + 1]! / 255, sb = s[si + 2]! / 255;
      const br = d[di]! / 255, bg = d[di + 1]! / 255, bb = d[di + 2]! / 255;
      let rr: number, rg: number, rb: number;
      if (isNormal || ab === 0) {
        rr = sr; rg = sg; rb = sb;
      } else {
        let xr: number, xg: number, xb: number;
        if (nonSep) {
          nonSeparableInto(blend, br, bg, bb, sr, sg, sb, scratch);
          xr = scratch[0]!; xg = scratch[1]!; xb = scratch[2]!;
        } else {
          xr = blendChannel(blend, br, sr); xg = blendChannel(blend, bg, sg); xb = blendChannel(blend, bb, sb);
        }
        // Cs' = (1 - ab) * Cs + ab * B(Cb, Cs)
        rr = (1 - ab) * sr + ab * xr;
        rg = (1 - ab) * sg + ab * xg;
        rb = (1 - ab) * sb + ab * xb;
      }
      // source-over, premultiplied: co = as * Cs' + ab * Cb * (1 - as); ao = as + ab * (1 - as)
      const k = ab * (1 - as);
      const ao = as + k;
      d[di] = to8((as * rr + k * br) / ao);
      d[di + 1] = to8((as * rg + k * bg) / ao);
      d[di + 2] = to8((as * rb + k * bb) / ao);
      d[di + 3] = to8(ao);
    }
  }
}
