// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/qr.ts — P-REMOTE.4a (ADR-0226/0227): a dependency-free byte-mode QR encoder.
//
// The invite link (roomId + room key, all in the URL fragment) becomes a QR the user scans with the phone.
// First-party + zero-dep ON PURPOSE: the repo is air-gap-conscious (ADR-0225) and security-obsessed, so we do
// NOT pull an npm QR lib (supply-chain surface + a bundle to vendor). A byte-mode encoder is a bounded, pure
// algorithm (ISO/IEC 18004): GF(256) + Reed-Solomon, spec module placement, penalty-scored masking. It runs
// in the renderer today and the phone PWA later (same file, no DOM dependency — it emits a matrix + SVG).
//
// Scope: byte mode, EC level M (a good balance of capacity + robustness for scanning a screen), versions
// 1..10 (up to 213 bytes — any invite link fits comfortably). Throws if the text is too long.

// --- GF(256) arithmetic (primitive polynomial 0x11d) ---
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]!;
}
function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!;
}

/** Reed-Solomon generator polynomial of the given degree (coefficients high-order first, g[0] === 1).
 *  Exported as a test seam (the syndrome-zero property of rsEncode is the encoder's core correctness anchor). */
export function rsGenerator(degree: number): number[] {
  let g = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] = next[j]! ^ g[j]!; // multiply by x
      next[j + 1] = next[j + 1]! ^ gfMul(g[j]!, GF_EXP[i]!); // + a^i term
    }
    g = next;
  }
  return g;
}

/** The `ecLen` Reed-Solomon error-correction codewords for a data block. Exported as a test seam. */
export function rsEncode(data: number[], ecLen: number): number[] {
  const gen = rsGenerator(ecLen);
  const res = new Array<number>(data.length + ecLen).fill(0);
  for (let i = 0; i < data.length; i++) res[i] = data[i]!;
  for (let i = 0; i < data.length; i++) {
    const coef = res[i]!;
    if (coef !== 0) for (let j = 0; j < gen.length; j++) res[i + j] = res[i + j]! ^ gfMul(gen[j]!, coef);
  }
  return res.slice(data.length);
}

// --- Per-version tables, EC level M (ISO/IEC 18004) ---
const M_TOTAL_DATA: Record<number, number> = { 1: 16, 2: 28, 3: 44, 4: 64, 5: 86, 6: 108, 7: 124, 8: 154, 9: 182, 10: 216 };
const M_ECC_PER_BLOCK: Record<number, number> = { 1: 10, 2: 16, 3: 26, 4: 18, 5: 24, 6: 16, 7: 18, 8: 22, 9: 22, 10: 26 };
// Block groups: [blockCount, dataCodewordsPerBlock][]
const M_BLOCKS: Record<number, [number, number][]> = {
  1: [[1, 16]], 2: [[1, 28]], 3: [[1, 44]], 4: [[2, 32]], 5: [[2, 43]],
  6: [[4, 27]], 7: [[4, 31]], 8: [[2, 38], [2, 39]], 9: [[3, 36], [2, 37]], 10: [[4, 43], [1, 44]],
};
const ALIGN_POS: Record<number, number[]> = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
  7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};
const REMAINDER_BITS: Record<number, number> = { 1: 0, 2: 7, 3: 7, 4: 7, 5: 7, 6: 7, 7: 0, 8: 0, 9: 0, 10: 0 };
// 18-bit version-information strings (v7..10) and 15-bit format-information strings (EC level M, mask 0..7).
// Hardcoded from the spec's published tables (cross-checked against a BCH computation in the tests).
const VERSION_INFO: Record<number, number> = { 7: 0x07c94, 8: 0x085bc, 9: 0x09a99, 10: 0x0a4d3 };
export const FORMAT_M: readonly number[] = [0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0];
const MAX_VERSION = 10;

const bit = (value: number, i: number): boolean => ((value >>> i) & 1) === 1;

/** GF(256) multiply — exported as a test seam for the syndrome check. */
export function gfMultiply(a: number, b: number): number { return gfMul(a, b); }

/** Byte capacity at EC level M for a version (mode + char-count overhead removed). */
function byteCapacity(version: number): number {
  const cci = version <= 9 ? 8 : 16;
  return Math.floor((M_TOTAL_DATA[version]! * 8 - 4 - cci) / 8);
}

export interface QrMatrix {
  version: number;
  /** Module count per side (4 * version + 17), excluding the quiet zone. */
  size: number;
  /** Row-major; `true` = dark module. */
  modules: boolean[][];
}

/** Encode `text` (UTF-8, byte mode) into a QR module matrix at EC level M. Throws if it exceeds version 10. */
export function encodeQr(text: string): QrMatrix {
  const bytes = [...new TextEncoder().encode(text)];
  let version = 0;
  for (let v = 1; v <= MAX_VERSION; v++) {
    if (bytes.length <= byteCapacity(v)) { version = v; break; }
  }
  if (version === 0) {
    throw new Error(`QR: ${bytes.length} bytes exceeds the version-${MAX_VERSION} byte capacity (${byteCapacity(MAX_VERSION)})`);
  }

  // --- bitstream: mode(0100) + char count + data, then terminator + byte pad + pad codewords ---
  const bits: number[] = [];
  const put = (val: number, len: number): void => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(0b0100, 4);
  put(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const totalData = M_TOTAL_DATA[version]!;
  const capacityBits = totalData * 8;
  for (let i = 0; i < 4 && bits.length < capacityBits; i++) bits.push(0); // terminator
  while (bits.length % 8 !== 0) bits.push(0);
  const dataCodewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j]!;
    dataCodewords.push(byte);
  }
  for (let pad = 0xec; dataCodewords.length < totalData; pad ^= 0xec ^ 0x11) dataCodewords.push(pad);

  // --- split into blocks, RS per block, then interleave ---
  const ecLen = M_ECC_PER_BLOCK[version]!;
  const blocks: { data: number[]; ec: number[] }[] = [];
  let offset = 0;
  for (const [count, perBlock] of M_BLOCKS[version]!) {
    for (let b = 0; b < count; b++) {
      const data = dataCodewords.slice(offset, offset + perBlock);
      offset += perBlock;
      blocks.push({ data, ec: rsEncode(data, ecLen) });
    }
  }
  const stream: number[] = [];
  const maxData = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.data.length) stream.push(b.data[i]!);
  for (let i = 0; i < ecLen; i++) for (const b of blocks) stream.push(b.ec[i]!);

  return placeModules(version, stream);
}

/** Build the module matrix: function patterns, data zigzag, penalty-scored mask, format + version info. */
function placeModules(version: number, stream: number[]): QrMatrix {
  const size = version * 4 + 17;
  const mods: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const fixed: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const setFn = (r: number, c: number, v: boolean): void => { mods[r]![c] = v; fixed[r]![c] = true; };

  // timing patterns (rows/cols overwritten by finders where they overlap)
  for (let i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }
  // finder patterns (center-based: dark where chebyshev distance is 0,1,3 → 7x7 + light separator ring)
  const finder = (cr: number, cc: number): void => {
    for (let dr = -4; dr <= 4; dr++) for (let dc = -4; dc <= 4; dc++) {
      const r = cr + dr, c = cc + dc;
      if (r >= 0 && r < size && c >= 0 && c < size) {
        const dist = Math.max(Math.abs(dr), Math.abs(dc));
        setFn(r, c, dist !== 2 && dist !== 4);
      }
    }
  };
  finder(3, 3); finder(3, size - 4); finder(size - 4, 3);
  setFn(size - 8, 8, true); // the always-dark module
  // alignment patterns (skip the three finder corners)
  const pos = ALIGN_POS[version]!;
  const last = pos.length - 1;
  for (let i = 0; i < pos.length; i++) for (let j = 0; j < pos.length; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
    const cr = pos[i]!, cc = pos[j]!;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
      setFn(cr + dr, cc + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
    }
  }
  // reserve format (placeholder) + write version info (constant per version) so data placement skips them
  writeFormat(mods, fixed, size, 0);
  if (version >= 7) writeVersion(setFn, size, VERSION_INFO[version]!);

  // data zigzag from the bottom-right, two columns at a time, skipping the vertical timing column
  let bitIndex = 0;
  const totalBits = stream.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    const col0 = right === 6 ? 5 : right; // hop over the timing column
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const col = col0 - j;
        const upward = ((col0 + 1) & 2) === 0;
        const row = upward ? size - 1 - vert : vert;
        if (!fixed[row]![col] && bitIndex < totalBits) {
          mods[row]![col] = bit(stream[bitIndex >> 3]!, 7 - (bitIndex & 7));
          bitIndex++;
        }
      }
    }
  }

  // choose the mask with the lowest penalty; write its format bits into the winner
  let best: boolean[][] | null = null;
  let bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const cand = mods.map((row) => row.slice());
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
      if (!fixed[r]![c] && maskAt(mask, r, c)) cand[r]![c] = !cand[r]![c];
    }
    writeFormat(cand, fixed, size, FORMAT_M[mask]!);
    const penalty = scorePenalty(cand, size);
    if (penalty < bestPenalty) { bestPenalty = penalty; best = cand; }
  }
  return { version, size, modules: best! };
}

function maskAt(mask: number, r: number, c: number): boolean {
  switch (mask) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    default: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
  }
}

/** Place the 15-bit format string in both copies (top-left L + the split right/bottom copy). */
function writeFormat(m: boolean[][], fixed: boolean[][], size: number, fmt: number): void {
  const set = (r: number, c: number, v: boolean): void => { m[r]![c] = v; fixed[r]![c] = true; };
  for (let i = 0; i <= 5; i++) set(i, 8, bit(fmt, i));
  set(7, 8, bit(fmt, 6));
  set(8, 8, bit(fmt, 7));
  set(8, 7, bit(fmt, 8));
  for (let i = 9; i < 15; i++) set(8, 14 - i, bit(fmt, i));
  for (let i = 0; i < 8; i++) set(8, size - 1 - i, bit(fmt, i));
  for (let i = 8; i < 15; i++) set(size - 15 + i, 8, bit(fmt, i));
  set(size - 8, 8, true);
}

/** Place the 18-bit version string in the two 3x6 blocks by the top-right + bottom-left finders (v >= 7). */
function writeVersion(setFn: (r: number, c: number, v: boolean) => void, size: number, ver: number): void {
  for (let i = 0; i < 18; i++) {
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    setFn(b, a, bit(ver, i));
    setFn(a, b, bit(ver, i));
  }
}

/** The four ISO/IEC 18004 penalty rules; lower is a more scannable code. */
function scorePenalty(m: boolean[][], size: number): number {
  let penalty = 0;
  // Rule 1: runs of 5+ same-color modules in each row and column.
  for (let r = 0; r < size; r++) {
    for (const line of [m[r]!, m.map((row) => row[r]!)]) {
      let run = 1;
      for (let i = 1; i < size; i++) {
        if (line[i] === line[i - 1]) { run++; if (run === 5) penalty += 3; else if (run > 5) penalty += 1; }
        else run = 1;
      }
    }
  }
  // Rule 2: 2x2 blocks of one color.
  for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) {
    const v = m[r]![c];
    if (m[r]![c + 1] === v && m[r + 1]![c] === v && m[r + 1]![c + 1] === v) penalty += 3;
  }
  // Rule 3: finder-like 1:1:3:1:1 pattern with 4 light modules on a side, in rows and columns.
  const pat = [true, false, true, true, true, false, true];
  const hasPattern = (line: boolean[], i: number): boolean => {
    for (let k = 0; k < 7; k++) if (line[i + k] !== pat[k]) return false;
    const before = i - 4 >= 0 && line.slice(i - 4, i).every((x) => !x);
    const after = i + 11 <= line.length && line.slice(i + 7, i + 11).every((x) => !x);
    return before || after;
  };
  for (let r = 0; r < size; r++) {
    const rowLine = m[r]!;
    const colLine = m.map((row) => row[r]!);
    for (let i = 0; i + 7 <= size; i++) { if (hasPattern(rowLine, i)) penalty += 40; if (hasPattern(colLine, i)) penalty += 40; }
  }
  // Rule 4: deviation of the dark-module proportion from 50%.
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (m[r]![c]) dark++;
  const percent = (dark * 100) / (size * size);
  penalty += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return penalty;
}

export interface QrSvgOptions {
  /** Quiet-zone width in modules (spec minimum is 4). Default 4. */
  margin?: number;
  /** Dark-module color. Default "#000". */
  dark?: string;
  /** Background color, or null for a transparent background. Default "#fff". */
  light?: string | null;
}

/** Encode `text` and render it as a self-contained, crisp SVG string (no external refs, safe to inline). */
export function qrSvg(text: string, opts: QrSvgOptions = {}): string {
  const { modules, size } = encodeQr(text);
  const margin = opts.margin ?? 4;
  const dark = opts.dark ?? "#000";
  const light = opts.light === undefined ? "#fff" : opts.light; // null = transparent; ?? would clobber it
  const dim = size + margin * 2;
  let path = "";
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
    if (modules[r]![c]) path += `M${c + margin} ${r + margin}h1v1h-1z`;
  }
  const bg = light === null ? "" : `<rect width="${dim}" height="${dim}" fill="${light}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges">${bg}<path d="${path}" fill="${dark}"/></svg>`;
}
