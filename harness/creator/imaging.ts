// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/creator/imaging.ts - CREATOR-IMG (ADR-0291): native image composition and encoding.
//
// Sprite sheets, animated GIFs, and memes are built IN the harness: pure TypeScript over raw RGBA, with
// no native module, no ffmpeg, no ImageMagick, and no network. That matters for three reasons: an air-gapped
// install keeps every one of these features, the output is byte-deterministic (so a test can prove it), and
// nothing here needs a GPU or an API key.
//
// The division of labour is deliberate:
//   * THIS module owns pixels and bytes - quantization, LZW, deflate, PNG/GIF containers, sheet geometry,
//     and text layout math. Pure functions, injectable measurement, fully unit-tested.
//   * The RENDERER owns rasterization - decoding a source image and drawing text with real fonts, because
//     a browser already has both and a Bun server has neither.
//
// Frames are `{ width, height, rgba }` with `rgba.length === width * height * 4`, straight from a canvas
// `getImageData()`.

import { deflateSync } from "node:zlib";
// Meme geometry lives in its own node-free module so the RENDERER can import it without dragging
// node:zlib into a browser bundle. Re-exported here so server-side callers have one import.
export { memeLayout, wrapLines, type MeasureText, type MemeLayout, type MemeTextBlock } from "./meme_layout.ts";

export interface RgbaFrame {
  readonly width: number;
  readonly height: number;
  /** Row-major RGBA, 4 bytes per pixel. */
  readonly rgba: Uint8Array;
}

/** Reject a malformed frame loudly: every encoder below assumes the invariant holds. */
export function assertFrame(f: RgbaFrame, label = "frame"): void {
  if (!Number.isInteger(f.width) || !Number.isInteger(f.height) || f.width <= 0 || f.height <= 0) {
    throw new Error(`${label}: width and height must be positive integers`);
  }
  if (f.rgba.length !== f.width * f.height * 4) {
    throw new Error(`${label}: expected ${f.width * f.height * 4} bytes of RGBA, got ${f.rgba.length}`);
  }
}

// ── PNG ──────────────────────────────────────────────────────────────────────

const CRC_TABLE = ((): Uint32Array => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 as PNG defines it (also used by the tests to verify every chunk). */
export function crc32(bytes: Uint8Array): number {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xFF]! ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const be32 = (n: number): Uint8Array => new Uint8Array([(n >>> 24) & 0xFF, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF]);

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new Uint8Array([...type].map((c) => c.charCodeAt(0)));
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);
  const out = new Uint8Array(4 + body.length + 4);
  out.set(be32(data.length), 0);
  out.set(body, 4);
  out.set(be32(crc32(body)), 4 + body.length);
  return out;
}

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

/** A true-colour-with-alpha PNG (bit depth 8, colour type 6, filter 0 per scanline). */
export function encodePng(frame: RgbaFrame): Uint8Array {
  assertFrame(frame);
  const { width, height, rgba } = frame;
  const stride = width * 4;
  // Filter byte 0 (None) per scanline: the simplest legal encoding, and deflate still shrinks flat art well.
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  ihdr.set(be32(width), 0);
  ihdr.set(be32(height), 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: truecolour with alpha
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace
  return concat([
    new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", new Uint8Array(deflateSync(raw, { level: 9 }))),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
}

// ── palette quantization ─────────────────────────────────────────────────────

export interface Quantized {
  /** RGB triplets, `colors * 3` bytes. */
  readonly palette: Uint8Array;
  readonly colors: number;
  /** One index per pixel, per frame, in frame order. */
  readonly indices: readonly Uint8Array[];
  /** The palette slot reserved for fully transparent pixels, or null when none was needed. */
  readonly transparentIndex: number | null;
  /** True when every source colour survived exactly (the pixel-art case). */
  readonly exact: boolean;
}

const key = (r: number, g: number, b: number): number => (r << 16) | (g << 8) | b;
/** 6x6x6 cube: deterministic, cheap, and closest-slot exact for art drawn on a small palette. */
const cube = (v: number): number => Math.min(5, Math.round((v / 255) * 5));

/** Map every frame onto ONE global palette of at most `maxColors`. Exact when the source fits; otherwise a
 *  deterministic 6x6x6 cube plus the most frequent leftovers, so the result never depends on iteration luck.
 *  Pixels with alpha under `alphaCutoff` become the transparent index. */
export function quantize(frames: readonly RgbaFrame[], maxColors = 256, alphaCutoff = 128): Quantized {
  if (!frames.length) throw new Error("quantize: at least one frame is required");
  for (const f of frames) assertFrame(f);
  const counts = new Map<number, number>();
  let needsTransparent = false;
  for (const f of frames) {
    for (let i = 0; i < f.rgba.length; i += 4) {
      if (f.rgba[i + 3]! < alphaCutoff) { needsTransparent = true; continue; }
      const k = key(f.rgba[i]!, f.rgba[i + 1]!, f.rgba[i + 2]!);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  const budget = maxColors - (needsTransparent ? 1 : 0);
  const exact = counts.size <= budget;
  // Slot order is frequency-desc then value-asc, so the palette is stable across runs.
  const ranked = [...counts.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] - b[0])).map(([k]) => k);
  const slots: number[] = exact ? ranked : (() => {
    const chosen: number[] = [];
    const seen = new Set<number>();
    for (const k of ranked) { // keep the most-used exact colours first
      if (chosen.length >= Math.floor(budget / 2)) break;
      if (!seen.has(k)) { seen.add(k); chosen.push(k); }
    }
    for (let r = 0; r < 6 && chosen.length < budget; r++) {
      for (let g = 0; g < 6 && chosen.length < budget; g++) {
        for (let b = 0; b < 6 && chosen.length < budget; b++) {
          const k = key(Math.round((r / 5) * 255), Math.round((g / 5) * 255), Math.round((b / 5) * 255));
          if (!seen.has(k)) { seen.add(k); chosen.push(k); }
        }
      }
    }
    return chosen;
  })();
  const transparentIndex = needsTransparent ? slots.length : null;
  const colors = slots.length + (needsTransparent ? 1 : 0);
  const palette = new Uint8Array(colors * 3);
  slots.forEach((k, i) => {
    palette[i * 3] = (k >> 16) & 0xFF;
    palette[i * 3 + 1] = (k >> 8) & 0xFF;
    palette[i * 3 + 2] = k & 0xFF;
  });
  const bySlot = new Map<number, number>();
  slots.forEach((k, i) => bySlot.set(k, i));
  const nearest = (r: number, g: number, b: number): number => {
    const direct = bySlot.get(key(r, g, b));
    if (direct !== undefined) return direct;
    const snapped = bySlot.get(key(Math.round((cube(r) / 5) * 255), Math.round((cube(g) / 5) * 255), Math.round((cube(b) / 5) * 255)));
    if (snapped !== undefined) return snapped;
    let best = 0, bestD = Number.POSITIVE_INFINITY;
    for (let i = 0; i < slots.length; i++) {
      const dr = ((slots[i]! >> 16) & 0xFF) - r, dg = ((slots[i]! >> 8) & 0xFF) - g, db = (slots[i]! & 0xFF) - b;
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  };
  const indices = frames.map((f) => {
    const out = new Uint8Array(f.width * f.height);
    for (let p = 0, i = 0; i < f.rgba.length; i += 4, p++) {
      out[p] = f.rgba[i + 3]! < alphaCutoff && transparentIndex !== null
        ? transparentIndex
        : nearest(f.rgba[i]!, f.rgba[i + 1]!, f.rgba[i + 2]!);
    }
    return out;
  });
  return { palette, colors, indices, transparentIndex, exact };
}

// ── GIF ──────────────────────────────────────────────────────────────────────

/** Variable-width LZW as GIF defines it, emitted as GIF sub-blocks (255 bytes max each). */
export function lzwEncode(indices: Uint8Array, minCodeSize: number): Uint8Array {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let codeSize = minCodeSize + 1;
  let next = eoi + 1;
  let dict = new Map<string, number>();
  const bytes: number[] = [];
  let bitBuf = 0, bitCount = 0;
  const emit = (code: number) => {
    bitBuf |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) { bytes.push(bitBuf & 0xFF); bitBuf >>= 8; bitCount -= 8; }
  };
  emit(clear);
  let prefix = "";
  for (const idx of indices) {
    const candidate = prefix === "" ? String(idx) : `${prefix},${idx}`;
    if (prefix !== "" && !dict.has(candidate)) {
      emit(dict.get(prefix) ?? Number(prefix));
      if (next < 4096) {
        dict.set(candidate, next++);
        // The decoder always lags one entry behind, so the width grows once the next code would not fit.
        if (next > (1 << codeSize) && codeSize < 12) codeSize++;
      } else {
        emit(clear);
        codeSize = minCodeSize + 1;
        next = eoi + 1;
        dict = new Map();
      }
      prefix = String(idx);
      continue;
    }
    prefix = candidate;
  }
  if (prefix !== "") emit(dict.get(prefix) ?? Number(prefix));
  emit(eoi);
  if (bitCount > 0) bytes.push(bitBuf & 0xFF);
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i += 255) {
    const chunk = bytes.slice(i, i + 255);
    out.push(chunk.length, ...chunk);
  }
  out.push(0); // block terminator
  return new Uint8Array(out);
}

export interface GifOptions {
  /** Per-frame delay in ms. A single value applies to every frame. Rounded to GIF's 10ms ticks. */
  readonly delayMs?: number | readonly number[];
  /** 0 = loop forever (the default), N = play N extra times. */
  readonly loop?: number;
  readonly maxColors?: number;
}

/** A GIF89a animation. All frames must share one size; the palette is global and deterministic. */
export function encodeGif(frames: readonly RgbaFrame[], opts: GifOptions = {}): Uint8Array {
  if (!frames.length) throw new Error("encodeGif: at least one frame is required");
  const { width, height } = frames[0]!;
  for (const f of frames) {
    assertFrame(f);
    if (f.width !== width || f.height !== height) throw new Error("encodeGif: every frame must share one size");
  }
  const q = quantize(frames, Math.max(2, Math.min(256, opts.maxColors ?? 256)));
  // GIF colour tables are a power of two, minimum 2 entries.
  let tableSize = 2;
  let sizeExp = 1;
  while (tableSize < q.colors) { tableSize <<= 1; sizeExp++; }
  const table = new Uint8Array(tableSize * 3);
  table.set(q.palette.subarray(0, Math.min(q.palette.length, table.length)));
  const minCodeSize = Math.max(2, sizeExp);
  const delays = Array.isArray(opts.delayMs) ? opts.delayMs : null;
  const delayAt = (i: number): number => {
    const ms = delays ? (delays[i] ?? delays[delays.length - 1] ?? 100) : (typeof opts.delayMs === "number" ? opts.delayMs : 100);
    return Math.max(0, Math.round(ms / 10)); // GIF ticks are hundredths of a second
  };
  const le16 = (n: number): Uint8Array => new Uint8Array([n & 0xFF, (n >> 8) & 0xFF]);
  const parts: Uint8Array[] = [
    new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]), // "GIF89a"
    le16(width), le16(height),
    new Uint8Array([0x80 | (sizeExp - 1), 0, 0]), // global table present, colour resolution, sort flag
    table,
    // NETSCAPE2.0 application extension: the loop count
    new Uint8Array([0x21, 0xFF, 0x0B, 0x4E, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2E, 0x30, 0x03, 0x01]),
    le16(Math.max(0, Math.trunc(opts.loop ?? 0))),
    new Uint8Array([0x00]),
  ];
  q.indices.forEach((idx, i) => {
    const disposal = q.transparentIndex === null ? 1 : 2; // keep, or restore to background for transparency
    parts.push(
      new Uint8Array([0x21, 0xF9, 0x04, (disposal << 2) | (q.transparentIndex === null ? 0 : 1)]),
      le16(delayAt(i)),
      new Uint8Array([q.transparentIndex ?? 0, 0x00]),
      new Uint8Array([0x2C]), // image descriptor
      le16(0), le16(0), le16(width), le16(height),
      new Uint8Array([0x00, minCodeSize]),
      lzwEncode(idx, minCodeSize),
    );
  });
  parts.push(new Uint8Array([0x3B])); // trailer
  return concat(parts);
}

// ── sprite sheets ────────────────────────────────────────────────────────────

export interface SheetCell { readonly index: number; readonly x: number; readonly y: number }
export interface SheetLayout {
  readonly columns: number;
  readonly rows: number;
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly width: number;
  readonly height: number;
  readonly count: number;
  readonly cells: readonly SheetCell[];
}

/** Grid geometry for a uniform sprite sheet. `columns` defaults to a near-square packing, which is what
 *  every engine importer expects and what keeps a 12-frame walk cycle readable at a glance. */
export function spriteSheetLayout(opts: { count: number; frameWidth: number; frameHeight: number; columns?: number }): SheetLayout {
  const { count, frameWidth, frameHeight } = opts;
  if (!Number.isInteger(count) || count <= 0) throw new Error("spriteSheetLayout: count must be a positive integer");
  if (frameWidth <= 0 || frameHeight <= 0) throw new Error("spriteSheetLayout: frame size must be positive");
  const columns = Math.max(1, Math.min(count, Math.trunc(opts.columns ?? Math.ceil(Math.sqrt(count)))));
  const rows = Math.ceil(count / columns);
  const cells = Array.from({ length: count }, (_, i) => ({
    index: i,
    x: (i % columns) * frameWidth,
    y: Math.floor(i / columns) * frameHeight,
  }));
  return { columns, rows, frameWidth, frameHeight, width: columns * frameWidth, height: rows * frameHeight, count, cells };
}

/** Blit frames into one sheet. Frames must share a size; empty cells stay fully transparent. */
export function composeSpriteSheet(frames: readonly RgbaFrame[], columns?: number): { frame: RgbaFrame; layout: SheetLayout } {
  if (!frames.length) throw new Error("composeSpriteSheet: at least one frame is required");
  const { width: fw, height: fh } = frames[0]!;
  for (const f of frames) {
    assertFrame(f);
    if (f.width !== fw || f.height !== fh) throw new Error("composeSpriteSheet: every frame must share one size");
  }
  const layout = spriteSheetLayout({ count: frames.length, frameWidth: fw, frameHeight: fh, columns });
  const rgba = new Uint8Array(layout.width * layout.height * 4);
  layout.cells.forEach((cell) => {
    const src = frames[cell.index]!;
    for (let y = 0; y < fh; y++) {
      const from = y * fw * 4;
      const to = ((cell.y + y) * layout.width + cell.x) * 4;
      rgba.set(src.rgba.subarray(from, from + fw * 4), to);
    }
  });
  return { frame: { width: layout.width, height: layout.height, rgba }, layout };
}

/** A ready-to-paste CSS steps() animation for the sheet - the fastest way to SEE the cycle in the preview. */
export function spriteCss(name: string, layout: SheetLayout, durationMs: number): string {
  const cls = (name || "sprite").replace(/[^a-zA-Z0-9_-]/g, "-").replace(/^-+|-+$/g, "") || "sprite";
  const secs = Math.max(0.05, Math.round(durationMs) / 1000);
  // One row animates horizontally; a multi-row sheet steps both axes, so it gets a per-row keyframe set.
  const frames = layout.cells.map((c, i) => `  ${((i / layout.count) * 100).toFixed(3)}% { background-position: -${c.x}px -${c.y}px; }`).join("\n");
  return `.${cls} {\n  width: ${layout.frameWidth}px;\n  height: ${layout.frameHeight}px;\n  background-image: url("${cls}.png");\n  background-repeat: no-repeat;\n  image-rendering: pixelated;\n  animation: ${cls}-play ${secs}s steps(1) infinite;\n}\n@keyframes ${cls}-play {\n${frames}\n  100% { background-position: -${layout.cells[0]!.x}px -${layout.cells[0]!.y}px; }\n}`;
}

/** The sidecar every engine wants: frame rects plus timing, so the sheet is not a mystery image. */
export function sheetManifest(name: string, layout: SheetLayout, durationMs: number): string {
  return JSON.stringify({
    name,
    image: `${name}.png`,
    frameWidth: layout.frameWidth,
    frameHeight: layout.frameHeight,
    columns: layout.columns,
    rows: layout.rows,
    count: layout.count,
    frameDurationMs: Math.round(durationMs / layout.count),
    frames: layout.cells.map((c) => ({ index: c.index, x: c.x, y: c.y, w: layout.frameWidth, h: layout.frameHeight })),
  }, null, 2);
}


