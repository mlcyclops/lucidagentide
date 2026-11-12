// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/design_png.ts - a small, strict PNG decoder for masks coming back from dgx-vision.
//
// Why not canvas: a mask is a 1-channel coverage plane. Decoding an 8-bit grayscale (mode L) PNG through
// createImageBitmap yields RGBA under the browser's colour handling, and any code that then reads those
// bytes with the wrong stride produces a speckled, striped mask. This decoder reads the samples exactly as
// stored (no colour management, no premultiplication) and `pngToMask` takes ONE value per pixel.
//
// Fail-closed: signature, chunk lengths, CRCs, IHDR fields, dimensions against the caller's expectation and
// the pixel budget, and the inflated size are all checked before a single byte reaches the document.
// Interlaced (Adam7) files are refused. Inflate uses the platform DecompressionStream (no WASM, no eval).

import type { MaskData } from "../../harness/creator/design/types.ts";
import { DESIGN_LIMITS } from "../../harness/creator/design/limits.ts";

export interface PngImage {
  width: number; height: number;
  /** 0 gray, 2 RGB, 3 palette, 4 gray+alpha, 6 RGBA (PNG colour types). */
  colorType: 0 | 2 | 3 | 4 | 6;
  bitDepth: 1 | 2 | 4 | 8 | 16;
  /** Unfiltered scanlines, `rowBytes` each, no filter bytes. */
  data: Uint8Array;
  rowBytes: number;
  palette: Uint8Array | null;
  trns: Uint8Array | null;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const DEPTHS: Record<number, readonly number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array, start: number, end: number): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = crcTable[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const u32 = (b: Uint8Array, o: number): number => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;

/** zlib inflate through DecompressionStream, refusing output beyond `maxBytes`. */
async function inflate(data: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate");
  const writer = ds.writable.getWriter();
  void writer.write(data as Uint8Array<ArrayBuffer>).then(() => writer.close()).catch(() => undefined);
  const reader = ds.readable.getReader();
  const out = new Uint8Array(maxBytes);
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (n + value.length > maxBytes) { void reader.cancel(); throw new Error("PNG image data inflates beyond its declared size."); }
    out.set(value, n);
    n += value.length;
  }
  return n === maxBytes ? out : out.subarray(0, n);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Decode a non-interlaced PNG. `expect` (when given) must match exactly. */
export async function decodePngImage(bytes: Uint8Array, expect?: { width: number; height: number }): Promise<PngImage> {
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 8 || SIG.some((v, i) => bytes[i] !== v)) throw new Error("Not a PNG file.");
  let p = 8;
  let ihdr: { w: number; h: number; depth: number; type: number } | null = null;
  let palette: Uint8Array | null = null, trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  let idatBytes = 0, ended = false;
  while (p + 12 <= bytes.length) {
    const len = u32(bytes, p);
    const type = String.fromCharCode(bytes[p + 4]!, bytes[p + 5]!, bytes[p + 6]!, bytes[p + 7]!);
    const body = p + 8, end = body + len;
    if (len > 0x7fffffff || end + 4 > bytes.length) throw new Error(`PNG chunk ${type} runs past the end of the file.`);
    if (crc32(bytes, p + 4, end) !== u32(bytes, end)) throw new Error(`PNG chunk ${type} fails its CRC.`);
    if (type === "IHDR") {
      if (len !== 13 || ihdr) throw new Error("PNG IHDR is malformed.");
      ihdr = { w: u32(bytes, body), h: u32(bytes, body + 4), depth: bytes[body + 8]!, type: bytes[body + 9]! };
      if (bytes[body + 10] !== 0 || bytes[body + 11] !== 0) throw new Error("PNG uses an unknown compression or filter method.");
      if (bytes[body + 12] !== 0) throw new Error("Interlaced PNG masks are not supported.");
    } else if (!ihdr) throw new Error("PNG does not start with IHDR.");
    else if (type === "PLTE") palette = bytes.slice(body, end);
    else if (type === "tRNS") trns = bytes.slice(body, end);
    else if (type === "IDAT") { idat.push(bytes.subarray(body, end)); idatBytes += len; }
    else if (type === "IEND") { ended = true; break; }
    p = end + 4;
  }
  if (!ihdr || !ended || !idat.length) throw new Error("PNG is truncated (no IHDR, IDAT or IEND).");
  const { w, h, depth, type } = ihdr;
  const channels = CHANNELS[type];
  if (!channels || !DEPTHS[type]!.includes(depth)) throw new Error(`PNG colour type ${type} at ${depth} bits is not valid.`);
  if (w < 1 || h < 1 || w > DESIGN_LIMITS.maxSide || h > DESIGN_LIMITS.maxSide || w * h > DESIGN_LIMITS.maxRasterPixels) throw new Error(`PNG is ${w} x ${h}, beyond the decode budget.`);
  if (expect && (w !== expect.width || h !== expect.height)) throw new Error(`PNG is ${w} x ${h}, expected ${expect.width} x ${expect.height}.`);
  if (type === 3 && (!palette || palette.length % 3 !== 0)) throw new Error("Palette PNG has no valid PLTE.");
  const rowBytes = Math.ceil((w * channels * depth) / 8);
  const bpp = Math.max(1, (channels * depth) >> 3);
  const z = new Uint8Array(idatBytes);
  let o = 0;
  for (const c of idat) { z.set(c, o); o += c.length; }
  const raw = await inflate(z, h * (rowBytes + 1));
  if (raw.length !== h * (rowBytes + 1)) throw new Error("PNG image data is shorter than its dimensions.");
  const data = new Uint8Array(h * rowBytes);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (rowBytes + 1)]!;
    const src = y * (rowBytes + 1) + 1, dst = y * rowBytes, prev = dst - rowBytes;
    for (let i = 0; i < rowBytes; i++) {
      const x = raw[src + i]!;
      const a = i >= bpp ? data[dst + i - bpp]! : 0;
      const b = y > 0 ? data[prev + i]! : 0;
      const c = y > 0 && i >= bpp ? data[prev + i - bpp]! : 0;
      let v: number;
      switch (f) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: v = x + paeth(a, b, c); break;
        default: throw new Error(`PNG row ${y} uses unknown filter ${f}.`);
      }
      data[dst + i] = v & 0xff;
    }
  }
  return { width: w, height: h, colorType: type as PngImage["colorType"], bitDepth: depth as PngImage["bitDepth"], data, rowBytes, palette, trns };
}

/** Sample `ch` of pixel `x` in row `y`, scaled to 0..255 (16-bit keeps the high byte, sub-byte depths expand). */
function sample(img: PngImage, x: number, y: number, ch: number, channels: number): number {
  const row = y * img.rowBytes;
  const d = img.bitDepth;
  if (d === 8) return img.data[row + x * channels + ch]!;
  if (d === 16) return img.data[row + (x * channels + ch) * 2]!;
  const per = 8 / d;
  const byte = img.data[row + Math.floor(x / per)]!;
  const shift = 8 - d * ((x % per) + 1);
  const v = (byte >> shift) & ((1 << d) - 1);
  return img.colorType === 3 ? v : Math.round((v * 255) / ((1 << d) - 1));
}

/** One coverage value per pixel. Gray: the gray level. RGB: the red channel (masks are r = g = b). Palette:
 *  the entry's red. Alpha (GA, RGBA, palette tRNS) multiplies the value, so a transparent pixel is
 *  uncovered; a gray/RGB tRNS colour key is ignored. */
export function pngToMask(img: PngImage): MaskData {
  const { width: w, height: h, colorType: t } = img;
  const channels = CHANNELS[t]!;
  const alpha = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v: number, a = 255;
      if (t === 3) {
        const idx = sample(img, x, y, 0, 1);
        v = img.palette![idx * 3] ?? 0;
        if (img.trns && idx < img.trns.length) a = img.trns[idx]!;
      } else {
        v = sample(img, x, y, 0, channels);
        if (t === 4) a = sample(img, x, y, 1, channels);
        else if (t === 6) a = sample(img, x, y, 3, channels);
      }
      alpha[y * w + x] = a === 255 ? v : Math.round((v * a) / 255);
    }
  }
  return { width: w, height: h, alpha };
}

/** A coverage mask as an 8-bit grayscale (mode L) PNG: one sample per pixel, filter 0, no ancillary
 *  chunks. This is what the brush mask is sent to dgx-vision as, so the service never has to guess which
 *  channel of an RGBA image holds the coverage. */
export async function encodeMaskPng(mask: MaskData): Promise<Uint8Array> {
  const { width: w, height: h, alpha } = mask;
  if (w < 1 || h < 1 || alpha.length !== w * h) throw new Error("encodeMaskPng: malformed mask");
  const raw = new Uint8Array(h * (w + 1));
  for (let y = 0; y < h; y++) raw.set(alpha.subarray(y * w, y * w + w), y * (w + 1) + 1);
  const cs = new CompressionStream("deflate");
  const writer = cs.writable.getWriter();
  void writer.write(raw).then(() => writer.close()).catch(() => undefined);
  const parts: Uint8Array[] = [];
  let zlen = 0;
  const reader = cs.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    zlen += value.length;
  }
  // Signature + IHDR (12 + 13) + IDAT (12 + zlen) + IEND (12).
  const out = new Uint8Array(8 + 25 + 12 + zlen + 12);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  let p = 8;
  const put32 = (v: number) => { out[p++] = (v >>> 24) & 255; out[p++] = (v >>> 16) & 255; out[p++] = (v >>> 8) & 255; out[p++] = v & 255; };
  const chunk = (type: string, len: number, write: () => void) => {
    put32(len);
    const start = p;
    for (let i = 0; i < 4; i++) out[p++] = type.charCodeAt(i);
    write();
    put32(crc32(out, start, p));
  };
  // 8-bit, colour type 0 (gray), deflate, filter method 0, no interlace.
  chunk("IHDR", 13, () => { put32(w); put32(h); out.set([8, 0, 0, 0, 0], p); p += 5; });
  chunk("IDAT", zlen, () => { for (const part of parts) { out.set(part, p); p += part.length; } });
  chunk("IEND", 0, () => undefined);
  return out;
}

/** A returned mask PNG, decoded and checked against the expected size. */
export async function decodeMaskPng(bytes: Uint8Array, width: number, height: number): Promise<MaskData> {
  return pngToMask(await decodePngImage(bytes, { width, height }));
}
