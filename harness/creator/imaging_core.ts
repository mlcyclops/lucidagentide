// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/creator/imaging_core.ts - CREATOR-IMG (ADR-0291) byte primitives with NO node:* import.
//
// imaging.ts deflates PNGs with node:zlib, which must never reach the browser bundle. The pieces that are
// pure byte math (frame invariant, CRC-32, PNG chunk framing, GIF LZW) live here so the renderer and its
// Web Workers (harness/creator/design/) share ONE implementation with the server. imaging.ts re-exports
// everything below, so existing server callers keep a single import.

export interface RgbaFrame {
  readonly width: number;
  readonly height: number;
  /** Row-major RGBA, 4 bytes per pixel. */
  readonly rgba: Uint8Array;
}

/** Reject a malformed frame loudly: every encoder assumes the invariant holds. */
export function assertFrame(f: { width: number; height: number; rgba: { length: number } }, label = "frame"): void {
  if (!Number.isInteger(f.width) || !Number.isInteger(f.height) || f.width <= 0 || f.height <= 0) {
    throw new Error(`${label}: width and height must be positive integers`);
  }
  if (f.rgba.length !== f.width * f.height * 4) {
    throw new Error(`${label}: expected ${f.width * f.height * 4} bytes of RGBA, got ${f.rgba.length}`);
  }
}

// ── CRC-32 / PNG framing ─────────────────────────────────────────────────────

const CRC_TABLE = ((): Uint32Array => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 as PNG defines it. Chainable: `crc32(b, crc32(a)) === crc32(concat(a, b))`, so a streaming
 *  writer can checksum a chunk without assembling it. */
export function crc32(bytes: Uint8Array, prev = 0): number {
  let c = (prev ^ 0xFFFFFFFF) >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xFF]! ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

export const be32 = (n: number): Uint8Array => new Uint8Array([(n >>> 24) & 0xFF, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF]);

export const PNG_SIGNATURE: Uint8Array = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

/** One PNG chunk: length, 4-char type, data, CRC over type + data. */
export function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  out.set(be32(data.length), 0);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i) & 0xFF;
  out.set(data, 8);
  out.set(be32(crc32(out.subarray(4, 8 + data.length))), 8 + data.length);
  return out;
}

export const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

/** IHDR payload for 8-bit RGBA (colour type 6), deflate, adaptive filtering, no interlace. */
export function pngIhdrRgba8(width: number, height: number): Uint8Array {
  const ihdr = new Uint8Array(13);
  ihdr.set(be32(width), 0);
  ihdr.set(be32(height), 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: truecolour with alpha
  return ihdr;  // bytes 10..12 (compression, filter, interlace) stay 0
}

// ── GIF LZW ──────────────────────────────────────────────────────────────────

const HASH_SIZE = 8192; // power of two, > 2 * 4096 live entries, so linear probing stays short

/** Variable-width LZW as GIF defines it, emitted as GIF sub-blocks (255 bytes max each) plus the block
 *  terminator. Codes are keyed `prefix << 8 | symbol` in an open-addressing table (no string keys), the
 *  table resets with a CLEAR code when it reaches 4096 entries, and the code width grows once the next
 *  code would not fit the decoder (which lags one entry behind the encoder). Every symbol must be
 *  `< 1 << minCodeSize`. */
export function lzwEncode(indices: Uint8Array, minCodeSize: number): Uint8Array {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let codeSize = minCodeSize + 1;
  let next = eoi + 1;
  const keys = new Int32Array(HASH_SIZE).fill(-1);
  const vals = new Int16Array(HASH_SIZE);
  // Raw code stream, then framed into sub-blocks. Worst case: one 12-bit code per symbol, plus a CLEAR
  // at least every ~3800 codes, plus the leading CLEAR and the EOI.
  const raw = new Uint8Array(Math.ceil((indices.length + (indices.length >>> 10) + 8) * 12 / 8) + 16);
  let rawLen = 0;
  let bitBuf = 0, bitCount = 0;
  const emit = (code: number): void => {
    bitBuf |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) { raw[rawLen++] = bitBuf & 0xFF; bitBuf >>>= 8; bitCount -= 8; }
  };
  emit(clear);
  let prefix = -1;
  let afterClear = true; // no data code emitted since the last CLEAR (the decoder adds no entry for the first)
  for (let i = 0; i < indices.length; i++) {
    const sym = indices[i]!;
    if (prefix < 0) { prefix = sym; continue; }
    const key = (prefix << 8) | sym;
    let h = (Math.imul(key, 0x9E3779B1) >>> 19) & (HASH_SIZE - 1);
    let found = -1;
    while (keys[h] !== -1) {
      if (keys[h] === key) { found = vals[h]!; break; }
      h = (h + 1) & (HASH_SIZE - 1);
    }
    if (found >= 0) { prefix = found; continue; }
    emit(prefix);
    afterClear = false;
    if (next < 4096) {
      keys[h] = key;
      vals[h] = next++;
      if (next > (1 << codeSize) && codeSize < 12) codeSize++;
    } else {
      emit(clear);
      codeSize = minCodeSize + 1;
      next = eoi + 1;
      keys.fill(-1);
      afterClear = true;
    }
    prefix = sym;
  }
  if (prefix >= 0) {
    emit(prefix);
    // Reading this last code the decoder adds the entry the encoder already holds (unless it is the first
    // code after a CLEAR), so it may widen before EOI; widen the same way so EOI is read at the right size.
    if (!afterClear && next === (1 << codeSize) && codeSize < 12) codeSize++;
  }
  emit(eoi);
  if (bitCount > 0) raw[rawLen++] = bitBuf & 0xFF;
  const blocks = Math.ceil(rawLen / 255);
  const out = new Uint8Array(rawLen + blocks + 1);
  let at = 0;
  for (let i = 0; i < rawLen; i += 255) {
    const n = Math.min(255, rawLen - i);
    out[at++] = n;
    out.set(raw.subarray(i, i + n), at);
    at += n;
  }
  out[at] = 0; // block terminator
  return out;
}
