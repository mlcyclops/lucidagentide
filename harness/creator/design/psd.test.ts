// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/creator/design/psd.test.ts - PSD/PSB writer parsed back by an independent reader in this file.

import { describe, expect, test } from "bun:test";
import { packBits, writePsd } from "./psd.ts";
import type { BlendMode, DesignDoc, Layer, RasterData } from "./types.ts";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const raster = (w: number, h: number, seed: number): RasterData => {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < rgba.length; i++) rgba[i] = (i % 4 === 3) ? (i < rgba.length / 2 ? 255 : (i * seed) & 255) : ((i * 31 + seed * 17) >> 2) & 255;
  return { width: w, height: h, rgba };
};

function baseLayer(id: string, name: string, extra: Record<string, unknown>): Layer {
  const blend: BlendMode = "normal";
  return {
    id, name, visible: true, locked: false, opacity: 1, blend, x: 0, y: 0,
    scale: 1, rotation: 0, anchorX: 0, anchorY: 0, ...extra,
  } as unknown as Layer;
}

function makeDoc(width: number, height: number): DesignDoc {
  const layers = Object.create(null) as Record<string, Layer>;
  layers.bg = baseLayer("bg", "Background", { kind: "raster", width, height });
  layers.grp = baseLayer("grp", "Group", { kind: "group", visible: false, opacity: 0.5, children: ["inner"] });
  layers.inner = baseLayer("inner", "Inner", { kind: "raster", width: 2, height: 2, x: 1, y: 1, parentId: "grp" });
  layers.cat = baseLayer("cat", "Caf\u00e9 \u732b", { kind: "raster", width: 4, height: 3, x: 3, y: -2, blend: "multiply", opacity: 0.5, visible: false });
  layers.vec = baseLayer("vec", "Vector", { kind: "vector", shapes: [] });
  return {
    version: 1, id: "doc1", name: "Doc", width, height, background: null, layers,
    order: ["bg", "grp", "cat", "vec"], masks: Object.create(null), hints: [],
    timeline: { fps: 24, durationMs: 1000, loop: true, tracks: [] },
  };
}

// ── Independent reader ───────────────────────────────────────────────────────

function unpackBits(src: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected);
  let i = 0, o = 0;
  while (i < src.length) {
    const h = src[i++]!;
    if (h < 128) {
      for (let k = 0; k <= h; k++) out[o++] = src[i++]!;
    } else if (h > 128) {
      const v = src[i++]!;
      for (let k = 0; k < 257 - h; k++) out[o++] = v;
    }
    if (o > expected) throw new Error("PackBits overrun");
  }
  if (o !== expected) throw new Error(`PackBits produced ${o} of ${expected} bytes`);
  return out;
}

class Reader {
  pos = 0;
  constructor(readonly b: Uint8Array, readonly psb: boolean) {}
  u8(): number { return this.b[this.pos++]!; }
  u16(): number { const v = (this.b[this.pos]! << 8) | this.b[this.pos + 1]!; this.pos += 2; return v; }
  i16(): number { const v = this.u16(); return v >= 0x8000 ? v - 0x10000 : v; }
  u32(): number { const v = ((this.b[this.pos]! << 24) | (this.b[this.pos + 1]! << 16) | (this.b[this.pos + 2]! << 8) | this.b[this.pos + 3]!) >>> 0; this.pos += 4; return v; }
  i32(): number { return this.u32() | 0; }
  len(): number { return this.psb ? this.u32() * 0x1_0000_0000 + this.u32() : this.u32(); }
  ascii(n: number): string { const s = String.fromCharCode(...this.b.subarray(this.pos, this.pos + n)); this.pos += n; return s; }
}

/** Read one RLE channel of `h` rows of `w` bytes. */
function readChannel(r: Reader, w: number, h: number): Uint8Array {
  expect(r.u16()).toBe(1);
  const counts: number[] = [];
  for (let y = 0; y < h; y++) counts.push(r.psb ? r.u32() : r.u16());
  const plane = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    plane.set(unpackBits(r.b.subarray(r.pos, r.pos + counts[y]!), w), y * w);
    r.pos += counts[y]!;
  }
  return plane;
}

interface ParsedLayer {
  top: number; left: number; bottom: number; right: number; channels: { id: number; len: number; plane?: Uint8Array }[];
  blend: string; opacity: number; clipping: number; flags: number; pascal: string; luni: string | null;
}

function parsePsd(b: Uint8Array) {
  const r0 = new Reader(b, false);
  const sig = r0.ascii(4);
  const version = r0.u16();
  const r = new Reader(b, version === 2);
  r.pos = r0.pos;
  const reserved = [...b.subarray(r.pos, r.pos + 6)];
  r.pos += 6;
  const channels = r.u16(), height = r.u32(), width = r.u32(), depth = r.u16(), mode = r.u16();
  const colorModeLen = r.u32();
  r.pos += colorModeLen;
  const resourcesLen = r.u32();
  r.pos += resourcesLen;
  const lmLen = r.len();
  const lmEnd = r.pos + lmLen;
  const liLen = r.len();
  const liStart = r.pos;
  let layerCount = 0;
  const layers: ParsedLayer[] = [];
  if (liLen > 0) {
    layerCount = r.i16();
    for (let i = 0; i < Math.abs(layerCount); i++) {
      const top = r.i32(), left = r.i32(), bottom = r.i32(), right = r.i32();
      const nch = r.u16();
      const chans: ParsedLayer["channels"] = [];
      for (let c = 0; c < nch; c++) chans.push({ id: r.i16(), len: r.len() });
      expect(r.ascii(4)).toBe("8BIM");
      const blend = r.ascii(4);
      const opacity = r.u8(), clipping = r.u8(), flags = r.u8();
      r.u8();
      const extraLen = r.u32();
      const extraEnd = r.pos + extraLen;
      // Read each length BEFORE advancing: `r.pos += r.u32()` reads r.pos first and drops u32's own advance.
      const maskLen = r.u32(); // layer mask data
      r.pos += maskLen;
      const rangesLen = r.u32(); // blending ranges
      r.pos += rangesLen;
      const nameStart = r.pos;
      const n = r.u8();
      const pascal = r.ascii(n);
      r.pos = nameStart + ((n + 1 + 3) & ~3);
      let luni: string | null = null;
      while (r.pos < extraEnd) {
        expect(r.ascii(4)).toBe("8BIM");
        const key = r.ascii(4);
        const len = r.u32();
        const end = r.pos + len;
        if (key === "luni") {
          const count = r.u32();
          let s = "";
          for (let k = 0; k < count; k++) s += String.fromCharCode(r.u16());
          luni = s;
        }
        r.pos = end;
      }
      expect(r.pos).toBe(extraEnd);
      layers.push({ top, left, bottom, right, channels: chans, blend, opacity, clipping, flags, pascal, luni });
    }
    for (const L of layers) {
      for (const ch of L.channels) {
        const start = r.pos;
        ch.plane = readChannel(r, L.right - L.left, L.bottom - L.top);
        expect(r.pos - start).toBe(ch.len);
      }
    }
    expect(r.pos).toBeLessThanOrEqual(liStart + liLen);
    expect((liLen % 2)).toBe(0);
    r.pos = liStart + liLen;
  }
  const globalMaskLen = r.u32();
  r.pos += globalMaskLen;
  expect(r.pos).toBe(lmEnd);
  // Merged image data: compression, all row counts for all channels, then the channel data.
  expect(r.u16()).toBe(1);
  const counts: number[] = [];
  for (let i = 0; i < channels * height; i++) counts.push(r.psb ? r.u32() : r.u16());
  const merged: Uint8Array[] = [];
  let k = 0;
  for (let c = 0; c < channels; c++) {
    const plane = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      plane.set(unpackBits(b.subarray(r.pos, r.pos + counts[k]!), width), y * width);
      r.pos += counts[k++]!;
    }
    merged.push(plane);
  }
  expect(r.pos).toBe(b.length);
  return { sig, version, reserved, channels, height, width, depth, mode, colorModeLen, resourcesLen, layerCount, layers, merged, lmLen };
}

const planeOf = (ras: RasterData, ch: number): number[] => {
  const out: number[] = [];
  for (let i = ch; i < ras.rgba.length; i += 4) out.push(ras.rgba[i]!);
  return out;
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe("writePsd", () => {
  const W = 10, H = 8;
  const rasters: Record<string, RasterData> = { bg: raster(W, H, 1), inner: raster(2, 2, 2), cat: raster(4, 3, 3) };
  const get = (id: string): RasterData | null => rasters[id] ?? null;
  const composite = raster(W, H, 9);

  for (const psb of [false, true]) {
    test(`${psb ? "PSB" : "PSD"}: header, empty sections, layer records, names, channels, and composite parse back`, () => {
      const p = parsePsd(writePsd(makeDoc(W, H), get, { psb, composite }));
      expect(p.sig).toBe("8BPS");
      expect(p.version).toBe(psb ? 2 : 1);
      expect(p.reserved).toEqual([0, 0, 0, 0, 0, 0]);
      expect([p.channels, p.height, p.width, p.depth, p.mode]).toEqual([4, H, W, 8, 3]);
      expect(p.colorModeLen).toBe(0);
      expect(p.resourcesLen).toBe(0);
      // bg, then the flattened group child, then cat; the vector layer has no raster and is skipped.
      expect(p.layerCount).toBe(-3);
      const [bg, inner, cat] = p.layers;
      expect([bg!.top, bg!.left, bg!.bottom, bg!.right]).toEqual([0, 0, H, W]);
      expect([inner!.top, inner!.left, inner!.bottom, inner!.right]).toEqual([1, 1, 3, 3]);
      expect([cat!.top, cat!.left, cat!.bottom, cat!.right]).toEqual([-2, 3, 1, 7]);
      expect(bg!.blend).toBe("norm");
      expect(cat!.blend).toBe("mul ");
      expect([bg!.opacity, inner!.opacity, cat!.opacity]).toEqual([255, 128, 128]);
      expect([bg!.flags & 2, inner!.flags & 2, cat!.flags & 2]).toEqual([0, 2, 2]); // hidden group hides its child
      expect(cat!.clipping).toBe(0);
      expect(bg!.pascal).toBe("Background");
      expect(cat!.pascal).toBe("Caf? ?");
      expect(cat!.luni).toBe("Caf\u00e9 \u732b");
      expect(inner!.luni).toBe("Inner");
      expect(cat!.channels.map((c) => c.id)).toEqual([-1, 0, 1, 2]);
      const src = rasters.cat!;
      expect([...cat!.channels[0]!.plane!]).toEqual(planeOf(src, 3));
      expect([...cat!.channels[1]!.plane!]).toEqual(planeOf(src, 0));
      expect([...cat!.channels[2]!.plane!]).toEqual(planeOf(src, 1));
      expect([...cat!.channels[3]!.plane!]).toEqual(planeOf(src, 2));
      expect([...bg!.channels[1]!.plane!]).toEqual(planeOf(rasters.bg!, 0));
      for (let c = 0; c < 4; c++) expect([...p.merged[c]!]).toEqual(planeOf(composite, c));
    });
  }

  test("PSB uses 8-byte section and channel lengths (PSD 4-byte)", () => {
    const doc = makeDoc(W, H);
    const psd = writePsd(doc, get, { psb: false, composite });
    const psb = writePsd(doc, get, { psb: true, composite });
    // 4 more bytes for the layer-and-mask length, 4 for the layer-info length, 4 per channel length
    // (3 layers x 4 channels), plus 2 per row-count entry: layer rows (8 + 2 + 3) x 4 and merged 4 x 8.
    const extraRowCounts = 2 * ((H + 2 + 3) * 4 + 4 * H);
    expect(psb.length - psd.length).toBe(4 + 4 + 4 * 12 + extraRowCounts);
    // In the PSB the layer-and-mask length is a u64 whose high word is 0.
    const lmAt = 26 + 4 + 4;
    expect([...psb.subarray(lmAt, lmAt + 4)]).toEqual([0, 0, 0, 0]);
  });

  test("switches to PSB above 30000 px per side even when psb is false", () => {
    const doc = makeDoc(30001, 1);
    const p = parsePsd(writePsd(doc, () => null, { psb: false, composite: raster(30001, 1, 4) }));
    expect(p.version).toBe(2);
    expect(p.layerCount).toBe(0);
    expect(p.width).toBe(30001);
  });

  test("refuses over 300000 px per side and a composite that does not match the doc", () => {
    expect(() => writePsd(makeDoc(300001, 1), () => null, { psb: true, composite: raster(300001, 1, 1) })).toThrow(/300000/);
    expect(() => writePsd(makeDoc(W, H), get, { psb: false, composite: raster(W + 1, H, 1) })).toThrow(/composite/);
  });
});

describe("packBits", () => {
  const roundTrip = (row: Uint8Array): Uint8Array => {
    const packed = packBits(row);
    expect([...unpackBits(packed, row.length)]).toEqual([...row]);
    return packed;
  };

  test("literal and repeat runs", () => {
    expect([...roundTrip(new Uint8Array([]))]).toEqual([]);
    expect([...roundTrip(new Uint8Array([7]))]).toEqual([0, 7]);
    expect([...roundTrip(new Uint8Array([1, 2, 3, 3, 3, 4]))]).toEqual([1, 1, 2, 254, 3, 0, 4]);
    expect([...roundTrip(new Uint8Array([5, 5]))]).toEqual([255, 5]);
  });

  test("128-byte packet boundaries", () => {
    expect([...roundTrip(new Uint8Array(128).fill(9))]).toEqual([129, 9]);
    expect([...roundTrip(new Uint8Array(129).fill(9))]).toEqual([129, 9, 0, 9]);
    expect([...roundTrip(new Uint8Array(130).fill(9))]).toEqual([129, 9, 255, 9]);
    const distinct = (n: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => i & 255);
    const p128 = roundTrip(distinct(128));
    expect(p128.length).toBe(129);
    expect(p128[0]).toBe(127);
    const p129 = roundTrip(distinct(129));
    expect([p129[0], p129[129], p129[130]]).toEqual([127, 0, 128]);
  });

  test("mixed pseudo-random rows round-trip", () => {
    let s = 12345;
    for (let t = 0; t < 50; t++) {
      const row = new Uint8Array(1 + (t * 37) % 700);
      for (let i = 0; i < row.length; i++) {
        s = (Math.imul(s, 1103515245) + 12345) >>> 0;
        row[i] = (s >>> 16) % 3 === 0 ? (row[i - 1] ?? 0) : (s >>> 24) & 7; // runs and literals of a small alphabet
      }
      roundTrip(row);
    }
  });
});
