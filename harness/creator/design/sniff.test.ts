// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/creator/design/sniff.test.ts - header sniffing dims, truncation safety, and the decode budget.

import { describe, expect, test } from "bun:test";
import { checkDecodeBudget, sniffImage } from "./sniff.ts";
import { DESIGN_LIMITS } from "./limits.ts";
import { PNG_SIGNATURE, concat, pngChunk, pngIhdrRgba8 } from "../imaging_core.ts";

const bytes = (...parts: (number[] | string | Uint8Array)[]): Uint8Array =>
  concat(parts.map((p) => (typeof p === "string" ? new Uint8Array([...p].map((c) => c.charCodeAt(0))) : p instanceof Uint8Array ? p : new Uint8Array(p))));
const le16 = (v: number): number[] => [v & 0xFF, (v >>> 8) & 0xFF];
const le32 = (v: number): number[] => [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF];
const be16 = (v: number): number[] => [(v >>> 8) & 0xFF, v & 0xFF];
const be32 = (v: number): number[] => [(v >>> 24) & 0xFF, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF];

function png(w: number, h: number, frames?: number): Uint8Array {
  const parts = [PNG_SIGNATURE, pngChunk("IHDR", pngIhdrRgba8(w, h))];
  if (frames !== undefined) parts.push(pngChunk("acTL", new Uint8Array([...be32(frames), ...be32(0)])));
  parts.push(pngChunk("IDAT", new Uint8Array([0x78, 0x9C, 3, 0, 0, 0, 0, 1])), pngChunk("IEND", new Uint8Array(0)));
  return concat(parts);
}

const JPEG = bytes(
  [0xFF, 0xD8],
  [0xFF, 0xE0], be16(16), "JFIF", [0, 1, 1, 0, 0, 1, 0, 1, 0, 0],
  [0xFF, 0xFF, 0xC0], be16(17), [8], be16(300), be16(400), [3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1],
  [0xFF, 0xD9],
);

function gif(w: number, h: number, frames: number): Uint8Array {
  const parts: (number[] | string)[] = ["GIF89a", le16(w), le16(h), [0x80, 0, 0], [0, 0, 0, 255, 255, 255]];
  parts.push([0x21, 0xFF, 11], "NETSCAPE2.0", [3, 1, 0, 0, 0]);
  for (let i = 0; i < frames; i++) {
    parts.push([0x21, 0xF9, 4, 0, 10, 0, 0, 0]);
    parts.push([0x2C], le16(0), le16(0), le16(Math.min(w, 2)), le16(Math.min(h, 2)), [0]);
    parts.push([2, 2, 0x44, 0x01, 0]);
  }
  parts.push([0x3B]);
  return bytes(...parts);
}

const riff = (...chunks: Uint8Array[]): Uint8Array => {
  const body = concat(chunks);
  return bytes("RIFF", le32(4 + body.length), "WEBP", body);
};
const webpChunk = (fourcc: string, data: number[]): Uint8Array => bytes(fourcc, le32(data.length), data, data.length & 1 ? [0] : []);

const VP8 = riff(webpChunk("VP8 ", [0x30, 0x01, 0x00, 0x9D, 0x01, 0x2A, ...le16(640 | 0x4000), ...le16(480 | 0x8000), 0, 0]));
const VP8L = riff(webpChunk("VP8L", [0x2F, ...le32(999 | (1999 << 14)), 0, 0]));
const VP8X = riff(
  webpChunk("VP8X", [0x02, 0, 0, 0, 1919 & 0xFF, (1919 >> 8) & 0xFF, 0, 1079 & 0xFF, (1079 >> 8) & 0xFF, 0]),
  webpChunk("ANIM", [0, 0, 0, 0, 0, 0]),
  webpChunk("ANMF", new Array<number>(16).fill(0)),
  webpChunk("ANMF", new Array<number>(17).fill(0)),
);
const BMP = bytes("BM", le32(1000), le32(0), le32(54), le32(40), le32(123), le32(-45 >>> 0), le16(1), le16(32));
const PSD = bytes("8BPS", be16(1), [0, 0, 0, 0, 0, 0], be16(3), be32(600), be32(800), be16(8), be16(3));

describe("sniffImage", () => {
  test("reads dims (and frames) from minimal headers of every format", () => {
    expect(sniffImage(png(320, 240))).toEqual({ format: "png", width: 320, height: 240 });
    expect(sniffImage(png(32, 16, 12))).toEqual({ format: "png", width: 32, height: 16, frames: 12 });
    expect(sniffImage(JPEG)).toEqual({ format: "jpeg", width: 400, height: 300 });
    expect(sniffImage(gif(7, 5, 3))).toEqual({ format: "gif", width: 7, height: 5, frames: 3 });
    expect(sniffImage(VP8)).toEqual({ format: "webp", width: 640, height: 480 });
    expect(sniffImage(VP8L)).toEqual({ format: "webp", width: 1000, height: 2000 });
    expect(sniffImage(VP8X)).toEqual({ format: "webp", width: 1920, height: 1080, frames: 2 });
    expect(sniffImage(BMP)).toEqual({ format: "bmp", width: 123, height: 45 });
    expect(sniffImage(PSD)).toEqual({ format: "psd", width: 800, height: 600 });
  });

  test("an acTL after the first IDAT is not an animation", () => {
    const p = concat([PNG_SIGNATURE, pngChunk("IHDR", pngIhdrRgba8(4, 4)), pngChunk("IDAT", new Uint8Array(4)), pngChunk("acTL", new Uint8Array([...be32(99), ...be32(0)]))]);
    expect(sniffImage(p).frames).toBeUndefined();
  });

  test("SVG: optional BOM and whitespace, xml prolog or comment, '<svg' within 4 KB, case-insensitive; no dims", () => {
    const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
    expect(sniffImage(enc("\uFEFF \n<?xml version=\"1.0\"?>\n<SVG xmlns=\"http://www.w3.org/2000/svg\"/>"))).toEqual({ format: "svg" });
    expect(sniffImage(enc("<!-- c --><svg width=\"10\"></svg>"))).toEqual({ format: "svg" });
    expect(sniffImage(enc("<svg/>"))).toEqual({ format: "svg" });
    expect(sniffImage(enc("<?xml version=\"1.0\"?><html></html>")).format).toBe("unknown");
    expect(sniffImage(enc(`<?xml version="1.0"?>${" ".repeat(5000)}<svg/>`)).format).toBe("unknown");
    expect(sniffImage(enc("hello <svg/>")).format).toBe("unknown");
  });

  test("PSD with an unknown version and random bytes are unknown", () => {
    expect(sniffImage(bytes("8BPS", be16(3), new Array<number>(20).fill(0))).format).toBe("unknown");
    expect(sniffImage(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])).format).toBe("unknown");
    expect(sniffImage(new Uint8Array(0)).format).toBe("unknown");
  });

  test("every truncated prefix keeps the format's dims either exact or undefined", () => {
    const samples = [png(320, 240, 4), JPEG, gif(7, 5, 3), VP8, VP8L, VP8X, BMP, PSD];
    for (const s of samples) {
      const full = sniffImage(s);
      for (let n = 0; n <= s.length; n++) {
        const r = sniffImage(s.subarray(0, n));
        if (r.width !== undefined) expect(r.width).toBe(full.width!);
        if (r.height !== undefined) expect(r.height).toBe(full.height!);
        if (r.frames !== undefined) expect(r.frames).toBeLessThanOrEqual(full.frames!);
        if (r.format !== "unknown") expect(full.format).toBe(r.format);
      }
    }
  });

  test("a GIF frame count stops one past the limit", () => {
    const r = sniffImage(gif(2, 2, DESIGN_LIMITS.maxGifFrames + 5));
    expect(r.frames).toBe(DESIGN_LIMITS.maxGifFrames + 1);
  });
});

describe("checkDecodeBudget", () => {
  const budget = 50_000_000;

  test("accepts in-budget rasters and SVG without dims", () => {
    expect(checkDecodeBudget(sniffImage(png(320, 240)), budget)).toBeNull();
    expect(checkDecodeBudget(sniffImage(gif(7, 5, 3)), budget)).toBeNull();
    expect(checkDecodeBudget(sniffImage(new TextEncoder().encode("<svg/>")), budget)).toBeNull();
  });

  test("refuses a bomb PNG header, over-side and over-pixel dims", () => {
    expect(checkDecodeBudget(sniffImage(png(100000, 100000)), DESIGN_LIMITS.maxRasterPixels)).toMatch(/side limit/);
    expect(checkDecodeBudget(sniffImage(png(60000, 60000)), DESIGN_LIMITS.maxRasterPixels)).toMatch(/budget/);
  });

  test("multiplies by frames: a GIF whose frames * w * h exceeds the budget is refused", () => {
    const one = sniffImage(gif(5000, 5000, 1));
    const three = sniffImage(gif(5000, 5000, 3));
    expect(checkDecodeBudget(one, budget)).toBeNull();
    expect(checkDecodeBudget(three, budget)).toMatch(/3 frames/);
  });

  test("refuses unknown formats, missing dims, and non-positive dims", () => {
    expect(checkDecodeBudget(sniffImage(new Uint8Array([0, 1, 2])), budget)).toMatch(/unrecognized/);
    expect(checkDecodeBudget(sniffImage(JPEG.subarray(0, 10)), budget)).toMatch(/dimensions unavailable/);
    expect(checkDecodeBudget(sniffImage(bytes("BM", le32(0), le32(0), le32(54), le32(40), le32(-5 >>> 0), le32(5))), budget)).toMatch(/invalid/);
    expect(checkDecodeBudget(sniffImage(png(0, 10)), budget)).toMatch(/invalid/);
  });
});
