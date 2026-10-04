// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/design_logic.ts - the Design pane's pure logic (no DOM): brush size mapping, viewport
// math, the magic wand flood fill, the byte-capped undo history, the pen tool's path builder, node editing,
// immutable document edits (layers, shapes, crop, resize, timeline keys) and filename hygiene.
//
// Everything here runs in Bun tests and in the renderer main thread or the design worker. The engine
// (harness/creator/design/) owns the document model; this module only reshapes it immutably, and every
// file-keyed record it builds is null-prototype (Object.create(null)), like the engine's own.

import type {
  AnimProp, DesignDoc, Ease, Keyframe, Layer, MaskData, MaskHint, MaskRecord, PathCmd, RasterData, Rect, Timeline, VShape,
} from "../../harness/creator/design/types.ts";
import { DESIGN_LIMITS } from "../../harness/creator/design/limits.ts";
import { layerMatrix, layerStateAt } from "../../harness/creator/design/anim.ts";

// ── brush size: a log slider 1..2000 px ─────────────────────────────────────

export const BRUSH_MIN = 1;
export const BRUSH_MAX = 2000;
export const BRUSH_SLIDER_STEPS = 1000;

/** Slider position 0..1000 to a brush radius in doc px, log-scaled so 1..20 px gets as much travel as 200..2000. */
export function sliderToBrush(v: number): number {
  const t = Math.min(1, Math.max(0, v / BRUSH_SLIDER_STEPS));
  return Math.min(BRUSH_MAX, Math.max(BRUSH_MIN, Math.round(Math.exp(t * Math.log(BRUSH_MAX)))));
}

export function brushToSlider(size: number): number {
  const s = Math.min(BRUSH_MAX, Math.max(BRUSH_MIN, size));
  return Math.round((Math.log(s) / Math.log(BRUSH_MAX)) * BRUSH_SLIDER_STEPS);
}

/** `[` / `]` and Shift+wheel: a 12% multiplicative step, never less than 1 px, clamped to 1..2000. */
export function stepBrush(size: number, dir: 1 | -1): number {
  const next = dir > 0 ? Math.max(size + 1, Math.round(size * 1.12)) : Math.min(size - 1, Math.round(size / 1.12));
  return Math.min(BRUSH_MAX, Math.max(BRUSH_MIN, next));
}

// ── viewport: screen = doc * zoom + pan ─────────────────────────────────────

export const ZOOM_MIN = 0.01;
export const ZOOM_MAX = 64;
export interface View { zoom: number; panX: number; panY: number }

export const clampZoom = (z: number): number => (Number.isFinite(z) ? Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)) : 1);

export function screenToDoc(v: View, sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - v.panX) / v.zoom, y: (sy - v.panY) / v.zoom };
}

export function docToScreen(v: View, x: number, y: number): { x: number; y: number } {
  return { x: x * v.zoom + v.panX, y: y * v.zoom + v.panY };
}

/** Zoom to `zoom` keeping the doc point under screen (sx, sy) fixed. */
export function zoomAbout(v: View, zoom: number, sx: number, sy: number): View {
  const z = clampZoom(zoom);
  const p = screenToDoc(v, sx, sy);
  return { zoom: z, panX: sx - p.x * z, panY: sy - p.y * z };
}

/** Fit a doc into a viewport with a margin, centered. */
export function fitView(docW: number, docH: number, viewW: number, viewH: number, margin = 24): View {
  const z = clampZoom(Math.min((viewW - margin * 2) / Math.max(1, docW), (viewH - margin * 2) / Math.max(1, docH)));
  return { zoom: z, panX: (viewW - docW * z) / 2, panY: (viewH - docH * z) / 2 };
}

/** Tile index range [tx0..tx1] x [ty0..ty1] of a layer-space rect, clipped to the layer. */
export function tileRange(rect: Rect, layerW: number, layerH: number, tile: number): { tx0: number; ty0: number; tx1: number; ty1: number } | null {
  const x0 = Math.max(0, Math.floor(rect.x)), y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(layerW, Math.ceil(rect.x + rect.w)), y1 = Math.min(layerH, Math.ceil(rect.y + rect.h));
  if (x1 <= x0 || y1 <= y0) return null;
  return { tx0: Math.floor(x0 / tile), ty0: Math.floor(y0 / tile), tx1: Math.floor((x1 - 1) / tile), ty1: Math.floor((y1 - 1) / tile) };
}

/** Device-pixel destination of the key-space rect [x0, x1) x [y0, y1) under an axis-aligned matrix
 *  (scale a, d; offset e, f). Edges are rounded, so two rects that share a key-space edge share the exact
 *  device edge: no gap and no overlap between neighbouring tiles at any fractional zoom. */
export function snappedRect(m: readonly number[], x0: number, y0: number, x1: number, y1: number): { x: number; y: number; w: number; h: number } {
  const X0 = Math.round(m[0]! * x0 + m[4]!), X1 = Math.round(m[0]! * x1 + m[4]!);
  const Y0 = Math.round(m[3]! * y0 + m[5]!), Y1 = Math.round(m[3]! * y1 + m[5]!);
  return { x: X0, y: Y0, w: X1 - X0, h: Y1 - Y0 };
}

// ── magic wand: scanline flood fill ─────────────────────────────────────────

/** Select pixels within `tolerance` (0..255, max channel difference incl. alpha) of the seed. Contiguous
 *  mode is an iterative scanline fill (no recursion, bounded stack of runs); otherwise a global color pick.
 *  Two fully transparent pixels always match. */
export function floodFillMask(src: RasterData, sx: number, sy: number, tolerance: number, contiguous = true): MaskData {
  const { width: w, height: h, rgba } = src;
  const out = new Uint8Array(w * h);
  const x0 = Math.floor(sx), y0 = Math.floor(sy);
  if (x0 < 0 || y0 < 0 || x0 >= w || y0 >= h) return { width: w, height: h, alpha: out };
  const s = (y0 * w + x0) * 4;
  const r0 = rgba[s]!, g0 = rgba[s + 1]!, b0 = rgba[s + 2]!, a0 = rgba[s + 3]!;
  const tol = Math.min(255, Math.max(0, Math.round(tolerance)));
  const match = (p: number): boolean => {
    const i = p * 4;
    const a = rgba[i + 3]!;
    if (a === 0 && a0 === 0) return true;
    return Math.abs(rgba[i]! - r0) <= tol && Math.abs(rgba[i + 1]! - g0) <= tol && Math.abs(rgba[i + 2]! - b0) <= tol && Math.abs(a - a0) <= tol;
  };
  if (!contiguous) {
    for (let p = 0; p < w * h; p++) if (match(p)) out[p] = 255;
    return { width: w, height: h, alpha: out };
  }
  const stack: number[] = [x0, y0];
  while (stack.length) {
    const y = stack.pop()!;
    const x = stack.pop()!;
    const row = y * w;
    if (out[row + x] || !match(row + x)) continue;
    let l = x;
    while (l > 0 && !out[row + l - 1] && match(row + l - 1)) l--;
    let r = x;
    while (r < w - 1 && !out[row + r + 1] && match(row + r + 1)) r++;
    for (let i = l; i <= r; i++) out[row + i] = 255;
    for (const ny of [y - 1, y + 1]) {
      if (ny < 0 || ny >= h) continue;
      const nrow = ny * w;
      let i = l;
      while (i <= r) {
        if (!out[nrow + i] && match(nrow + i)) {
          stack.push(i, ny);
          while (i <= r && !out[nrow + i] && match(nrow + i)) i++;
        } else i++;
      }
    }
  }
  return { width: w, height: h, alpha: out };
}

// ── undo / redo with a byte cap ─────────────────────────────────────────────

/** One tile's pixels before and after an edit; null = the tile did not exist. */
export interface TilePatch { key: string; tx: number; ty: number; before: Uint8ClampedArray | null; after: Uint8ClampedArray | null }
export interface HistoryEntry<D> { label: string; before: D; after: D; patches: TilePatch[]; bytes: number }

export const DEFAULT_HISTORY_BYTES = 512 * 1024 * 1024;

const patchBytes = (p: TilePatch): number => (p.before?.byteLength ?? 0) + (p.after?.byteLength ?? 0) + 64;

/** A linear undo stack whose pixel patches are counted in bytes. Pushing past the cap drops the OLDEST
 *  steps; a single step larger than the whole cap is not kept at all, and the history is cleared, because
 *  undoing across a state that was never recorded would restore the wrong pixels. */
export class History<D> {
  private undoStack: HistoryEntry<D>[] = [];
  private redoStack: HistoryEntry<D>[] = [];
  private total = 0;
  constructor(readonly capBytes: number = DEFAULT_HISTORY_BYTES, private readonly docBytes = 4096) {}

  push(e: { label: string; before: D; after: D; patches?: TilePatch[] }): { dropped: number; oversize: boolean } {
    const patches = e.patches ?? [];
    const bytes = this.docBytes + patches.reduce((n, p) => n + patchBytes(p), 0);
    for (const r of this.redoStack) this.total -= r.bytes;
    this.redoStack = [];
    if (bytes > this.capBytes) {
      this.clear();
      return { dropped: 0, oversize: true };
    }
    this.undoStack.push({ label: e.label, before: e.before, after: e.after, patches, bytes });
    this.total += bytes;
    let dropped = 0;
    while (this.total > this.capBytes && this.undoStack.length > 1) {
      this.total -= this.undoStack.shift()!.bytes;
      dropped++;
    }
    return { dropped, oversize: false };
  }

  undo(): HistoryEntry<D> | null {
    const e = this.undoStack.pop();
    if (!e) return null;
    this.redoStack.push(e);
    return e;
  }

  redo(): HistoryEntry<D> | null {
    const e = this.redoStack.pop();
    if (!e) return null;
    this.undoStack.push(e);
    return e;
  }

  clear(): void { this.undoStack = []; this.redoStack = []; this.total = 0; }
  canUndo(): boolean { return this.undoStack.length > 0; }
  canRedo(): boolean { return this.redoStack.length > 0; }
  bytes(): number { return this.total; }
  peekUndo(): string { return this.undoStack[this.undoStack.length - 1]?.label ?? ""; }
  peekRedo(): string { return this.redoStack[this.redoStack.length - 1]?.label ?? ""; }
}

// ── debounce (injectable clock for tests) ───────────────────────────────────

export interface TimerApi { set(fn: () => void, ms: number): unknown; clear(h: unknown): void }
const realTimers: TimerApi = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** Trailing-edge debounce: `fire()` restarts the wait; `flush()` runs a pending call now. */
export function debounce(fn: () => void, ms: number, timers: TimerApi = realTimers): { fire(): void; flush(): void; cancel(): void } {
  let h: unknown = null;
  const run = () => { h = null; fn(); };
  return {
    fire() { if (h !== null) timers.clear(h); h = timers.set(run, ms); },
    flush() { if (h !== null) { timers.clear(h); run(); } },
    cancel() { if (h !== null) { timers.clear(h); h = null; } },
  };
}

// ── pen tool and node editing ───────────────────────────────────────────────

export interface Pt { x: number; y: number }
/** A pen anchor with optional absolute handle positions. A dragged anchor gets mirrored handles. */
export interface PenAnchor { x: number; y: number; hin?: Pt; hout?: Pt }

/** Anchors to path commands: a segment is a cubic when either end carries a handle, else a line. */
export function penToPath(anchors: readonly PenAnchor[], closed: boolean): PathCmd[] {
  if (!anchors.length) return [];
  const first = anchors[0]!;
  const out: PathCmd[] = [{ c: "M", x: first.x, y: first.y }];
  const seg = (a: PenAnchor, b: PenAnchor) => {
    if (a.hout || b.hin) {
      const c1 = a.hout ?? a, c2 = b.hin ?? b;
      out.push({ c: "C", x1: c1.x, y1: c1.y, x2: c2.x, y2: c2.y, x: b.x, y: b.y });
    } else out.push({ c: "L", x: b.x, y: b.y });
  };
  for (let i = 1; i < anchors.length; i++) seg(anchors[i - 1]!, anchors[i]!);
  if (closed && anchors.length > 2) {
    seg(anchors[anchors.length - 1]!, first);
    out.push({ c: "Z" });
  }
  return out;
}

/** A smooth anchor from a press at `a` dragged to `drag`: out handle at the drag, in handle mirrored. */
export function smoothAnchor(a: Pt, drag: Pt): PenAnchor {
  return { x: a.x, y: a.y, hout: { x: drag.x, y: drag.y }, hin: { x: 2 * a.x - drag.x, y: 2 * a.y - drag.y } };
}

export type NodePart = "p" | "c1" | "c2";
export interface NodeRef { cmd: number; part: NodePart }
export interface PathNode { ref: NodeRef; x: number; y: number; kind: "anchor" | "handle" }

/** Every editable point of a path: anchors (command end points) and control handles. */
export function pathNodes(cmds: readonly PathCmd[]): PathNode[] {
  const out: PathNode[] = [];
  cmds.forEach((c, i) => {
    if (c.c === "Z") return;
    if (c.c === "C") {
      out.push({ ref: { cmd: i, part: "c1" }, x: c.x1, y: c.y1, kind: "handle" });
      out.push({ ref: { cmd: i, part: "c2" }, x: c.x2, y: c.y2, kind: "handle" });
    } else if (c.c === "Q") out.push({ ref: { cmd: i, part: "c1" }, x: c.x1, y: c.y1, kind: "handle" });
    out.push({ ref: { cmd: i, part: "p" }, x: c.x, y: c.y, kind: "anchor" });
  });
  return out;
}

/** The nearest node within `radius` (anchors win ties over handles). */
export function hitNode(nodes: readonly PathNode[], x: number, y: number, radius: number): NodeRef | null {
  let best: PathNode | null = null;
  let bestD = radius * radius;
  for (const n of nodes) {
    const d = (n.x - x) ** 2 + (n.y - y) ** 2;
    if (d < bestD || (d === bestD && best?.kind === "handle" && n.kind === "anchor")) { best = n; bestD = d; }
  }
  return best ? best.ref : null;
}

function translateCmd(c: PathCmd, dx: number, dy: number): PathCmd {
  switch (c.c) {
    case "M": case "L": return { ...c, x: c.x + dx, y: c.y + dy };
    case "C": return { ...c, x1: c.x1 + dx, y1: c.y1 + dy, x2: c.x2 + dx, y2: c.y2 + dy, x: c.x + dx, y: c.y + dy };
    case "Q": return { ...c, x1: c.x1 + dx, y1: c.y1 + dy, x: c.x + dx, y: c.y + dy };
    default: return c;
  }
}

export function translateCmds(cmds: readonly PathCmd[], dx: number, dy: number): PathCmd[] {
  return cmds.map((c) => translateCmd(c, dx, dy));
}

/** Move one node. Moving an anchor carries its two neighbouring handles (the in handle of its own cubic,
 *  the out handle of the next cubic). Moving the start anchor of a closed subpath also moves the closing
 *  segment's end point, so the shape stays closed. */
export function moveNode(cmds: readonly PathCmd[], ref: NodeRef, x: number, y: number): PathCmd[] {
  const out = cmds.slice();
  const c = out[ref.cmd];
  if (!c || c.c === "Z") return out;
  if (ref.part === "c1" && (c.c === "C" || c.c === "Q")) { out[ref.cmd] = { ...c, x1: x, y1: y }; return out; }
  if (ref.part === "c2" && c.c === "C") { out[ref.cmd] = { ...c, x2: x, y2: y }; return out; }
  if (ref.part !== "p") return out;
  const dx = x - c.x, dy = y - c.y;
  out[ref.cmd] = c.c === "C" ? { ...c, x, y, x2: c.x2 + dx, y2: c.y2 + dy } : { ...c, x, y };
  const next = out[ref.cmd + 1];
  if (next && next.c === "C") out[ref.cmd + 1] = { ...next, x1: next.x1 + dx, y1: next.y1 + dy };
  if (c.c === "M") {
    // Find this subpath's end: the command before the next M, and whether it closes with Z.
    let end = ref.cmd + 1;
    while (end < out.length && out[end]!.c !== "M") end++;
    const last = out[end - 1];
    const before = out[end - 2];
    if (last?.c === "Z" && before && before.c !== "Z" && before.c !== "M" && Math.abs(before.x - c.x) < 1e-6 && Math.abs(before.y - c.y) < 1e-6) {
      out[end - 2] = before.c === "C" ? { ...before, x, y, x2: before.x2 + dx, y2: before.y2 + dy } : { ...before, x, y };
    }
  }
  return out;
}

export type Corner = "nw" | "ne" | "sw" | "se";
/** Drag one corner of a rect; the opposite corner stays fixed and the result is normalized (w, h >= 1). */
export function moveRectCorner(r: Rect, corner: Corner, x: number, y: number): Rect {
  const fx = corner === "nw" || corner === "sw" ? r.x + r.w : r.x;
  const fy = corner === "nw" || corner === "ne" ? r.y + r.h : r.y;
  return normRect(fx, fy, x, y);
}

export function normRect(x0: number, y0: number, x1: number, y1: number): Rect {
  const x = Math.min(x0, x1), y = Math.min(y0, y1);
  return { x, y, w: Math.max(1, Math.abs(x1 - x0)), h: Math.max(1, Math.abs(y1 - y0)) };
}

export function rectCorners(r: Rect): { corner: Corner; x: number; y: number }[] {
  return [
    { corner: "nw", x: r.x, y: r.y }, { corner: "ne", x: r.x + r.w, y: r.y },
    { corner: "sw", x: r.x, y: r.y + r.h }, { corner: "se", x: r.x + r.w, y: r.y + r.h },
  ];
}

export function translateShape(s: VShape, dx: number, dy: number): VShape {
  const out: VShape = { ...s };
  if (s.d) out.d = translateCmds(s.d, dx, dy);
  if (s.rect) out.rect = { ...s.rect, x: s.rect.x + dx, y: s.rect.y + dy };
  return out;
}

function scaleCmd(c: PathCmd, sx: number, sy: number): PathCmd {
  switch (c.c) {
    case "M": case "L": return { ...c, x: c.x * sx, y: c.y * sy };
    case "C": return { ...c, x1: c.x1 * sx, y1: c.y1 * sy, x2: c.x2 * sx, y2: c.y2 * sy, x: c.x * sx, y: c.y * sy };
    case "Q": return { ...c, x1: c.x1 * sx, y1: c.y1 * sy, x: c.x * sx, y: c.y * sy };
    default: return c;
  }
}

export function scaleShape(s: VShape, sx: number, sy: number): VShape {
  const out: VShape = { ...s, paint: { ...s.paint, strokeWidth: s.paint.strokeWidth * Math.sqrt(Math.abs(sx * sy)) } };
  if (s.d) out.d = s.d.map((c) => scaleCmd(c, sx, sy));
  if (s.rect) out.rect = { x: s.rect.x * sx, y: s.rect.y * sy, w: s.rect.w * sx, h: s.rect.h * sy };
  if (s.rx !== undefined) out.rx = s.rx * Math.min(sx, sy);
  if (s.text) out.text = { ...s.text, size: Math.max(1, s.text.size * sy) };
  if (s.transform) out.transform = [s.transform[0], s.transform[1], s.transform[2], s.transform[3], s.transform[4] * sx, s.transform[5] * sy];
  return out;
}

// ── immutable document edits ────────────────────────────────────────────────

export function copyRecord<T>(r: Record<string, T>): Record<string, T> {
  const out = Object.create(null) as Record<string, T>;
  for (const k of Object.keys(r)) out[k] = r[k]!;
  return out;
}

/** A shallow structural copy whose containers can be mutated without touching `doc`. */
export function cloneDoc(doc: DesignDoc): DesignDoc {
  return {
    ...doc,
    layers: copyRecord(doc.layers),
    order: doc.order.slice(),
    masks: copyRecord(doc.masks),
    hints: doc.hints.slice(),
    timeline: { ...doc.timeline, tracks: doc.timeline.tracks.map((t) => ({ ...t, keys: t.keys.slice() })) },
  };
}

/** Insert a top-level layer directly above `aboveId` (or at the top). Caps at maxLayers. */
export function addLayer(doc: DesignDoc, layer: Layer, aboveId?: string): { doc: DesignDoc } | { error: string } {
  if (Object.keys(doc.layers).length >= DESIGN_LIMITS.maxLayers) return { error: `A document holds at most ${DESIGN_LIMITS.maxLayers} layers.` };
  const d = cloneDoc(doc);
  d.layers[layer.id] = layer;
  const at = aboveId ? d.order.indexOf(aboveId) : -1;
  if (at >= 0) d.order.splice(at + 1, 0, layer.id);
  else d.order.push(layer.id);
  return { doc: d };
}

export function replaceLayer(doc: DesignDoc, layer: Layer): DesignDoc {
  const d = cloneDoc(doc);
  d.layers[layer.id] = layer;
  return d;
}

export function addMask(doc: DesignDoc, mask: MaskRecord): DesignDoc {
  const d = cloneDoc(doc);
  d.masks[mask.id] = mask;
  return d;
}

export function addHint(doc: DesignDoc, hint: MaskHint): { doc: DesignDoc } | { error: string } {
  if (doc.hints.length >= DESIGN_LIMITS.maxHints) return { error: `A document holds at most ${DESIGN_LIMITS.maxHints} hints.` };
  const d = cloneDoc(doc);
  d.hints.push(hint);
  return { doc: d };
}

export function removeHint(doc: DesignDoc, id: string): DesignDoc {
  const d = cloneDoc(doc);
  d.hints = d.hints.filter((h) => h.id !== id);
  return d;
}

/** One paintable (non-group) layer in paint order. `groups` is its ancestor chain, outermost first: a
 *  group's transform and opacity apply to its children (SVG nesting semantics). `parentOpacity` is the
 *  product of the groups' static opacity, for callers that do not animate. */
export interface PaintItem { id: string; groups: string[]; parentOpacity: number; visible: boolean }

/** Ids in paint order (bottom -> top), groups expanded depth-first, each with its effective visibility and
 *  its group chain (groups themselves paint nothing). */
export function paintList(doc: DesignDoc): PaintItem[] {
  const out: PaintItem[] = [];
  const seen = new Set<string>();
  const walk = (ids: readonly string[], groups: string[], parentOpacity: number, visible: boolean) => {
    if (groups.length > 32) return;
    for (const id of ids) {
      const l = doc.layers[id];
      if (!l || seen.has(id)) continue;
      seen.add(id);
      const vis = visible && l.visible;
      if (l.kind === "group") walk(l.children, [...groups, id], parentOpacity * l.opacity, vis);
      else out.push({ id, groups, parentOpacity, visible: vis });
    }
  };
  walk(doc.order, [], 1, true);
  return out;
}

export type Mat = [number, number, number, number, number, number];
export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

/** a then b, in canvas order: transform(a); transform(b) == transform(mulMat(a, b)). */
export function mulMat(a: Mat, b: Mat): Mat {
  return [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

export function invertMat(m: Mat): Mat | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!det || !Number.isFinite(det)) return null;
  const a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

export const applyMat = (m: Mat, x: number, y: number): Pt => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });

/** A paintable layer's full layer-px -> doc-px matrix and opacity at time `t`, its groups included. */
export function layerWorld(doc: DesignDoc, item: Pick<PaintItem, "id" | "groups">, t: number): { m: Mat; opacity: number } {
  let m: Mat = IDENTITY;
  let opacity = 1;
  for (const g of [...item.groups, item.id]) {
    const l = doc.layers[g];
    if (!l) continue;
    const st = layerStateAt(doc, g, t);
    m = mulMat(m, layerMatrix(l, st));
    opacity *= st.opacity;
  }
  return { m, opacity };
}

/** When `m` is a whole-pixel translation, its offset (the compositor's direct path); else null. */
export function integerTranslation(m: Mat): { dx: number; dy: number } | null {
  return m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && Number.isInteger(m[4]) && Number.isInteger(m[5]) ? { dx: m[4], dy: m[5] } : null;
}

/** The layers panel rows, TOP -> bottom, with nesting depth. */
export function layerRows(doc: DesignDoc): { id: string; depth: number }[] {
  const out: { id: string; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (ids: readonly string[], depth: number) => {
    if (depth > 32) return;
    for (let i = ids.length - 1; i >= 0; i--) {
      const id = ids[i]!;
      const l = doc.layers[id];
      if (!l || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, depth });
      if (l.kind === "group") walk(l.children, depth + 1);
    }
  };
  walk(doc.order, 0);
  return out;
}

const shiftStrokes = (h: MaskHint, dx: number, dy: number): MaskHint => ({
  ...h,
  bbox: { ...h.bbox, x: h.bbox.x + dx, y: h.bbox.y + dy },
  strokes: h.strokes.map((s) => ({ ...s, points: s.points.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy })) })),
});

/** Non-destructive crop: the canvas becomes `rect`; every layer, mask, hint and x/y key shifts by -rect.
 *  Pixels outside the crop stay in their layers (moving a layer later can reveal them). */
export function cropDoc(doc: DesignDoc, rect: Rect): { doc: DesignDoc } | { error: string } {
  const x = Math.round(rect.x), y = Math.round(rect.y), w = Math.round(rect.w), h = Math.round(rect.h);
  if (w < 1 || h < 1) return { error: "Drag a crop rectangle first." };
  if (w > DESIGN_LIMITS.maxSide || h > DESIGN_LIMITS.maxSide) return { error: `A side is limited to ${DESIGN_LIMITS.maxSide} px.` };
  const d = cloneDoc(doc);
  d.width = w; d.height = h;
  for (const id of Object.keys(d.layers)) {
    const l = d.layers[id]!;
    if (l.kind !== "group") d.layers[id] = { ...l, x: l.x - x, y: l.y - y };
  }
  for (const id of Object.keys(d.masks)) {
    const m = d.masks[id]!;
    d.masks[id] = { ...m, x: m.x - x, y: m.y - y };
  }
  d.hints = d.hints.map((hh) => shiftStrokes(hh, -x, -y));
  d.timeline = {
    ...d.timeline,
    tracks: d.timeline.tracks.map((t) => (t.prop === "x" ? shiftKeys(t, -x) : t.prop === "y" ? shiftKeys(t, -y) : t)),
  };
  return { doc: d };
}

const shiftKeys = <T extends { keys: Keyframe[] }>(t: T, dv: number): T => ({ ...t, keys: t.keys.map((k) => ({ ...k, v: k.v + dv })) });
const scaleKeys = <T extends { keys: Keyframe[] }>(t: T, f: number): T => ({ ...t, keys: t.keys.map((k) => ({ ...k, v: k.v * f })) });

/** The structural half of a document resize: canvas, layer offsets, raster/mask dimensions, vector
 *  geometry, hints and x/y keys all scale by (sx, sy). The caller resamples the pixels to the new sizes. */
export function scaleDocStructure(doc: DesignDoc, width: number, height: number): DesignDoc {
  const sx = width / doc.width, sy = height / doc.height;
  const d = cloneDoc(doc);
  d.width = width; d.height = height;
  for (const id of Object.keys(d.layers)) {
    const l = d.layers[id]!;
    if (l.kind === "raster") {
      d.layers[id] = { ...l, x: l.x * sx, y: l.y * sy, anchorX: l.anchorX * sx, anchorY: l.anchorY * sy, width: Math.max(1, Math.round(l.width * sx)), height: Math.max(1, Math.round(l.height * sy)) };
    } else if (l.kind === "vector") {
      d.layers[id] = { ...l, x: l.x * sx, y: l.y * sy, anchorX: l.anchorX * sx, anchorY: l.anchorY * sy, shapes: l.shapes.map((s) => scaleShape(s, sx, sy)) };
    }
  }
  for (const id of Object.keys(d.masks)) {
    const m = d.masks[id]!;
    d.masks[id] = { ...m, x: m.x * sx, y: m.y * sy, width: Math.max(1, Math.round(m.width * sx)), height: Math.max(1, Math.round(m.height * sy)) };
  }
  d.hints = d.hints.map((h) => ({
    ...h,
    bbox: { x: h.bbox.x * sx, y: h.bbox.y * sy, w: h.bbox.w * sx, h: h.bbox.h * sy },
    area: Math.round(h.area * sx * sy),
    strokes: h.strokes.map((s) => ({ ...s, radius: s.radius * Math.sqrt(sx * sy), points: s.points.map((p) => ({ ...p, x: p.x * sx, y: p.y * sy })) })),
  }));
  d.timeline = { ...d.timeline, tracks: d.timeline.tracks.map((t) => (t.prop === "x" ? scaleKeys(t, sx) : t.prop === "y" ? scaleKeys(t, sy) : t)) };
  return d;
}

// ── timeline key edits (the add/upsert path is applyOps "keyframe") ─────────

function editTrack(doc: DesignDoc, layerId: string, prop: AnimProp, fn: (keys: Keyframe[]) => Keyframe[]): DesignDoc {
  const d = cloneDoc(doc);
  d.timeline = {
    ...d.timeline,
    tracks: d.timeline.tracks
      .map((t) => (t.layerId === layerId && t.prop === prop ? { ...t, keys: fn(t.keys.slice()).sort((a, b) => a.t - b.t) } : t))
      .filter((t) => t.keys.length > 0),
  };
  return d;
}

/** Move a key in time; a key already sitting at the target time is replaced. */
export function moveKey(doc: DesignDoc, layerId: string, prop: AnimProp, fromT: number, toT: number): DesignDoc {
  const t = Math.round(Math.min(doc.timeline.durationMs, Math.max(0, toT)));
  return editTrack(doc, layerId, prop, (keys) => {
    const k = keys.find((x) => x.t === fromT);
    if (!k) return keys;
    return [...keys.filter((x) => x.t !== fromT && x.t !== t), { ...k, t }];
  });
}

export function deleteKey(doc: DesignDoc, layerId: string, prop: AnimProp, t: number): DesignDoc {
  return editTrack(doc, layerId, prop, (keys) => keys.filter((x) => x.t !== t));
}

export function setKey(doc: DesignDoc, layerId: string, prop: AnimProp, t: number, patch: { v?: number; ease?: Ease }): DesignDoc {
  return editTrack(doc, layerId, prop, (keys) => keys.map((k) => (k.t === t ? { ...k, ...(patch.v !== undefined && Number.isFinite(patch.v) ? { v: patch.v } : {}), ...(patch.ease ? { ease: patch.ease } : {}) } : k)));
}

export const FPS_MIN = 1, FPS_MAX = 60, DURATION_MIN = 100, DURATION_MAX = 600_000;

/** Clamp the timeline so fps * seconds never exceeds the frame cap. */
export function setTimeline(doc: DesignDoc, patch: Partial<Pick<Timeline, "fps" | "durationMs" | "loop">>): DesignDoc {
  const fps = Math.round(Math.min(FPS_MAX, Math.max(FPS_MIN, patch.fps ?? doc.timeline.fps)));
  let durationMs = Math.round(Math.min(DURATION_MAX, Math.max(DURATION_MIN, patch.durationMs ?? doc.timeline.durationMs)));
  const maxMs = Math.floor((DESIGN_LIMITS.maxFrames / fps) * 1000);
  if (durationMs > maxMs) durationMs = maxMs;
  const d = cloneDoc(doc);
  d.timeline = { ...d.timeline, fps, durationMs, loop: patch.loop ?? doc.timeline.loop };
  return d;
}

/** Snap a time to the frame grid. */
export const snapToFrame = (tMs: number, fps: number): number => Math.round((Math.round((tMs * fps) / 1000) * 1000) / fps);

/** Clamp a cubic-bezier easing to CSS rules: x1, x2 in [0, 1]; y unbounded but finite (capped +-4). */
export function clampCubic(c: [number, number, number, number]): [number, number, number, number] {
  const cx = (v: number) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));
  const cy = (v: number) => Math.min(4, Math.max(-4, Number.isFinite(v) ? v : 0));
  return [cx(c[0]), cy(c[1]), cx(c[2]), cy(c[3])];
}

export const EASE_PRESETS: Record<string, [number, number, number, number]> = {
  ease: [0.25, 0.1, 0.25, 1], "ease-in": [0.42, 0, 1, 1], "ease-out": [0, 0, 0.58, 1], "ease-in-out": [0.42, 0, 0.58, 1],
};

// ── names, files, bytes ─────────────────────────────────────────────────────

/** A filename stem safe on every OS: letters, digits, space, dot, dash, underscore; no leading dots; capped. */
export function safeFileStem(name: string, fallback = "design"): string {
  let s = "";
  for (const ch of String(name ?? "")) {
    const c = ch.charCodeAt(0);
    const ok = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || ch === " " || ch === "-" || ch === "_" || ch === ".";
    s += ok ? ch : "_";
    if (s.length >= 80) break;
  }
  s = s.replace(/^[.\s]+/, "").replace(/[.\s]+$/, "").replace(/_{2,}/g, "_");
  return s || fallback;
}

export function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode(...bytes.subarray(i, i + CH));
  return btoa(s);
}

/** Strict base64 decode: refuses anything outside the alphabet instead of guessing. */
export function b64ToBytes(b64: string): Uint8Array | null {
  if (typeof b64 !== "string" || b64.length % 4 !== 0) return null;
  let pad = false;
  for (let i = 0; i < b64.length; i++) {
    const c = b64.charCodeAt(i);
    if (c === 61) { if (i < b64.length - 2) return null; pad = true; continue; }
    // Padding is only ever trailing: a data character after '=' is malformed.
    const ok = !pad && ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47);
    if (!ok) return null;
  }
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch { return null; }
}

/** The union of two rects (either may be null). */
export function unionRect(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/** Rect clipped to [0, w) x [0, h), integer-aligned outward; null when empty. */
export function clipRect(r: Rect, w: number, h: number): Rect | null {
  const x0 = Math.max(0, Math.floor(r.x)), y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(w, Math.ceil(r.x + r.w)), y1 = Math.min(h, Math.ceil(r.y + r.h));
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}
