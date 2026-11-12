// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/creator/design/apng.ts - animated PNG (APNG) and single-frame PNG encoders without node:zlib.
//
// Layout per the APNG specification (wiki.mozilla.org/APNG_Specification, folded into PNG 3rd edition):
// signature, IHDR, acTL, then fcTL + IDAT for frame 0 (the default image IS frame 0), then fcTL + fdAT
// for every later frame, then IEND. Sequence numbers run 0, 1, 2, ... across fcTL and fdAT in file
// order. Every frame is a full-canvas frame with dispose_op NONE and blend_op SOURCE, so each frame
// replaces the canvas exactly and no compositing state carries between frames. Rows are filtered with
// png_stream.ts filterRows and deflated with CompressionStream("deflate"). No metadata chunks.

import type { RasterData } from "./types.ts";
import { DESIGN_LIMITS } from "./limits.ts";
import { PNG_SIGNATURE, assertFrame, concat, pngChunk, pngIhdrRgba8 } from "../imaging_core.ts";
import { deflateBytes, encodePngTiled, filterRows } from "./png_stream.ts";

/** Validate a frame list shared by the animated encoders (APNG, GIF): count, equal size, side limit, and
 *  the total pixel budget (frames * w * h <= 4 * maxRasterPixels). Returns the common size. */
export function checkAnimationFrames(frames: RasterData[], maxFrames: number, label: string): { w: number; h: number } {
  if (!Array.isArray(frames) || frames.length < 1) throw new Error(`${label}: at least one frame is required`);
  if (frames.length > maxFrames) throw new Error(`${label}: ${frames.length} frames exceeds the ${maxFrames} frame limit`);
  const first = frames[0]!;
  assertFrame(first, `${label} frame 0`);
  const w = first.width, h = first.height;
  if (w > DESIGN_LIMITS.maxSide || h > DESIGN_LIMITS.maxSide) {
    throw new Error(`${label}: ${w}x${h} exceeds the ${DESIGN_LIMITS.maxSide} px side limit`);
  }
  for (let i = 1; i < frames.length; i++) {
    const f = frames[i]!;
    assertFrame(f, `${label} frame ${i}`);
    if (f.width !== w || f.height !== h) throw new Error(`${label}: frame ${i} is ${f.width}x${f.height}, frame 0 is ${w}x${h}; all frames must match`);
  }
  if (w * h * frames.length > DESIGN_LIMITS.maxRasterPixels * 4) {
    throw new Error(`${label}: ${frames.length} frames of ${w}x${h} exceed the ${DESIGN_LIMITS.maxRasterPixels * 4} total pixel budget`);
  }
  return { w, h };
}

/** Per-frame delays in ms from a single value or one value per frame; finite and >= 0. */
export function frameDelays(delayMs: number | number[], n: number, label: string): number[] {
  const out: number[] = [];
  if (Array.isArray(delayMs)) {
    if (delayMs.length !== n) throw new Error(`${label}: delayMs has ${delayMs.length} entries for ${n} frames`);
    for (const d of delayMs) out.push(d);
  } else {
    for (let i = 0; i < n; i++) out.push(delayMs);
  }
  for (const d of out) {
    if (typeof d !== "number" || !Number.isFinite(d) || d < 0) throw new Error(`${label}: delayMs must be finite and >= 0`);
  }
  return out;
}

/** fcTL delay as a fraction. Milliseconds (den 1000) when they fit in 16 bits, else centiseconds. */
function delayFraction(ms: number): [number, number] {
  const r = Math.round(ms);
  if (r <= 0xFFFF) return [r, 1000];
  return [Math.min(0xFFFF, Math.round(ms / 10)), 100];
}

function u32(b: Uint8Array, at: number, v: number): void {
  b[at] = (v >>> 24) & 0xFF; b[at + 1] = (v >>> 16) & 0xFF; b[at + 2] = (v >>> 8) & 0xFF; b[at + 3] = v & 0xFF;
}

function fctl(seq: number, w: number, h: number, ms: number): Uint8Array {
  const b = new Uint8Array(26);
  u32(b, 0, seq);
  u32(b, 4, w);
  u32(b, 8, h);
  // x_offset, y_offset stay 0 (full frames)
  const [num, den] = delayFraction(ms);
  b[20] = num >>> 8; b[21] = num & 0xFF;
  b[22] = den >>> 8; b[23] = den & 0xFF;
  b[24] = 0; // dispose_op NONE
  b[25] = 0; // blend_op SOURCE
  return b;
}

/**
 * Encode an APNG. `loop` is acTL num_plays (0 = forever, clamped to 0..2^31-1). All frames must share
 * one size; frames 1..DESIGN_LIMITS.maxFrames.
 */
export async function encodeApng(frames: RasterData[], opts: { delayMs: number | number[]; loop: number }): Promise<Uint8Array> {
  const { w, h } = checkAnimationFrames(frames, DESIGN_LIMITS.maxFrames, "encodeApng");
  const delays = frameDelays(opts.delayMs, frames.length, "encodeApng");
  if (typeof opts.loop !== "number" || !Number.isFinite(opts.loop)) throw new Error("encodeApng: loop must be a finite number");
  const plays = Math.min(0x7FFFFFFF, Math.max(0, Math.round(opts.loop)));

  const actl = new Uint8Array(8);
  u32(actl, 0, frames.length);
  u32(actl, 4, plays);
  const parts: Uint8Array[] = [PNG_SIGNATURE, pngChunk("IHDR", pngIhdrRgba8(w, h)), pngChunk("acTL", actl)];
  let seq = 0;
  for (let i = 0; i < frames.length; i++) {
    parts.push(pngChunk("fcTL", fctl(seq++, w, h, delays[i]!)));
    const f = frames[i]!;
    const z = await deflateBytes(filterRows(f.rgba, w, h, null));
    if (i === 0) {
      parts.push(pngChunk("IDAT", z));
    } else {
      const fd = new Uint8Array(4 + z.length);
      u32(fd, 0, seq++);
      fd.set(z, 4);
      parts.push(pngChunk("fdAT", fd));
    }
  }
  parts.push(pngChunk("IEND", new Uint8Array(0)));
  return concat(parts);
}

/** Single-frame RGBA8 PNG through the same node-free path (streamed strips, IDAT chunks <= 1 MiB). */
export async function encodePngAsync(raster: RasterData): Promise<Uint8Array> {
  assertFrame(raster, "encodePngAsync");
  if (raster.width * raster.height > DESIGN_LIMITS.maxRasterPixels) {
    throw new Error(`encodePngAsync: ${raster.width}x${raster.height} exceeds the ${DESIGN_LIMITS.maxRasterPixels} pixel limit`);
  }
  const rb = raster.width * 4;
  return encodePngTiled(raster.width, raster.height, (y0, rows) => raster.rgba.subarray(y0 * rb, (y0 + rows) * rb));
}
