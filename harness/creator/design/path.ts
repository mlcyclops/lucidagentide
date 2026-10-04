// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/creator/design/path.ts - SVG path data parse, serialize, bounds, and transform.
//
// parsePathData is a single-pass, hand-written scanner for the SVG 2 path grammar
// (https://www.w3.org/TR/SVG2/paths.html#PathDataBNF): no regex, no backtracking, O(input length).
// Output is normalized to absolute M/L/C/Q/Z only (H/V -> L, S -> C, T -> Q, A -> cubic beziers through
// the SVG implementation notes endpoint-to-center conversion), so every consumer handles five commands.
// serializePath emits only [MLCQZ0-9 .-e]: svg_export.ts relies on that to inline it into an attribute.

import { DESIGN_LIMITS } from "./limits.ts";
import type { PathCmd, Rect } from "./types.ts";

/** Path data longer than this is refused before scanning (4 MiB of UTF-16 units). */
export const MAX_PATH_DATA_LENGTH = 4 * 1024 * 1024;

export type PathParseResult = { ok: true; cmds: PathCmd[] } | { ok: false; error: string };

/** SVG matrix(a b c d e f): x' = a*x + c*y + e, y' = b*x + d*y + f. */
export type Matrix2D = [number, number, number, number, number, number];

// ------------------------------------------------------------------------------------------------
// Scanner helpers (char codes, no allocation besides the number substring)

const isWsp = (c: number): boolean => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0c;
const isDigit = (c: number): boolean => c >= 48 && c <= 57;
/** Characters that can begin a number token: digit, sign, or '.'. */
const startsNumber = (c: number): boolean => isDigit(c) || c === 43 || c === 45 || c === 46;

/** Scan one SVG number starting at `i`; returns the end index, or -1 when no valid number starts there.
 *  Grammar: sign? (digits ('.' digits?)? | '.' digits) ([eE] sign? digits)?. A dangling exponent marker
 *  is left unconsumed so the caller rejects it as a stray character. */
export function scanNumberEnd(s: string, i: number): number {
  const n = s.length;
  let j = i;
  let c = s.charCodeAt(j);
  if (c === 43 || c === 45) { j++; c = s.charCodeAt(j); }
  let digits = 0;
  while (j < n && isDigit(s.charCodeAt(j))) { j++; digits++; }
  if (j < n && s.charCodeAt(j) === 46) {
    j++;
    while (j < n && isDigit(s.charCodeAt(j))) { j++; digits++; }
  }
  if (digits === 0) return -1;
  if (j < n) {
    const e = s.charCodeAt(j);
    if (e === 101 || e === 69) {
      let k = j + 1;
      const sc = s.charCodeAt(k);
      if (sc === 43 || sc === 45) k++;
      let ed = 0;
      while (k < n && isDigit(s.charCodeAt(k))) { k++; ed++; }
      if (ed > 0) j = k;
    }
  }
  return j;
}

/** Arguments per command letter (lowercase), 0 for Z. */
function argCount(lower: number): number {
  switch (lower) {
    case 109: case 108: case 116: return 2; // m l t
    case 104: case 118: return 1;           // h v
    case 99: return 6;                      // c
    case 115: case 113: return 4;           // s q
    case 97: return 7;                      // a
    case 122: return 0;                     // z
    default: return -1;
  }
}

// ------------------------------------------------------------------------------------------------
// Arc to cubic (SVG 2 implementation notes, appendix B.2.4 / SVG 1.1 F.6.5 and F.6.6)

function vecAngle(ux: number, uy: number, vx: number, vy: number): number {
  return Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
}

/** Append cubic beziers approximating the elliptical arc from (x1, y1) to (x2, y2). Each segment spans at
 *  most 90 degrees. Degenerate cases follow the spec: same endpoints -> nothing, zero radius -> line. */
function arcToCubics(
  out: PathCmd[], x1: number, y1: number, rxIn: number, ryIn: number, angleDeg: number,
  largeArc: boolean, sweep: boolean, x2: number, y2: number,
): void {
  if (x1 === x2 && y1 === y2) return;
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0) { out.push({ c: "L", x: x2, y: y2 }); return; }
  const phi = ((angleDeg % 360) * Math.PI) / 180;
  const cosP = Math.cos(phi);
  const sinP = Math.sin(phi);
  // F.6.5.1: move origin to the midpoint and rotate
  const dx2 = (x1 - x2) / 2;
  const dy2 = (y1 - y2) / 2;
  const x1p = cosP * dx2 + sinP * dy2;
  const y1p = -sinP * dx2 + cosP * dy2;
  // F.6.6.2: radii correction
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) { const s = Math.sqrt(lambda); rx *= s; ry *= s; }
  // F.6.5.2: center in the rotated frame
  const rx2 = rx * rx, ry2 = ry * ry, x1p2 = x1p * x1p, y1p2 = y1p * y1p;
  const den = rx2 * y1p2 + ry2 * x1p2;
  let coef = den === 0 ? 0 : Math.sqrt(Math.max(0, (rx2 * ry2 - rx2 * y1p2 - ry2 * x1p2) / den));
  if (largeArc === sweep) coef = -coef;
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  // F.6.5.3: center in user space
  const cx = cosP * cxp - sinP * cyp + (x1 + x2) / 2;
  const cy = sinP * cxp + cosP * cyp + (y1 + y2) / 2;
  // F.6.5.5 / F.6.5.6: start angle and sweep extent
  const ux = (x1p - cxp) / rx, uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx, vy = (-y1p - cyp) / ry;
  const theta1 = vecAngle(1, 0, ux, uy);
  let dTheta = vecAngle(ux, uy, vx, vy);
  if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI;
  else if (sweep && dTheta < 0) dTheta += 2 * Math.PI;
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(dTheta)) {
    out.push({ c: "L", x: x2, y: y2 });
    return;
  }
  const segs = Math.max(1, Math.ceil(Math.abs(dTheta) / (Math.PI / 2) - 1e-9));
  const delta = dTheta / segs;
  const k = (4 / 3) * Math.tan(delta / 4);
  // unit-circle point (u, v) -> user space
  let t1 = theta1;
  let cos1 = Math.cos(t1), sin1 = Math.sin(t1);
  for (let s = 0; s < segs; s++) {
    const t2 = t1 + delta;
    const cos2 = Math.cos(t2), sin2 = Math.sin(t2);
    const ax = cos1 - k * sin1, ay = sin1 + k * cos1;
    const bx = cos2 + k * sin2, by = sin2 - k * cos2;
    const last = s === segs - 1;
    out.push({
      c: "C",
      x1: cx + rx * cosP * ax - ry * sinP * ay,
      y1: cy + rx * sinP * ax + ry * cosP * ay,
      x2: cx + rx * cosP * bx - ry * sinP * by,
      y2: cy + rx * sinP * bx + ry * cosP * by,
      x: last ? x2 : cx + rx * cosP * cos2 - ry * sinP * sin2,
      y: last ? y2 : cy + rx * sinP * cos2 + ry * cosP * sin2,
    });
    t1 = t2; cos1 = cos2; sin1 = sin2;
  }
}

// ------------------------------------------------------------------------------------------------
// parsePathData

/** True when every coordinate of the command is finite. */
export function cmdIsFinite(cmd: PathCmd): boolean {
  switch (cmd.c) {
    case "M": case "L": return Number.isFinite(cmd.x) && Number.isFinite(cmd.y);
    case "C":
      return Number.isFinite(cmd.x1) && Number.isFinite(cmd.y1) && Number.isFinite(cmd.x2) &&
        Number.isFinite(cmd.y2) && Number.isFinite(cmd.x) && Number.isFinite(cmd.y);
    case "Q": return Number.isFinite(cmd.x1) && Number.isFinite(cmd.y1) && Number.isFinite(cmd.x) && Number.isFinite(cmd.y);
    case "Z": return true;
    default: return false;
  }
}

/** Parse SVG path data into absolute M/L/C/Q/Z commands. Empty or whitespace-only input yields []. */
export function parsePathData(d: string): PathParseResult {
  if (typeof d !== "string") return { ok: false, error: "path data is not a string" };
  if (d.length > MAX_PATH_DATA_LENGTH) return { ok: false, error: "path data too long" };
  const n = d.length;
  const maxCmds = DESIGN_LIMITS.maxPathCmds;
  const cmds: PathCmd[] = [];
  const args = new Float64Array(7);
  let i = 0;
  const skipWsp = (): void => { while (i < n && isWsp(d.charCodeAt(i))) i++; };
  /** Skip comma-wsp; returns true when a comma was consumed. */
  const skipCommaWsp = (): boolean => {
    skipWsp();
    if (i < n && d.charCodeAt(i) === 44) { i++; skipWsp(); return true; }
    return false;
  };
  const fail = (msg: string, at: number): PathParseResult => ({ ok: false, error: `${msg} at offset ${at}` });

  let cx = 0, cy = 0;          // current point
  let sx = 0, sy = 0;          // subpath start
  let lcx = 0, lcy = 0;        // last cubic control 2 (valid when prev was C/S)
  let lqx = 0, lqy = 0;        // last quadratic control (valid when prev was Q/T)
  let prev = 0;                // previous command letter, upper case code (0 at start)
  let first = true;

  skipWsp();
  while (i < n) {
    const cmdAt = i;
    const code = d.charCodeAt(i);
    const lower = code | 0x20;
    const argc = code >= 65 && code <= 122 ? argCount(lower) : -1;
    if (argc < 0 || (code > 90 && code < 97)) return fail("unexpected character", cmdAt);
    if (first && lower !== 109) return fail("path must start with M", cmdAt);
    first = false;
    const rel = code >= 97;
    i++;
    skipWsp();
    if (argc === 0) {
      cmds.push({ c: "Z" });
      cx = sx; cy = sy; prev = 90;
      if (cmds.length > maxCmds) return fail("too many path commands", cmdAt);
      continue;
    }
    let group = 0;
    for (;;) {
      // read one argument group
      for (let a = 0; a < argc; a++) {
        if (a > 0) skipCommaWsp();
        if (i >= n) return fail("missing arguments", i);
        if (lower === 97 && (a === 3 || a === 4)) {
          const f = d.charCodeAt(i);
          if (f !== 48 && f !== 49) return fail("invalid arc flag", i);
          args[a] = f - 48;
          i++;
          continue;
        }
        const end = scanNumberEnd(d, i);
        if (end < 0) return fail("expected number", i);
        const v = Number(d.slice(i, end));
        if (!Number.isFinite(v)) return fail("non-finite number", i);
        args[a] = v;
        i = end;
      }
      const before = cmds.length;
      const ox = rel ? cx : 0;
      const oy = rel ? cy : 0;
      let up = code & ~0x20; // upper-case command
      if (up === 77 && group > 0) up = 76; // extra M pairs are implicit L
      switch (up) {
        case 77: { // M
          cx = args[0]! + ox; cy = args[1]! + oy;
          sx = cx; sy = cy;
          cmds.push({ c: "M", x: cx, y: cy });
          break;
        }
        case 76: { // L
          cx = args[0]! + ox; cy = args[1]! + oy;
          cmds.push({ c: "L", x: cx, y: cy });
          break;
        }
        case 72: { // H
          cx = args[0]! + ox;
          cmds.push({ c: "L", x: cx, y: cy });
          break;
        }
        case 86: { // V
          cy = args[0]! + oy;
          cmds.push({ c: "L", x: cx, y: cy });
          break;
        }
        case 67: { // C
          const x1 = args[0]! + ox, y1 = args[1]! + oy, x2 = args[2]! + ox, y2 = args[3]! + oy;
          cx = args[4]! + ox; cy = args[5]! + oy;
          cmds.push({ c: "C", x1, y1, x2, y2, x: cx, y: cy });
          lcx = x2; lcy = y2;
          break;
        }
        case 83: { // S
          const x1 = prev === 67 || prev === 83 ? 2 * cx - lcx : cx;
          const y1 = prev === 67 || prev === 83 ? 2 * cy - lcy : cy;
          const x2 = args[0]! + ox, y2 = args[1]! + oy;
          cx = args[2]! + ox; cy = args[3]! + oy;
          cmds.push({ c: "C", x1, y1, x2, y2, x: cx, y: cy });
          lcx = x2; lcy = y2;
          break;
        }
        case 81: { // Q
          const x1 = args[0]! + ox, y1 = args[1]! + oy;
          cx = args[2]! + ox; cy = args[3]! + oy;
          cmds.push({ c: "Q", x1, y1, x: cx, y: cy });
          lqx = x1; lqy = y1;
          break;
        }
        case 84: { // T
          const x1 = prev === 81 || prev === 84 ? 2 * cx - lqx : cx;
          const y1 = prev === 81 || prev === 84 ? 2 * cy - lqy : cy;
          cx = args[0]! + ox; cy = args[1]! + oy;
          cmds.push({ c: "Q", x1, y1, x: cx, y: cy });
          lqx = x1; lqy = y1;
          break;
        }
        case 65: { // A
          const ex = args[5]! + ox, ey = args[6]! + oy;
          arcToCubics(cmds, cx, cy, args[0]!, args[1]!, args[2]!, args[3] === 1, args[4] === 1, ex, ey);
          cx = ex; cy = ey;
          break;
        }
        default:
          return fail("unexpected command", cmdAt);
      }
      // finite inputs can still overflow (relative offsets, S/T reflection, arc centers)
      for (let k = before; k < cmds.length; k++) {
        if (!cmdIsFinite(cmds[k]!)) return fail("non-finite coordinate", cmdAt);
      }
      if (cmds.length > maxCmds) return fail("too many path commands", cmdAt);
      prev = up;
      group++;
      const comma = skipCommaWsp();
      if (i < n && startsNumber(d.charCodeAt(i))) continue;
      if (comma) return fail("dangling comma", i);
      break;
    }
  }
  return { ok: true, cmds };
}

// ------------------------------------------------------------------------------------------------
// serializePath

/** Format a number with at most `precision` decimals: trailing zeros trimmed, never "-0", NaN, or
 *  Infinity (non-finite -> "0"), never a '+' sign. */
export function formatPathNumber(v: number, precision = 3): string {
  if (!Number.isFinite(v)) return "0";
  const p = Number.isFinite(precision) ? Math.min(20, Math.max(0, Math.floor(precision))) : 3;
  let s: string;
  if (Math.abs(v) >= 1e21) {
    // toFixed switches to exponent notation here; drop the '+' to stay inside [0-9.-e]
    s = String(v).replace("+", "");
  } else {
    s = v.toFixed(p);
    if (s.indexOf(".") >= 0) {
      let end = s.length;
      while (end > 0 && s.charCodeAt(end - 1) === 48) end--;
      if (end > 0 && s.charCodeAt(end - 1) === 46) end--;
      s = s.slice(0, end);
    }
  }
  if (s === "-0" || s === "" || s === "-") return "0";
  return s;
}

/** Serialize commands to SVG path data. Only `M x y`, `L x y`, `C ...`, `Q ...`, `Z` are emitted, space
 *  separated; unknown entries are skipped. */
export function serializePath(cmds: PathCmd[], precision = 3): string {
  const parts: string[] = [];
  const f = (v: number): string => formatPathNumber(v, precision);
  for (const cmd of cmds) {
    if (cmd === null || typeof cmd !== "object") continue;
    switch (cmd.c) {
      case "M": parts.push(`M ${f(cmd.x)} ${f(cmd.y)}`); break;
      case "L": parts.push(`L ${f(cmd.x)} ${f(cmd.y)}`); break;
      case "C": parts.push(`C ${f(cmd.x1)} ${f(cmd.y1)} ${f(cmd.x2)} ${f(cmd.y2)} ${f(cmd.x)} ${f(cmd.y)}`); break;
      case "Q": parts.push(`Q ${f(cmd.x1)} ${f(cmd.y1)} ${f(cmd.x)} ${f(cmd.y)}`); break;
      case "Z": parts.push("Z"); break;
      default: break;
    }
  }
  return parts.join(" ");
}

// ------------------------------------------------------------------------------------------------
// pathBBox

interface BoxAcc { minX: number; minY: number; maxX: number; maxY: number; any: boolean }

function addPt(b: BoxAcc, x: number, y: number): void {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  if (!b.any) { b.minX = b.maxX = x; b.minY = b.maxY = y; b.any = true; return; }
  if (x < b.minX) b.minX = x; else if (x > b.maxX) b.maxX = x;
  if (y < b.minY) b.minY = y; else if (y > b.maxY) b.maxY = y;
}

const cubicAt = (p0: number, p1: number, p2: number, p3: number, t: number): number => {
  const mt = 1 - t;
  return mt * mt * mt * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t * p3;
};
const quadAt = (p0: number, p1: number, p2: number, t: number): number => {
  const mt = 1 - t;
  return mt * mt * p0 + 2 * mt * t * p1 + t * t * p2;
};

/** Parameters in (0, 1) where the cubic's derivative on one axis is zero (at most 2, written to `out`). */
function cubicExtrema(p0: number, p1: number, p2: number, p3: number, out: Float64Array): number {
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  let k = 0;
  const eps = 1e-12;
  if (Math.abs(a) < eps) {
    if (Math.abs(b) > eps) {
      const t = -c / b;
      if (t > 0 && t < 1) out[k++] = t;
    }
    return k;
  }
  const disc = b * b - 4 * a * c;
  if (disc < 0) return k;
  const sq = Math.sqrt(disc);
  const t1 = (-b + sq) / (2 * a);
  const t2 = (-b - sq) / (2 * a);
  if (t1 > 0 && t1 < 1) out[k++] = t1;
  if (t2 > 0 && t2 < 1) out[k++] = t2;
  return k;
}

/** Tight bounding box of the path, including bezier extrema. Empty path -> {0, 0, 0, 0}. */
export function pathBBox(cmds: PathCmd[]): Rect {
  const b: BoxAcc = { minX: 0, minY: 0, maxX: 0, maxY: 0, any: false };
  const roots = new Float64Array(2);
  let cx = 0, cy = 0, sx = 0, sy = 0;
  for (const cmd of cmds) {
    switch (cmd.c) {
      case "M":
        cx = sx = cmd.x; cy = sy = cmd.y;
        addPt(b, cx, cy);
        break;
      case "L":
        addPt(b, cx, cy);
        cx = cmd.x; cy = cmd.y;
        addPt(b, cx, cy);
        break;
      case "C": {
        addPt(b, cx, cy);
        addPt(b, cmd.x, cmd.y);
        let k = cubicExtrema(cx, cmd.x1, cmd.x2, cmd.x, roots);
        for (let r = 0; r < k; r++) {
          const t = roots[r]!;
          addPt(b, cubicAt(cx, cmd.x1, cmd.x2, cmd.x, t), cubicAt(cy, cmd.y1, cmd.y2, cmd.y, t));
        }
        k = cubicExtrema(cy, cmd.y1, cmd.y2, cmd.y, roots);
        for (let r = 0; r < k; r++) {
          const t = roots[r]!;
          addPt(b, cubicAt(cx, cmd.x1, cmd.x2, cmd.x, t), cubicAt(cy, cmd.y1, cmd.y2, cmd.y, t));
        }
        cx = cmd.x; cy = cmd.y;
        break;
      }
      case "Q": {
        addPt(b, cx, cy);
        addPt(b, cmd.x, cmd.y);
        const dx = cx - 2 * cmd.x1 + cmd.x;
        if (dx !== 0) {
          const t = (cx - cmd.x1) / dx;
          if (t > 0 && t < 1) addPt(b, quadAt(cx, cmd.x1, cmd.x, t), quadAt(cy, cmd.y1, cmd.y, t));
        }
        const dy = cy - 2 * cmd.y1 + cmd.y;
        if (dy !== 0) {
          const t = (cy - cmd.y1) / dy;
          if (t > 0 && t < 1) addPt(b, quadAt(cx, cmd.x1, cmd.x, t), quadAt(cy, cmd.y1, cmd.y, t));
        }
        cx = cmd.x; cy = cmd.y;
        break;
      }
      case "Z":
        cx = sx; cy = sy;
        break;
      default:
        break;
    }
  }
  if (!b.any) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: b.minX, y: b.minY, w: b.maxX - b.minX, h: b.maxY - b.minY };
}

// ------------------------------------------------------------------------------------------------
// transformPath

/** Apply an SVG matrix to every point (anchors and controls). Returns new command objects. */
export function transformPath(cmds: PathCmd[], m: Matrix2D): PathCmd[] {
  const [a, b, c, d, e, f] = m;
  const tx = (x: number, y: number): number => a * x + c * y + e;
  const ty = (x: number, y: number): number => b * x + d * y + f;
  const out: PathCmd[] = new Array<PathCmd>(cmds.length);
  for (let i = 0; i < cmds.length; i++) {
    const cmd = cmds[i]!;
    switch (cmd.c) {
      case "M": out[i] = { c: "M", x: tx(cmd.x, cmd.y), y: ty(cmd.x, cmd.y) }; break;
      case "L": out[i] = { c: "L", x: tx(cmd.x, cmd.y), y: ty(cmd.x, cmd.y) }; break;
      case "C":
        out[i] = {
          c: "C",
          x1: tx(cmd.x1, cmd.y1), y1: ty(cmd.x1, cmd.y1),
          x2: tx(cmd.x2, cmd.y2), y2: ty(cmd.x2, cmd.y2),
          x: tx(cmd.x, cmd.y), y: ty(cmd.x, cmd.y),
        };
        break;
      case "Q":
        out[i] = { c: "Q", x1: tx(cmd.x1, cmd.y1), y1: ty(cmd.x1, cmd.y1), x: tx(cmd.x, cmd.y), y: ty(cmd.x, cmd.y) };
        break;
      default: out[i] = { c: "Z" }; break;
    }
  }
  return out;
}
