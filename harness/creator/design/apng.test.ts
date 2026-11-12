// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/creator/design/apng.test.ts - APNG chunk layout, CRCs, sequence numbers, and pixel round trip.

import { describe, expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import { encodeApng, encodePngAsync } from "./apng.ts";
import { crc32 } from "../imaging_core.ts";
import { DESIGN_LIMITS } from "./limits.ts";
import type { RasterData } from "./types.ts";

const raster = (w: number, h: number, seed: number): RasterData => {
  const rgba = new Uint8ClampedArray(w * h * 4);
  let s = seed >>> 0 || 1;
  for (let i = 0; i < rgba.length; i++) {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    rgba[i] = i % 7 === 0 ? 255 : s & 0xFF; // mix of noise and repeats so every filter type gets used
  }
  return { width: w, height: h, rgba };
};

const be32 = (b: Uint8Array, o: number): number => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;

interface Chunk { type: string; data: Uint8Array }

/** Walk every chunk after the signature, verifying each CRC. */
function chunks(png: Uint8Array): Chunk[] {
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const out: Chunk[] = [];
  let at = 8;
  while (at < png.length) {
    const len = be32(png, at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const data = png.subarray(at + 8, at + 8 + len);
    expect(be32(png, at + 8 + len)).toBe(crc32(png.subarray(at + 4, at + 8 + len)));
    out.push({ type, data });
    at += 12 + len;
  }
  expect(at).toBe(png.length);
  return out;
}

/** Independent PNG unfilter for 8-bit RGBA. */
function unfilter(data: Uint8Array, w: number, h: number): Uint8Array {
  const rb = w * 4;
  expect(data.length).toBe((rb + 1) * h);
  const out = new Uint8Array(rb * h);
  for (let y = 0; y < h; y++) {
    const ft = data[y * (rb + 1)]!;
    for (let i = 0; i < rb; i++) {
      const x = data[y * (rb + 1) + 1 + i]!;
      const a = i >= 4 ? out[y * rb + i - 4]! : 0;
      const b = y > 0 ? out[(y - 1) * rb + i]! : 0;
      const c = i >= 4 && y > 0 ? out[(y - 1) * rb + i - 4]! : 0;
      let pred = 0;
      if (ft === 1) pred = a;
      else if (ft === 2) pred = b;
      else if (ft === 3) pred = (a + b) >> 1;
      else if (ft === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (ft !== 0) throw new Error(`bad filter type ${ft}`);
      out[y * rb + i] = (x + pred) & 0xFF;
    }
  }
  return out;
}

describe("encodeApng", () => {
  test("chunk order, CRCs, contiguous sequence numbers, acTL/fcTL fields, and pixel round trip", async () => {
    const frames = [raster(9, 6, 1), raster(9, 6, 2), raster(9, 6, 3)];
    const png = await encodeApng(frames, { delayMs: [100, 33, 70000], loop: 2 });
    const cs = chunks(png);
    expect(cs.map((c) => c.type)).toEqual(["IHDR", "acTL", "fcTL", "IDAT", "fcTL", "fdAT", "fcTL", "fdAT", "IEND"]);
    const ihdr = cs[0]!.data;
    expect([be32(ihdr, 0), be32(ihdr, 4), ihdr[8], ihdr[9], ihdr[12]]).toEqual([9, 6, 8, 6, 0]);
    expect([be32(cs[1]!.data, 0), be32(cs[1]!.data, 4)]).toEqual([3, 2]);

    const seqs = cs.filter((c) => c.type === "fcTL" || c.type === "fdAT").map((c) => be32(c.data, 0));
    expect(seqs).toEqual([0, 1, 2, 3, 4]);

    const fctls = cs.filter((c) => c.type === "fcTL").map((c) => c.data);
    const u16 = (d: Uint8Array, o: number): number => (d[o]! << 8) | d[o + 1]!;
    for (const f of fctls) {
      expect(f.length).toBe(26);
      expect([be32(f, 4), be32(f, 8), be32(f, 12), be32(f, 16), f[24], f[25]]).toEqual([9, 6, 0, 0, 0, 0]);
    }
    expect([u16(fctls[0]!, 20), u16(fctls[0]!, 22)]).toEqual([100, 1000]);
    expect([u16(fctls[1]!, 20), u16(fctls[1]!, 22)]).toEqual([33, 1000]);
    expect([u16(fctls[2]!, 20), u16(fctls[2]!, 22)]).toEqual([7000, 100]); // > 65535 ms falls back to centiseconds

    const idat = cs[3]!.data;
    expect([...unfilter(new Uint8Array(inflateSync(idat)), 9, 6)]).toEqual([...frames[0]!.rgba]);
    const fd1 = cs[5]!.data, fd2 = cs[7]!.data;
    expect([...unfilter(new Uint8Array(inflateSync(fd1.subarray(4))), 9, 6)]).toEqual([...frames[1]!.rgba]);
    expect([...unfilter(new Uint8Array(inflateSync(fd2.subarray(4))), 9, 6)]).toEqual([...frames[2]!.rgba]);

    for (const banned of ["tEXt", "iTXt", "zTXt", "eXIf", "tIME", "gAMA", "iCCP", "sRGB", "pHYs"]) {
      expect(cs.some((c) => c.type === banned)).toBe(false);
    }
  });

  test("a single frame is still a valid APNG with one fcTL and an IDAT", async () => {
    const f = raster(3, 2, 9);
    const cs = chunks(await encodeApng([f], { delayMs: 40, loop: 0 }));
    expect(cs.map((c) => c.type)).toEqual(["IHDR", "acTL", "fcTL", "IDAT", "IEND"]);
    expect([be32(cs[1]!.data, 0), be32(cs[1]!.data, 4)]).toEqual([1, 0]);
  });

  test("refuses mismatched sizes, too many frames, and bad delays", async () => {
    await expect(encodeApng([raster(2, 2, 1), raster(3, 2, 1)], { delayMs: 10, loop: 0 })).rejects.toThrow(/must match/);
    const one = raster(1, 1, 1);
    await expect(encodeApng(new Array<RasterData>(DESIGN_LIMITS.maxFrames + 1).fill(one), { delayMs: 10, loop: 0 })).rejects.toThrow(/frame limit/);
    await expect(encodeApng([one], { delayMs: -1, loop: 0 })).rejects.toThrow();
    await expect(encodeApng([one, one], { delayMs: [10], loop: 0 })).rejects.toThrow();
  });
});

describe("encodePngAsync", () => {
  test("encodes a plain PNG whose IDAT stream inflates back to the pixels", async () => {
    const f = raster(17, 11, 5);
    const cs = chunks(await encodePngAsync(f));
    expect(cs[0]!.type).toBe("IHDR");
    expect(cs[cs.length - 1]!.type).toBe("IEND");
    expect(cs.every((c) => c.type === "IHDR" || c.type === "IDAT" || c.type === "IEND")).toBe(true);
    const z = Buffer.concat(cs.filter((c) => c.type === "IDAT").map((c) => c.data));
    expect([...unfilter(new Uint8Array(inflateSync(z)), 17, 11)]).toEqual([...f.rgba]);
  });
});
