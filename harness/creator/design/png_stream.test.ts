// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/creator/design/png_stream.test.ts - strip-wise PNG encoder: round trip, IDAT bound, refusals.

import { describe, expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import { IDAT_MAX_BYTES, encodePngTiled } from "./png_stream.ts";
import { crc32 } from "../imaging_core.ts";

const be32 = (b: Uint8Array, o: number): number => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;

interface Chunk { type: string; data: Uint8Array }

function chunks(png: Uint8Array): Chunk[] {
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const out: Chunk[] = [];
  let at = 8;
  while (at < png.length) {
    const len = be32(png, at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    expect(be32(png, at + 8 + len)).toBe(crc32(png.subarray(at + 4, at + 8 + len)));
    out.push({ type, data: png.subarray(at + 8, at + 8 + len) });
    at += 12 + len;
  }
  return out;
}

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

/** Decode a PNG produced here: IHDR dims, concatenated IDAT inflated and unfiltered. */
function decode(png: Uint8Array): { w: number; h: number; rgba: Uint8Array; idat: Uint8Array[]; types: string[] } {
  const cs = chunks(png);
  const ihdr = cs[0]!.data;
  const w = be32(ihdr, 0), h = be32(ihdr, 4);
  const idat = cs.filter((c) => c.type === "IDAT").map((c) => c.data);
  const rgba = unfilter(new Uint8Array(inflateSync(Buffer.concat(idat))), w, h);
  return { w, h, rgba, idat, types: cs.map((c) => c.type) };
}

const sliceRows = (src: Uint8ClampedArray, w: number) => (y0: number, rows: number): Uint8ClampedArray => src.subarray(y0 * w * 4, (y0 + rows) * w * 4);

describe("encodePngTiled", () => {
  test("a 300x200 gradient in strips of 7 rows round-trips exactly", async () => {
    const w = 300, h = 200;
    const src = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        src[i] = x & 255; src[i + 1] = y; src[i + 2] = (x * y) & 255; src[i + 3] = 255 - (x % 50);
      }
    }
    const calls: [number, number][] = [];
    const progress: number[] = [];
    const png = await encodePngTiled(w, h, (y0, rows) => { calls.push([y0, rows]); return sliceRows(src, w)(y0, rows); }, {
      rowsPerStrip: 7,
      onProgress: (done, total) => { expect(total).toBe(h); progress.push(done); },
    });
    const d = decode(png);
    expect([d.w, d.h]).toEqual([w, h]);
    expect(d.types[0]).toBe("IHDR");
    expect(d.types[d.types.length - 1]).toBe("IEND");
    expect(d.types.every((t) => t === "IHDR" || t === "IDAT" || t === "IEND")).toBe(true);
    expect(Buffer.from(d.rgba).equals(Buffer.from(src.buffer, src.byteOffset, src.byteLength))).toBe(true);
    expect(calls.length).toBe(Math.ceil(h / 7));
    expect(calls[calls.length - 1]).toEqual([196, 4]);
    expect(progress[progress.length - 1]).toBe(h);
  });

  test("incompressible data is split into IDAT chunks of at most 1 MiB that still round-trip", async () => {
    const w = 640, h = 480;
    const src = new Uint8ClampedArray(w * h * 4);
    let s = 0x9E3779B9;
    for (let i = 0; i < src.length; i++) { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; src[i] = s & 0xFF; }
    const d = decode(await encodePngTiled(w, h, sliceRows(src, w), { rowsPerStrip: 33 }));
    expect(d.idat.length).toBeGreaterThanOrEqual(2);
    for (const c of d.idat) expect(c.length).toBeLessThanOrEqual(IDAT_MAX_BYTES);
    expect(Buffer.from(d.rgba).equals(Buffer.from(src.buffer, src.byteOffset, src.byteLength))).toBe(true);
  });

  test("a buffer reused by readRows across strips is safe (previous row is copied)", async () => {
    const w = 5, h = 9;
    const src = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < src.length; i++) src[i] = (i * 37) & 255;
    const scratch = new Uint8ClampedArray(2 * w * 4);
    const d = decode(await encodePngTiled(w, h, (y0, rows) => {
      const out = scratch.subarray(0, rows * w * 4);
      out.set(src.subarray(y0 * w * 4, (y0 + rows) * w * 4));
      return out;
    }, { rowsPerStrip: 2 }));
    expect([...d.rgba]).toEqual([...src]);
  });

  test("readRows returning the wrong length rejects", async () => {
    await expect(encodePngTiled(4, 4, () => new Uint8ClampedArray(3))).rejects.toThrow(/exactly/);
  });

  test("an aborted signal rejects with an AbortError, before or during encoding", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const pre = await encodePngTiled(4, 4, () => new Uint8ClampedArray(64), { signal: ctl.signal }).then(() => null, (e: unknown) => e);
    expect(pre).toBeInstanceOf(Error);
    expect((pre as Error).name).toBe("AbortError");

    const mid = new AbortController();
    const src = new Uint8ClampedArray(8 * 8 * 4);
    const during = await encodePngTiled(8, 8, sliceRows(src, 8), { rowsPerStrip: 2, signal: mid.signal, onProgress: (done) => { if (done === 4) mid.abort(); } })
      .then(() => null, (e: unknown) => e);
    expect(during).toBeInstanceOf(Error);
    expect((during as Error).name).toBe("AbortError");
  });

  test("refuses sides outside 1..65535", async () => {
    await expect(encodePngTiled(0, 4, () => new Uint8ClampedArray(0))).rejects.toThrow();
    await expect(encodePngTiled(65536, 1, () => new Uint8ClampedArray(65536 * 4))).rejects.toThrow(/side limit/);
  });
});
