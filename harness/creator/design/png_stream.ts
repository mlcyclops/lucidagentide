// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/creator/design/png_stream.ts - strip-wise PNG encoder for exports too large for one canvas.
//
// The caller hands rows over in strips (`readRows`), each strip is filtered (PNG adaptive filtering,
// heuristic: minimum sum of absolute signed residuals, PNG spec section 12.8) and written into ONE
// CompressionStream("deflate") (zlib-wrapped, exactly what IDAT carries). The readable side is drained
// concurrently into IDAT chunks of at most 1 MiB, so memory stays at the compressed output plus one
// strip. Pure web platform: runs in the renderer, its Web Workers, and Bun. No metadata chunks, ever.

import { DESIGN_LIMITS } from "./limits.ts";
import { PNG_SIGNATURE, concat, pngChunk, pngIhdrRgba8 } from "../imaging_core.ts";

/** Largest IDAT payload this module emits. */
export const IDAT_MAX_BYTES = 1 << 20;
/** The huge-export path is not bound by maxRasterPixels, only by this. */
export const PNG_STREAM_MAX_PIXELS = 2 ** 31;
/** A single strip never exceeds this many raw bytes; rowsPerStrip is lowered to fit. */
const MAX_STRIP_BYTES = 64 << 20;

type Bytes = Uint8Array | Uint8ClampedArray;
/** The slice of ReadableStream this module uses (structural, so it type-checks with or without lib.dom). */
interface ByteReadable {
  getReader(): { read(): Promise<{ done: true; value?: unknown } | { done: false; value: Uint8Array }> };
}

/** An Error whose name is "AbortError", like the DOMException fetch() throws, without needing the DOM. */
export function abortError(): Error {
  const e = new Error("PNG encoding aborted");
  e.name = "AbortError";
  return e;
}

/**
 * PNG-filter `rows` rows of RGBA8 starting at `srcOffset` in `src`. Each output row is one filter-type
 * byte followed by `width * 4` residual bytes. Per row the filter (None, Sub, Up, Average, Paeth) with the
 * smallest sum of absolute signed residuals wins, ties going to the lower type. `prevRow` is the row
 * above the first one (the last row of the previous strip), or null for the first row of the image.
 */
export function filterRows(src: Bytes, width: number, rows: number, prevRow: Bytes | null, srcOffset = 0): Uint8Array<ArrayBuffer> {
  const rb = width * 4;
  const stride = rb + 1;
  const out = new Uint8Array(stride * rows);
  const zero = prevRow === null ? new Uint8Array(rb) : null;
  for (let r = 0; r < rows; r++) {
    const cur = srcOffset + r * rb;
    const pBuf: Bytes = r > 0 ? src : (prevRow ?? zero!);
    const pOff = r > 0 ? cur - rb : 0;
    let sNone = 0, sSub = 0, sUp = 0, sAvg = 0, sPaeth = 0;
    for (let i = 0; i < rb; i++) {
      const x = src[cur + i]!;
      const a = i >= 4 ? src[cur + i - 4]! : 0;
      const b = pBuf[pOff + i]!;
      const c = i >= 4 ? pBuf[pOff + i - 4]! : 0;
      sNone += x < 128 ? x : 256 - x;
      let d = (x - a) & 255; sSub += d < 128 ? d : 256 - d;
      d = (x - b) & 255; sUp += d < 128 ? d : 256 - d;
      d = (x - ((a + b) >>> 1)) & 255; sAvg += d < 128 ? d : 256 - d;
      const p = a + b - c;
      const pa = p > a ? p - a : a - p, pb = p > b ? p - b : b - p, pc = p > c ? p - c : c - p;
      d = (x - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255; sPaeth += d < 128 ? d : 256 - d;
    }
    let ft = 0, best = sNone;
    if (sSub < best) { ft = 1; best = sSub; }
    if (sUp < best) { ft = 2; best = sUp; }
    if (sAvg < best) { ft = 3; best = sAvg; }
    if (sPaeth < best) { ft = 4; }
    const o = r * stride;
    out[o] = ft;
    const w = o + 1;
    switch (ft) {
      case 0:
        for (let i = 0; i < rb; i++) out[w + i] = src[cur + i]!;
        break;
      case 1:
        for (let i = 0; i < rb; i++) out[w + i] = src[cur + i]! - (i >= 4 ? src[cur + i - 4]! : 0);
        break;
      case 2:
        for (let i = 0; i < rb; i++) out[w + i] = src[cur + i]! - pBuf[pOff + i]!;
        break;
      case 3:
        for (let i = 0; i < rb; i++) out[w + i] = src[cur + i]! - (((i >= 4 ? src[cur + i - 4]! : 0) + pBuf[pOff + i]!) >>> 1);
        break;
      default:
        for (let i = 0; i < rb; i++) {
          const a = i >= 4 ? src[cur + i - 4]! : 0;
          const b = pBuf[pOff + i]!;
          const c = i >= 4 ? pBuf[pOff + i - 4]! : 0;
          const p = a + b - c;
          const pa = p > a ? p - a : a - p, pb = p > b ? p - b : b - p, pc = p > c ? p - c : c - p;
          out[w + i] = src[cur + i]! - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
        }
    }
  }
  return out;
}

/** Collects a deflate stream into IDAT chunks whose payload is at most IDAT_MAX_BYTES. */
class IdatChunker {
  private readonly pending = new Uint8Array(IDAT_MAX_BYTES);
  private fill = 0;
  private readonly parts: Uint8Array[];
  constructor(parts: Uint8Array[]) { this.parts = parts; }
  push(bytes: Uint8Array): void {
    let at = 0;
    while (at < bytes.length) {
      const n = Math.min(IDAT_MAX_BYTES - this.fill, bytes.length - at);
      this.pending.set(bytes.subarray(at, at + n), this.fill);
      this.fill += n;
      at += n;
      if (this.fill === IDAT_MAX_BYTES) this.emit();
    }
  }
  emit(): void {
    if (this.fill === 0) return;
    this.parts.push(pngChunk("IDAT", this.pending.subarray(0, this.fill))); // pngChunk copies
    this.fill = 0;
  }
}

/** Drain a reader into `sink` until done. The returned promise is pre-handled so an abort that the
 *  writer side already reports never surfaces as an unhandled rejection; awaiting it still rethrows. */
function drainReader(readable: ByteReadable, sink: (b: Uint8Array) => void): Promise<void> {
  const reader = readable.getReader();
  const p = (async (): Promise<void> => {
    for (;;) {
      const r = await reader.read();
      if (r.done) return;
      sink(r.value);
    }
  })();
  p.catch(() => {});
  return p;
}

/** zlib-wrapped deflate of a whole buffer via CompressionStream("deflate"). */
export async function deflateBytes(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate");
  const writer = cs.writable.getWriter();
  const parts: Uint8Array[] = [];
  const drain = drainReader(cs.readable, (b) => { parts.push(b); });
  try {
    await writer.write(data);
    await writer.close();
  } catch (e) {
    writer.abort(e).catch(() => {});
    throw e;
  }
  await drain;
  return concat(parts);
}

/**
 * Encode a `width x height` RGBA8 PNG pulling rows in strips. `readRows(y0, rows)` must return exactly
 * `rows * width * 4` bytes (it may reuse its buffer between calls: the last row is copied). Rejects with
 * an AbortError-named Error when `opts.signal` aborts, and with a plain Error on bad input.
 */
export async function encodePngTiled(
  width: number,
  height: number,
  readRows: (y0: number, rows: number) => Uint8ClampedArray,
  opts?: { rowsPerStrip?: number; signal?: AbortSignal; onProgress?: (done: number, total: number) => void },
): Promise<Uint8Array> {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error("encodePngTiled: width and height must be positive integers");
  }
  if (width > DESIGN_LIMITS.maxSide || height > DESIGN_LIMITS.maxSide) {
    throw new Error(`encodePngTiled: ${width}x${height} exceeds the ${DESIGN_LIMITS.maxSide} px side limit`);
  }
  if (width * height > PNG_STREAM_MAX_PIXELS) throw new Error("encodePngTiled: image exceeds 2^31 pixels");
  const rps0 = opts?.rowsPerStrip ?? 64;
  if (!Number.isInteger(rps0) || rps0 < 1) throw new Error("encodePngTiled: rowsPerStrip must be a positive integer");
  const rowBytes = width * 4;
  const rps = Math.max(1, Math.min(rps0, height, Math.floor(MAX_STRIP_BYTES / rowBytes)));
  const signal = opts?.signal;
  if (signal?.aborted) throw abortError();

  const parts: Uint8Array[] = [PNG_SIGNATURE, pngChunk("IHDR", pngIhdrRgba8(width, height))];
  const chunker = new IdatChunker(parts);
  const cs = new CompressionStream("deflate");
  const writer = cs.writable.getWriter();
  const drain = drainReader(cs.readable, (b) => { chunker.push(b); });
  try {
    let prev: Bytes | null = null;
    for (let y0 = 0; y0 < height; y0 += rps) {
      if (signal?.aborted) throw abortError();
      const rows = Math.min(rps, height - y0);
      // Typed as unknown for the runtime check: the callback is caller code and may return anything, and a
      // Bytes-typed value would narrow to never between the two instanceof tests (TS2358).
      const got: unknown = readRows(y0, rows);
      if (!(got instanceof Uint8ClampedArray || got instanceof Uint8Array) || got.length !== rows * rowBytes) {
        throw new Error(`encodePngTiled: readRows(${y0}, ${rows}) must return exactly ${rows * rowBytes} bytes`);
      }
      const strip: Bytes = got;
      const filtered = filterRows(strip, width, rows, prev);
      prev = strip.slice((rows - 1) * rowBytes, rows * rowBytes);
      await writer.write(filtered);
      opts?.onProgress?.(y0 + rows, height);
    }
    if (signal?.aborted) throw abortError();
    await writer.close();
  } catch (e) {
    writer.abort(e).catch(() => {});
    throw e;
  }
  await drain;
  chunker.emit();
  parts.push(pngChunk("IEND", new Uint8Array(0)));
  return concat(parts);
}
