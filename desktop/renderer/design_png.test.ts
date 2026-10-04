// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import { decodeMaskPng, decodePngImage, encodeMaskPng, pngToMask } from "./design_png.ts";

// ── a tiny PNG writer for fixtures (independent of the decoder under test) ──

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const v of b) c = CRC[(c ^ v) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
function chunk(type: string, data: Uint8Array | number[]): number[] {
  const body = new Uint8Array([...type].map((c) => c.charCodeAt(0)).concat([...data]));
  return [...be32(data.length), ...body, ...be32(crc(body))];
}

/** Filter each row with filter (row % 5) so every PNG filter type is exercised. */
function filtered(rows: Uint8Array[], bpp: number): Uint8Array {
  const out: number[] = [];
  rows.forEach((row, y) => {
    const f = y % 5;
    const prev = y > 0 ? rows[y - 1]! : new Uint8Array(row.length);
    out.push(f);
    for (let i = 0; i < row.length; i++) {
      const a = i >= bpp ? row[i - bpp]! : 0, b = prev[i]!, c = i >= bpp ? prev[i - bpp]! : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      out.push((row[i]! - pred) & 255);
    }
  });
  return new Uint8Array(out);
}

function png(w: number, h: number, colorType: number, depth: number, rows: Uint8Array[], extra: number[] = [], interlace = 0): Uint8Array {
  const CH: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const channels = CH[colorType]!;
  const bpp = Math.max(1, (channels * depth) >> 3);
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk("IHDR", [...be32(w), ...be32(h), depth, colorType, 0, 0, interlace]),
    ...extra,
    ...chunk("IDAT", deflateSync(filtered(rows, bpp))),
    ...chunk("IEND", []),
  ]);
}

/** An 8-bit L mask: a filled disc of 255 on 0, with a soft 128 ring, like a SAM mask in mode L. */
function discRows(w: number, h: number): Uint8Array[] {
  return Array.from({ length: h }, (_, y) => Uint8Array.from({ length: w }, (_, x) => {
    const d = Math.hypot(x - w / 2, y - h / 2);
    return d < h / 3 ? 255 : d < h / 3 + 1.5 ? 128 : 0;
  }));
}

describe("mask PNG decoding", () => {
  test("an 8-bit grayscale (mode L) mask decodes to exactly one coverage value per pixel", async () => {
    const w = 53, h = 37;
    const rows = discRows(w, h);
    const m = await decodeMaskPng(png(w, h, 0, 8, rows), w, h);
    expect(m.alpha.length).toBe(w * h);
    expect(Array.from(m.alpha)).toEqual(rows.flatMap((r) => Array.from(r)));
    // No stride drift: the disc centre is covered and the corners and edge midpoints are not.
    expect(m.alpha[Math.floor(h / 2) * w + Math.floor(w / 2)]).toBe(255);
    for (const [x, y] of [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1], [0, Math.floor(h / 2)], [w - 1, Math.floor(h / 2)]]) expect(m.alpha[y! * w + x!]).toBe(0);
  });

  test("the same mask stored as RGB (r = g = b), RGBA, or 16-bit gray gives the same plane", async () => {
    const w = 20, h = 11;
    const rows = discRows(w, h);
    const want = rows.flatMap((r) => Array.from(r));
    const rgb = rows.map((r) => Uint8Array.from(Array.from(r).flatMap((v) => [v, v, v])));
    const rgba = rows.map((r) => Uint8Array.from(Array.from(r).flatMap((v) => [v, v, v, 255])));
    const l16 = rows.map((r) => Uint8Array.from(Array.from(r).flatMap((v) => [v, 0x7f])));
    expect(Array.from((await decodeMaskPng(png(w, h, 2, 8, rgb), w, h)).alpha)).toEqual(want);
    expect(Array.from((await decodeMaskPng(png(w, h, 6, 8, rgba), w, h)).alpha)).toEqual(want);
    expect(Array.from((await decodeMaskPng(png(w, h, 0, 16, l16), w, h)).alpha)).toEqual(want);
  });

  test("alpha multiplies coverage; 1-bit gray expands to 0/255; palette reads the entry with its tRNS", async () => {
    const ga = await decodeMaskPng(png(2, 1, 4, 8, [Uint8Array.from([255, 128, 200, 0])]), 2, 1);
    expect(Array.from(ga.alpha)).toEqual([128, 0]);
    const bits = await decodeMaskPng(png(10, 1, 0, 1, [Uint8Array.from([0b10100000, 0b01000000])]), 10, 1);
    expect(Array.from(bits.alpha)).toEqual([255, 0, 255, 0, 0, 0, 0, 0, 0, 255]);
    const pal = await decodeMaskPng(png(3, 1, 3, 8, [Uint8Array.from([0, 1, 2])], [...chunk("PLTE", [0, 0, 0, 255, 255, 255, 200, 9, 9]), ...chunk("tRNS", [255, 255, 0])]), 3, 1);
    expect(Array.from(pal.alpha)).toEqual([0, 255, 0]);
  });

  test("refuses a mask of the wrong size, a corrupt chunk, interlacing, truncation, and non-PNG bytes", async () => {
    const good = png(8, 8, 0, 8, discRows(8, 8));
    await expect(decodeMaskPng(good, 8, 9)).rejects.toThrow("expected 8 x 9");
    const bad = good.slice();
    bad[40] ^= 0xff; // inside IDAT
    await expect(decodeMaskPng(bad, 8, 8)).rejects.toThrow("CRC");
    await expect(decodeMaskPng(png(8, 8, 0, 8, discRows(8, 8), [], 1), 8, 8)).rejects.toThrow("Interlaced");
    await expect(decodeMaskPng(png(8, 8, 0, 8, discRows(8, 7)), 8, 8)).rejects.toThrow("shorter");
    await expect(decodeMaskPng(good.subarray(0, 30), 8, 8)).rejects.toThrow();
    await expect(decodeMaskPng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]), 8, 8)).rejects.toThrow("Not a PNG");
  });

  test("the brush mask is sent as an 8-bit grayscale PNG that decodes back byte for byte", async () => {
    const w = 300, h = 7;
    const alpha = Uint8Array.from({ length: w * h }, (_, i) => (i * 37) & 255);
    const bytes = await encodeMaskPng({ width: w, height: h, alpha });
    const img = await decodePngImage(bytes, { width: w, height: h });
    expect([img.colorType, img.bitDepth]).toEqual([0, 8]);
    expect(Array.from(pngToMask(img).alpha)).toEqual(Array.from(alpha));
  });

  test("the image header is reported as stored", async () => {
    const img = await decodePngImage(png(4, 2, 0, 8, discRows(4, 2)));
    expect([img.width, img.height, img.colorType, img.bitDepth, img.rowBytes]).toEqual([4, 2, 0, 8, 4]);
    expect(pngToMask(img).alpha.length).toBe(8);
  });
});
