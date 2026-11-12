// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/creator/design/gif.test.ts - animated GIF encoder proven by an independent decoder in this file.

import { describe, expect, test } from "bun:test";
import { encodeAnimatedGif, quantizeRgba } from "./gif.ts";
import { DESIGN_LIMITS } from "./limits.ts";
import type { RasterData } from "./types.ts";

const raster = (w: number, h: number, px: (x: number, y: number) => [number, number, number, number]): RasterData => {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = px(x, y);
      const i = (y * w + x) * 4;
      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = a;
    }
  }
  return { width: w, height: h, rgba };
};

// ── Independent GIF89a decoder ───────────────────────────────────────────────

function lzwDecode(data: Uint8Array, minCode: number, expected: number): Uint8Array {
  const clear = 1 << minCode, eoi = clear + 1;
  const prefix = new Int32Array(4096), suffix = new Uint8Array(4096), first = new Uint8Array(4096), len = new Int32Array(4096);
  for (let i = 0; i < clear; i++) { prefix[i] = -1; suffix[i] = i; first[i] = i; len[i] = 1; }
  const out = new Uint8Array(expected);
  let n = 0;
  const put = (code: number): void => {
    const l = len[code]!;
    if (n + l > expected) throw new Error("LZW overrun");
    let c = code;
    for (let k = l - 1; k >= 0; k--) { out[n + k] = suffix[c]!; c = prefix[c]!; }
    n += l;
  };
  let codeSize = minCode + 1, next = eoi + 1, prev = -1, bit = 0;
  const totalBits = data.length * 8;
  let sawEoi = false;
  while (bit + codeSize <= totalBits) {
    let code = 0;
    for (let i = 0; i < codeSize; i++, bit++) code |= ((data[bit >> 3]! >> (bit & 7)) & 1) << i;
    if (code === clear) { codeSize = minCode + 1; next = eoi + 1; prev = -1; continue; }
    if (code === eoi) { sawEoi = true; break; }
    if (prev === -1) {
      if (code >= clear) throw new Error("LZW: first code after CLEAR is not a literal");
      put(code);
      prev = code;
      continue;
    }
    let f: number;
    if (code < next) { put(code); f = first[code]!; }
    else if (code === next) { put(prev); if (n >= expected) throw new Error("LZW overrun"); out[n++] = first[prev]!; f = first[prev]!; }
    else throw new Error(`LZW: code ${code} beyond table ${next}`);
    if (next < 4096) {
      prefix[next] = prev; suffix[next] = f; first[next] = first[prev]!; len[next] = len[prev]! + 1;
      next++;
      if (next === 1 << codeSize && codeSize < 12) codeSize++;
    }
    prev = code;
  }
  if (!sawEoi) throw new Error("LZW: missing end-of-information code");
  if (n !== expected) throw new Error(`LZW: decoded ${n} of ${expected} pixels`);
  return out;
}

interface DecodedFrame {
  canvas: Uint8ClampedArray; delayCs: number; disposal: number;
  x: number; y: number; w: number; h: number; table: Uint8Array; local: boolean; indices: Uint8Array; transparent: number;
}
interface DecodedGif { width: number; height: number; hasGct: boolean; gct: Uint8Array | null; loop: number | null; frames: DecodedFrame[] }

function decodeGif(b: Uint8Array): DecodedGif {
  const sig = String.fromCharCode(...b.subarray(0, 6));
  if (sig !== "GIF89a") throw new Error(`bad signature ${sig}`);
  const u16 = (o: number): number => b[o]! | (b[o + 1]! << 8);
  const width = u16(6), height = u16(8);
  const packed = b[10]!;
  let o = 13;
  let gct: Uint8Array | null = null;
  if (packed & 0x80) { const n = 3 * (2 << (packed & 7)); gct = b.subarray(o, o + n); o += n; }
  const subBlocks = (): Uint8Array => {
    const parts: number[] = [];
    for (;;) {
      const n = b[o++]!;
      if (n === 0) break;
      for (let i = 0; i < n; i++) parts.push(b[o + i]!);
      o += n;
    }
    return new Uint8Array(parts);
  };
  const canvas = new Uint8ClampedArray(width * height * 4);
  const frames: DecodedFrame[] = [];
  let loop: number | null = null;
  let gce = { disposal: 0, delay: 0, transparent: -1 };
  let lastDispose: { disposal: number; x: number; y: number; w: number; h: number } | null = null;
  for (;;) {
    if (o >= b.length) throw new Error("missing trailer");
    const tag = b[o++]!;
    if (tag === 0x3B) break;
    if (tag === 0x21) {
      const label = b[o++]!;
      if (label === 0xF9) {
        const data = subBlocks();
        const pk = data[0]!;
        gce = { disposal: (pk >> 2) & 7, delay: data[1]! | (data[2]! << 8), transparent: pk & 1 ? data[3]! : -1 };
      } else if (label === 0xFF) {
        const n = b[o++]!;
        const app = String.fromCharCode(...b.subarray(o, o + n));
        o += n;
        const data = subBlocks();
        if (app === "NETSCAPE2.0") loop = data[1]! | (data[2]! << 8);
        else throw new Error(`unexpected application extension ${app}`);
      } else {
        throw new Error(`unexpected extension 0x${label.toString(16)}`);
      }
      continue;
    }
    if (tag !== 0x2C) throw new Error(`unexpected block 0x${tag.toString(16)}`);
    const x = u16(o), y = u16(o + 2), w = u16(o + 4), h = u16(o + 6), pk = b[o + 8]!;
    o += 9;
    let table = gct;
    const local = (pk & 0x80) !== 0;
    if (local) { const n = 3 * (2 << (pk & 7)); table = b.subarray(o, o + n); o += n; }
    if (table === null) throw new Error("frame without a color table");
    const minCode = b[o++]!;
    const indices = lzwDecode(subBlocks(), minCode, w * h);
    if (lastDispose !== null && lastDispose.disposal === 2) {
      for (let yy = lastDispose.y; yy < lastDispose.y + lastDispose.h; yy++) {
        for (let xx = lastDispose.x; xx < lastDispose.x + lastDispose.w; xx++) canvas.fill(0, (yy * width + xx) * 4, (yy * width + xx) * 4 + 4);
      }
    }
    if (x + w > width || y + h > height) throw new Error("frame outside the logical screen");
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const idx = indices[yy * w + xx]!;
        if (idx === gce.transparent) continue;
        if (idx * 3 + 2 >= table.length) throw new Error("index outside the color table");
        const c = ((y + yy) * width + x + xx) * 4;
        canvas[c] = table[idx * 3]!; canvas[c + 1] = table[idx * 3 + 1]!; canvas[c + 2] = table[idx * 3 + 2]!; canvas[c + 3] = 255;
      }
    }
    frames.push({ canvas: canvas.slice(), delayCs: gce.delay, disposal: gce.disposal, x, y, w, h, table, local, indices, transparent: gce.transparent });
    lastDispose = { disposal: gce.disposal, x, y, w, h };
    gce = { disposal: 0, delay: 0, transparent: -1 };
  }
  return { width, height, hasGct: gct !== null, gct, loop, frames };
}

/** Decoded canvas equals the source: transparent where alpha < 128, exact opaque color elsewhere. */
function expectMatches(decoded: Uint8ClampedArray, src: RasterData): void {
  let bad = 0;
  for (let i = 0; i < src.rgba.length; i += 4) {
    if (src.rgba[i + 3]! < 128) { if (decoded[i + 3] !== 0) bad++; continue; }
    if (decoded[i] !== src.rgba[i] || decoded[i + 1] !== src.rgba[i + 1] || decoded[i + 2] !== src.rgba[i + 2] || decoded[i + 3] !== 255) bad++;
  }
  expect(bad).toBe(0);
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const PALETTE4: [number, number, number][] = [[200, 30, 30], [30, 200, 30], [30, 30, 200], [240, 240, 240]];
/** Static 32x32 background of 4 colors with a 4x4 black square at (sx, sy). */
const squareFrame = (sx: number, sy: number): RasterData => raster(32, 32, (x, y) => {
  if (x >= sx && x < sx + 4 && y >= sy && y < sy + 4) return [0, 0, 0, 255];
  const c = PALETTE4[((x >> 3) + (y >> 3)) & 3]!;
  return [c[0], c[1], c[2], 255];
});
/** 64x64 gradient with far more than 256 colors. */
const gradient = (shift: number): RasterData => raster(64, 64, (x, y) => [(x * 4 + shift) & 255, y * 4, (x + y) * 2, 255]);

describe("encodeAnimatedGif", () => {
  test("a 3-frame animation with <= 255 colors decodes back exactly, with loop count and per-frame delays", () => {
    const frames = [0, 1, 2].map((k) => raster(10, 7, (x, y) => [(x * 20 + k * 7) & 255, y * 30, (x * y + k) & 255, 255]));
    const gif = encodeAnimatedGif(frames, { delayMs: [100, 250, 40], loop: 3, dither: "none", palette: "global" });
    const d = decodeGif(gif);
    expect(d.width).toBe(10);
    expect(d.height).toBe(7);
    expect(d.loop).toBe(3);
    expect(d.frames.length).toBe(3);
    expect(d.frames.map((f) => f.delayCs)).toEqual([10, 25, 4]);
    for (let i = 0; i < 3; i++) expectMatches(d.frames[i]!.canvas, frames[i]!);
  });

  test("loop 0 means forever and clamps above 65535; delays below 20 ms become 2 cs", () => {
    const f = [raster(2, 2, () => [1, 2, 3, 255]), raster(2, 2, () => [4, 5, 6, 255])];
    expect(decodeGif(encodeAnimatedGif(f, { delayMs: 0, loop: 0, dither: "none", palette: "global" })).loop).toBe(0);
    const d = decodeGif(encodeAnimatedGif(f, { delayMs: [5, 19], loop: 1e9, dither: "none", palette: "global" }));
    expect(d.loop).toBe(65535);
    expect(d.frames.map((x) => x.delayCs)).toEqual([2, 2]);
  });

  test("frame diffing writes sub-rects for a moving 4x4 square on a static background", () => {
    const frames = [squareFrame(2, 2), squareFrame(4, 2), squareFrame(6, 3)];
    const d = decodeGif(encodeAnimatedGif(frames, { delayMs: 50, loop: 0, dither: "none", palette: "global" }));
    expect(d.frames.length).toBe(3);
    const f0 = d.frames[0]!;
    expect([f0.x, f0.y, f0.w, f0.h]).toEqual([0, 0, 32, 32]);
    // Square moved from x 2..5 to 4..7 (rows 2..5): the changed pixels span x 2..7, y 2..5.
    const f1 = d.frames[1]!;
    expect([f1.x, f1.y, f1.w, f1.h]).toEqual([2, 2, 6, 4]);
    const f2 = d.frames[2]!;
    expect(f2.w * f2.h).toBeLessThan(32 * 32);
    for (let i = 0; i < 3; i++) expectMatches(d.frames[i]!.canvas, frames[i]!);
  });

  test("identical consecutive frames are merged into one with the summed delay", () => {
    const a = squareFrame(0, 0), b = squareFrame(8, 8);
    const d = decodeGif(encodeAnimatedGif([a, a, b], { delayMs: [100, 150, 70], loop: 0, dither: "none", palette: "global" }));
    expect(d.frames.length).toBe(2);
    expect(d.frames.map((f) => f.delayCs)).toEqual([25, 7]);
    expectMatches(d.frames[1]!.canvas, b);
  });

  test("per-frame palettes: local color tables decode each frame exactly when the union exceeds 256 colors", () => {
    // 200 distinct colors per frame, 400 across both: one global table could not be lossless.
    const a = raster(20, 10, (x, y) => [(y * 20 + x) & 255, 10, 20, 255]);
    const b = raster(20, 10, (x, y) => [5, (y * 20 + x) & 255, 250, 255]);
    const d = decodeGif(encodeAnimatedGif([a, b], { delayMs: 80, loop: 0, dither: "none", palette: "per-frame" }));
    expect(d.hasGct).toBe(false);
    expect(d.frames.every((f) => f.local)).toBe(true);
    expectMatches(d.frames[0]!.canvas, a);
    expectMatches(d.frames[1]!.canvas, b);
  });

  test("alpha 0 pixels decode as transparent, including opaque pixels that later turn transparent", () => {
    const f0 = raster(12, 8, () => [220, 10, 10, 255]);
    const f1 = raster(12, 8, (x) => (x < 6 ? [0, 0, 0, 0] : [10, 220, 10, 255]));
    const f2 = raster(12, 8, (x, y) => (y < 4 ? [10, 10, 220, 255] : [0, 0, 0, 0]));
    for (const palette of ["global", "per-frame"] as const) {
      const d = decodeGif(encodeAnimatedGif([f0, f1, f2], { delayMs: 60, loop: 0, dither: "none", palette }));
      expect(d.frames.length).toBe(3);
      expectMatches(d.frames[0]!.canvas, f0);
      expectMatches(d.frames[1]!.canvas, f1);
      expectMatches(d.frames[2]!.canvas, f2);
      expect(d.frames[1]!.transparent).toBeGreaterThanOrEqual(0);
    }
  });

  test("transparentBelow sets the alpha threshold", () => {
    const f = raster(4, 1, (x) => [100, 100, 100, x * 60]); // alpha 0, 60, 120, 180
    const d = decodeGif(encodeAnimatedGif([f], { delayMs: 10, loop: 0, dither: "none", palette: "global", transparentBelow: 100 }));
    const c = d.frames[0]!.canvas;
    expect([c[3], c[7], c[11], c[15]]).toEqual([0, 0, 255, 255]);
  });

  for (const dither of ["bayer4", "floyd-steinberg"] as const) {
    test(`${dither} output decodes, stays within the palette, and tracks the source`, () => {
      const frames = [gradient(0), gradient(16)];
      const d = decodeGif(encodeAnimatedGif(frames, { delayMs: 100, loop: 0, dither, palette: "global" }));
      expect(d.frames.length).toBe(2);
      const gct = d.gct!;
      const inPalette = new Set<number>();
      for (let i = 0; i < gct.length; i += 3) inPalette.add((gct[i]! << 16) | (gct[i + 1]! << 8) | gct[i + 2]!);
      for (let k = 0; k < 2; k++) {
        const c = d.frames[k]!.canvas, src = frames[k]!.rgba;
        let outside = 0, err = 0;
        for (let i = 0; i < c.length; i += 4) {
          if (c[i + 3] !== 255 || !inPalette.has((c[i]! << 16) | (c[i + 1]! << 8) | c[i + 2]!)) outside++;
          err += Math.abs(c[i]! - src[i]!) + Math.abs(c[i + 1]! - src[i + 1]!) + Math.abs(c[i + 2]! - src[i + 2]!);
        }
        expect(outside).toBe(0);
        expect(err / (c.length / 4) / 3).toBeLessThan(24); // mean abs error per channel
      }
    });
  }

  test("refuses mismatched frame sizes, too many frames, and no frames", () => {
    const opts = { delayMs: 10, loop: 0, dither: "none", palette: "global" } as const;
    expect(() => encodeAnimatedGif([raster(4, 4, () => [0, 0, 0, 255]), raster(4, 5, () => [0, 0, 0, 255])], opts)).toThrow(/must match/);
    const one = raster(1, 1, () => [0, 0, 0, 255]);
    expect(() => encodeAnimatedGif(new Array<RasterData>(DESIGN_LIMITS.maxGifFrames + 1).fill(one), opts)).toThrow(/frame limit/);
    expect(() => encodeAnimatedGif([], opts)).toThrow();
    expect(() => encodeAnimatedGif([one, one], { ...opts, delayMs: [10] })).toThrow();
  });
});

describe("quantizeRgba", () => {
  test("keeps exact colors within budget and reserves the last slot for transparency", () => {
    const px = new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255, 1, 2, 3, 255, 9, 9, 9, 0]);
    const q = quantizeRgba([px], 8, 128);
    expect(q.exact).toBe(true);
    expect(q.colors).toBe(3);
    expect(q.transparentIndex).toBe(2);
    expect([...q.palette.subarray(0, 6)]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("over budget, two tight clusters land on their means", () => {
    const n = 200;
    const px = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) {
      const base = i < n / 2 ? 20 : 230;
      const d = i % 7; // 0..6 spread
      px[i * 4] = base + d; px[i * 4 + 1] = base + d; px[i * 4 + 2] = base - d; px[i * 4 + 3] = 255;
    }
    const q = quantizeRgba([px], 2, 128);
    expect(q.exact).toBe(false);
    expect(q.colors).toBe(2);
    expect(q.transparentIndex).toBeNull();
    const lo = Math.min(q.palette[0]!, q.palette[3]!), hi = Math.max(q.palette[0]!, q.palette[3]!);
    expect(Math.abs(lo - 23)).toBeLessThanOrEqual(1);
    expect(Math.abs(hi - 233)).toBeLessThanOrEqual(1);
  });

  test("never exceeds maxColors and is deterministic", () => {
    const g = gradient(3).rgba;
    const a = quantizeRgba([g], 16, 128), b = quantizeRgba([g], 16, 128);
    expect(a.colors).toBeLessThanOrEqual(16);
    expect([...a.palette]).toEqual([...b.palette]);
  });
});
