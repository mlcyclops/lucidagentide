// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/creator/design/svg_import.ts - convert a sanitized SVG element tree into vector shapes.
//
// The renderer runs DOMPurify + DOMParser and hands us a plain SvgNode tree; this module never sees
// markup. Only svg/g/path/rect/circle/ellipse/line/polyline/polygon/text are understood; every other
// element (script, style, image, use, foreignObject, a, defs, filter, ...) is dropped with one warning
// per tag name. Traversal is iterative with an explicit stack (depth, node, shape, and command caps), all
// attribute parsing is hand-written and linear, every number is checked finite, and colors go through
// color.ts (anything else, including url(...) paints, falls back). Hostile input yields warnings, never
// an exception.

import { namedColor, parseColor, toHex, type RGBA } from "./color.ts";
import { DESIGN_LIMITS, DESIGN_MAX_TEXT } from "./limits.ts";
import { parsePathData, scanNumberEnd, type Matrix2D } from "./path.ts";
import type { PathCmd, VPaint, VShape } from "./types.ts";
import { clamp, cleanText } from "./util.ts";

export interface SvgNode { tag: string; attrs: Map<string, string>; children: SvgNode[]; text?: string }

export interface SvgImportResult { shapes: VShape[]; warnings: string[] }

/** Elements nested deeper than this are dropped. */
export const SVG_IMPORT_MAX_DEPTH = 64;
/** Total elements visited; protects against very wide trees. */
export const SVG_IMPORT_MAX_NODES = 200_000;
const MAX_WARNINGS = 50;
/** Attribute values longer than this are ignored (numbers, colors, enums). */
const MAX_SCALAR_ATTR = 256;
/** Transform lists and point lists may be long but not unbounded. */
const MAX_LIST_ATTR = 1 << 20;

const IDENTITY: Matrix2D = [1, 0, 0, 1, 0, 0];

type LineCap = NonNullable<VPaint["lineCap"]>;
type LineJoin = NonNullable<VPaint["lineJoin"]>;

/** Inherited presentation state while walking the tree. */
interface Ctx {
  m: Matrix2D;
  fill: RGBA | null;
  stroke: RGBA | null;
  strokeWidth: number;
  opacity: number;
  fillOpacity: number;
  strokeOpacity: number;
  lineCap?: LineCap;
  lineJoin?: LineJoin;
}

interface Frame { node: unknown; depth: number; ctx: Ctx }

class Warnings {
  readonly list: string[] = [];
  private readonly seen = new Set<string>();
  add(msg: string): void {
    if (this.list.length >= MAX_WARNINGS || this.seen.has(msg)) return;
    this.seen.add(msg);
    this.list.push(msg);
  }
}

// ------------------------------------------------------------------------------------------------
// Scalars

const isWsp = (c: number): boolean => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0c;

function isSvgNode(v: unknown): v is SvgNode {
  if (v === null || typeof v !== "object") return false;
  if (!("tag" in v) || typeof v.tag !== "string") return false;
  if (!("attrs" in v) || !(v.attrs instanceof Map)) return false;
  return "children" in v && Array.isArray(v.children);
}

function attr(node: SvgNode, name: string): string | undefined {
  const v = node.attrs.get(name);
  return typeof v === "string" ? v : undefined;
}

/** A single number with optional "px" (or "%" when allowed, returned divided by 100). NaN otherwise. */
function parseScalar(s: string | undefined, allowPercent = false): number {
  if (s === undefined || s.length > MAX_SCALAR_ATTR) return NaN;
  let i = 0, n = s.length;
  while (i < n && isWsp(s.charCodeAt(i))) i++;
  while (n > i && isWsp(s.charCodeAt(n - 1))) n--;
  if (i >= n) return NaN;
  const end = scanNumberEnd(s, i);
  if (end < 0) return NaN;
  let v = Number(s.slice(i, end));
  if (end === n - 2 && s.charCodeAt(end) === 112 && s.charCodeAt(end + 1) === 120) { /* px */ }
  else if (allowPercent && end === n - 1 && s.charCodeAt(end) === 37) v /= 100;
  else if (end !== n) return NaN;
  return Number.isFinite(v) ? v : NaN;
}

/** Geometry attribute: finite number or the fallback. */
function num(node: SvgNode, name: string, fallback = 0): number {
  const v = parseScalar(attr(node, name));
  return Number.isNaN(v) ? fallback : v;
}

/** Whitespace/comma separated number list; null on any malformed or non-finite entry. */
function parseNumberList(s: string, maxCount: number): number[] | null {
  if (s.length > MAX_LIST_ATTR) return null;
  const out: number[] = [];
  const n = s.length;
  let i = 0;
  for (;;) {
    while (i < n && (isWsp(s.charCodeAt(i)) || s.charCodeAt(i) === 44)) i++;
    if (i >= n) return out;
    const end = scanNumberEnd(s, i);
    if (end < 0) return null;
    const v = Number(s.slice(i, end));
    if (!Number.isFinite(v)) return null;
    if (out.length >= maxCount) return null;
    out.push(v);
    i = end;
  }
}

// ------------------------------------------------------------------------------------------------
// Transforms

function mulMatrix(a: Matrix2D, b: Matrix2D): Matrix2D {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

const matrixFinite = (m: Matrix2D): boolean => m.every((v) => Number.isFinite(v));

/** Parse an SVG transform list (matrix, translate, scale, rotate, skewX, skewY), composed left to right.
 *  Returns null for any malformed, unknown, or non-finite entry. */
export function parseTransform(s: string): Matrix2D | null {
  if (s.length > MAX_LIST_ATTR) return null;
  const n = s.length;
  let i = 0;
  let m: Matrix2D = [...IDENTITY];
  const args: number[] = [];
  for (;;) {
    while (i < n && (isWsp(s.charCodeAt(i)) || s.charCodeAt(i) === 44)) i++;
    if (i >= n) break;
    const nameStart = i;
    while (i < n) {
      const c = s.charCodeAt(i) | 0x20;
      if (c < 97 || c > 122) break;
      i++;
    }
    const name = s.slice(nameStart, i);
    if (name.length === 0 || name.length > 9) return null;
    while (i < n && isWsp(s.charCodeAt(i))) i++;
    if (s.charCodeAt(i) !== 40) return null; // (
    i++;
    args.length = 0;
    for (;;) {
      while (i < n && isWsp(s.charCodeAt(i))) i++;
      if (i >= n) return null;
      if (s.charCodeAt(i) === 41) { i++; break; } // )
      if (args.length > 0 && s.charCodeAt(i) === 44) { i++; while (i < n && isWsp(s.charCodeAt(i))) i++; }
      const end = scanNumberEnd(s, i);
      if (end < 0) return null;
      const v = Number(s.slice(i, end));
      if (!Number.isFinite(v) || args.length >= 6) return null;
      args.push(v);
      i = end;
    }
    const k = args.length;
    const a0 = args[0] ?? 0, a1 = args[1] ?? 0, a2 = args[2] ?? 0;
    let t: Matrix2D;
    switch (name) {
      case "matrix":
        if (k !== 6) return null;
        t = [a0, a1, a2, args[3]!, args[4]!, args[5]!];
        break;
      case "translate":
        if (k !== 1 && k !== 2) return null;
        t = [1, 0, 0, 1, a0, k === 2 ? a1 : 0];
        break;
      case "scale":
        if (k !== 1 && k !== 2) return null;
        t = [a0, 0, 0, k === 2 ? a1 : a0, 0, 0];
        break;
      case "rotate": {
        if (k !== 1 && k !== 3) return null;
        const r = (a0 * Math.PI) / 180;
        const cos = Math.cos(r), sin = Math.sin(r);
        // rotate(a, cx, cy) = translate(cx, cy) rotate(a) translate(-cx, -cy)
        t = [cos, sin, -sin, cos, a1 - cos * a1 + sin * a2, a2 - sin * a1 - cos * a2];
        break;
      }
      case "skewX":
        if (k !== 1) return null;
        t = [1, 0, Math.tan((a0 * Math.PI) / 180), 1, 0, 0];
        break;
      case "skewY":
        if (k !== 1) return null;
        t = [1, Math.tan((a0 * Math.PI) / 180), 0, 1, 0, 0];
        break;
      default:
        return null;
    }
    m = mulMatrix(m, t);
    if (!matrixFinite(m)) return null;
  }
  return m;
}

// ------------------------------------------------------------------------------------------------
// Presentation attributes

function scalarAttr(node: SvgNode, name: string): string | undefined {
  const v = attr(node, name);
  return v === undefined || v.length > MAX_SCALAR_ATTR ? undefined : v.trim();
}

/** Resolve a paint attribute: undefined = keep inherited, null = none, RGBA = color, "bad" = unparsable. */
function paintAttr(node: SvgNode, name: string): RGBA | null | undefined | "bad" {
  const raw = attr(node, name);
  if (raw === undefined) return undefined;
  const v = raw.length > MAX_SCALAR_ATTR ? "" : raw.trim();
  if (v === "inherit") return undefined;
  if (v === "none") return null;
  return parseColor(v) ?? namedColor(v) ?? "bad";
}

/** Apply the node's own presentation attributes and transform on top of the inherited context. */
function applyPresentation(node: SvgNode, parent: Ctx, warn: Warnings): Ctx {
  const ctx: Ctx = { ...parent };
  const fill = paintAttr(node, "fill");
  if (fill === "bad") { warn.add("unsupported fill value, using #000000"); ctx.fill = [0, 0, 0, 255]; }
  else if (fill !== undefined) ctx.fill = fill;
  const stroke = paintAttr(node, "stroke");
  if (stroke === "bad") { warn.add("unsupported stroke value, stroke removed"); ctx.stroke = null; }
  else if (stroke !== undefined) ctx.stroke = stroke;

  const sw = parseScalar(scalarAttr(node, "stroke-width"));
  if (!Number.isNaN(sw) && sw >= 0) ctx.strokeWidth = sw;
  const op = parseScalar(scalarAttr(node, "opacity"), true);
  if (!Number.isNaN(op)) ctx.opacity = parent.opacity * clamp(op, 0, 1);
  const fo = parseScalar(scalarAttr(node, "fill-opacity"), true);
  if (!Number.isNaN(fo)) ctx.fillOpacity = clamp(fo, 0, 1);
  const so = parseScalar(scalarAttr(node, "stroke-opacity"), true);
  if (!Number.isNaN(so)) ctx.strokeOpacity = clamp(so, 0, 1);

  const cap = scalarAttr(node, "stroke-linecap");
  if (cap === "butt" || cap === "round" || cap === "square") ctx.lineCap = cap;
  const join = scalarAttr(node, "stroke-linejoin");
  if (join === "miter" || join === "round" || join === "bevel") ctx.lineJoin = join;

  const tr = attr(node, "transform");
  if (tr !== undefined) {
    const t = parseTransform(tr);
    const m = t ? mulMatrix(parent.m, t) : null;
    if (m && matrixFinite(m)) ctx.m = m;
    else warn.add("invalid transform ignored");
  }
  return ctx;
}

function paintOf(ctx: Ctx): VPaint {
  const p: VPaint = {
    fill: ctx.fill ? toHex([ctx.fill[0], ctx.fill[1], ctx.fill[2], ctx.fill[3] * ctx.fillOpacity]) : null,
    stroke: ctx.stroke ? toHex([ctx.stroke[0], ctx.stroke[1], ctx.stroke[2], ctx.stroke[3] * ctx.strokeOpacity]) : null,
    strokeWidth: ctx.strokeWidth,
    opacity: clamp(ctx.opacity, 0, 1),
  };
  if (ctx.lineCap) p.lineCap = ctx.lineCap;
  if (ctx.lineJoin) p.lineJoin = ctx.lineJoin;
  return p;
}

// ------------------------------------------------------------------------------------------------
// Text

/** Collapse whitespace like xml:space="default": tabs/newlines -> space, runs collapsed, trimmed. */
function collapseWs(s: string): string {
  let out = "";
  let pendingSpace = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (isWsp(c)) { pendingSpace = out.length > 0; continue; }
    if (pendingSpace) { out += " "; pendingSpace = false; }
    out += s[i]!;
  }
  return out;
}

/** Concatenated text of the node and its descendants (iterative, depth and size bounded). */
function collectText(root: SvgNode, depthLeft: number): string {
  const rawCap = DESIGN_MAX_TEXT * 4;
  let raw = "";
  const stack: { node: unknown; depth: number }[] = [{ node: root, depth: 0 }];
  let visited = 0;
  while (stack.length > 0 && raw.length < rawCap && visited < SVG_IMPORT_MAX_NODES) {
    const { node, depth } = stack.pop()!;
    visited++;
    if (!isSvgNode(node)) continue;
    if (typeof node.text === "string") raw += node.text.slice(0, rawCap - raw.length);
    if (depth >= depthLeft) continue;
    for (let k = node.children.length - 1; k >= 0; k--) stack.push({ node: node.children[k], depth: depth + 1 });
  }
  return cleanText(collapseWs(raw), DESIGN_MAX_TEXT);
}

function fontFamily(raw: string | undefined): "sans-serif" | "serif" | "monospace" {
  if (raw === undefined) return "sans-serif";
  const f = raw.slice(0, MAX_SCALAR_ATTR).toLowerCase();
  if (f.includes("mono") || f.includes("courier") || f.includes("consolas")) return "monospace";
  if (f.includes("sans")) return "sans-serif";
  if (f.includes("serif") || f.includes("times") || f.includes("georgia")) return "serif";
  return "sans-serif";
}

/** First number of an x/y attribute (which may be a list on <text>). */
function firstNumber(node: SvgNode, name: string): number {
  const v = attr(node, name);
  if (v === undefined) return 0;
  const list = parseNumberList(v.slice(0, MAX_SCALAR_ATTR), 64);
  return list && list.length > 0 ? list[0]! : 0;
}

// ------------------------------------------------------------------------------------------------
// Geometry

const finiteRect = (x: number, y: number, w: number, h: number): boolean =>
  Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(w) && Number.isFinite(h);

function pointsToPath(node: SvgNode, close: boolean, warn: Warnings): PathCmd[] | null {
  const raw = attr(node, "points");
  if (raw === undefined) return null;
  const list = parseNumberList(raw, DESIGN_LIMITS.maxPathCmds * 2);
  if (!list) { warn.add("invalid points attribute"); return null; }
  const pairs = list.length >> 1;
  if (pairs < 2) return null;
  const d: PathCmd[] = [{ c: "M", x: list[0]!, y: list[1]! }];
  for (let k = 1; k < pairs; k++) d.push({ c: "L", x: list[2 * k]!, y: list[2 * k + 1]! });
  if (close) d.push({ c: "Z" });
  return d;
}

/** Build the shape for a geometry element, or null when it has nothing to draw. */
function buildShape(tag: string, node: SvgNode, ctx: Ctx, warn: Warnings, depth: number): Omit<VShape, "id"> | null {
  const paint = paintOf(ctx);
  switch (tag) {
    case "path": {
      const d = attr(node, "d");
      if (d === undefined) return null;
      const r = parsePathData(d);
      if (!r.ok) { warn.add("invalid path data dropped"); return null; }
      return r.cmds.length > 0 ? { kind: "path", d: r.cmds, paint } : null;
    }
    case "rect": {
      const x = num(node, "x"), y = num(node, "y"), w = num(node, "width"), h = num(node, "height");
      if (!(w > 0 && h > 0) || !finiteRect(x, y, w, h)) return null;
      let rx = parseScalar(attr(node, "rx"));
      if (Number.isNaN(rx)) rx = parseScalar(attr(node, "ry"));
      const shape: Omit<VShape, "id"> = { kind: "rect", rect: { x, y, w, h }, paint };
      if (rx > 0) shape.rx = Math.min(rx, w / 2, h / 2);
      return shape;
    }
    case "circle": {
      const cx = num(node, "cx"), cy = num(node, "cy"), r = num(node, "r");
      if (!(r > 0) || !finiteRect(cx - r, cy - r, 2 * r, 2 * r)) return null;
      return { kind: "ellipse", rect: { x: cx - r, y: cy - r, w: 2 * r, h: 2 * r }, paint };
    }
    case "ellipse": {
      const cx = num(node, "cx"), cy = num(node, "cy");
      let rx = parseScalar(attr(node, "rx"));
      let ry = parseScalar(attr(node, "ry"));
      if (Number.isNaN(rx)) rx = ry; // "auto" behaviour: one radius given
      if (Number.isNaN(ry)) ry = rx;
      if (!(rx > 0 && ry > 0) || !finiteRect(cx - rx, cy - ry, 2 * rx, 2 * ry)) return null;
      return { kind: "ellipse", rect: { x: cx - rx, y: cy - ry, w: 2 * rx, h: 2 * ry }, paint };
    }
    case "line": {
      const d: PathCmd[] = [
        { c: "M", x: num(node, "x1"), y: num(node, "y1") },
        { c: "L", x: num(node, "x2"), y: num(node, "y2") },
      ];
      return { kind: "path", d, paint: { ...paint, fill: null } }; // a line has no fill area
    }
    case "polyline":
    case "polygon": {
      const d = pointsToPath(node, tag === "polygon", warn);
      return d ? { kind: "path", d, paint } : null;
    }
    case "text": {
      const content = collectText(node, SVG_IMPORT_MAX_DEPTH - depth);
      if (content.length === 0) return null;
      const x = firstNumber(node, "x"), y = firstNumber(node, "y");
      const fs = parseScalar(scalarAttr(node, "font-size"));
      const size = fs > 0 && fs <= 100_000 ? fs : 16;
      return {
        kind: "text",
        rect: { x, y, w: 0, h: 0 },
        text: { content, size, family: fontFamily(attr(node, "font-family")) },
        paint,
      };
    }
    default:
      return null;
  }
}

const GEOMETRY_TAGS = new Set(["path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text"]);

// ------------------------------------------------------------------------------------------------
// svgNodesToShapes

/**
 * Convert an SvgNode tree into VShapes (document order, ids "s0", "s1", ...). Paint and transforms are
 * inherited from ancestor svg/g elements. Unsupported elements are dropped with one warning per tag.
 */
export function svgNodesToShapes(root: SvgNode): SvgImportResult {
  const warn = new Warnings();
  const shapes: VShape[] = [];
  let totalCmds = 0;
  let visited = 0;
  const rootCtx: Ctx = {
    m: [...IDENTITY],
    fill: [0, 0, 0, 255],
    stroke: null,
    strokeWidth: 1,
    opacity: 1,
    fillOpacity: 1,
    strokeOpacity: 1,
  };
  const stack: Frame[] = [{ node: root, depth: 0, ctx: rootCtx }];

  while (stack.length > 0) {
    const { node, depth, ctx } = stack.pop()!;
    if (++visited > SVG_IMPORT_MAX_NODES) { warn.add("element limit reached, rest dropped"); break; }
    if (!isSvgNode(node)) { warn.add("invalid node dropped"); continue; }
    if (depth > SVG_IMPORT_MAX_DEPTH) { warn.add(`nesting deeper than ${SVG_IMPORT_MAX_DEPTH} dropped`); continue; }
    const tag = node.tag.length > 64 ? "" : node.tag.toLowerCase();
    if (tag.startsWith("#")) continue; // DOM text/comment nodes carried as children

    if (tag === "svg" || tag === "g") {
      const next = applyPresentation(node, ctx, warn);
      for (let k = node.children.length - 1; k >= 0; k--) stack.push({ node: node.children[k], depth: depth + 1, ctx: next });
      continue;
    }
    if (!GEOMETRY_TAGS.has(tag)) {
      warn.add(`unsupported element <${cleanText(tag, 32) || "?"}> dropped`);
      continue;
    }
    if (shapes.length >= DESIGN_LIMITS.maxShapes) { warn.add("shape limit reached, rest dropped"); break; }
    const own = applyPresentation(node, ctx, warn);
    const shape = buildShape(tag, node, own, warn, depth);
    if (!shape) continue;
    const cmdCount = shape.d ? shape.d.length : 0;
    if (totalCmds + cmdCount > DESIGN_LIMITS.maxPathCmds) { warn.add("path command limit reached, shape dropped"); continue; }
    totalCmds += cmdCount;
    const out: VShape = { id: `s${shapes.length}`, ...shape };
    if (!own.m.every((v, k) => v === IDENTITY[k])) out.transform = [...own.m];
    shapes.push(out);
  }
  return { shapes, warnings: warn.list };
}
