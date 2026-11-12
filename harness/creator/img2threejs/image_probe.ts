// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/creator/img2threejs/image_probe.ts - technical probe of a reference image (CREATOR-IMG2THREEJS,
// ADR-0562). TypeScript port of forge/stage1_intake/probe_image.py from github.com/img2threejs/img2threejs
// (Apache-2.0): container type and pixel size from the header bytes of PNG, JPEG, GIF, WebP, BMP and TIFF.
//
// This is ONLY a technical probe. It says whether the file is an image the pipeline can reason about and
// whether its resolution and aspect ratio are workable; whether the SUBJECT suits reconstruction is the
// agent's visual judgment. Pure over bytes: the caller reads the file (and passes the real byte count when
// it only read a prefix).

export interface ImageProbe {
  readonly type: "png" | "jpeg" | "gif" | "webp" | "bmp" | "tiff" | null;
  readonly bytes: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly aspectRatio: number | null;
  readonly technicalSuitability: "pass" | "conditional";
  readonly warnings: readonly string[];
  readonly note: string;
}

const startsWith = (d: Uint8Array, sig: readonly number[]): boolean => d.length >= sig.length && sig.every((b, i) => d[i] === b);
const u16be = (d: Uint8Array, i: number): number => ((d[i]! << 8) | d[i + 1]!) >>> 0;
const u16le = (d: Uint8Array, i: number): number => (d[i]! | (d[i + 1]! << 8)) >>> 0;
const u32be = (d: Uint8Array, i: number): number => ((d[i]! << 24) | (d[i + 1]! << 16) | (d[i + 2]! << 8) | d[i + 3]!) >>> 0;
const u32le = (d: Uint8Array, i: number): number => (d[i]! | (d[i + 1]! << 8) | (d[i + 2]! << 16) | (d[i + 3]! << 24)) >>> 0;
const ascii = (d: Uint8Array, start: number, end: number): string => String.fromCharCode(...d.subarray(start, end));

export function detectImageType(data: Uint8Array): ImageProbe["type"] {
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(data, [0xff, 0xd8])) return "jpeg";
  if (data.length >= 6 && (ascii(data, 0, 6) === "GIF87a" || ascii(data, 0, 6) === "GIF89a")) return "gif";
  if (data.length >= 12 && ascii(data, 0, 4) === "RIFF" && ascii(data, 8, 12) === "WEBP") return "webp";
  if (data.length >= 2 && ascii(data, 0, 2) === "BM") return "bmp";
  if (data.length >= 4 && (startsWith(data, [0x49, 0x49, 0x2a, 0x00]) || startsWith(data, [0x4d, 0x4d, 0x00, 0x2a]))) return "tiff";
  return null;
}

function pngSize(d: Uint8Array): [number, number] | null {
  return detectImageType(d) === "png" && d.length >= 24 ? [u32be(d, 16), u32be(d, 20)] : null;
}

function gifSize(d: Uint8Array): [number, number] | null {
  return detectImageType(d) === "gif" && d.length >= 10 ? [u16le(d, 6), u16le(d, 8)] : null;
}

const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegSize(d: Uint8Array): [number, number] | null {
  if (!startsWith(d, [0xff, 0xd8])) return null;
  let i = 2;
  while (i + 9 < d.length) {
    if (d[i] !== 0xff) { i += 1; continue; }
    const marker = d[i + 1]!;
    i += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (i + 2 > d.length) return null;
    const length = u16be(d, i);
    if (length < 2 || i + length > d.length) return null;
    if (SOF_MARKERS.has(marker) && length >= 7) return [u16be(d, i + 5), u16be(d, i + 3)];
    i += length;
  }
  return null;
}

function webpSize(d: Uint8Array): [number, number] | null {
  if (d.length < 30 || detectImageType(d) !== "webp") return null;
  const chunk = ascii(d, 12, 16);
  if (chunk === "VP8X") return [1 + (d[24]! | (d[25]! << 8) | (d[26]! << 16)), 1 + (d[27]! | (d[28]! << 8) | (d[29]! << 16))];
  if (chunk === "VP8 ") {
    for (let i = 20; i + 7 <= d.length; i++) {
      if (d[i] === 0x9d && d[i + 1] === 0x01 && d[i + 2] === 0x2a) return [u16le(d, i + 3) & 0x3fff, u16le(d, i + 5) & 0x3fff];
    }
  }
  return null;
}

function bmpSize(d: Uint8Array): [number, number] | null {
  if (d.length < 26 || detectImageType(d) !== "bmp") return null;
  const height = u32le(d, 22) | 0; // signed: a negative height means top-down rows
  return [u32le(d, 18), Math.abs(height)];
}

function tiffSize(d: Uint8Array): [number, number] | null {
  if (d.length < 8 || detectImageType(d) !== "tiff") return null;
  const le = d[0] === 0x49;
  const u16 = le ? u16le : u16be;
  const u32 = le ? u32le : u32be;
  const offset = u32(d, 4);
  if (offset + 2 > d.length) return null;
  const count = u16(d, offset);
  let width: number | null = null;
  let height: number | null = null;
  let cursor = offset + 2;
  for (let n = 0; n < count; n++) {
    if (cursor + 12 > d.length) return null;
    const tag = u16(d, cursor);
    const type = u16(d, cursor + 2);
    const entryCount = u32(d, cursor + 4);
    if ((type === 3 || type === 4) && entryCount === 1) {
      const value = type === 4 ? u32(d, cursor + 8) : u16(d, cursor + 8);
      if (tag === 256) width = value;
      else if (tag === 257) height = value;
    }
    cursor += 12;
  }
  return width && height ? [width, height] : null;
}

export function detectImageSize(data: Uint8Array): [number, number] | null {
  return pngSize(data) ?? jpegSize(data) ?? gifSize(data) ?? webpSize(data) ?? bmpSize(data) ?? tiffSize(data);
}

/** Probe header bytes. `totalBytes` is the file's full size when only a prefix was read. */
export function probeImage(data: Uint8Array, totalBytes: number = data.length): ImageProbe {
  const type = detectImageType(data);
  const size = detectImageSize(data);
  const warnings: string[] = [];
  if (!type) warnings.push("unknown image type");
  let width: number | null = null;
  let height: number | null = null;
  let aspect: number | null = null;
  if (!size) warnings.push("could not read image dimensions");
  else {
    [width, height] = size;
    aspect = height ? width / height : null;
    if (width < 512 || height < 512) warnings.push("low resolution; small geometry/material details may be unreliable");
    if (aspect !== null && (aspect > 3.0 || aspect < 0.33)) warnings.push("extreme aspect ratio; object may be cropped or surrounded by empty space");
  }
  return {
    type,
    bytes: totalBytes,
    width,
    height,
    aspectRatio: aspect,
    technicalSuitability: warnings.length ? "conditional" : "pass",
    warnings,
    note: "This is only technical image probing. Semantic object suitability still requires visual inspection.",
  };
}
