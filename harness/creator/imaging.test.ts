// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import {
  composeSpriteSheet, crc32, encodeGif, encodePng, lzwEncode, memeLayout, quantize, sheetManifest,
  spriteCss, spriteSheetLayout, wrapLines, type RgbaFrame,
} from "./imaging.ts";

/** Solid-colour frame. */
const solid = (w: number, h: number, r: number, g: number, b: number, a = 255): RgbaFrame => {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < rgba.length; i += 4) { rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = a; }
  return { width: w, height: h, rgba };
};

/** An independent GIF LZW decoder, so the encoder is proven by ROUND TRIP, not by eyeballing bytes. */
function lzwDecode(blocks: Uint8Array, minCodeSize: number): number[] {
  const data: number[] = [];
  for (let i = 0; i < blocks.length;) {
    const len = blocks[i]!;
    if (len === 0) break;
    for (let j = 0; j < len; j++) data.push(blocks[i + 1 + j]!);
    i += len + 1;
  }
  const clear = 1 << minCodeSize, eoi = clear + 1;
  let codeSize = minCodeSize + 1;
  let dict: number[][] = [];
  const reset = () => { dict = []; for (let i = 0; i < clear; i++) dict.push([i]); dict.push([], []); codeSize = minCodeSize + 1; };
  reset();
  const out: number[] = [];
  let bitPos = 0, prev: number[] | null = null;
  const read = (): number => {
    let v = 0;
    for (let i = 0; i < codeSize; i++) {
      const byte = data[(bitPos >> 3)] ?? 0;
      v |= ((byte >> (bitPos & 7)) & 1) << i;
      bitPos++;
    }
    return v;
  };
  for (;;) {
    if ((bitPos >> 3) >= data.length) break;
    const code = read();
    if (code === clear) { reset(); prev = null; continue; }
    if (code === eoi) break;
    let entry: number[];
    if (code < dict.length && dict[code]!.length) entry = dict[code]!;
    else if (prev) entry = [...prev, prev[0]!];
    else break;
    out.push(...entry);
    if (prev) {
      dict.push([...prev, entry[0]!]);
      if (dict.length === (1 << codeSize) && codeSize < 12) codeSize++;
    }
    prev = entry;
  }
  return out;
}

describe("PNG encoder (CREATOR-IMG, ADR-0291)", () => {
  test("emits the PNG signature, IHDR, IDAT, and IEND with valid CRCs", () => {
    const png = encodePng(solid(4, 3, 10, 20, 30));
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const text = Buffer.from(png).toString("latin1");
    expect(text.indexOf("IHDR")).toBe(12);
    expect(text).toContain("IDAT");
    expect(text.endsWith("IEND\u00ae\u0042\u0060\u0082")).toBe(true); // the fixed IEND chunk + its CRC
    // walk every chunk and verify its CRC independently
    let at = 8, chunks = 0;
    while (at < png.length) {
      const len = (png[at]! << 24) | (png[at + 1]! << 16) | (png[at + 2]! << 8) | png[at + 3]!;
      const body = png.subarray(at + 4, at + 8 + len);
      const crc = ((png[at + 8 + len]! << 24) | (png[at + 9 + len]! << 16) | (png[at + 10 + len]! << 8) | png[at + 11 + len]!) >>> 0;
      expect(crc32(body)).toBe(crc);
      at += 12 + len;
      chunks++;
    }
    expect(chunks).toBe(3);
  });

  test("IHDR carries the real dimensions and RGBA8 fields", () => {
    const png = encodePng(solid(7, 5, 1, 2, 3));
    const ihdr = png.subarray(16, 29);
    expect((ihdr[2]! << 8) | ihdr[3]!).toBe(7);
    expect((ihdr[6]! << 8) | ihdr[7]!).toBe(5);
    expect(ihdr[8]).toBe(8); // bit depth
    expect(ihdr[9]).toBe(6); // truecolour + alpha
  });

  test("the pixels survive: inflating IDAT reproduces every scanline with its filter byte", () => {
    const f = solid(2, 2, 200, 100, 50, 128);
    const png = encodePng(f);
    const start = 8 + 12 + 13; // signature + IHDR chunk
    const len = (png[start]! << 24) | (png[start + 1]! << 16) | (png[start + 2]! << 8) | png[start + 3]!;
    const raw = new Uint8Array(inflateSync(png.subarray(start + 8, start + 8 + len)));
    expect(raw.length).toBe(2 * (2 * 4 + 1));
    expect(raw[0]).toBe(0); // filter: none
    expect([...raw.subarray(1, 5)]).toEqual([200, 100, 50, 128]);
  });

  test("a malformed frame is refused instead of writing garbage", () => {
    expect(() => encodePng({ width: 2, height: 2, rgba: new Uint8Array(3) })).toThrow(/RGBA/);
    expect(() => encodePng({ width: 0, height: 2, rgba: new Uint8Array(0) })).toThrow(/positive/);
  });
});

describe("palette quantization", () => {
  test("a small palette survives EXACTLY (the pixel-art case)", () => {
    const f = solid(2, 2, 255, 0, 0);
    f.rgba.set([0, 255, 0, 255], 4);
    const q = quantize([f]);
    expect(q.exact).toBe(true);
    expect(q.colors).toBe(2);
    expect(q.indices[0]!.length).toBe(4);
    const c0 = q.indices[0]![0]!;
    expect([...q.palette.subarray(c0 * 3, c0 * 3 + 3)]).toEqual([255, 0, 0]);
  });

  test("transparency gets its own reserved slot", () => {
    const f = solid(2, 1, 9, 9, 9);
    f.rgba.set([0, 0, 0, 0], 4);
    const q = quantize([f]);
    expect(q.transparentIndex).not.toBeNull();
    expect(q.indices[0]![1]).toBe(q.transparentIndex ?? -1);
  });

  test("more than 256 colours folds deterministically and never exceeds the budget", () => {
    const w = 40, h = 40;
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
      rgba[i] = p % 251; rgba[i + 1] = (p * 7) % 253; rgba[i + 2] = (p * 13) % 249; rgba[i + 3] = 255;
    }
    const q1 = quantize([{ width: w, height: h, rgba }]);
    const q2 = quantize([{ width: w, height: h, rgba }]);
    expect(q1.exact).toBe(false);
    expect(q1.colors).toBeLessThanOrEqual(256);
    expect(Buffer.from(q1.palette).equals(Buffer.from(q2.palette))).toBe(true); // deterministic
    expect(Buffer.from(q1.indices[0]!).equals(Buffer.from(q2.indices[0]!))).toBe(true);
    for (const idx of q1.indices[0]!) expect(idx).toBeLessThan(q1.colors);
  });

  test("frames share ONE global palette", () => {
    const q = quantize([solid(2, 2, 255, 0, 0), solid(2, 2, 0, 0, 255)]);
    expect(q.colors).toBe(2);
    expect(q.indices).toHaveLength(2);
    expect(q.indices[0]![0]).not.toBe(q.indices[1]![0]);
  });
});

describe("GIF encoder", () => {
  test("LZW round-trips: the decoder recovers the exact index stream", () => {
    const indices = new Uint8Array([0, 0, 1, 1, 2, 2, 2, 0, 1, 2, 3, 3, 3, 3, 1, 0]);
    expect(lzwDecode(lzwEncode(indices, 2), 2)).toEqual([...indices]);
  });

  test("LZW round-trips a long run that forces code-size growth", () => {
    const indices = new Uint8Array(4096);
    for (let i = 0; i < indices.length; i++) indices[i] = (i * 5) % 16;
    expect(lzwDecode(lzwEncode(indices, 4), 4)).toEqual([...indices]);
  });

  test("a two-frame animation has the header, the loop extension, both frames, and the trailer", () => {
    const gif = encodeGif([solid(4, 4, 255, 0, 0), solid(4, 4, 0, 0, 255)], { delayMs: 120, loop: 0 });
    const text = Buffer.from(gif).toString("latin1");
    expect(text.startsWith("GIF89a")).toBe(true);
    expect(text).toContain("NETSCAPE2.0");
    expect(gif[gif.length - 1]).toBe(0x3B);
    let descriptors = 0;
    for (let i = 0; i < gif.length; i++) if (gif[i] === 0x2C) descriptors++;
    expect(descriptors).toBeGreaterThanOrEqual(2);
    expect((gif[6]! | (gif[7]! << 8))).toBe(4); // logical screen width
  });

  test("the delay is written in GIF ticks (hundredths), per frame", () => {
    const gif = encodeGif([solid(2, 2, 1, 2, 3), solid(2, 2, 4, 5, 6)], { delayMs: [250, 40] });
    const gce: number[] = [];
    for (let i = 0; i < gif.length - 8; i++) if (gif[i] === 0x21 && gif[i + 1] === 0xF9) gce.push(gif[i + 4]! | (gif[i + 5]! << 8));
    expect(gce).toEqual([25, 4]);
  });

  test("a transparent pixel sets the transparency flag and index", () => {
    const f = solid(2, 1, 200, 0, 0);
    f.rgba.set([0, 0, 0, 0], 4);
    const gif = encodeGif([f]);
    let flags = -1;
    for (let i = 0; i < gif.length - 8; i++) if (gif[i] === 0x21 && gif[i + 1] === 0xF9) { flags = gif[i + 3]!; break; }
    expect(flags & 1).toBe(1);
  });

  test("mismatched frame sizes and empty input are refused", () => {
    expect(() => encodeGif([solid(2, 2, 0, 0, 0), solid(3, 2, 0, 0, 0)])).toThrow(/share one size/);
    expect(() => encodeGif([])).toThrow(/at least one frame/);
  });

  test("encoding is byte-deterministic", () => {
    const frames = [solid(6, 6, 12, 34, 56), solid(6, 6, 200, 10, 10)];
    expect(Buffer.from(encodeGif(frames, { delayMs: 80 })).equals(Buffer.from(encodeGif(frames, { delayMs: 80 })))).toBe(true);
  });
});

describe("sprite sheets", () => {
  test("layout packs near-square by default and honors an explicit column count", () => {
    const auto = spriteSheetLayout({ count: 9, frameWidth: 32, frameHeight: 32 });
    expect([auto.columns, auto.rows, auto.width, auto.height]).toEqual([3, 3, 96, 96]);
    const strip = spriteSheetLayout({ count: 8, frameWidth: 16, frameHeight: 24, columns: 8 });
    expect([strip.columns, strip.rows, strip.width, strip.height]).toEqual([8, 1, 128, 24]);
    const wrapped = spriteSheetLayout({ count: 7, frameWidth: 10, frameHeight: 10, columns: 4 });
    expect([wrapped.columns, wrapped.rows]).toEqual([4, 2]);
    expect(wrapped.cells[4]).toEqual({ index: 4, x: 0, y: 10 });
  });

  test("frames land in their cells and empty cells stay transparent", () => {
    const { frame, layout } = composeSpriteSheet([solid(2, 2, 255, 0, 0), solid(2, 2, 0, 255, 0), solid(2, 2, 0, 0, 255)], 2);
    expect([layout.columns, layout.rows, frame.width, frame.height]).toEqual([2, 2, 4, 4]);
    const at = (x: number, y: number) => [...frame.rgba.subarray((y * frame.width + x) * 4, (y * frame.width + x) * 4 + 4)];
    expect(at(0, 0)).toEqual([255, 0, 0, 255]);
    expect(at(2, 0)).toEqual([0, 255, 0, 255]);
    expect(at(0, 2)).toEqual([0, 0, 255, 255]);
    expect(at(3, 3)).toEqual([0, 0, 0, 0]); // the unused 4th cell
  });

  test("the CSS snippet steps through every cell and the manifest describes each rect", () => {
    const { layout } = composeSpriteSheet([solid(4, 4, 1, 1, 1), solid(4, 4, 2, 2, 2)], 2);
    const css = spriteCss("run cycle", layout, 400);
    expect(css).toContain(".run-cycle {");
    expect(css).toContain("steps(1) infinite");
    expect(css).toContain("background-position: -4px -0px");
    expect(css).toContain("image-rendering: pixelated");
    const man: unknown = JSON.parse(sheetManifest("run", layout, 400));
    expect(man).toMatchObject({
      image: "run.png", count: 2, frameDurationMs: 200, columns: 2, rows: 1,
      frames: [{ index: 0, x: 0, y: 0, w: 4, h: 4 }, { index: 1, x: 4, y: 0, w: 4, h: 4 }],
    });
  });

  test("mismatched frames are refused", () => {
    expect(() => composeSpriteSheet([solid(2, 2, 0, 0, 0), solid(2, 3, 0, 0, 0)])).toThrow(/share one size/);
  });
});

describe("meme layout", () => {
  // A stub monospace metric: every glyph is 0.6em, which makes the wrap math checkable by hand.
  const measure = (t: string, px: number) => t.length * px * 0.6;

  test("wrapping breaks on words and never overflows", () => {
    const lines = wrapLines("one does not simply wrap text", 120, 20, measure);
    for (const l of lines) expect(measure(l, 20)).toBeLessThanOrEqual(120);
    expect(lines.join(" ")).toBe("one does not simply wrap text");
  });

  test("a single unbreakable word is split rather than spilling out of the image", () => {
    const lines = wrapLines("supercalifragilistic", 60, 20, measure);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(measure(l, 20)).toBeLessThanOrEqual(60);
    expect(lines.join("")).toBe("supercalifragilistic");
  });

  test("text shrinks to fit the top and bottom thirds", () => {
    const l = memeLayout({ width: 400, height: 400, top: "when the build is green", bottom: "but you never ran the tests", measure });
    expect(l.top).not.toBeNull();
    expect(l.bottom).not.toBeNull();
    expect(l.top!.lines.length * l.top!.lineHeight).toBeLessThanOrEqual(400 / 3);
    expect(l.top!.y).toBeGreaterThan(0);
    expect(l.bottom!.y + (l.bottom!.lines.length - 1) * l.bottom!.lineHeight).toBeLessThanOrEqual(400);
    expect(l.strokePx).toBeGreaterThanOrEqual(2);
  });

  test("empty text yields no block at all, and a bad size is refused", () => {
    const l = memeLayout({ width: 200, height: 200, top: "   ", measure });
    expect(l.top).toBeNull();
    expect(l.bottom).toBeNull();
    expect(() => memeLayout({ width: 0, height: 10, measure })).toThrow(/positive/);
  });
});
