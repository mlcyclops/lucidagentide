// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/creator/design/sniff.ts - header-only image identification and the decode budget check.
//
// Runs BEFORE any decoder sees untrusted bytes: it reads magic numbers and the few header fields that
// carry dimensions (and frame counts for animated formats), never pixels. Every read is bounds-checked
// (a truncated header yields the format with dims undefined), every walk is bounded in bytes and steps,
// and nothing throws. checkDecodeBudget then refuses unknown formats, missing dims, oversize sides, and
// width * height * frames over the caller's pixel budget (the decompression-bomb guard).

import { DESIGN_LIMITS } from "./limits.ts";

export type SniffFormat = "png" | "jpeg" | "gif" | "webp" | "bmp" | "psd" | "svg" | "unknown";
export interface SniffResult { format: SniffFormat; width?: number; height?: number; frames?: number }

const PNG_MAX_CHUNKS = 64;
const PNG_MAX_SCAN = 1 << 20;
const JPEG_MAX_SEGMENTS = 4096;
const GIF_MAX_SCAN = 64 << 20;
const WEBP_MAX_SCAN = 64 << 20;
const SVG_SCAN = 4096;

const u16be = (b: Uint8Array, o: number): number => (b[o]! << 8) | b[o + 1]!;
const u16le = (b: Uint8Array, o: number): number => b[o]! | (b[o + 1]! << 8);
const u32be = (b: Uint8Array, o: number): number => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
const u32le = (b: Uint8Array, o: number): number => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
const i32le = (b: Uint8Array, o: number): number => b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24);

/** True when `bytes` holds the ASCII text `s` at offset `o` (bounds-checked). */
function hasAscii(bytes: Uint8Array, o: number, s: string): boolean {
  if (o + s.length > bytes.length) return false;
  for (let i = 0; i < s.length; i++) if (bytes[o + i] !== s.charCodeAt(i)) return false;
  return true;
}

function sniffPng(b: Uint8Array): SniffResult {
  const out: SniffResult = { format: "png" };
  if (b.length < 24 || !hasAscii(b, 12, "IHDR")) return out;
  out.width = u32be(b, 16);
  out.height = u32be(b, 20);
  let off = 8;
  const limit = Math.min(b.length, PNG_MAX_SCAN);
  for (let n = 0; n < PNG_MAX_CHUNKS && off + 8 <= limit; n++) {
    const len = u32be(b, off);
    if (hasAscii(b, off + 4, "IDAT")) break;
    if (hasAscii(b, off + 4, "acTL")) {
      if (len >= 8 && off + 16 <= b.length) {
        const frames = u32be(b, off + 8);
        if (frames >= 1) out.frames = frames;
      }
      break;
    }
    off += 12 + len;
  }
  return out;
}

function isSof(m: number): boolean {
  return (m >= 0xC0 && m <= 0xC3) || (m >= 0xC5 && m <= 0xC7) || (m >= 0xC9 && m <= 0xCB) || (m >= 0xCD && m <= 0xCF);
}

function sniffJpeg(b: Uint8Array): SniffResult {
  const out: SniffResult = { format: "jpeg" };
  let off = 2;
  for (let n = 0; n < JPEG_MAX_SEGMENTS && off < b.length; n++) {
    if (b[off] !== 0xFF) return out;
    while (off < b.length && b[off] === 0xFF) off++; // marker prefix plus fill bytes
    if (off >= b.length) return out;
    const m = b[off]!;
    off++;
    if ((m >= 0xD0 && m <= 0xD7) || m === 0xD8 || m === 0x01) continue; // standalone: no length
    if (m === 0xD9 || m === 0xDA) return out; // EOI, or SOS before any SOF: give up
    if (off + 2 > b.length) return out;
    const segLen = u16be(b, off);
    if (segLen < 2) return out;
    if (isSof(m)) {
      if (off + 7 <= b.length) {
        out.height = u16be(b, off + 3);
        out.width = u16be(b, off + 5);
      }
      return out;
    }
    off += segLen;
  }
  return out;
}

function sniffGif(b: Uint8Array): SniffResult {
  const out: SniffResult = { format: "gif" };
  if (b.length < 13) return out;
  out.width = u16le(b, 6);
  out.height = u16le(b, 8);
  const limit = Math.min(b.length, GIF_MAX_SCAN);
  const packed = b[10]!;
  let off = 13 + ((packed & 0x80) !== 0 ? 3 * (2 << (packed & 7)) : 0);
  let frames = 0;
  while (off < limit) {
    const tag = b[off]!;
    if (tag === 0x2C) {
      frames++;
      if (frames > DESIGN_LIMITS.maxGifFrames) break;
      if (off + 10 > limit) break;
      const p = b[off + 9]!;
      off += 10 + ((p & 0x80) !== 0 ? 3 * (2 << (p & 7)) : 0);
      off++; // LZW minimum code size
    } else if (tag === 0x21) {
      off += 2; // introducer + label
    } else {
      break; // trailer 0x3B or garbage
    }
    // Skip the data sub-blocks up to the block terminator.
    while (off < limit) {
      const n = b[off]!;
      off++;
      if (n === 0) break;
      off += n;
    }
  }
  if (frames > 0) out.frames = frames;
  return out;
}

function sniffWebp(b: Uint8Array): SniffResult {
  const out: SniffResult = { format: "webp" };
  if (b.length < 20) return out;
  const d = 20;
  if (hasAscii(b, 12, "VP8 ")) {
    if (b.length >= d + 10 && b[d + 3] === 0x9D && b[d + 4] === 0x01 && b[d + 5] === 0x2A) {
      out.width = u16le(b, d + 6) & 0x3FFF;
      out.height = u16le(b, d + 8) & 0x3FFF;
    }
  } else if (hasAscii(b, 12, "VP8L")) {
    if (b.length >= d + 5 && b[d] === 0x2F) {
      const bits = u32le(b, d + 1);
      out.width = (bits & 0x3FFF) + 1;
      out.height = ((bits >>> 14) & 0x3FFF) + 1;
    }
  } else if (hasAscii(b, 12, "VP8X")) {
    if (b.length >= d + 10) {
      out.width = (b[d + 4]! | (b[d + 5]! << 8) | (b[d + 6]! << 16)) + 1;
      out.height = (b[d + 7]! | (b[d + 8]! << 8) | (b[d + 9]! << 16)) + 1;
      if ((b[d]! & 0x02) !== 0) {
        const limit = Math.min(b.length, WEBP_MAX_SCAN);
        let off = 12;
        let frames = 0;
        while (off + 8 <= limit && frames <= DESIGN_LIMITS.maxFrames) {
          if (hasAscii(b, off, "ANMF")) frames++;
          const size = u32le(b, off + 4);
          off += 8 + size + (size & 1);
        }
        if (frames > 0) out.frames = frames;
      }
    }
  }
  return out;
}

function sniffBmp(b: Uint8Array): SniffResult {
  const out: SniffResult = { format: "bmp" };
  if (b.length < 18) return out;
  const dib = u32le(b, 14);
  if (dib === 12) {
    if (b.length >= 22) { out.width = u16le(b, 18); out.height = u16le(b, 20); }
  } else if (b.length >= 26) {
    out.width = i32le(b, 18);
    out.height = Math.abs(i32le(b, 22));
  }
  return out;
}

/** Case-insensitive ASCII match of lowercase `s` at `o`. */
function hasAsciiCi(b: Uint8Array, o: number, s: string): boolean {
  if (o + s.length > b.length) return false;
  for (let i = 0; i < s.length; i++) {
    const c = b[o + i]!;
    if ((c >= 0x41 && c <= 0x5A ? c + 32 : c) !== s.charCodeAt(i)) return false;
  }
  return true;
}

function looksSvg(b: Uint8Array): boolean {
  let o = 0;
  if (b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) o = 3;
  const limit = Math.min(b.length, SVG_SCAN);
  while (o < limit && (b[o] === 0x20 || b[o] === 0x09 || b[o] === 0x0A || b[o] === 0x0D)) o++;
  if (!hasAsciiCi(b, o, "<?xml") && !hasAsciiCi(b, o, "<svg") && !hasAscii(b, o, "<!--")) return false;
  for (let i = o; i + 4 <= limit; i++) if (hasAsciiCi(b, i, "<svg")) return true;
  return false;
}

/** Identify an image from its header bytes. Never decodes, never throws, never reads out of bounds. */
export function sniffImage(bytes: Uint8Array): SniffResult {
  const b = bytes;
  if (!(b instanceof Uint8Array)) return { format: "unknown" };
  if (b.length >= 8 && b[0] === 0x89 && hasAscii(b, 1, "PNG") && b[4] === 0x0D && b[5] === 0x0A && b[6] === 0x1A && b[7] === 0x0A) return sniffPng(b);
  if (b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return sniffJpeg(b);
  if (hasAscii(b, 0, "GIF87a") || hasAscii(b, 0, "GIF89a")) return sniffGif(b);
  if (hasAscii(b, 0, "RIFF") && hasAscii(b, 8, "WEBP")) return sniffWebp(b);
  if (hasAscii(b, 0, "BM") && b.length >= 14) return sniffBmp(b);
  if (hasAscii(b, 0, "8BPS") && b.length >= 6) {
    const version = u16be(b, 4);
    if (version !== 1 && version !== 2) return { format: "unknown" };
    const out: SniffResult = { format: "psd" };
    if (b.length >= 22) { out.height = u32be(b, 14); out.width = u32be(b, 18); }
    return out;
  }
  if (looksSvg(b)) return { format: "svg" };
  return { format: "unknown" };
}

/**
 * null when the image may be decoded; otherwise the refusal reason. SVG is exempt from dimension checks
 * (it is sanitized and rasterized at a caller-chosen size instead).
 */
export function checkDecodeBudget(info: SniffResult, maxPixels: number): string | null {
  if (info.format === "unknown") return "unrecognized image format";
  if (info.format === "svg") return null;
  const { width, height } = info;
  if (width === undefined || height === undefined) return `${info.format} header is truncated or malformed: dimensions unavailable`;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return `${info.format} declares invalid dimensions ${width}x${height}`;
  if (width > DESIGN_LIMITS.maxSide || height > DESIGN_LIMITS.maxSide) {
    return `${info.format} is ${width}x${height}, over the ${DESIGN_LIMITS.maxSide} px side limit`;
  }
  const frames = info.frames !== undefined && info.frames >= 1 ? info.frames : 1;
  const total = width * height * frames;
  if (!(total <= maxPixels)) {
    return `${info.format} needs ${total} pixels (${width}x${height}${frames > 1 ? ` x ${frames} frames` : ""}), over the ${maxPixels} pixel budget`;
  }
  return null;
}
