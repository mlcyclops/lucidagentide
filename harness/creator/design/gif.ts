// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/creator/design/gif.ts - animated GIF89a encoder with a native color quantizer.
//
// Format: W3C/CompuServe GIF89a (www.w3.org/Graphics/GIF/spec-gif89a.txt). One NETSCAPE2.0 loop
// extension, one Graphic Control Extension per frame, no comment or other application extensions, no
// metadata. LZW comes from ../imaging_core.ts.
//
// Quantizer (written from the literature, no third-party source): when the opaque pixels hold at most
// the color budget, the palette is those exact colors (lossless). Otherwise Heckbert median cut
// ("Color image quantization for frame buffer display", SIGGRAPH 1982) over a 5-5-5 histogram, where each
// step splits the box with the largest sum of squared error at the axis position that minimizes the two
// halves' summed squared error (the variance-based split of Wan, Wong and Prusinkiewicz 1988 / Wu 1991,
// computed exactly from per-axis moment marginals), followed by Lloyd (k-means) refinement passes over
// the histogram bins. Deterministic: no randomness, ties resolve to the lower index.
//
// Frame diffing (exact up to quantization): the encoder tracks the composited canvas, which after every
// frame equals that frame's quantized pixels. Frame 0 is a full-canvas write. Frame i > 0:
//  - if some pixel turns transparent where the canvas is opaque, disposal 1 cannot express it, so the
//    PREVIOUS frame is rewritten with disposal 2 (restore to background, which browsers treat as
//    transparent) and its rect widened to cover every opaque canvas pixel, so the canvas is fully clear;
//    frame i then writes the bounding rect of its own opaque pixels (a 1x1 transparent frame when none);
//  - otherwise frame i writes only the bounding rect of pixels that differ from the canvas, with
//    disposal 1, and pixels inside that rect that did not change are written as the transparent index
//    (when the palette has one), which leaves the canvas as is and compresses better;
//  - a frame identical to the canvas emits nothing: its delay is added to the previous frame's.
// If frame 0 has transparent pixels the last frame gets disposal 2 too (rect widened the same way), so a
// decoder that does not reset the canvas when it loops still restarts from a clear canvas.
//
// Delays: GIF stores centiseconds and browsers treat delays below 20 ms as 100 ms, so any delay below
// 20 ms is written as 2 cs (20 ms); otherwise round(ms / 10), clamped to 65535.

import type { RasterData } from "./types.ts";
import { DESIGN_LIMITS } from "./limits.ts";
import { ByteWriter } from "./util.ts";
import { lzwEncode } from "../imaging_core.ts";
import { checkAnimationFrames, frameDelays } from "./apng.ts";

export type GifDither = "none" | "floyd-steinberg" | "bayer4";
export type GifPaletteMode = "global" | "per-frame";
export interface GifOptions { delayMs: number | number[]; loop: number; dither: GifDither; palette: GifPaletteMode; transparentBelow?: number }

export interface QuantizeResult {
  /** RGB triplets, `colors * 3` bytes. The transparent slot (if any) is the LAST entry and reads 0,0,0. */
  palette: Uint8Array;
  colors: number;
  transparentIndex: number | null;
  /** True when every opaque input color is in the palette verbatim (no quantization error). */
  exact: boolean;
}

const BINS = 32768;
const EXACT_HASH = 1024; // power of two, > 2 * 256 keys
const LLOYD_PASSES = 3;
const BAYER4 = new Uint8Array([0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]);

const binOf = (r: number, g: number, b: number): number => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
const exactSlot = (key: number): number => Math.imul(key, 0x9E3779B1) >>> 22; // top 10 bits: 0..1023

interface Box {
  r0: number; r1: number; g0: number; g1: number; b0: number; b1: number;
  n: number; sR: number; sG: number; sB: number; sse: number;
  /** Best split: axis 0..2 and the last bin coordinate of the low half; cutAxis -1 = unsplittable. */
  cutAxis: number; cutPos: number;
}

/** Per-axis marginals: (axis * 32 + coord) * 5 + [count, sumR, sumG, sumB, sumSq]. Scratch, reset per box. */
const MARG = new Float64Array(3 * 32 * 5);

const sseOf = (n: number, r: number, g: number, b: number, q: number): number => (n > 0 ? q - (r * r + g * g + b * b) / n : 0);

interface Hist { cnt: Float64Array; sr: Float64Array; sg: Float64Array; sb: Float64Array; sq: Float64Array }

function makeBox(hist: Hist, r0: number, r1: number, g0: number, g1: number, b0: number, b1: number): Box {
  MARG.fill(0);
  let n = 0, sR = 0, sG = 0, sB = 0, sQ = 0;
  for (let r = r0; r <= r1; r++) {
    for (let g = g0; g <= g1; g++) {
      for (let b = b0; b <= b1; b++) {
        const bin = (r << 10) | (g << 5) | b;
        const c = hist.cnt[bin]!;
        if (c === 0) continue;
        const vr = hist.sr[bin]!, vg = hist.sg[bin]!, vb = hist.sb[bin]!, vq = hist.sq[bin]!;
        n += c; sR += vr; sG += vg; sB += vb; sQ += vq;
        let m = r * 5;
        MARG[m]! += c; MARG[m + 1]! += vr; MARG[m + 2]! += vg; MARG[m + 3]! += vb; MARG[m + 4]! += vq;
        m = (32 + g) * 5;
        MARG[m]! += c; MARG[m + 1]! += vr; MARG[m + 2]! += vg; MARG[m + 3]! += vb; MARG[m + 4]! += vq;
        m = (64 + b) * 5;
        MARG[m]! += c; MARG[m + 1]! += vr; MARG[m + 2]! += vg; MARG[m + 3]! += vb; MARG[m + 4]! += vq;
      }
    }
  }
  let cutAxis = -1, cutPos = 0, bestCost = Infinity;
  const lo = [r0, g0, b0], hi = [r1, g1, b1];
  for (let axis = 0; axis < 3; axis++) {
    let ln = 0, lr = 0, lg = 0, lb = 0, lq = 0;
    for (let t = lo[axis]!; t < hi[axis]!; t++) {
      const m = (axis * 32 + t) * 5;
      ln += MARG[m]!; lr += MARG[m + 1]!; lg += MARG[m + 2]!; lb += MARG[m + 3]!; lq += MARG[m + 4]!;
      const rn = n - ln;
      if (ln <= 0 || rn <= 0) continue;
      const cost = sseOf(ln, lr, lg, lb, lq) + sseOf(rn, sR - lr, sG - lg, sB - lb, sQ - lq);
      if (cost < bestCost) { bestCost = cost; cutAxis = axis; cutPos = t; }
    }
  }
  return { r0, r1, g0, g1, b0, b1, n, sR, sG, sB, sse: sseOf(n, sR, sG, sB, sQ), cutAxis, cutPos };
}

/** Median cut (variance split) to at most k boxes, then Lloyd refinement. Returns RGB as floats. */
function medianCut(hist: Hist, k: number): Float64Array {
  const boxes: Box[] = [makeBox(hist, 0, 31, 0, 31, 0, 31)];
  if (boxes[0]!.n === 0) return new Float64Array(0);
  while (boxes.length < k) {
    let pick = -1, best = -1;
    for (let i = 0; i < boxes.length; i++) {
      const bx = boxes[i]!;
      if (bx.cutAxis >= 0 && bx.sse > best) { best = bx.sse; pick = i; }
    }
    if (pick < 0) break;
    const bx = boxes[pick]!;
    const c = bx.cutPos;
    let a: Box, b: Box;
    if (bx.cutAxis === 0) {
      a = makeBox(hist, bx.r0, c, bx.g0, bx.g1, bx.b0, bx.b1);
      b = makeBox(hist, c + 1, bx.r1, bx.g0, bx.g1, bx.b0, bx.b1);
    } else if (bx.cutAxis === 1) {
      a = makeBox(hist, bx.r0, bx.r1, bx.g0, c, bx.b0, bx.b1);
      b = makeBox(hist, bx.r0, bx.r1, c + 1, bx.g1, bx.b0, bx.b1);
    } else {
      a = makeBox(hist, bx.r0, bx.r1, bx.g0, bx.g1, bx.b0, c);
      b = makeBox(hist, bx.r0, bx.r1, bx.g0, bx.g1, c + 1, bx.b1);
    }
    boxes[pick] = a;
    boxes.push(b);
  }
  const n = boxes.length;
  const pal = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const bx = boxes[i]!;
    pal[i * 3] = bx.sR / bx.n; pal[i * 3 + 1] = bx.sG / bx.n; pal[i * 3 + 2] = bx.sB / bx.n;
  }
  // Lloyd refinement over the non-empty bins, each weighted by its pixel count (via its sums).
  const live: number[] = [];
  for (let i = 0; i < BINS; i++) if (hist.cnt[i]! > 0) live.push(i);
  const acc = new Float64Array(n * 4);
  for (let pass = 0; pass < LLOYD_PASSES; pass++) {
    acc.fill(0);
    for (const bin of live) {
      const c = hist.cnt[bin]!;
      const mr = hist.sr[bin]! / c, mg = hist.sg[bin]! / c, mb = hist.sb[bin]! / c;
      let bi = 0, bd = Infinity;
      for (let j = 0; j < n; j++) {
        const dr = pal[j * 3]! - mr, dg = pal[j * 3 + 1]! - mg, db = pal[j * 3 + 2]! - mb;
        const d = dr * dr + dg * dg + db * db;
        if (d < bd) { bd = d; bi = j; }
      }
      acc[bi * 4]! += c; acc[bi * 4 + 1]! += hist.sr[bin]!; acc[bi * 4 + 2]! += hist.sg[bin]!; acc[bi * 4 + 3]! += hist.sb[bin]!;
    }
    for (let j = 0; j < n; j++) {
      const c = acc[j * 4]!;
      if (c > 0) { pal[j * 3] = acc[j * 4 + 1]! / c; pal[j * 3 + 1] = acc[j * 4 + 2]! / c; pal[j * 3 + 2] = acc[j * 4 + 3]! / c; }
    }
  }
  return pal;
}

/**
 * Build a palette of at most `maxColors` (2..256) entries for the given RGBA buffers. Pixels with alpha
 * below `transparentBelow` are transparent: they are not counted as colors and, when any exist, one slot
 * (the last, `transparentIndex`) is reserved for them, leaving `maxColors - 1` for opaque colors.
 */
export function quantizeRgba(pixels: Uint8ClampedArray[], maxColors: number, transparentBelow: number): QuantizeResult {
  if (!Number.isInteger(maxColors) || maxColors < 2 || maxColors > 256) throw new Error("quantizeRgba: maxColors must be an integer in 2..256");
  if (typeof transparentBelow !== "number" || !Number.isFinite(transparentBelow)) throw new Error("quantizeRgba: transparentBelow must be finite");
  const tb = transparentBelow;
  const hist: Hist = {
    cnt: new Float64Array(BINS), sr: new Float64Array(BINS), sg: new Float64Array(BINS),
    sb: new Float64Array(BINS), sq: new Float64Array(BINS),
  };
  const keys = new Int32Array(EXACT_HASH).fill(-1);
  const distinct = new Int32Array(256);
  let nDistinct = 0, overflow = false, hasT = false;
  for (const buf of pixels) {
    const len = buf.length - (buf.length % 4);
    for (let i = 0; i < len; i += 4) {
      if (buf[i + 3]! < tb) { hasT = true; continue; }
      const r = buf[i]!, g = buf[i + 1]!, b = buf[i + 2]!;
      const bin = binOf(r, g, b);
      hist.cnt[bin]! += 1; hist.sr[bin]! += r; hist.sg[bin]! += g; hist.sb[bin]! += b; hist.sq[bin]! += r * r + g * g + b * b;
      if (overflow) continue;
      const key = (r << 16) | (g << 8) | b;
      let h = exactSlot(key);
      while (keys[h] !== -1 && keys[h] !== key) h = (h + 1) & (EXACT_HASH - 1);
      if (keys[h] === -1) {
        if (nDistinct === maxColors) overflow = true;
        else { keys[h] = key; distinct[nDistinct++] = key; }
      }
    }
  }
  const budget = hasT ? maxColors - 1 : maxColors;
  const exact = !overflow && nDistinct <= budget;
  let opaque: number;
  let palette: Uint8Array;
  if (exact) {
    opaque = nDistinct;
    palette = new Uint8Array((opaque + (hasT ? 1 : 0)) * 3);
    for (let i = 0; i < opaque; i++) {
      const key = distinct[i]!;
      palette[i * 3] = (key >>> 16) & 0xFF; palette[i * 3 + 1] = (key >>> 8) & 0xFF; palette[i * 3 + 2] = key & 0xFF;
    }
  } else {
    const pal = medianCut(hist, budget);
    opaque = pal.length / 3;
    palette = new Uint8Array((opaque + (hasT ? 1 : 0)) * 3);
    for (let i = 0; i < pal.length; i++) palette[i] = Math.round(pal[i]!); // means of 0..255 values: in range
  }
  return { palette, colors: opaque + (hasT ? 1 : 0), transparentIndex: hasT ? opaque : null, exact };
}

/** Nearest palette entry among the first `n` (opaque) entries. Exact palettes resolve through a 24-bit
 *  hash; everything else through a 5-5-5 cache filled by an exact search on the first miss per bin. */
class PaletteMapper {
  private readonly pal: Uint8Array;
  private readonly n: number;
  private readonly cache = new Int16Array(BINS).fill(-1);
  private readonly keys: Int32Array | null = null;
  private readonly vals: Uint8Array | null = null;
  constructor(pal: Uint8Array, n: number, exact: boolean) {
    this.pal = pal;
    this.n = n;
    if (exact) {
      const keys = new Int32Array(EXACT_HASH).fill(-1);
      const vals = new Uint8Array(EXACT_HASH);
      for (let i = 0; i < n; i++) {
        const key = (pal[i * 3]! << 16) | (pal[i * 3 + 1]! << 8) | pal[i * 3 + 2]!;
        let h = exactSlot(key);
        while (keys[h] !== -1 && keys[h] !== key) h = (h + 1) & (EXACT_HASH - 1);
        if (keys[h] === -1) { keys[h] = key; vals[h] = i; }
      }
      this.keys = keys;
      this.vals = vals;
    }
  }
  lookup(r: number, g: number, b: number): number {
    if (this.keys !== null) {
      const key = (r << 16) | (g << 8) | b;
      let h = exactSlot(key);
      while (this.keys[h] !== -1) {
        if (this.keys[h] === key) return this.vals![h]!;
        h = (h + 1) & (EXACT_HASH - 1);
      }
    }
    const bin = binOf(r, g, b);
    const c = this.cache[bin]!;
    if (c >= 0) return c;
    const pal = this.pal;
    let bi = 0, bd = Infinity;
    for (let j = 0; j < this.n; j++) {
      const dr = pal[j * 3]! - r, dg = pal[j * 3 + 1]! - g, db = pal[j * 3 + 2]! - b;
      const d = dr * dr + dg * dg + db * db;
      if (d < bd) { bd = d; bi = j; }
    }
    this.cache[bin] = bi;
    return bi;
  }
}

/** A palette ready for encoding: transparent slot guaranteed when there is room for one. */
interface GifPalette { pal: Uint8Array; colors: number; t: number | null; mapper: PaletteMapper; exact: boolean }

function buildPalette(bufs: Uint8ClampedArray[], tb: number): GifPalette {
  const q = quantizeRgba(bufs, 256, tb);
  const opaque = q.transparentIndex ?? q.colors;
  let pal = q.palette, colors = q.colors, t = q.transparentIndex;
  if (t === null && colors < 256) {
    // Reserve a transparent slot anyway: diff frames write unchanged pixels with it.
    pal = new Uint8Array((colors + 1) * 3);
    pal.set(q.palette);
    t = colors;
    colors++;
  }
  return { pal, colors, t, mapper: new PaletteMapper(q.palette, opaque, q.exact), exact: q.exact };
}

/** Map one frame to palette indices with the requested dithering. Exact palettes are never dithered
 *  (every pixel already has its color, dithering could only add noise). */
function mapFrame(rgba: Uint8ClampedArray, w: number, h: number, p: GifPalette, tb: number, dither: GifDither, out: Uint8Array): void {
  const t = p.t ?? 0;
  const mapper = p.mapper;
  const pal = p.pal;
  const mode = p.exact ? "none" : dither;
  if (mode === "none") {
    for (let i = 0, px = 0; px < w * h; px++, i += 4) {
      out[px] = rgba[i + 3]! < tb ? t : mapper.lookup(rgba[i]!, rgba[i + 1]!, rgba[i + 2]!);
    }
    return;
  }
  if (mode === "bayer4") {
    const opaque = p.t ?? p.colors;
    const spread = 255 / Math.cbrt(Math.max(2, opaque));
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const px = y * w + x, i = px * 4;
        if (rgba[i + 3]! < tb) { out[px] = t; continue; }
        const off = ((BAYER4[((y & 3) << 2) | (x & 3)]! + 0.5) / 16 - 0.5) * spread;
        let r = Math.round(rgba[i]! + off), g = Math.round(rgba[i + 1]! + off), b = Math.round(rgba[i + 2]! + off);
        r = r < 0 ? 0 : r > 255 ? 255 : r;
        g = g < 0 ? 0 : g > 255 ? 255 : g;
        b = b < 0 ? 0 : b > 255 ? 255 : b;
        out[px] = mapper.lookup(r, g, b);
      }
    }
    return;
  }
  // Floyd-Steinberg, serpentine. Error rows carry one padding pixel on each side.
  let cur = new Float32Array((w + 2) * 3);
  let nxt = new Float32Array((w + 2) * 3);
  for (let y = 0; y < h; y++) {
    const dir = (y & 1) === 0 ? 1 : -1;
    for (let k = 0; k < w; k++) {
      const x = dir === 1 ? k : w - 1 - k;
      const px = y * w + x, i = px * 4;
      if (rgba[i + 3]! < tb) { out[px] = t; continue; }
      const e = (x + 1) * 3;
      let r = rgba[i]! + cur[e]!, g = rgba[i + 1]! + cur[e + 1]!, b = rgba[i + 2]! + cur[e + 2]!;
      r = r < 0 ? 0 : r > 255 ? 255 : r;
      g = g < 0 ? 0 : g > 255 ? 255 : g;
      b = b < 0 ? 0 : b > 255 ? 255 : b;
      const idx = mapper.lookup(Math.round(r), Math.round(g), Math.round(b));
      out[px] = idx;
      const er = r - pal[idx * 3]!, eg = g - pal[idx * 3 + 1]!, eb = b - pal[idx * 3 + 2]!;
      const ahead = (x + 1 + dir) * 3, behind = (x + 1 - dir) * 3;
      cur[ahead]! += er * 0.4375; cur[ahead + 1]! += eg * 0.4375; cur[ahead + 2]! += eb * 0.4375;
      nxt[behind]! += er * 0.1875; nxt[behind + 1]! += eg * 0.1875; nxt[behind + 2]! += eb * 0.1875;
      nxt[e]! += er * 0.3125; nxt[e + 1]! += eg * 0.3125; nxt[e + 2]! += eb * 0.3125;
      nxt[ahead]! += er * 0.0625; nxt[ahead + 1]! += eg * 0.0625; nxt[ahead + 2]! += eb * 0.0625;
    }
    const tmp = cur; cur = nxt; nxt = tmp;
    nxt.fill(0);
  }
}

interface QFrame { idx: Uint8Array; p: GifPalette }
interface PendingFrame {
  q: QFrame;
  /** Canvas before this frame (null = clear). Used to write unchanged pixels as transparent. */
  before: QFrame | null;
  x0: number; y0: number; x1: number; y1: number; // rect, x1/y1 exclusive
  disposal: 1 | 2;
  delayMs: number;
}

const isTransparent = (q: QFrame, px: number): boolean => q.p.t !== null && q.idx[px] === q.p.t;

/** True when pixel `px` shows the same opaque color in both frames. */
function sameOpaque(a: QFrame, b: QFrame, px: number, shared: boolean): boolean {
  const ia = a.idx[px]!, ib = b.idx[px]!;
  if (shared) return ia === ib && ia !== a.p.t;
  if (ia === a.p.t || ib === b.p.t) return false;
  const pa = a.p.pal, pb = b.p.pal;
  return pa[ia * 3] === pb[ib * 3] && pa[ia * 3 + 1] === pb[ib * 3 + 1] && pa[ia * 3 + 2] === pb[ib * 3 + 2];
}

/** Bounding rect of opaque pixels as [x0, y0, x1, y1] (exclusive), or null. */
function opaqueRect(q: QFrame, w: number, h: number): [number, number, number, number] | null {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (isTransparent(q, y * w + x)) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      y1 = y;
    }
  }
  return x1 < 0 ? null : [x0, y0, x1 + 1, y1 + 1];
}

function widenToOpaque(f: PendingFrame, w: number, h: number): void {
  const r = opaqueRect(f.q, w, h);
  if (r === null) return;
  f.x0 = Math.min(f.x0, r[0]); f.y0 = Math.min(f.y0, r[1]);
  f.x1 = Math.max(f.x1, r[2]); f.y1 = Math.max(f.y1, r[3]);
}

function tableBits(colors: number): number {
  let bits = 1;
  while ((1 << bits) < colors) bits++;
  return bits;
}

function writeTable(out: ByteWriter, p: GifPalette, bits: number): void {
  out.bytes(p.pal.subarray(0, p.colors * 3));
  for (let i = p.colors * 3; i < (1 << bits) * 3; i++) out.u8(0);
}

function emitFrame(out: ByteWriter, f: PendingFrame, w: number, shared: boolean): void {
  const { q, before } = f;
  const t = q.p.t;
  const ms = f.delayMs;
  const ticks = ms < 20 ? 2 : Math.min(0xFFFF, Math.round(ms / 10));
  out.u8(0x21); out.u8(0xF9); out.u8(4);
  out.u8((f.disposal << 2) | (t !== null ? 1 : 0));
  out.u16le(ticks);
  out.u8(t ?? 0);
  out.u8(0);
  const rw = f.x1 - f.x0, rh = f.y1 - f.y0;
  const bits = tableBits(q.p.colors);
  out.u8(0x2C);
  out.u16le(f.x0); out.u16le(f.y0); out.u16le(rw); out.u16le(rh);
  out.u8(shared ? 0 : 0x80 | (bits - 1));
  if (!shared) writeTable(out, q.p, bits);
  const sub = new Uint8Array(rw * rh);
  let k = 0;
  for (let y = f.y0; y < f.y1; y++) {
    for (let x = f.x0; x < f.x1; x++) {
      const px = y * w + x;
      sub[k++] = t !== null && before !== null && sameOpaque(before, q, px, shared) ? t : q.idx[px]!;
    }
  }
  const minCode = Math.max(2, bits);
  out.u8(minCode);
  out.bytes(lzwEncode(sub, minCode));
}

/**
 * Encode an animated GIF89a. All frames share one size (1..65535 per side), 1..maxGifFrames frames,
 * frames * w * h <= 4 * maxRasterPixels. `loop` is the NETSCAPE2.0 repeat count (0 = forever, clamped to
 * 0..65535). Pixels with alpha below `transparentBelow` (default 128) are fully transparent; the rest
 * are written opaque. With <= 255 distinct opaque colors (256 without transparency) the output is
 * lossless.
 */
export function encodeAnimatedGif(frames: RasterData[], opts: GifOptions): Uint8Array {
  const { w, h } = checkAnimationFrames(frames, DESIGN_LIMITS.maxGifFrames, "encodeAnimatedGif");
  const delays = frameDelays(opts.delayMs, frames.length, "encodeAnimatedGif");
  if (typeof opts.loop !== "number" || !Number.isFinite(opts.loop)) throw new Error("encodeAnimatedGif: loop must be a finite number");
  if (opts.dither !== "none" && opts.dither !== "floyd-steinberg" && opts.dither !== "bayer4") throw new Error("encodeAnimatedGif: unknown dither mode");
  if (opts.palette !== "global" && opts.palette !== "per-frame") throw new Error("encodeAnimatedGif: unknown palette mode");
  const tbRaw = opts.transparentBelow ?? 128;
  if (typeof tbRaw !== "number" || !Number.isFinite(tbRaw)) throw new Error("encodeAnimatedGif: transparentBelow must be finite");
  const tb = Math.min(256, Math.max(0, tbRaw));
  const loop = Math.min(0xFFFF, Math.max(0, Math.round(opts.loop)));
  const shared = opts.palette === "global";

  const out = new ByteWriter(Math.min(1 << 24, Math.max(1024, (w * h * frames.length) >>> 2)));
  out.ascii("GIF89a");
  out.u16le(w); out.u16le(h);
  let global: GifPalette | null = null;
  if (shared) {
    const bufs: Uint8ClampedArray[] = [];
    for (const f of frames) bufs.push(f.rgba);
    global = buildPalette(bufs, tb);
    const bits = tableBits(global.colors);
    out.u8(0x80 | 0x70 | (bits - 1));
    out.u8(0); out.u8(0); // background index, pixel aspect
    writeTable(out, global, bits);
  } else {
    out.u8(0x70);
    out.u8(0); out.u8(0);
  }
  out.u8(0x21); out.u8(0xFF); out.u8(11); out.ascii("NETSCAPE2.0");
  out.u8(3); out.u8(1); out.u16le(loop); out.u8(0);

  let pending: PendingFrame | null = null;
  let prev: QFrame | null = null;
  let emitted = 0;
  let firstHasT = false;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]!;
    const p = global ?? buildPalette([f.rgba], tb);
    const idx = new Uint8Array(w * h);
    mapFrame(f.rgba, w, h, p, tb, opts.dither, idx);
    const q: QFrame = { idx, p };
    if (pending === null || prev === null) {
      pending = { q, before: null, x0: 0, y0: 0, x1: w, y1: h, disposal: 1, delayMs: delays[i]! };
      if (p.t !== null) for (let px = 0; px < w * h; px++) if (idx[px] === p.t) { firstHasT = true; break; }
      prev = q;
      continue;
    }
    let clear = false;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    scan: for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const px = y * w + x;
        const curT = isTransparent(q, px), prevT = isTransparent(prev, px);
        if (curT) {
          if (!prevT) { clear = true; break scan; }
          continue;
        }
        if (sameOpaque(prev, q, px, shared)) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
    }
    if (clear) {
      pending.disposal = 2;
      widenToOpaque(pending, w, h);
      emitFrame(out, pending, w, shared);
      emitted++;
      const r = opaqueRect(q, w, h) ?? [0, 0, 1, 1];
      pending = { q, before: null, x0: r[0], y0: r[1], x1: r[2], y1: r[3], disposal: 1, delayMs: delays[i]! };
    } else if (x1 < 0) {
      pending.delayMs += delays[i]!; // identical to the canvas: merge
      continue;
    } else {
      emitFrame(out, pending, w, shared);
      emitted++;
      pending = { q, before: prev, x0, y0, x1: x1 + 1, y1: y1 + 1, disposal: 1, delayMs: delays[i]! };
    }
    prev = q;
  }
  if (pending !== null) {
    if (firstHasT && emitted > 0) {
      pending.disposal = 2;
      widenToOpaque(pending, w, h);
    }
    emitFrame(out, pending, w, shared);
  }
  out.u8(0x3B);
  return out.finish();
}
