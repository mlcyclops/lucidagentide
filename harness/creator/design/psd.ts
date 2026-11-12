// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/creator/design/psd.ts - native PSD / PSB writer (RGB, 8 bit, layered, PackBits).
//
// Written from the public Adobe Photoshop File Formats Specification (no Adobe code or SDK). Sections:
// file header ('8BPS', version 1 = PSD or 2 = PSB, 4 channels RGBA, depth 8, mode 3 RGB), empty color
// mode data, EMPTY image resources (so never EXIF/XMP 1058/1060 or any other metadata), the layer and
// mask information section, and the merged image data (PackBits, planes R, G, B, A).
//
// Layers: doc.order is bottom -> top, which is also Photoshop's record order (first record = bottom).
// Every id for which getRaster returns pixels becomes a pixel layer at its (x, y), whatever its kind
// (the caller rasterizes vector layers or whole groups when it wants them). A group with no raster of
// its own is FLATTENED: its children (bottom -> top) are emitted in place, inheriting the group's
// visibility (hidden group = hidden children) and multiplying its opacity; the group blend mode is
// treated as pass-through. Layer scale/rotation are not applied: getRaster returns final pixels.
// The layer count is written NEGATIVE: the merged image's first alpha channel holds its transparency.
// Flags bit 1 marks a hidden layer (what Photoshop does, despite the spec text calling it "visible").
// Names: Pascal string (ASCII, '?' for anything else, padded to 4) plus a 'luni' UTF-16BE block.
// PSB widens the section, layer-info and channel lengths to 8 bytes and the PackBits row counts to 4.

import type { BlendMode, DesignDoc, RasterData } from "./types.ts";
import { DESIGN_LIMITS } from "./limits.ts";
import { ByteWriter, cleanText } from "./util.ts";
import { assertFrame } from "../imaging_core.ts";

export const PSD_MAX_SIDE = 30_000;
export const PSB_MAX_SIDE = 300_000;
const MAX_GROUP_DEPTH = 64;

/** Photoshop blend-mode keys for every BlendMode. */
export const PSD_BLEND_KEYS: Readonly<Record<BlendMode, string>> = {
  "normal": "norm", "multiply": "mul ", "screen": "scrn", "overlay": "over", "darken": "dark",
  "lighten": "lite", "color-dodge": "div ", "color-burn": "idiv", "hard-light": "hLit", "soft-light": "sLit",
  "difference": "diff", "exclusion": "smud", "hue": "hue ", "saturation": "sat ", "color": "colr",
  "luminosity": "lum ",
};

/** Upper bound of PackBits output for `n` input bytes (128 literal bytes cost 129). */
const packBound = (n: number): number => n + Math.ceil(n / 64) + 2;

/** PackBits-encode `len` bytes of `src` from `start` into `out` at `at`; returns the end offset. Repeat
 *  packets for runs of 2..128 at a packet start, literal packets of 1..128 that stop before a run of 3. */
function packBitsInto(src: Uint8Array, start: number, len: number, out: Uint8Array, at: number): number {
  const end = start + len;
  let i = start, o = at;
  while (i < end) {
    const v = src[i]!;
    let run = 1;
    while (i + run < end && run < 128 && src[i + run] === v) run++;
    if (run >= 2) {
      out[o++] = 257 - run; // -(run - 1) as int8
      out[o++] = v;
      i += run;
      continue;
    }
    const lit0 = i;
    let lit = 0;
    while (i < end && lit < 128) {
      if (i + 2 < end && src[i] === src[i + 1] && src[i] === src[i + 2]) break;
      i++;
      lit++;
    }
    out[o++] = lit - 1;
    for (let k = 0; k < lit; k++) out[o++] = src[lit0 + k]!;
  }
  return o;
}

/** PackBits (Apple TN1023, as used by PSD RLE) of one row. */
export function packBits(row: Uint8Array): Uint8Array {
  const out = new Uint8Array(packBound(row.length));
  return out.slice(0, packBitsInto(row, 0, row.length, out, 0));
}

interface PackedPlane { counts: Uint32Array; data: Uint8Array; len: number }

/** PackBits every row of one channel (0 R, 1 G, 2 B, 3 A) of an RGBA raster. */
function packPlane(r: RasterData, ch: number): PackedPlane {
  const w = r.width, h = r.height, src = r.rgba;
  const row = new Uint8Array(w);
  const data = new Uint8Array(h * packBound(w));
  const counts = new Uint32Array(h);
  let len = 0;
  for (let y = 0; y < h; y++) {
    let i = y * w * 4 + ch;
    for (let x = 0; x < w; x++, i += 4) row[x] = src[i]!;
    const end = packBitsInto(row, 0, w, data, len);
    counts[y] = end - len;
    len = end;
  }
  return { counts, data, len };
}

/** Compression 1 (RLE), the row byte-count table, then the packed rows. */
function writePlane(out: ByteWriter, p: PackedPlane, psb: boolean): void {
  out.u16be(1);
  for (let y = 0; y < p.counts.length; y++) {
    if (psb) out.u32be(p.counts[y]!);
    else out.u16be(p.counts[y]!);
  }
  out.bytes(p.data.subarray(0, p.len));
}

interface PsdLayer { name: string; raster: RasterData; top: number; left: number; opacity: number; visible: boolean; blend: BlendMode }

function collectLayers(doc: DesignDoc, getRaster: (layerId: string) => RasterData | null, maxSide: number): PsdLayer[] {
  const out: PsdLayer[] = [];
  const seen = new Set<string>();
  const visit = (id: string, parentVisible: boolean, parentOpacity: number, depth: number): void => {
    if (depth > MAX_GROUP_DEPTH || seen.has(id) || !Object.hasOwn(doc.layers, id)) return;
    seen.add(id);
    const layer = doc.layers[id]!;
    const visible = parentVisible && layer.visible !== false;
    const op = typeof layer.opacity === "number" && Number.isFinite(layer.opacity) ? Math.min(1, Math.max(0, layer.opacity)) : 1;
    const opacity = parentOpacity * op;
    const raster = getRaster(id);
    if (raster) {
      assertFrame(raster, `writePsd layer ${id}`);
      if (raster.width > maxSide || raster.height > maxSide || raster.width * raster.height > DESIGN_LIMITS.maxRasterPixels) {
        throw new Error(`writePsd: layer ${id} raster ${raster.width}x${raster.height} exceeds the format limits`);
      }
      const left = Number.isFinite(layer.x) ? Math.round(layer.x) : 0;
      const top = Number.isFinite(layer.y) ? Math.round(layer.y) : 0;
      if (Math.abs(left) + raster.width > 0x7FFFFFFF || Math.abs(top) + raster.height > 0x7FFFFFFF) {
        throw new Error(`writePsd: layer ${id} position is out of range`);
      }
      const blend: BlendMode = Object.hasOwn(PSD_BLEND_KEYS, layer.blend) ? layer.blend : "normal";
      out.push({ name: cleanText(layer.name, DESIGN_LIMITS.maxLabel), raster, top, left, opacity, visible, blend });
      if (out.length > DESIGN_LIMITS.maxLayers) throw new Error(`writePsd: more than ${DESIGN_LIMITS.maxLayers} layers`);
      return;
    }
    if (layer.kind === "group" && Array.isArray(layer.children)) {
      for (const child of layer.children) visit(child, visible, opacity, depth + 1);
    }
  };
  for (const id of doc.order) visit(id, true, 1, 0);
  return out;
}

/** Pascal string: length byte + ASCII ('?' for non-ASCII), max 255 bytes, padded to a multiple of 4. */
function pascalName(name: string): Uint8Array {
  const n = Math.min(255, name.length);
  const out = new Uint8Array((n + 1 + 3) & ~3);
  out[0] = n;
  for (let i = 0; i < n; i++) {
    const c = name.charCodeAt(i);
    out[1 + i] = c >= 0x20 && c <= 0x7E ? c : 0x3F;
  }
  return out;
}

/** 'luni' payload: uint32 UTF-16 unit count, UTF-16BE units, zero padded to a multiple of 4. */
function unicodeName(name: string): Uint8Array {
  const out = new Uint8Array((4 + name.length * 2 + 3) & ~3);
  const n = name.length;
  out[0] = (n >>> 24) & 0xFF; out[1] = (n >>> 16) & 0xFF; out[2] = (n >>> 8) & 0xFF; out[3] = n & 0xFF;
  for (let i = 0; i < n; i++) {
    const c = name.charCodeAt(i);
    out[4 + i * 2] = c >>> 8;
    out[5 + i * 2] = c & 0xFF;
  }
  return out;
}

/**
 * Write `doc` as PSD (version 1) or PSB (version 2: when opts.psb or a side exceeds 30000 px; PSB max
 * 300000 px per side). `opts.composite` is the merged image and must match the doc size.
 */
export function writePsd(doc: DesignDoc, getRaster: (layerId: string) => RasterData | null, opts: { psb: boolean; composite: RasterData }): Uint8Array {
  const W = doc.width, H = doc.height;
  if (!Number.isInteger(W) || !Number.isInteger(H) || W < 1 || H < 1) throw new Error("writePsd: doc width and height must be positive integers");
  if (W > PSB_MAX_SIDE || H > PSB_MAX_SIDE) throw new Error(`writePsd: ${W}x${H} exceeds the ${PSB_MAX_SIDE} px PSB side limit`);
  const psb = opts.psb === true || W > PSD_MAX_SIDE || H > PSD_MAX_SIDE;
  const comp = opts.composite;
  assertFrame(comp, "writePsd composite");
  if (comp.width !== W || comp.height !== H) throw new Error(`writePsd: composite is ${comp.width}x${comp.height}, doc is ${W}x${H}`);
  if (W * H > DESIGN_LIMITS.maxRasterPixels) throw new Error(`writePsd: composite exceeds the ${DESIGN_LIMITS.maxRasterPixels} pixel limit`);
  const layers = collectLayers(doc, getRaster, psb ? PSB_MAX_SIDE : PSD_MAX_SIDE);

  const lenSize = psb ? 8 : 4;
  const out = new ByteWriter(1 << 16);
  const writeLen = (v: number): void => { if (psb) out.u64be(v); else out.u32be(v); };
  const patchLen = (at: number, v: number): void => {
    if (psb) { out.patchU64be(at, v); return; }
    if (v > 0xFFFFFFFF) throw new Error("writePsd: section exceeds 4 GiB; use PSB");
    out.patchU32be(at, v);
  };

  // File header.
  out.ascii("8BPS");
  out.u16be(psb ? 2 : 1);
  for (let i = 0; i < 6; i++) out.u8(0);
  out.u16be(4);   // channels: R, G, B, A
  out.u32be(H);
  out.u32be(W);
  out.u16be(8);   // depth
  out.u16be(3);   // color mode RGB
  out.u32be(0);   // color mode data: none
  out.u32be(0);   // image resources: none (never EXIF/XMP or any metadata)

  // Layer and mask information.
  const lmAt = out.length;
  writeLen(0);
  const liAt = out.length;
  writeLen(0);
  if (layers.length > 0) {
    out.i16be(-layers.length);
    const chanLenAt: number[] = [];
    for (const L of layers) {
      out.i32be(L.top);
      out.i32be(L.left);
      out.i32be(L.top + L.raster.height);
      out.i32be(L.left + L.raster.width);
      out.u16be(4);
      for (const id of [-1, 0, 1, 2]) {
        out.i16be(id);
        chanLenAt.push(out.length);
        writeLen(0);
      }
      out.ascii("8BIM");
      out.ascii(PSD_BLEND_KEYS[L.blend]);
      out.u8(Math.round(L.opacity * 255));
      out.u8(0);                    // clipping: base
      out.u8(L.visible ? 0 : 0x02); // flags: bit 1 = hidden
      out.u8(0);                    // filler
      const pascal = pascalName(L.name);
      const luni = unicodeName(L.name);
      out.u32be(4 + 4 + pascal.length + 12 + luni.length);
      out.u32be(0);                 // layer mask data: none
      out.u32be(0);                 // blending ranges: none
      out.bytes(pascal);
      out.ascii("8BIM");
      out.ascii("luni");
      out.u32be(luni.length);
      out.bytes(luni);
    }
    let k = 0;
    for (const L of layers) {
      for (const ch of [3, 0, 1, 2]) { // same order as the channel info: alpha (-1), R, G, B
        const start = out.length;
        writePlane(out, packPlane(L.raster, ch), psb);
        patchLen(chanLenAt[k++]!, out.length - start);
      }
    }
    while ((out.length - liAt - lenSize) % 4 !== 0) out.u8(0);
  }
  patchLen(liAt, out.length - liAt - lenSize);
  out.u32be(0); // global layer mask info: none
  patchLen(lmAt, out.length - lmAt - lenSize);

  // Merged image data: one compression field, every row count of every channel, then the channel data.
  const planes = [packPlane(comp, 0), packPlane(comp, 1), packPlane(comp, 2), packPlane(comp, 3)];
  out.u16be(1);
  for (const p of planes) {
    for (let y = 0; y < H; y++) {
      if (psb) out.u32be(p.counts[y]!);
      else out.u16be(p.counts[y]!);
    }
  }
  for (const p of planes) out.bytes(p.data.subarray(0, p.len));
  return out.finish();
}
