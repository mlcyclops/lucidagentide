// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/design_pane.ts - the Design pane's DOM controller (Image / Vector / Motion on one doc).
//
// State is module-level (like the Markup pane) so a Studio repaint, which replaces the pane's DOM, keeps
// the open document, its pixels, the undo history and the tool; `mountDesignPane` re-attaches.
//
//   * The document model, its validation, agent op application and every encoder are the pure engine's
//     (harness/creator/design/). Pixels live in the engine TileStore; heavy pixel work runs in the design
//     worker (design_worker_client.ts).
//   * Undo/redo: one History of (doc before, doc after, tile patches), capped in bytes.
//   * Agents: the pane pushes the doc (no pixels) + manifest debounced 1 s, polls queued agent ops,
//     applies each batch through applyOps(..., "agent") as ONE undo step with an "Agent edit" toast, and
//     holds `request` ops until the user clicks Allow.
//   * DGX buttons carry the dgx-vision CUI verdict and stay disabled, with the reason, when refused.
//   * Untrusted text (file names, model labels, agent params, server errors) only ever reaches the DOM
//     through textContent (design_view.ts DOM builders).

import type {
  AnimProp, BrushStroke, DesignDoc, DesignOp, Ease, Layer, MaskData, MaskRecord, RasterData, RasterLayer, Rect, VShape, VectorLayer,
} from "../../harness/creator/design/types.ts";
import { BLEND_MODES } from "../../harness/creator/design/types.ts";
import { DESIGN_LIMITS, DESIGN_MAX_POINTS_PER_STROKE, DESIGN_MAX_STROKES_PER_HINT, DESIGN_MAX_TEXT } from "../../harness/creator/design/limits.ts";
import { applyOps, createDoc, newId } from "../../harness/creator/design/doc.ts";
import { DesignBudgetError, TILE, TileStore, readMaskRect, readRect, writeMask, writeRaster } from "../../harness/creator/design/tiles.ts";
import { combineMasks, hintFromStrokes, maskArea, maskBBox, rasterizeStroke, strokesToPrompts } from "../../harness/creator/design/mask.ts";
import { planResize } from "../../harness/creator/design/resample.ts";
import { checkDecodeBudget, sniffImage } from "../../harness/creator/design/sniff.ts";
import { getStroke, strokeToPath } from "../../harness/creator/design/freehand.ts";
import { fitBezier } from "../../harness/creator/design/fit.ts";
import { pathBBox } from "../../harness/creator/design/path.ts";
import { svgNodesToShapes } from "../../harness/creator/design/svg_import.ts";
import { buildAgentManifest } from "../../harness/creator/design/agent_view.ts";
import { layerStateAt } from "../../harness/creator/design/anim.ts";
import { cleanText } from "../../harness/creator/design/util.ts";
import { bridge } from "./bridge.ts";
import { showToast } from "./ui.ts";
import { svgTextToNode } from "./svg_sanitize.ts";
import {
  isUpscaleResult, isVectorize, isVisionJobStart, isVisionMask, isVisionSegment, parseDecompose, parseLabels,
  type VisionOp,
} from "./design_api.ts";
import {
  DEFAULT_HISTORY_BYTES, History, addHint, addLayer, addMask, applyMat, b64ToBytes, bytesToB64, clipRect, cloneDoc,
  cropDoc, debounce, deleteKey, fitView, hitNode, integerTranslation, invertMat, layerWorld, moveKey, moveNode, moveRectCorner,
  normRect, paintList, pathNodes, penToPath, rectCorners, removeHint, replaceLayer, scaleDocStructure, screenToDoc, setKey,
  setTimeline, smoothAnchor, snapToFrame, stepBrush, sliderToBrush, translateShape, unionRect, zoomAbout,
  type Corner, type Mat, type NodeRef, type PenAnchor, type Pt, type TilePatch, type View,
} from "./design_logic.ts";
import { DesignViewport } from "./design_viewport.ts";
import { DesignCancelled, DesignWorkerClient } from "./design_worker_client.ts";
import type { DecodedImage } from "./design_tasks.ts";
import { buildScene, runExport } from "./design_export.ts";
import { shapePath, textBounds } from "./design_draw.ts";
import {
  MODE_TOOLS, TOOL_BY_KEY, buildHintsPanel, buildLayersPanel, buildRequestsPanel, creatorDesignHtml, designBarHtml, dgxHtml,
  dgxReasonText, exportHtml, optionsHtml, toolsHtml,
  type DesignMode, type DesignTool, type DgxView, type ExportKind, type RequestView,
} from "./design_view.ts";
import { buildTimeline, movePlayhead, type KeyRef } from "./design_timeline.ts";

export { creatorDesignHtml };

type RequestOp = Extract<DesignOp, { op: "request" }>;

// ── state ────────────────────────────────────────────────────────────────────

const st = {
  doc: null as DesignDoc | null,
  mode: "image" as DesignMode,
  tool: "brush" as DesignTool,
  view: { zoom: 1, panX: 0, panY: 0 } as View,
  selected: "",
  multi: new Set<string>(),
  shapeId: "",
  brushSize: 40,
  hardness: 0.8,
  brushMode: "add" as "add" | "subtract",
  tint: "#ff3366",
  tintAlpha: 0.45,
  showMask: true,
  activeMaskId: "",
  pendingStrokes: [] as BrushStroke[],
  traceRect: null as Rect | null,
  traced: false,
  hintLabel: "",
  hintIntent: "isolate" as "isolate" | "remove" | "keep" | "refine",
  wandTolerance: 32,
  wandContiguous: true,
  crop: null as Rect | null,
  keepAspect: true,
  traceColors: 8,
  fill: "#4b8bff", fillNone: false, stroke: "#1b1f24", strokeNone: false, strokeWidth: 2, paintOpacity: 1,
  textFamily: "sans-serif" as "sans-serif" | "serif" | "monospace", textSize: 48, freehandMode: "ink" as "ink" | "smooth",
  pen: [] as PenAnchor[],
  autoKey: true,
  time: 0,
  playing: false,
  selKey: null as KeyRef | null,
  exportKind: "png" as ExportKind,
  gifDither: "floyd-steinberg" as "none" | "floyd-steinberg" | "bayer4",
  gifPalette: "global" as "global" | "per-frame",
  exportMax: 1024,
  upscale: 4,
  newForm: false,
  busy: "",
  cancelRequested: false,
  status: "",
  tone: "" as "" | "ok" | "error",
  dgx: { verdict: null, endpointId: "", reason: "" } as DgxView,
  opsSince: 0,
  requests: [] as (RequestView & { op: RequestOp })[],
  cursor: null as Pt | null,
  spaceDown: false,
};

let store = new TileStore(DESIGN_LIMITS.defaultTileBudgetBytes);
const viewport = new DesignViewport(() => store);
const history = new History<DesignDoc>(DEFAULT_HISTORY_BYTES);
const worker = new DesignWorkerClient();
let root: HTMLElement | null = null;
let drawQueued = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let playRaf = 0;
let resizeObs: ResizeObserver | null = null;

const q = <T extends Element = HTMLElement>(sel: string): T | null => root?.querySelector<T>(sel) ?? null;
const fieldFocused = () => {
  const a = document.activeElement;
  return a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement || a instanceof HTMLSelectElement;
};
const dgxAllowed = () => !!st.dgx.verdict?.allowed;
const radius = () => Math.max(0.5, st.brushSize / 2);

// ── painting the chrome ──────────────────────────────────────────────────────

function setStatus(status: string, tone: "" | "ok" | "error" = ""): void {
  st.status = status;
  st.tone = tone;
  const p = q("[data-dsn-status]");
  if (p) { p.textContent = status; p.className = `cpl-status${tone ? ` ${tone}` : ""}`; p.hidden = !status; }
}

function paintBar(): void {
  const bar = q("[data-dsn-bar]");
  if (!bar) return;
  const d = st.doc;
  bar.innerHTML = designBarHtml({
    hasDoc: !!d, mode: st.mode, zoom: st.view.zoom, canUndo: history.canUndo(), canRedo: history.canRedo(),
    undoLabel: history.peekUndo(), redoLabel: history.peekRedo(), busy: !!st.busy, workerMode: worker.mode(),
    docSize: d ? `${d.width} x ${d.height}` : "no document", historyMb: Math.round(history.bytes() / 1048576),
  });
  const name = q("[data-dsn-docname]");
  if (name) { name.textContent = d ? d.name : "No document"; name.title = d ? d.name : ""; }
  setStatus(st.status, st.tone);
}

function hasRasterSelected(): boolean { return st.doc?.layers[st.selected]?.kind === "raster"; }

function paintSide(): void {
  const d = st.doc;
  const tools = q("[data-dsn-tools]");
  if (tools) tools.innerHTML = toolsHtml(st.mode, st.tool, !!d);
  const opts = q("[data-dsn-options]");
  if (opts) {
    if (st.newForm || !d) opts.innerHTML = newDocFormHtml();
    else opts.innerHTML = optionsHtml({
      mode: st.mode, tool: st.tool, hasDoc: !!d, busy: !!st.busy, brushSize: st.brushSize, hardness: st.hardness, brushMode: st.brushMode,
      tint: st.tint, tintAlpha: st.tintAlpha, showMask: st.showMask, hasMask: !!(d && d.masks[st.activeMaskId]),
      wandTolerance: st.wandTolerance, wandContiguous: st.wandContiguous, crop: st.crop ? { w: st.crop.w, h: st.crop.h } : null,
      docW: d.width, docH: d.height, keepAspect: st.keepAspect, hasRaster: hasRasterSelected(), hasVector: d.layers[st.selected]?.kind === "vector",
      hasShape: !!selectedShape(), fill: st.fill, fillNone: st.fillNone, stroke: st.stroke, strokeNone: st.strokeNone, strokeWidth: st.strokeWidth,
      paintOpacity: st.paintOpacity, textFamily: st.textFamily, textSize: st.textSize, freehandMode: st.freehandMode, autoKey: st.autoKey, traceColors: st.traceColors,
    });
  }
  const dgx = q("[data-dsn-dgx]");
  if (dgx) {
    dgx.innerHTML = dgxHtml(st.dgx, { hasDoc: !!d, busy: !!st.busy, hasMask: !!(d && d.masks[st.activeMaskId]), hasRaster: hasRasterSelected(), upscale: st.upscale });
    const reason = q("[data-dsn-dgx-reason]");
    if (reason) reason.textContent = dgxReasonText(st.dgx);
  }
  const exp = q("[data-dsn-export-sec]");
  if (exp) exp.innerHTML = exportHtml({ kind: st.exportKind, hasDoc: !!d, busy: !!st.busy, fps: d?.timeline.fps ?? 30, dither: st.gifDither, palette: st.gifPalette, maxSide: st.exportMax, loop: d?.timeline.loop ?? true });
  const layers = q("[data-dsn-layers]");
  if (layers) {
    if (d) buildLayersPanel(layers, { doc: d, selected: st.selected, multi: st.multi, busy: !!st.busy }, (c, l) => viewport.thumb(c, d, l));
    else layers.replaceChildren();
  }
  const hints = q("[data-dsn-hints]");
  if (hints) {
    if (d) buildHintsPanel(hints, { hints: d.hints, pending: st.traced, label: st.hintLabel, intent: st.hintIntent, busy: !!st.busy, dgxAllowed: dgxAllowed(), activeMaskId: st.activeMaskId });
    else hints.replaceChildren();
  }
  const reqs = q("[data-dsn-requests]");
  if (reqs) buildRequestsPanel(reqs, st.requests, !!st.busy);
  paintTimeline();
}

function newDocFormHtml(): string {
  return `<div class="dsn-sec-title">New document</div>
    <div class="dsn-row"><span class="dsn-lbl">Size</span><input class="prov-key dsn-num" type="number" min="1" max="65535" value="1920" data-dsn-new-w /><span class="dsn-x">x</span><input class="prov-key dsn-num" type="number" min="1" max="65535" value="1080" data-dsn-new-h /></div>
    <div class="dsn-row"><span class="dsn-lbl">Background</span><select class="prov-key" data-dsn-new-bg><option value="">Transparent</option><option value="#ffffff">White</option><option value="#000000">Black</option></select></div>
    <div class="dsn-row"><button type="button" class="btn-mini ok" data-dsn-new-create>Create</button>${st.doc ? `<button type="button" class="btn-mini" data-dsn-new-cancel>Cancel</button>` : ""}</div>`;
}

function paintTimeline(): void {
  const tl = q("[data-dsn-timeline]");
  if (!tl) return;
  const show = st.mode === "motion" && !!st.doc;
  tl.hidden = !show;
  if (show) buildTimeline(tl, timelineHost);
  else tl.replaceChildren();
}

function paintAll(): void {
  paintBar();
  paintSide();
  const empty = q("[data-dsn-empty]");
  if (empty) empty.hidden = !!st.doc;
  requestDraw();
}

function paintProgress(fraction: number | null, note = ""): void {
  const box = q("[data-dsn-progress]");
  if (!box) return;
  box.hidden = !st.busy;
  const n = q("[data-dsn-progress-note]");
  if (n) n.textContent = st.busy ? `${st.busy}${note ? `: ${note}` : ""}` : "";
  const bar = q<HTMLProgressElement>("[data-dsn-progress-bar]");
  if (bar) { if (fraction === null) bar.removeAttribute("value"); else bar.value = fraction; }
}

/** Run a long task with the busy strip, progress, and Cancel. Never throws; reports in the status line. */
async function busyRun(label: string, fn: () => Promise<void>): Promise<void> {
  if (st.busy) {
    // Never drop a click silently: say what is running and how to stop it.
    const exporting = st.busy.startsWith("Export");
    setStatus(`${exporting && label.startsWith("Export") ? "An export is already running" : `"${st.busy}" is still running`} - wait for it to finish or press Cancel. "${label}" was not started.`, "error");
    return;
  }
  st.busy = label;
  st.cancelRequested = false;
  paintAll();
  paintProgress(null);
  try {
    await fn();
  } catch (e) {
    if (e instanceof DesignCancelled || st.cancelRequested) setStatus(`${label}: cancelled.`);
    else if (e instanceof DesignBudgetError) setStatus(`${label}: the tile budget is full (${Math.round(e.budget / 1048576)} MB). Close other documents or work smaller.`, "error");
    else setStatus(`${label}: ${e instanceof Error ? e.message : String(e)}`, "error");
  } finally {
    st.busy = "";
    paintProgress(null);
    paintAll();
  }
}

const progressCb = (f: number, note: string) => paintProgress(f, note);

// ── drawing ──────────────────────────────────────────────────────────────────

function requestDraw(): void {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => { drawQueued = false; drawNow(); });
}

function canvasPair(): { main: HTMLCanvasElement; over: HTMLCanvasElement } | null {
  const main = q<HTMLCanvasElement>("[data-dsn-canvas]"), over = q<HTMLCanvasElement>("[data-dsn-overlay]");
  return main && over ? { main, over } : null;
}

function baseMatrix(): Mat {
  const dpr = window.devicePixelRatio || 1;
  return [st.view.zoom * dpr, 0, 0, st.view.zoom * dpr, st.view.panX * dpr, st.view.panY * dpr];
}

function drawNow(): void {
  const c = canvasPair();
  if (!c) return;
  const ctx = c.main.getContext("2d");
  if (!ctx) return;
  if (!st.doc) { ctx.clearRect(0, 0, c.main.width, c.main.height); drawOverlay(); return; }
  viewport.draw(ctx, c.main.width, c.main.height, st.doc, baseMatrix(), {
    t: st.time, overlayMaskId: st.showMask ? st.activeMaskId : undefined, tint: st.tint, tintAlpha: st.tintAlpha,
  });
  drawOverlay();
}

function toScreen(p: Pt): Pt { return { x: p.x * st.view.zoom + st.view.panX, y: p.y * st.view.zoom + st.view.panY }; }

function selectedItemWorld(id: string): Mat | null {
  const d = st.doc;
  if (!d) return null;
  const item = paintList(d).find((p) => p.id === id);
  return item ? layerWorld(d, item, st.time).m : null;
}

function shapeBox(s: VShape): Rect | null {
  if (s.kind === "text") return textBounds(s);
  if (s.d) return pathBBox(s.d);
  return s.rect ?? null;
}

function drawOverlay(): void {
  const c = canvasPair();
  if (!c) return;
  const ctx = c.over.getContext("2d");
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, c.over.width, c.over.height);
  const d = st.doc;
  if (!d) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineWidth = 1;
  const poly = (pts: Pt[], close = true) => { ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); if (close) ctx.closePath(); };
  // Selected layer outline.
  const sel = d.layers[st.selected];
  const m = sel ? selectedItemWorld(sel.id) : null;
  if (sel && m) {
    let box: Rect | null = null;
    if (sel.kind === "raster") box = { x: 0, y: 0, w: sel.width, h: sel.height };
    else if (sel.kind === "vector") for (const s of sel.shapes) box = unionRect(box, shapeBox(s));
    if (box) {
      const corners = [[box.x, box.y], [box.x + box.w, box.y], [box.x + box.w, box.y + box.h], [box.x, box.y + box.h]].map(([x, y]) => toScreen(applyMat(m, x!, y!)));
      ctx.setLineDash([5, 4]); ctx.strokeStyle = "rgba(75,139,255,.9)"; poly(corners); ctx.stroke(); ctx.setLineDash([]);
    }
    const shape = selectedShape();
    if (shape && sel.kind === "vector") {
      const sm = shape.transform ? mulMat2(m, shape.transform) : m;
      const sb = shapeBox(shape);
      if (sb) {
        const corners = [[sb.x, sb.y], [sb.x + sb.w, sb.y], [sb.x + sb.w, sb.y + sb.h], [sb.x, sb.y + sb.h]].map(([x, y]) => toScreen(applyMat(sm, x!, y!)));
        ctx.strokeStyle = "rgba(255,122,69,.95)"; poly(corners); ctx.stroke();
      }
      if (st.tool === "node") {
        const dot = (p: Pt, handle: boolean) => { const s = toScreen(applyMat(sm, p.x, p.y)); ctx.beginPath(); if (handle) ctx.arc(s.x, s.y, 3.5, 0, Math.PI * 2); else ctx.rect(s.x - 4, s.y - 4, 8, 8); ctx.fillStyle = handle ? "#ff7a45" : "#ffffff"; ctx.fill(); ctx.strokeStyle = "#1b1f24"; ctx.stroke(); };
        if (shape.d) for (const n of pathNodes(shape.d)) dot(n, n.kind === "handle");
        else if (shape.rect && shape.kind !== "text") for (const k of rectCorners(shape.rect)) dot(k, false);
      }
    }
  }
  // Crop rectangle with the outside dimmed.
  if (st.crop && st.tool === "crop") {
    const a = toScreen({ x: st.crop.x, y: st.crop.y }), b = toScreen({ x: st.crop.x + st.crop.w, y: st.crop.y + st.crop.h });
    ctx.fillStyle = "rgba(0,0,0,.45)";
    ctx.beginPath(); ctx.rect(0, 0, c.over.width / dpr, c.over.height / dpr); ctx.rect(a.x, a.y, b.x - a.x, b.y - a.y); ctx.fill("evenodd");
    ctx.strokeStyle = "#ffffff"; ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
  }
  // Pen path in progress.
  if (st.pen.length) {
    const cmds = penToPath(st.cursor && !dragState ? [...st.pen, { x: screenToDoc(st.view, st.cursor.x, st.cursor.y).x, y: screenToDoc(st.view, st.cursor.x, st.cursor.y).y }] : st.pen, false);
    ctx.save();
    ctx.setTransform(dpr * st.view.zoom, 0, 0, dpr * st.view.zoom, dpr * st.view.panX, dpr * st.view.panY);
    ctx.lineWidth = 1.5 / st.view.zoom;
    ctx.strokeStyle = "#4b8bff";
    const p = new Path2D();
    for (const cmd of cmds) {
      if (cmd.c === "M") p.moveTo(cmd.x, cmd.y); else if (cmd.c === "L") p.lineTo(cmd.x, cmd.y); else if (cmd.c === "C") p.bezierCurveTo(cmd.x1, cmd.y1, cmd.x2, cmd.y2, cmd.x, cmd.y);
    }
    ctx.stroke(p);
    ctx.restore();
    for (const a of st.pen) {
      const s = toScreen(a);
      ctx.fillStyle = "#ffffff"; ctx.strokeStyle = "#1b1f24"; ctx.fillRect(s.x - 3.5, s.y - 3.5, 7, 7); ctx.strokeRect(s.x - 3.5, s.y - 3.5, 7, 7);
      for (const h of [a.hin, a.hout]) if (h) { const hs = toScreen(h); ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(hs.x, hs.y); ctx.strokeStyle = "#ff7a45"; ctx.stroke(); ctx.beginPath(); ctx.arc(hs.x, hs.y, 3, 0, Math.PI * 2); ctx.fillStyle = "#ff7a45"; ctx.fill(); }
    }
  }
  // Shape being dragged out, freehand trail.
  if (dragState?.kind === "shape") {
    const a = toScreen(dragState.start), b = toScreen(dragState.cur);
    ctx.strokeStyle = "#4b8bff";
    ctx.beginPath();
    if (dragState.tool === "line") { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
    else if (dragState.tool === "rect") ctx.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    else ctx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (dragState?.kind === "freehand" && dragState.pts.length > 1) {
    ctx.strokeStyle = st.strokeNone ? st.fill : st.stroke; ctx.lineWidth = Math.max(1, st.strokeWidth * st.view.zoom); ctx.lineCap = "round"; ctx.lineJoin = "round";
    poly(dragState.pts.map(toScreen), false); ctx.stroke(); ctx.lineWidth = 1;
  }
  // The brush cursor at TRUE size: radius in doc px times the zoom.
  if (st.cursor && (st.tool === "brush" || st.tool === "eraser") && st.mode === "image") {
    const r = Math.max(1, radius() * st.view.zoom);
    ctx.beginPath(); ctx.arc(st.cursor.x, st.cursor.y, r, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(0,0,0,.85)"; ctx.lineWidth = 2.5; ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,.95)"; ctx.lineWidth = 1; ctx.stroke();
    if (st.hardness < 1 && r > 6) { ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.arc(st.cursor.x, st.cursor.y, r * st.hardness, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]); }
  }
}

function mulMat2(a: Mat, b: readonly number[]): Mat {
  return [a[0] * b[0]! + a[2] * b[1]!, a[1] * b[0]! + a[3] * b[1]!, a[0] * b[2]! + a[2] * b[3]!, a[1] * b[2]! + a[3] * b[3]!, a[0] * b[4]! + a[2] * b[5]! + a[4], a[1] * b[4]! + a[3] * b[5]! + a[5]];
}

// ── document commits, undo/redo, pixel patches ──────────────────────────────

const pushState = debounce(() => { void pushStateNow(); }, 1000);

function commit(next: DesignDoc, label: string, patches: TilePatch[] = []): void {
  const before = st.doc;
  st.doc = next;
  if (before) {
    const r = history.push({ label, before, after: next, patches });
    if (r.oversize) setStatus(`${label} is larger than the undo budget, so the undo history was cleared.`);
  }
  if (st.selected && !next.layers[st.selected]) st.selected = "";
  for (const id of [...st.multi]) if (!next.layers[id]) st.multi.delete(id);
  pushState.fire();
  paintAll();
}

function applyPatches(patches: readonly TilePatch[], side: "before" | "after"): void {
  for (const p of patches) {
    const data = p[side];
    if (data) store.set(p.key, p.tx, p.ty, data.slice());
    else store.deleteTile(p.key, p.tx, p.ty);
    viewport.invalidate(p.key, p.tx, p.ty);
  }
}

function undo(): void {
  if (st.busy) return;
  const e = history.undo();
  if (!e) return;
  applyPatches([...e.patches].reverse(), "before");
  st.doc = e.before;
  afterHistoryMove(`Undid ${e.label}.`);
}

function redo(): void {
  if (st.busy) return;
  const e = history.redo();
  if (!e) return;
  applyPatches(e.patches, "after");
  st.doc = e.after;
  afterHistoryMove(`Redid ${e.label}.`);
}

function afterHistoryMove(msg: string): void {
  const d = st.doc;
  if (d && st.selected && !d.layers[st.selected]) st.selected = "";
  if (d && st.activeMaskId && !d.masks[st.activeMaskId]) { st.activeMaskId = ""; st.traced = false; st.pendingStrokes = []; }
  st.shapeId = selectedShape() ? st.shapeId : "";
  pushState.fire();
  setStatus(msg);
  paintAll();
}

/** Records the before/after bytes of every tile an edit touches, for one undo step. */
class PatchRecorder {
  private before = new Map<string, { key: string; tx: number; ty: number; data: Uint8ClampedArray | null }>();
  private whole = new Set<string>();
  touch(key: string, tx: number, ty: number): void {
    const k = `${key}|${tx}|${ty}`;
    if (!this.before.has(k)) this.before.set(k, { key, tx, ty, data: store.get(key, tx, ty)?.slice() ?? null });
  }
  /** Every tile of `rect` (key space). */
  touchRect(key: string, rect: Rect): void {
    const tx0 = Math.max(0, Math.floor(rect.x / TILE)), ty0 = Math.max(0, Math.floor(rect.y / TILE));
    const tx1 = Math.floor((rect.x + rect.w - 1) / TILE), ty1 = Math.floor((rect.y + rect.h - 1) / TILE);
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) this.touch(key, tx, ty);
  }
  /** The whole key: existing tiles now, plus any tile that exists once the edit is done. */
  touchAll(key: string): void {
    for (const t of store.tilesOf(key)) this.touch(key, t.tx, t.ty);
    this.whole.add(key);
  }
  finish(): TilePatch[] {
    for (const key of this.whole) for (const t of store.tilesOf(key)) {
      const k = `${key}|${t.tx}|${t.ty}`;
      if (!this.before.has(k)) this.before.set(k, { key, tx: t.tx, ty: t.ty, data: null });
    }
    const out: TilePatch[] = [];
    for (const b of this.before.values()) {
      const after = store.get(b.key, b.tx, b.ty)?.slice() ?? null;
      viewport.invalidate(b.key, b.tx, b.ty);
      if (!b.data && !after) continue;
      out.push({ key: b.key, tx: b.tx, ty: b.ty, before: b.data, after });
    }
    return out;
  }
}

/** Replace all pixels of a raster key (or mask key) with `data` at (0, 0). */
function replaceRaster(rec: PatchRecorder, key: string, data: RasterData): void {
  rec.touchAll(key);
  store.delete(key);
  writeRaster(store, key, data, 0, 0);
  viewport.invalidate(key);
}

function replaceMask(rec: PatchRecorder, key: string, data: MaskData): void {
  rec.touchAll(key);
  store.delete(key);
  writeMask(store, key, data, 0, 0);
  viewport.invalidate(key);
}

// ── layers ───────────────────────────────────────────────────────────────────

function baseLayer(name: string, w: number, h: number): Omit<RasterLayer, "kind" | "width" | "height"> {
  return { id: newId("layer"), name: cleanText(name, 200) || "Layer", visible: true, locked: false, opacity: 1, blend: "normal", x: 0, y: 0, scale: 1, rotation: 0, anchorX: w / 2, anchorY: h / 2 };
}

function rasterLayer(name: string, w: number, h: number, x = 0, y = 0, meta?: RasterLayer["meta"]): RasterLayer {
  return { ...baseLayer(name, w, h), kind: "raster", width: w, height: h, x, y, ...(meta ? { meta } : {}) };
}

function vectorLayer(name: string): VectorLayer {
  const d = st.doc!;
  return { ...baseLayer(name, d.width, d.height), kind: "vector", shapes: [] };
}

function userOps(ops: DesignOp[], label: string): void {
  const d = st.doc;
  if (!d) return;
  const r = applyOps(d, ops, "user");
  if (r.errors.length) setStatus(r.errors[0]!, "error");
  if (r.applied > 0) commit(r.doc, label);
}

function selectedShape(): VShape | null {
  const l = st.doc?.layers[st.selected];
  return l?.kind === "vector" ? l.shapes.find((s) => s.id === st.shapeId) ?? null : null;
}

function topLevelIndex(d: DesignDoc, id: string): { siblings: string[]; index: number } {
  const l = d.layers[id];
  const parent = l?.parentId ? d.layers[l.parentId] : undefined;
  const siblings = parent?.kind === "group" ? parent.children : d.order;
  return { siblings, index: siblings.indexOf(id) };
}

// ── opening, placing, importing ─────────────────────────────────────────────

const MIME_OF: Record<string, string> = { png: "image/png", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp" };

function resetForDoc(doc: DesignDoc): void {
  store = new TileStore(DESIGN_LIMITS.defaultTileBudgetBytes);
  viewport.clear();
  history.clear();
  st.doc = doc;
  st.selected = ""; st.multi.clear(); st.shapeId = ""; st.activeMaskId = ""; st.pendingStrokes = []; st.traced = false; st.traceRect = null;
  st.crop = null; st.pen = []; st.time = 0; st.selKey = null; st.requests = []; st.newForm = false;
  fitToStage();
}

function fitToStage(): void {
  const stage = q("[data-dsn-stage]");
  if (!stage || !st.doc) return;
  st.view = fitView(st.doc.width, st.doc.height, stage.clientWidth || 800, stage.clientHeight || 600);
}

async function decodeBytes(bytes: Uint8Array, refuseLabel: string): Promise<DecodedImage> {
  const info = sniffImage(bytes);
  if (info.format === "psd") throw new Error("PSD import is not supported this phase.");
  if (info.format === "svg" || info.format === "unknown") throw new Error(`${refuseLabel} is not a PNG, JPEG, GIF, WebP or BMP image.`);
  const refusal = checkDecodeBudget(info, DESIGN_LIMITS.maxRasterPixels);
  if (refusal) throw new Error(`${refuseLabel} was refused before decoding: ${refusal}.`);
  const buf = bytes.slice().buffer as ArrayBuffer;
  return worker.run<DecodedImage>({ op: "decode", bytes: buf, mime: MIME_OF[info.format] ?? "" }, { transfer: [buf], onProgress: progressCb });
}

function writeDecoded(key: string, dec: DecodedImage): void {
  for (const s of dec.strips) writeRaster(store, key, { width: dec.width, height: s.rows, rgba: s.rgba }, 0, s.y);
  viewport.invalidate(key);
}

async function openFile(file: File, mode: "open" | "place"): Promise<void> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const info = sniffImage(bytes);
  if (info.format === "psd") { setStatus("PSD import is not supported this phase. Open a PNG, JPEG, GIF, WebP or BMP, or export PSD from here.", "error"); return; }
  if (info.format === "svg") { await importSvgText(new TextDecoder().decode(bytes), file.name); return; }
  const name = cleanText(file.name, 200) || "Image";
  await busyRun("Decoding", async () => {
    const dec = await decodeBytes(bytes, "That file");
    if (mode === "open" || !st.doc) {
      const doc = createDoc(name.replace(/\.[A-Za-z0-9]{1,5}$/, "") || "Image", dec.width, dec.height, null);
      resetForDoc(doc);
      const l = rasterLayer(name, dec.width, dec.height, 0, 0, { source: "import" });
      writeDecoded(l.id, dec);
      const added = addLayer(doc, l);
      if ("error" in added) throw new Error(added.error);
      st.doc = added.doc;
      st.selected = l.id;
      pushState.fire();
      setStatus(`Opened ${dec.width} x ${dec.height}.`, "ok");
      return;
    }
    const rec = new PatchRecorder();
    const l = rasterLayer(name, dec.width, dec.height, 0, 0, { source: "import" });
    rec.touchAll(l.id);
    writeDecoded(l.id, dec);
    const added = addLayer(st.doc, l, st.doc.layers[st.selected] && !st.doc.layers[st.selected]!.parentId ? st.selected : undefined);
    if ("error" in added) throw new Error(added.error);
    st.selected = l.id;
    commit(added.doc, "Place image", rec.finish());
    setStatus(`Placed ${dec.width} x ${dec.height}.`, "ok");
  });
}

async function importSvgText(text: string, fileName: string): Promise<void> {
  const parsed = svgTextToNode(text);
  if (!parsed.ok) { setStatus(parsed.error, "error"); return; }
  const r = svgNodesToShapes(parsed.root);
  if (!r.shapes.length) { setStatus(`Nothing drawable was found in that SVG.${r.warnings.length ? ` ${r.warnings.length} element(s) were dropped.` : ""}`, "error"); return; }
  if (!st.doc) {
    // A fresh canvas sized to the drawing's right/bottom extent (at least 1 px, at most maxSide).
    let right = 1, bottom = 1;
    for (const s of r.shapes) { const b = shapeBox(s); if (b) { right = Math.max(right, b.x + b.w); bottom = Math.max(bottom, b.y + b.h); } }
    const w = Math.min(DESIGN_LIMITS.maxSide, Math.ceil(right));
    // createDoc refuses an area over the raster budget; keep the width and shorten the canvas instead.
    const h = Math.min(DESIGN_LIMITS.maxSide, Math.ceil(bottom), Math.floor(DESIGN_LIMITS.maxRasterPixels / w));
    resetForDoc(createDoc(cleanText(fileName, 200) || "Vector", w, h, null));
  }
  const l: VectorLayer = { ...vectorLayer(cleanText(fileName, 200) || "Imported SVG"), shapes: r.shapes.slice(0, DESIGN_LIMITS.maxShapes), meta: { source: "import" } };
  const added = addLayer(st.doc!, l);
  if ("error" in added) { setStatus(added.error, "error"); return; }
  st.selected = l.id;
  st.mode = "vector";
  st.tool = "select";
  commit(added.doc, "Import SVG");
  setStatus(`Imported ${l.shapes.length} shape(s)${r.warnings.length ? `; ${r.warnings.length} unsupported element(s) dropped` : ""}.`, "ok");
}

// ── mask tracing ─────────────────────────────────────────────────────────────

/** The mask being traced, created (canvas-sized at the origin) on first use. */
function ensureActiveMask(d: DesignDoc): { doc: DesignDoc; rec: MaskRecord } {
  const have = d.masks[st.activeMaskId];
  if (have) return { doc: d, rec: have };
  const rec: MaskRecord = { id: newId("mask"), x: 0, y: 0, width: d.width, height: d.height };
  st.activeMaskId = rec.id;
  return { doc: addMask(d, rec), rec };
}

interface StrokeDrag { kind: "stroke"; rec: MaskRecord; stroke: BrushStroke; last: Pt; recorder: PatchRecorder; docBefore: DesignDoc; docAfter: DesignDoc; dirty: Rect | null }

function paintSegment(drag: StrokeDrag, a: Pt, b: Pt): void {
  const r = drag.stroke.radius + 2;
  const rec = drag.rec;
  const box = clipRect({ x: Math.min(a.x, b.x) - r - rec.x, y: Math.min(a.y, b.y) - r - rec.y, w: Math.abs(b.x - a.x) + r * 2, h: Math.abs(b.y - a.y) + r * 2 }, rec.width, rec.height);
  if (!box) return;
  const key = `mask:${rec.id}`;
  drag.recorder.touchRect(key, box);
  const m = readMaskRect(store, key, rec.width, rec.height, box);
  rasterizeStroke(m, { points: a === b ? [a] : [a, b], radius: drag.stroke.radius, hardness: drag.stroke.hardness, mode: drag.stroke.mode }, rec.x + box.x, rec.y + box.y);
  writeMask(store, key, m, box.x, box.y);
  const tx0 = Math.floor(box.x / TILE), ty0 = Math.floor(box.y / TILE), tx1 = Math.floor((box.x + box.w - 1) / TILE), ty1 = Math.floor((box.y + box.h - 1) / TILE);
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) viewport.invalidate(key, tx, ty);
  drag.dirty = unionRect(drag.dirty, box);
}

function finishStroke(drag: StrokeDrag): void {
  const patches = drag.recorder.finish();
  if (drag.stroke.points.length > DESIGN_MAX_POINTS_PER_STROKE) {
    const step = Math.ceil(drag.stroke.points.length / DESIGN_MAX_POINTS_PER_STROKE);
    drag.stroke.points = drag.stroke.points.filter((_, i) => i % step === 0);
  }
  if (st.pendingStrokes.length < DESIGN_MAX_STROKES_PER_HINT) st.pendingStrokes.push(drag.stroke);
  st.traceRect = unionRect(st.traceRect, drag.dirty);
  st.traced = true;
  st.doc = drag.docBefore;
  commit(drag.docAfter, drag.stroke.mode === "add" ? "Brush trace" : "Brush erase", patches);
}

async function wandAt(p: Pt, subtract: boolean): Promise<void> {
  const d = st.doc;
  const l = d?.layers[st.selected];
  if (!d || !l || l.kind !== "raster") { setStatus("Select a raster layer for the magic wand.", "error"); return; }
  const m = selectedItemWorld(l.id);
  const off = m ? integerTranslation(m) : null;
  if (!off) { setStatus("The magic wand needs an unrotated, unscaled layer.", "error"); return; }
  await busyRun("Magic wand", async () => {
    const src = readRect(store, l.id, l.width, l.height, { x: 0, y: 0, w: l.width, h: l.height });
    const sel = await worker.run<MaskData>({ op: "wand", src, x: Math.floor(p.x - off.dx), y: Math.floor(p.y - off.dy), tolerance: st.wandTolerance, contiguous: st.wandContiguous }, { transfer: [src.rgba.buffer as ArrayBuffer] });
    const { doc, rec } = ensureActiveMask(st.doc!);
    // The selection sits at the layer's offset; combine it into the mask over the overlapping region.
    const region = clipRect({ x: off.dx - rec.x, y: off.dy - rec.y, w: sel.width, h: sel.height }, rec.width, rec.height);
    if (!region) { setStatus("That layer does not overlap the canvas.", "error"); return; }
    const key = `mask:${rec.id}`;
    const recorder = new PatchRecorder();
    recorder.touchRect(key, region);
    const cur = readMaskRect(store, key, rec.width, rec.height, region);
    const piece = new Uint8Array(region.w * region.h);
    const sx = region.x + rec.x - off.dx, sy = region.y + rec.y - off.dy;
    for (let y = 0; y < region.h; y++) piece.set(sel.alpha.subarray((sy + y) * sel.width + sx, (sy + y) * sel.width + sx + region.w), y * region.w);
    const merged = combineMasks(cur, { width: region.w, height: region.h, alpha: piece }, subtract ? "subtract" : "add");
    writeMask(store, key, merged, region.x, region.y);
    st.traceRect = unionRect(st.traceRect, region);
    st.traced = true;
    commit(doc, subtract ? "Wand subtract" : "Magic wand", recorder.finish());
  });
}

function createHint(): void {
  const d = st.doc;
  const rec = d?.masks[st.activeMaskId];
  if (!d || !rec) return;
  const label = cleanText(st.hintLabel, 200);
  if (!label) { setStatus("Type a short label for what you traced.", "error"); return; }
  const r = clipRect(st.traceRect ?? { x: 0, y: 0, w: rec.width, h: rec.height }, rec.width, rec.height) ?? { x: 0, y: 0, w: 1, h: 1 };
  const m = readMaskRect(store, `mask:${rec.id}`, rec.width, rec.height, r);
  const hint = hintFromStrokes(rec.id, st.pendingStrokes, label, st.hintIntent, m, rec.x + r.x, rec.y + r.y);
  const added = addHint(d, hint);
  if ("error" in added) { setStatus(added.error, "error"); return; }
  st.pendingStrokes = []; st.traced = false; st.traceRect = null; st.hintLabel = "";
  st.activeMaskId = "";
  commit(added.doc, "Create hint");
  setStatus("Hint created. Agents read its label and intent; the next trace starts a new mask.", "ok");
}

function discardTrace(): void {
  const d = st.doc;
  const rec = d?.masks[st.activeMaskId];
  if (!d || !rec) { st.traced = false; st.pendingStrokes = []; paintAll(); return; }
  const recorder = new PatchRecorder();
  const key = `mask:${rec.id}`;
  recorder.touchAll(key);
  store.delete(key);
  viewport.invalidate(key);
  const used = d.hints.some((h) => h.maskId === rec.id) || Object.keys(d.layers).some((id) => d.layers[id]!.maskId === rec.id);
  const next = cloneDoc(d);
  if (!used) delete next.masks[rec.id];
  st.pendingStrokes = []; st.traced = false; st.traceRect = null;
  if (!used) st.activeMaskId = "";
  commit(next, "Discard trace", recorder.finish());
}

async function layerFromMask(): Promise<void> {
  const d = st.doc;
  const l = d?.layers[st.selected];
  const rec = d?.masks[st.activeMaskId];
  if (!d || !l || l.kind !== "raster" || !rec) { setStatus("Select a raster layer and trace a mask first.", "error"); return; }
  const m = selectedItemWorld(l.id);
  const off = m ? integerTranslation(m) : null;
  if (!off) { setStatus("New layer from mask needs an unrotated, unscaled layer.", "error"); return; }
  await busyRun("New layer from mask", async () => {
    const src = readRect(store, l.id, l.width, l.height, { x: 0, y: 0, w: l.width, h: l.height });
    const mask = readMaskRect(store, `mask:${rec.id}`, rec.width, rec.height, { x: 0, y: 0, w: rec.width, h: rec.height });
    const cut = await worker.run<RasterData>({ op: "applyMask", src, mask, dx: Math.round(rec.x - off.dx), dy: Math.round(rec.y - off.dy) }, { transfer: [src.rgba.buffer as ArrayBuffer, mask.alpha.buffer as ArrayBuffer] });
    const alpha = new Uint8Array(cut.width * cut.height);
    for (let i = 0; i < alpha.length; i++) alpha[i] = cut.rgba[i * 4 + 3]!;
    const bb = maskBBox({ width: cut.width, height: cut.height, alpha });
    if (!bb) { setStatus("The mask does not cover any pixel of that layer.", "error"); return; }
    const crop: RasterData = { width: bb.w, height: bb.h, rgba: new Uint8ClampedArray(bb.w * bb.h * 4) };
    for (let y = 0; y < bb.h; y++) crop.rgba.set(cut.rgba.subarray(((bb.y + y) * cut.width + bb.x) * 4, ((bb.y + y) * cut.width + bb.x + bb.w) * 4), y * bb.w * 4);
    const nl = rasterLayer(`${l.name} (cut)`, bb.w, bb.h, off.dx + bb.x, off.dy + bb.y, { source: "user", bbox: { x: off.dx + bb.x, y: off.dy + bb.y, w: bb.w, h: bb.h } });
    const recorder = new PatchRecorder();
    replaceRaster(recorder, nl.id, crop);
    const added = addLayer(st.doc!, nl, l.parentId ? undefined : l.id);
    if ("error" in added) throw new Error(added.error);
    st.selected = nl.id;
    commit(added.doc, "New layer from mask", recorder.finish());
  });
}

// ── crop, resize, trace ─────────────────────────────────────────────────────

function applyCrop(): void {
  const d = st.doc;
  if (!d || !st.crop) return;
  const r = cropDoc(d, st.crop);
  if ("error" in r) { setStatus(r.error, "error"); return; }
  st.crop = null;
  commit(r.doc, "Crop");
  fitToStage();
  requestDraw();
}

/** Resize the whole document. Every raster and mask is resampled in the worker BEFORE any tile changes,
 *  so a cancel leaves the document untouched. `overrides` supplies ready pixels for a layer (AI upscale). */
async function resizeDoc(width: number, height: number, overrides = new Map<string, RasterData>()): Promise<void> {
  const d = st.doc!;
  const next = scaleDocStructure(d, width, height);
  for (const id of Object.keys(next.layers)) {
    const l = next.layers[id]!;
    if (l.kind === "raster" && (l.width > DESIGN_LIMITS.maxSide || l.height > DESIGN_LIMITS.maxSide || l.width * l.height > DESIGN_LIMITS.maxRasterPixels)) throw new Error(`Layer pixels would exceed ${DESIGN_LIMITS.maxSide} px a side or the pixel budget.`);
  }
  const rasters: [string, RasterData][] = [];
  const masks: [string, MaskData][] = [];
  const ids = Object.keys(d.layers).filter((id) => d.layers[id]!.kind === "raster");
  const maskIds = Object.keys(d.masks);
  const total = ids.length + maskIds.length;
  let done = 0;
  for (const id of ids) {
    const l = d.layers[id] as RasterLayer, nl = next.layers[id] as RasterLayer;
    paintProgress(done++ / total, `layer ${done} / ${total}`);
    let src = overrides.get(id) ?? readRect(store, id, l.width, l.height, { x: 0, y: 0, w: l.width, h: l.height });
    if (src.width !== nl.width || src.height !== nl.height) src = await worker.run<RasterData>({ op: "resample", src, width: nl.width, height: nl.height }, { transfer: [src.rgba.buffer as ArrayBuffer] });
    if (st.cancelRequested) throw new DesignCancelled();
    rasters.push([id, src]);
  }
  for (const id of maskIds) {
    const m = d.masks[id]!, nm = next.masks[id]!;
    paintProgress(done++ / total, `mask ${done} / ${total}`);
    const a = readMaskRect(store, `mask:${id}`, m.width, m.height, { x: 0, y: 0, w: m.width, h: m.height });
    const rgba = new Uint8ClampedArray(a.width * a.height * 4);
    for (let i = 0; i < a.alpha.length; i++) rgba[i * 4 + 3] = a.alpha[i]!;
    const out = await worker.run<RasterData>({ op: "resample", src: { width: a.width, height: a.height, rgba }, width: nm.width, height: nm.height }, { transfer: [rgba.buffer as ArrayBuffer] });
    if (st.cancelRequested) throw new DesignCancelled();
    const alpha = new Uint8Array(out.width * out.height);
    for (let i = 0; i < alpha.length; i++) alpha[i] = out.rgba[i * 4 + 3]!;
    masks.push([id, { width: out.width, height: out.height, alpha }]);
  }
  const recorder = new PatchRecorder();
  for (const [id, r] of rasters) replaceRaster(recorder, id, r);
  for (const [id, m] of masks) replaceMask(recorder, `mask:${id}`, m);
  commit(next, `Resize to ${width} x ${height}`, recorder.finish());
  fitToStage();
}

async function resizeFromForm(): Promise<void> {
  const d = st.doc;
  if (!d) return;
  const w = Number(q<HTMLInputElement>("[data-dsn-resize-w]")?.value), h = Number(q<HTMLInputElement>("[data-dsn-resize-h]")?.value);
  const plan = planResize(d.width, d.height, st.keepAspect ? { width: w !== d.width ? w : undefined, height: w === d.width ? h : undefined, keepAspect: true } : { width: w, height: h, keepAspect: false });
  if ("error" in plan) { setStatus(plan.error, "error"); return; }
  if (plan.width === d.width && plan.height === d.height) { setStatus("That is already the size."); return; }
  await busyRun("Resize", () => resizeDoc(plan.width, plan.height));
}

async function traceToVector(): Promise<void> {
  const d = st.doc;
  const l = d?.layers[st.selected];
  if (!d || !l || l.kind !== "raster") { setStatus("Select a raster layer to trace.", "error"); return; }
  await busyRun("Trace to vector", async () => {
    const src = readRect(store, l.id, l.width, l.height, { x: 0, y: 0, w: l.width, h: l.height });
    const shapes = await worker.run<VShape[]>({ op: "trace", src, colors: Math.max(2, Math.min(64, st.traceColors)), minArea: 8, tolerance: 1 }, { transfer: [src.rgba.buffer as ArrayBuffer], onProgress: progressCb });
    addVectorFromShapes(shapes, `${l.name} (traced)`, l, "Trace to vector");
  });
}

function addVectorFromShapes(shapes: VShape[], name: string, like: Layer, label: string): void {
  const v: VectorLayer = { ...vectorLayer(name), x: like.x, y: like.y, scale: like.scale, rotation: like.rotation, anchorX: like.anchorX, anchorY: like.anchorY, shapes: shapes.slice(0, DESIGN_LIMITS.maxShapes), meta: { source: "user" } };
  const added = addLayer(st.doc!, v, like.parentId ? undefined : like.id);
  if ("error" in added) throw new Error(added.error);
  st.selected = v.id;
  commit(added.doc, label);
  setStatus(`${label}: ${v.shapes.length} shape(s).`, "ok");
}

// ── vector drawing ───────────────────────────────────────────────────────────

function paint(forText = false): VShape["paint"] {
  const fill = st.fillNone ? null : st.fill;
  const stroke = st.strokeNone ? null : st.stroke;
  return forText ? { fill: fill ?? stroke ?? "#000000", stroke: null, strokeWidth: 0, opacity: st.paintOpacity } : { fill, stroke, strokeWidth: st.strokeWidth, opacity: st.paintOpacity, lineCap: "round", lineJoin: "round" };
}

/** The vector layer new shapes go into: the selected unlocked vector layer, else a new one. */
function vectorTarget(): { doc: DesignDoc; layer: VectorLayer; inv: Mat } | null {
  const d = st.doc;
  if (!d) return null;
  const sel = d.layers[st.selected];
  if (sel?.kind === "vector" && !sel.locked) {
    const m = selectedItemWorld(sel.id);
    const inv = m ? invertMat(m) : null;
    if (inv) return { doc: d, layer: sel, inv };
  }
  const v = vectorLayer(`Vector ${Object.keys(d.layers).filter((id) => d.layers[id]!.kind === "vector").length + 1}`);
  const added = addLayer(d, v);
  if ("error" in added) { setStatus(added.error, "error"); return null; }
  st.selected = v.id;
  return { doc: added.doc, layer: v, inv: [1, 0, 0, 1, 0, 0] };
}

function addShapeDoc(build: (toLayer: (p: Pt) => Pt) => VShape | null, label: string): void {
  const prevSel = st.selected;
  const t = vectorTarget();
  if (!t) return;
  const shape = build((p) => applyMat(t.inv, p.x, p.y));
  if (!shape || t.layer.shapes.length >= DESIGN_LIMITS.maxShapes) {
    st.selected = prevSel;
    if (shape) setStatus(`A layer holds at most ${DESIGN_LIMITS.maxShapes} shapes.`, "error");
    drawOverlay();
    return;
  }
  st.shapeId = shape.id;
  commit(replaceLayer(t.doc, { ...t.layer, shapes: [...t.layer.shapes, shape] }), label);
}

function finishPen(closed: boolean): void {
  const anchors = st.pen;
  st.pen = [];
  if (anchors.length < 2) { requestDraw(); return; }
  addShapeDoc((toLayer) => {
    const local = anchors.map((a) => ({ ...toLayer(a), ...(a.hin ? { hin: toLayer(a.hin) } : {}), ...(a.hout ? { hout: toLayer(a.hout) } : {}) }));
    const p = paint();
    return { id: newId("shape"), kind: "path", d: penToPath(local, closed), paint: closed ? p : { ...p, fill: null, stroke: p.stroke ?? p.fill ?? "#000000" } };
  }, "Pen path");
}

function updateSelectedShape(fn: (s: VShape) => VShape, label: string): void {
  const d = st.doc;
  const l = d?.layers[st.selected];
  if (!d || l?.kind !== "vector" || l.locked) return;
  const i = l.shapes.findIndex((s) => s.id === st.shapeId);
  if (i < 0) return;
  const shapes = l.shapes.slice();
  shapes[i] = fn(shapes[i]!);
  commit(replaceLayer(d, { ...l, shapes }), label);
}

let hitCtx: OffscreenCanvasRenderingContext2D | null = null;
function hitShape(l: VectorLayer, p: Pt): VShape | null {
  hitCtx ??= new OffscreenCanvas(1, 1).getContext("2d");
  if (!hitCtx) return null;
  for (let i = l.shapes.length - 1; i >= 0; i--) {
    const s = l.shapes[i]!;
    let lp = p;
    if (s.transform) { const inv = invertMat([...s.transform] as Mat); if (!inv) continue; lp = applyMat(inv, p.x, p.y); }
    if (s.kind === "text") {
      const b = textBounds(s);
      if (b && lp.x >= b.x && lp.x <= b.x + b.w && lp.y >= b.y && lp.y <= b.y + b.h) return s;
      continue;
    }
    const path = shapePath(s);
    if (!path) continue;
    hitCtx.lineWidth = Math.max(s.paint.strokeWidth, 8 / st.view.zoom);
    if ((s.paint.fill && hitCtx.isPointInPath(path, lp.x, lp.y)) || hitCtx.isPointInStroke(path, lp.x, lp.y)) return s;
  }
  return null;
}

function openTextInput(docPt: Pt, screen: Pt): void {
  const input = q<HTMLInputElement>("[data-dsn-text-in]");
  if (!input) return;
  input.hidden = false;
  input.value = "";
  input.style.left = `${screen.x}px`;
  input.style.top = `${screen.y - 14}px`;
  input.dataset.x = String(docPt.x);
  input.dataset.y = String(docPt.y);
  input.focus();
}

function commitTextInput(): void {
  const input = q<HTMLInputElement>("[data-dsn-text-in]");
  if (!input || input.hidden) return;
  input.hidden = true;
  const content = input.value.slice(0, DESIGN_MAX_TEXT);
  if (!content.trim()) return;
  const at = { x: Number(input.dataset.x), y: Number(input.dataset.y) };
  addShapeDoc((toLayer) => {
    const p = toLayer(at);
    return { id: newId("shape"), kind: "text", rect: { x: p.x, y: p.y, w: 0, h: 0 }, text: { content, size: Math.max(4, Math.min(2000, st.textSize)), family: st.textFamily }, paint: paint(true) };
  }, "Text");
}

// ── pointer handling ─────────────────────────────────────────────────────────

type Drag =
  | { kind: "pan"; sx: number; sy: number; panX: number; panY: number }
  | { kind: "move"; id: string; start: Pt; origX: number; origY: number; motion: boolean; docBefore: DesignDoc }
  | StrokeDrag
  | { kind: "crop"; start: Pt }
  | { kind: "shape"; tool: "rect" | "ellipse" | "line"; start: Pt; cur: Pt }
  | { kind: "freehand"; pts: { x: number; y: number; p: number }[] }
  | { kind: "shape-move"; start: Pt; orig: VShape; docBefore: DesignDoc }
  | { kind: "node"; ref: NodeRef | { corner: Corner }; docBefore: DesignDoc; inv: Mat }
  | { kind: "pen"; anchor: PenAnchor; start: Pt };
let dragState: Drag | null = null;

function eventPoint(e: PointerEvent | WheelEvent | MouseEvent): { screen: Pt; doc: Pt } {
  const target = q<HTMLCanvasElement>("[data-dsn-overlay]");
  const r = target?.getBoundingClientRect();
  const screen = { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  return { screen, doc: screenToDoc(st.view, screen.x, screen.y) };
}

/** Live preview of a layer move: the doc is replaced without a history step until pointerup. */
function previewMove(drag: Extract<Drag, { kind: "move" }>, p: Pt): void {
  const d = drag.docBefore;
  const l = d.layers[drag.id];
  if (!l) return;
  const nx = Math.round(drag.origX + p.x - drag.start.x), ny = Math.round(drag.origY + p.y - drag.start.y);
  if (drag.motion) {
    const r = applyOps(d, [{ op: "keyframe", id: l.id, prop: "x", t: st.time, v: nx }, { op: "keyframe", id: l.id, prop: "y", t: st.time, v: ny }], "user");
    st.doc = r.doc;
  } else st.doc = replaceLayer(d, { ...l, x: nx, y: ny });
}

function onPointerDown(e: PointerEvent): void {
  const d = st.doc;
  const over = e.currentTarget as HTMLCanvasElement;
  if (!d || st.busy) return;
  const { screen, doc: p } = eventPoint(e);
  over.setPointerCapture(e.pointerId);
  if (e.button === 1 || st.spaceDown) {
    dragState = { kind: "pan", sx: screen.x, sy: screen.y, panX: st.view.panX, panY: st.view.panY };
    return;
  }
  if (e.button !== 0) return;
  commitTextInput();
  const sel = d.layers[st.selected];
  switch (st.tool) {
    case "move": {
      if (!sel || sel.locked) { setStatus("Select an unlocked layer to move.", "error"); return; }
      const motion = st.mode === "motion" && st.autoKey;
      const s = motion ? layerStateAt(d, sel.id, st.time) : sel;
      dragState = { kind: "move", id: sel.id, start: p, origX: s.x, origY: s.y, motion, docBefore: d };
      return;
    }
    case "brush":
    case "eraser": {
      const { doc, rec } = ensureActiveMask(d);
      const base = st.tool === "eraser" ? "subtract" : st.brushMode;
      const mode = e.altKey ? (base === "add" ? "subtract" : "add") : base;
      const drag: StrokeDrag = { kind: "stroke", rec, stroke: { points: [{ x: p.x, y: p.y, p: e.pressure || 0.5 }], radius: radius(), hardness: st.hardness, mode }, last: p, recorder: new PatchRecorder(), docBefore: d, docAfter: doc, dirty: null };
      try { paintSegment(drag, p, p); } catch (err) { setStatus(err instanceof Error ? err.message : String(err), "error"); return; }
      // Show the (possibly new) mask record while painting; finishStroke turns this into one undo step.
      st.doc = doc;
      dragState = drag;
      requestDraw();
      return;
    }
    case "wand": void wandAt(p, e.altKey); return;
    case "crop": dragState = { kind: "crop", start: p }; st.crop = null; return;
    case "rect": case "ellipse": case "line": dragState = { kind: "shape", tool: st.tool, start: p, cur: p }; return;
    case "freehand": dragState = { kind: "freehand", pts: [{ x: p.x, y: p.y, p: e.pressure || 0.5 }] }; return;
    case "text": openTextInput(p, screen); return;
    case "pen": {
      const first = st.pen[0];
      if (first && st.pen.length > 2 && Math.hypot((first.x - p.x) * st.view.zoom, (first.y - p.y) * st.view.zoom) < 8) { finishPen(true); return; }
      const anchor: PenAnchor = { x: p.x, y: p.y };
      st.pen.push(anchor);
      dragState = { kind: "pen", anchor, start: p };
      requestDraw();
      return;
    }
    case "select":
    case "node": {
      if (sel?.kind !== "vector") {
        // Pick the topmost vector layer under the pointer.
        const hit = [...paintList(d)].reverse().find((it) => {
          const l = d.layers[it.id];
          if (l?.kind !== "vector" || !it.visible) return false;
          const inv = invertMat(layerWorld(d, it, st.time).m);
          return !!inv && !!hitShape(l, applyMat(inv, p.x, p.y));
        });
        if (hit) { st.selected = hit.id; st.shapeId = ""; }
      }
      const l = d.layers[st.selected];
      if (l?.kind !== "vector") { st.shapeId = ""; paintAll(); return; }
      const m = selectedItemWorld(l.id);
      const inv = m ? invertMat(m) : null;
      if (!inv) return;
      const lp = applyMat(inv, p.x, p.y);
      const shape = selectedShape();
      if (st.tool === "node" && shape && !l.locked) {
        const sInv = shape.transform ? invertMat([...shape.transform] as Mat) : null;
        const sp = sInv ? applyMat(sInv, lp.x, lp.y) : lp;
        const tol = 8 / st.view.zoom;
        if (shape.d) {
          const ref = hitNode(pathNodes(shape.d), sp.x, sp.y, tol);
          if (ref) { dragState = { kind: "node", ref, docBefore: d, inv: sInv ? mulMat2(sInv, inv) : inv }; return; }
        } else if (shape.rect && shape.kind !== "text") {
          const k = rectCorners(shape.rect).find((c) => Math.hypot(c.x - sp.x, c.y - sp.y) <= tol);
          if (k) { dragState = { kind: "node", ref: { corner: k.corner }, docBefore: d, inv: sInv ? mulMat2(sInv, inv) : inv }; return; }
        }
      }
      const hit = hitShape(l, lp);
      st.shapeId = hit?.id ?? "";
      if (hit && !l.locked) dragState = { kind: "shape-move", start: lp, orig: hit, docBefore: d };
      paintAll();
      return;
    }
  }
}

function onPointerMove(e: PointerEvent): void {
  const { screen, doc: p } = eventPoint(e);
  st.cursor = screen;
  const drag = dragState;
  if (!drag) { if (st.tool === "brush" || st.tool === "eraser" || st.pen.length) drawOverlay(); return; }
  switch (drag.kind) {
    case "pan":
      st.view = { ...st.view, panX: drag.panX + screen.x - drag.sx, panY: drag.panY + screen.y - drag.sy };
      requestDraw();
      return;
    case "move": previewMove(drag, p); requestDraw(); return;
    case "stroke": {
      const step = Math.max(1, drag.stroke.radius / 4);
      if (Math.hypot(p.x - drag.last.x, p.y - drag.last.y) < step) { drawOverlay(); return; }
      try { paintSegment(drag, drag.last, p); } catch (err) { setStatus(err instanceof Error ? err.message : String(err), "error"); }
      drag.stroke.points.push({ x: p.x, y: p.y, p: e.pressure || 0.5 });
      drag.last = p;
      requestDraw();
      return;
    }
    case "crop": {
      const a = drag.start;
      st.crop = normRect(Math.round(a.x), Math.round(a.y), Math.round(p.x), Math.round(p.y));
      drawOverlay();
      return;
    }
    case "shape": drag.cur = p; drawOverlay(); return;
    case "freehand": drag.pts.push({ x: p.x, y: p.y, p: e.pressure || 0.5 }); drawOverlay(); return;
    case "pen": {
      if (Math.hypot((p.x - drag.start.x) * st.view.zoom, (p.y - drag.start.y) * st.view.zoom) > 3) {
        const smooth = smoothAnchor(drag.start, p);
        drag.anchor.hin = smooth.hin; drag.anchor.hout = smooth.hout;
      }
      drawOverlay();
      return;
    }
    case "shape-move": {
      const l = drag.docBefore.layers[st.selected];
      const m = selectedItemWorld(st.selected);
      const inv = m ? invertMat(m) : null;
      if (l?.kind !== "vector" || !inv) return;
      const lp = applyMat(inv, p.x, p.y);
      st.doc = replaceLayer(drag.docBefore, { ...l, shapes: l.shapes.map((s) => (s.id === drag.orig.id ? translateShape(drag.orig, lp.x - drag.start.x, lp.y - drag.start.y) : s)) });
      requestDraw();
      return;
    }
    case "node": {
      const l = drag.docBefore.layers[st.selected];
      if (l?.kind !== "vector") return;
      const sp = applyMat(drag.inv, p.x, p.y);
      st.doc = replaceLayer(drag.docBefore, {
        ...l,
        shapes: l.shapes.map((s) => {
          if (s.id !== st.shapeId) return s;
          if ("corner" in drag.ref) return s.rect ? { ...s, rect: moveRectCorner(s.rect, drag.ref.corner, sp.x, sp.y) } : s;
          return s.d ? { ...s, d: moveNode(s.d, drag.ref, sp.x, sp.y) } : s;
        }),
      });
      requestDraw();
      return;
    }
  }
}

/** Engine helpers throw on out-of-range input (stroke caps, budget); a gesture never ends in an uncaught error. */
function onPointerUp(e: PointerEvent): void {
  try { finishGesture(e); }
  catch (err) {
    setStatus(err instanceof DesignBudgetError ? "The tile budget is full; that edit was not applied." : err instanceof Error ? err.message : String(err), "error");
    paintAll();
  }
}

function finishGesture(e: PointerEvent): void {
  const drag = dragState;
  dragState = null;
  if (!drag) return;
  const { doc: p } = eventPoint(e);
  switch (drag.kind) {
    case "move": {
      const after = st.doc!;
      st.doc = drag.docBefore;
      if (after !== drag.docBefore) commit(after, drag.motion ? "Key position" : "Move layer");
      return;
    }
    case "stroke": finishStroke(drag); return;
    case "crop": paintSide(); drawOverlay(); return;
    case "shape": {
      const a = drag.start, b = p;
      if (Math.hypot((b.x - a.x) * st.view.zoom, (b.y - a.y) * st.view.zoom) < 3) { drawOverlay(); return; }
      addShapeDoc((toLayer) => {
        const la = toLayer(a), lb = toLayer(b);
        if (drag.tool === "line") return { id: newId("shape"), kind: "path", d: [{ c: "M", x: la.x, y: la.y }, { c: "L", x: lb.x, y: lb.y }], paint: { ...paint(), fill: null, stroke: st.strokeNone ? st.fill : st.stroke } };
        return { id: newId("shape"), kind: drag.tool, rect: normRect(la.x, la.y, lb.x, lb.y), paint: paint() };
      }, drag.tool === "rect" ? "Rectangle" : drag.tool === "ellipse" ? "Ellipse" : "Line");
      return;
    }
    case "freehand": {
      const pts = drag.pts.slice(0, DESIGN_MAX_POINTS_PER_STROKE);
      if (pts.length < 2) { drawOverlay(); return; }
      addShapeDoc((toLayer) => {
        const local = pts.map((q0) => ({ ...toLayer(q0), p: q0.p }));
        const color = st.strokeNone ? st.fill : st.stroke;
        if (st.freehandMode === "ink") {
          const outline = getStroke(local.map((q0) => [q0.x, q0.y, q0.p]), { size: Math.max(2, st.strokeWidth * 2), thinning: 0.5, smoothing: 0.5, streamline: 0.5 });
          if (outline.length < 3) return null;
          return { id: newId("shape"), kind: "path", d: strokeToPath(outline), paint: { fill: color, stroke: null, strokeWidth: 0, opacity: st.paintOpacity } };
        }
        const cmds = fitBezier(local.map((q0) => ({ x: q0.x, y: q0.y })), Math.max(0.5, 2 / st.view.zoom));
        if (!cmds.length) return null;
        return { id: newId("shape"), kind: "path", d: cmds, paint: { ...paint(), fill: null, stroke: color } };
      }, "Freehand");
      return;
    }
    case "pen": drawOverlay(); return;
    case "shape-move":
    case "node": {
      const after = st.doc!;
      st.doc = drag.docBefore;
      if (after !== drag.docBefore) commit(after, drag.kind === "node" ? "Edit nodes" : "Move shape");
      else paintAll();
      return;
    }
    case "pan": return;
  }
}

function onWheel(e: WheelEvent): void {
  if (!st.doc) return;
  e.preventDefault();
  const { screen } = eventPoint(e);
  if (e.shiftKey && (st.tool === "brush" || st.tool === "eraser")) {
    st.brushSize = stepBrush(st.brushSize, e.deltaY < 0 || e.deltaX < 0 ? 1 : -1);
    syncBrushControls();
    drawOverlay();
    return;
  }
  if (e.ctrlKey || e.metaKey) {
    st.view = zoomAbout(st.view, st.view.zoom * Math.exp(-e.deltaY * 0.0015), screen.x, screen.y);
    paintBar();
    requestDraw();
    return;
  }
  st.view = { ...st.view, panX: st.view.panX - e.deltaX, panY: st.view.panY - e.deltaY };
  requestDraw();
}

function syncBrushControls(): void {
  const val = q("[data-dsn-brush-val]");
  if (val) val.textContent = `${st.brushSize} px`;
  const slider = q<HTMLInputElement>("[data-dsn-brush-size]");
  if (slider) slider.value = String(Math.round((Math.log(Math.max(1, st.brushSize)) / Math.log(2000)) * 1000));
}

// ── motion ───────────────────────────────────────────────────────────────────

const timelineHost = {
  doc: () => st.doc,
  time: () => st.time,
  playing: () => st.playing,
  selectedLayer: () => st.selected,
  selectedKey: () => st.selKey,
  setTime(t: number) {
    st.time = Math.max(0, Math.min(st.doc?.timeline.durationMs ?? 0, t));
    const tl = q("[data-dsn-timeline]");
    if (tl && st.doc) movePlayhead(tl, st.time, st.doc.timeline.durationMs);
    requestDraw();
  },
  togglePlay() { if (st.playing) stopPlay(); else startPlay(); },
  selectLayer(id: string) { st.selected = id; st.selKey = null; paintAll(); },
  selectKey(k: KeyRef | null) { st.selKey = k; if (k) st.selected = k.layerId; paintSide(); },
  addKey(layerId: string, prop: AnimProp, t: number) {
    const d = st.doc;
    if (!d) return;
    const v = layerStateAt(d, layerId, t)[prop];
    st.selKey = { layerId, prop, t };
    st.selected = layerId;
    userOps([{ op: "keyframe", id: layerId, prop, t, v }], "Add keyframe");
  },
  moveKey(k: KeyRef, toT: number) {
    if (!st.doc) return;
    const t = Math.round(Math.min(st.doc.timeline.durationMs, Math.max(0, toT)));
    st.selKey = { ...k, t };
    commit(moveKey(st.doc, k.layerId, k.prop, k.t, t), "Move keyframe");
  },
  deleteKey(k: KeyRef) { if (st.doc) { st.selKey = null; commit(deleteKey(st.doc, k.layerId, k.prop, k.t), "Delete keyframe"); } },
  setKeyEase(k: KeyRef, ease: Ease) { if (st.doc) commit(setKey(st.doc, k.layerId, k.prop, k.t, { ease }), "Keyframe easing"); },
  setKeyValue(k: KeyRef, v: number) { if (st.doc) commit(setKey(st.doc, k.layerId, k.prop, k.t, { v }), "Keyframe value"); },
  setTimeline(patch: { fps?: number; durationMs?: number; loop?: boolean }) { if (st.doc) commit(setTimeline(st.doc, patch), "Timeline settings"); },
};

function startPlay(): void {
  const d = st.doc;
  if (!d || st.playing) return;
  st.playing = true;
  let last = performance.now();
  if (st.time >= d.timeline.durationMs - 1) st.time = 0;
  const tick = (now: number) => {
    const doc = st.doc;
    if (!st.playing || !doc || !root?.isConnected) { st.playing = false; return; }
    st.time += now - last;
    last = now;
    if (st.time >= doc.timeline.durationMs) {
      if (doc.timeline.loop) st.time %= doc.timeline.durationMs;
      else { st.time = doc.timeline.durationMs; stopPlay(); }
    }
    const shown = snapToFrame(st.time, doc.timeline.fps);
    const tl = q("[data-dsn-timeline]");
    if (tl) movePlayhead(tl, shown, doc.timeline.durationMs);
    drawAt(shown);
    if (st.playing) playRaf = requestAnimationFrame(tick);
  };
  playRaf = requestAnimationFrame(tick);
  paintTimeline();
}

function drawAt(t: number): void {
  const saved = st.time;
  st.time = t;
  drawNow();
  st.time = saved;
}

function stopPlay(): void {
  st.playing = false;
  cancelAnimationFrame(playRaf);
  if (st.doc) st.time = snapToFrame(st.time, st.doc.timeline.fps);
  paintTimeline();
  requestDraw();
}

// ── DGX vision ───────────────────────────────────────────────────────────────

async function refreshDgx(): Promise<void> {
  const v = await bridge.creatorStudio();
  const p = v?.providers.find((x) => x.id === "dgx-vision");
  if (!p) { st.dgx = { verdict: null, endpointId: "", reason: v ? "dgx-vision is not in the provider registry of this engine." : "The Creator registry did not answer." }; paintSide(); return; }
  const eps = (p.endpoints ?? []).filter((e) => e.enabled);
  const ep = eps.find((e) => e.cui?.allowed !== false) ?? eps[0];
  const verdict = ep?.cui && ep.cui.allowed === false ? ep.cui : p.cui ?? null;
  st.dgx = { verdict: verdict ?? { posture: "unknown", allowed: false, reason: "posture unknown (an older engine)" }, endpointId: ep?.id ?? "", reason: "" };
  paintSide();
}

function requireDgx(): boolean {
  if (dgxAllowed()) return true;
  setStatus(dgxReasonText(st.dgx), "error");
  return false;
}

async function vision(op: VisionOp, body: Record<string, unknown>): Promise<unknown> {
  const r = await bridge.visionCall(op, { ...(st.dgx.endpointId ? { endpointId: st.dgx.endpointId } : {}), ...body });
  if (!r.ok) {
    if (r.cui) st.dgx = { ...st.dgx, verdict: r.cui };
    throw new Error(r.error ?? "The DGX vision route refused.");
  }
  return r.data;
}

const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

async function pollJob(jobId: string): Promise<unknown> {
  for (let i = 0; i < 3600; i++) {
    if (st.cancelRequested) throw new DesignCancelled();
    const r = await bridge.visionJob(jobId);
    if (!r.ok || !r.data) throw new Error(r.error ?? "The vision job did not answer.");
    const s = r.data.state;
    paintProgress(typeof r.data.progress === "number" ? r.data.progress : null, r.data.message ? cleanText(r.data.message, 120) : s);
    if (s === "done" || s === "succeeded" || s === "completed") return r.data.result;
    if (s === "failed" || s === "error" || s === "cancelled" || s === "refused") throw new Error(r.data.error ? cleanText(r.data.error, 300) : `The vision job ${s}.`);
    await sleep(1000);
  }
  throw new Error("The vision job did not finish within an hour.");
}

/** The visible document flattened at the playhead, as PNG base64 (the image the user sees). */
async function flattenB64(): Promise<string> {
  const { scene, transfer } = buildScene(st.doc!, store);
  const png = await worker.run<Uint8Array>({ op: "png", scene, t: st.time }, { transfer, onProgress: progressCb });
  return bytesToB64(png);
}

async function layerPngB64(l: RasterLayer): Promise<string> {
  const src = readRect(store, l.id, l.width, l.height, { x: 0, y: 0, w: l.width, h: l.height });
  return bytesToB64(await worker.run<Uint8Array>({ op: "encodePng", src }, { transfer: [src.rgba.buffer as ArrayBuffer] }));
}

/** Decode a returned PNG and check its size before it touches the document. */
async function decodePng(b64: string, w: number, h: number, what: string): Promise<RasterData> {
  const bytes = b64ToBytes(b64);
  if (!bytes) throw new Error(`The ${what} was not valid base64.`);
  const dec = await decodeBytes(bytes, `The ${what}`);
  if (dec.width !== w || dec.height !== h) throw new Error(`The ${what} is ${dec.width} x ${dec.height}, expected ${w} x ${h}. Nothing was changed.`);
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (const s of dec.strips) rgba.set(s.rgba, s.y * w * 4);
  return { width: w, height: h, rgba };
}

/** A returned mask (8-bit L from dgx-vision, or any PNG colour type) as one coverage value per pixel.
 *  Decoded by design_png.ts in the worker, never through canvas, so no RGBA stride or colour handling
 *  can touch the samples; the size must match exactly. */
async function decodeMaskPng(b64: string, w: number, h: number, what: string): Promise<MaskData> {
  const bytes = b64ToBytes(b64);
  if (!bytes) throw new Error(`The ${what} was not valid base64.`);
  const info = sniffImage(bytes);
  if (info.format !== "png") throw new Error(`The ${what} is not a PNG.`);
  const refusal = checkDecodeBudget(info, DESIGN_LIMITS.maxRasterPixels);
  if (refusal) throw new Error(`The ${what} was refused before decoding: ${refusal}.`);
  const buf = bytes.buffer as ArrayBuffer;
  try {
    return await worker.run<MaskData>({ op: "decodeMask", bytes: buf, width: w, height: h }, { transfer: [buf] });
  } catch (e) {
    if (e instanceof DesignCancelled) throw e;
    throw new Error(`The ${what} could not be used: ${e instanceof Error ? e.message : String(e)} Nothing was changed.`);
  }
}

async function refineMask(maskId: string, strokes: BrushStroke[]): Promise<void> {
  if (!requireDgx()) return;
  const d = st.doc;
  const rec = d?.masks[maskId];
  if (!d || !rec) { setStatus("That mask is gone.", "error"); return; }
  if (rec.x !== 0 || rec.y !== 0 || rec.width !== d.width || rec.height !== d.height) { setStatus("Refine needs a mask that covers the canvas (trace a new one after a crop or resize).", "error"); return; }
  await busyRun("Refine mask (DGX)", async () => {
    const prompts = strokesToPrompts(strokes, 64);
    const image = await flattenB64();
    const mask = readMaskRect(store, `mask:${rec.id}`, rec.width, rec.height, { x: 0, y: 0, w: rec.width, h: rec.height });
    const maskPng = await worker.run<Uint8Array>({ op: "maskPng", mask }, { transfer: [mask.alpha.buffer as ArrayBuffer] });
    const res = await vision("segment", { image: { dataB64: image }, positive: prompts.positive, negative: prompts.negative, ...(prompts.box.some((n) => n !== 0) ? { box: prompts.box } : {}), maskB64: bytesToB64(maskPng), multimask: false });
    if (!isVisionSegment(res)) throw new Error("The segment reply was not a mask.");
    const next = await decodeMaskPng(res.maskB64, rec.width, rec.height, "refined mask");
    const recorder = new PatchRecorder();
    replaceMask(recorder, `mask:${rec.id}`, next);
    st.activeMaskId = rec.id;
    // The refined mask IS the hint's mask: any hint already on it gets the refined bbox and area, and a
    // hint created next from the pending form reads the whole refined mask (not just the traced region).
    const bb = maskBBox(next);
    const area = maskArea(next);
    const bbox = bb ? { x: rec.x + bb.x, y: rec.y + bb.y, w: bb.w, h: bb.h } : { x: 0, y: 0, w: 0, h: 0 };
    const cur = st.doc!;
    const after = cur.hints.some((h) => h.maskId === rec.id) ? { ...cloneDoc(cur), hints: cur.hints.map((h) => (h.maskId === rec.id ? { ...h, bbox, area } : h)) } : cur;
    st.traceRect = null;
    commit(after, "Refine mask (DGX)", recorder.finish());
    setStatus(`Mask refined by dgx-vision (score ${Math.round(res.score * 100) / 100}).`, "ok");
  });
}

async function runDecompose(params: Record<string, number | string | boolean> = {}): Promise<void> {
  if (!requireDgx() || !st.doc) return;
  await busyRun("Decompose (DGX)", async () => {
    const image = await flattenB64();
    const maxLayers = Math.max(2, Math.min(32, Number(params.maxLayers) || 12));
    const mode = params.mode === "generative" ? "generative" : "fast";
    const start = await vision("decompose", { image: { dataB64: image }, maxLayers, mode, fillBackground: true });
    if (!isVisionJobStart(start)) throw new Error("The decompose reply had no job id.");
    const result = parseDecompose(await pollJob(start.jobId));
    if (!result) throw new Error("The decompose result was malformed. Nothing was changed.");
    const d = st.doc!;
    const recorder = new PatchRecorder();
    const children: string[] = [];
    let next = d;
    const groupId = newId("group");
    if (result.background) {
      const bg = await decodePng(result.background.pngB64, d.width, d.height, "background");
      const l = rasterLayer("Background (DGX)", d.width, d.height, 0, 0, { source: "decompose" });
      l.parentId = groupId;
      replaceRaster(recorder, l.id, bg);
      next = replaceLayer(next, l);
      children.push(l.id);
    }
    // Far first (bottom), near last (top).
    const ordered = [...result.layers].sort((a, b) => b.depth - a.depth);
    for (let i = 0; i < ordered.length; i++) {
      const dl = ordered[i]!;
      paintProgress(i / ordered.length, `layer ${i + 1} / ${ordered.length}`);
      const px = await decodePng(dl.pngB64, dl.width, dl.height, `layer ${i + 1}`);
      const l = rasterLayer(`Layer ${i + 1}`, dl.width, dl.height, dl.x, dl.y, {
        source: "decompose", ...(dl.label ? { label: dl.label, labelSource: "model" as const } : {}),
        confidence: dl.confidence, depth: dl.depth, bbox: { x: dl.x, y: dl.y, w: dl.width, h: dl.height }, area: dl.area,
      });
      l.parentId = groupId;
      replaceRaster(recorder, l.id, px);
      next = replaceLayer(next, l);
      children.push(l.id);
    }
    const group: Layer = { ...baseLayer("Decomposed (DGX)", d.width, d.height), id: groupId, kind: "group", children, meta: { source: "decompose" } };
    const added = addLayer(next, group);
    if ("error" in added) throw new Error(added.error);
    st.selected = groupId;
    commit(added.doc, "Decompose (DGX)", recorder.finish());
    setStatus(`Decomposed into ${ordered.length} layer(s)${result.background ? " plus a filled background" : ""}. Model labels are shown as untrusted chips.`, "ok");
  });
}

function targetRaster(target?: string): RasterLayer | null {
  const l = st.doc?.layers[target ?? st.selected];
  return l?.kind === "raster" ? l : null;
}

async function runMatte(target?: string): Promise<void> {
  if (!requireDgx()) return;
  const l = targetRaster(target);
  if (!l) { setStatus("Select a raster layer.", "error"); return; }
  const m = selectedItemWorld(l.id);
  const off = m ? integerTranslation(m) : null;
  if (!off) { setStatus("Remove background works on an unrotated, unscaled layer.", "error"); return; }
  await busyRun("Remove background (DGX)", async () => {
    const res = await vision("matte", { image: { dataB64: await layerPngB64(l) } });
    if (!isVisionMask(res)) throw new Error("The matte reply was not a mask.");
    const mask = await decodeMaskPng(res.maskB64, l.width, l.height, "matte");
    const rec: MaskRecord = { id: newId("mask"), x: off.dx, y: off.dy, width: l.width, height: l.height };
    const recorder = new PatchRecorder();
    replaceMask(recorder, `mask:${rec.id}`, mask);
    const cur = st.doc!.layers[l.id] as RasterLayer;
    commit(replaceLayer(addMask(st.doc!, rec), { ...cur, maskId: rec.id }), "Remove background (DGX)", recorder.finish());
    setStatus("Background removed as a layer mask (non-destructive; delete the layer mask by undoing).", "ok");
  });
}

async function runUpscale(target?: string, scaleParam?: number): Promise<void> {
  if (!requireDgx()) return;
  const l = targetRaster(target);
  const d = st.doc;
  if (!l || !d) { setStatus("Select a raster layer to upscale.", "error"); return; }
  const scale = [2, 4, 8].includes(Number(scaleParam)) ? Number(scaleParam) : st.upscale;
  const W = d.width * scale, H = d.height * scale;
  if (W > DESIGN_LIMITS.maxSide || H > DESIGN_LIMITS.maxSide) { setStatus(`A ${scale}x canvas would exceed ${DESIGN_LIMITS.maxSide} px a side.`, "error"); return; }
  await busyRun("AI upscale (DGX)", async () => {
    const start = await vision("upscale", { image: { dataB64: await layerPngB64(l) }, scale, tile: 512, overlap: 32 });
    if (!isVisionJobStart(start)) throw new Error("The upscale reply had no job id.");
    const res = await pollJob(start.jobId);
    if (!isUpscaleResult(res)) throw new Error("The upscale result was malformed. Nothing was changed.");
    if (!res.pngB64) { setStatus(`The upscaled image is too large to load here; it is in the Creator library${res.artifact ? ` (${res.artifact.id})` : ""}.`, "ok"); return; }
    const px = await decodePng(res.pngB64, res.width, res.height, "upscaled image");
    if (Math.abs(res.width - l.width * scale) > 1 || Math.abs(res.height - l.height * scale) > 1) throw new Error(`The upscaled image is ${res.width} x ${res.height}, not ${scale}x the layer. Nothing was changed.`);
    await resizeDoc(W, H, new Map([[l.id, px]]));
    setStatus(`Upscaled ${scale}x with dgx-vision; the other layers were resampled with Lanczos-3.`, "ok");
  });
}

async function runVectorize(target?: string): Promise<void> {
  if (!requireDgx()) return;
  const l = targetRaster(target);
  if (!l) { setStatus("Select a raster layer to vectorize.", "error"); return; }
  await busyRun("Vectorize (DGX)", async () => {
    const res = await vision("vectorize", { image: { dataB64: await layerPngB64(l) }, colors: 16, filterSpeckle: 4, mode: "spline" });
    if (!isVectorize(res)) throw new Error("The vectorize reply had no SVG.");
    const parsed = svgTextToNode(res.svg);
    if (!parsed.ok) throw new Error(parsed.error);
    const r = svgNodesToShapes(parsed.root);
    if (!r.shapes.length) throw new Error("The vectorized SVG had no drawable shapes.");
    addVectorFromShapes(r.shapes, `${l.name} (vectorized)`, l, "Vectorize (DGX)");
  });
}

async function runLabel(): Promise<void> {
  if (!requireDgx() || !st.doc) return;
  await busyRun("Label layers (DGX)", async () => {
    const d = st.doc!;
    const targets: { id: string; box: [number, number, number, number] }[] = [];
    for (const item of paintList(d)) {
      const l = d.layers[item.id];
      if (l?.kind !== "raster" || targets.length >= 64) continue;
      const off = integerTranslation(layerWorld(d, item, st.time).m);
      if (!off) continue;
      const b = l.meta?.bbox ?? { x: off.dx, y: off.dy, w: l.width, h: l.height };
      targets.push({ id: l.id, box: [b.x, b.y, b.x + b.w, b.y + b.h] });
    }
    if (!targets.length) throw new Error("No unrotated raster layer to label.");
    const labels = parseLabels(await vision("label", { image: { dataB64: await flattenB64() }, boxes: targets.map((t) => t.box) }));
    if (!labels) throw new Error("The label reply was malformed.");
    const iou = (a: number[], b: number[]) => {
      const ix = Math.max(0, Math.min(a[2]!, b[2]!) - Math.max(a[0]!, b[0]!)), iy = Math.max(0, Math.min(a[3]!, b[3]!) - Math.max(a[1]!, b[1]!));
      const inter = ix * iy, ua = (a[2]! - a[0]!) * (a[3]! - a[1]!) + (b[2]! - b[0]!) * (b[3]! - b[1]!) - inter;
      return ua > 0 ? inter / ua : 0;
    };
    let next = st.doc!;
    let n = 0;
    for (const t of targets) {
      const best = labels.map((lb) => ({ lb, s: iou(t.box, lb.box) })).sort((a, b) => b.s - a.s)[0];
      const l = next.layers[t.id];
      if (!best || best.s < 0.3 || !best.lb.text || !l || l.locked) continue;
      next = replaceLayer(next, { ...l, meta: { ...l.meta, label: best.lb.text, labelSource: "model", confidence: Math.max(0, Math.min(1, best.lb.score)) } });
      n++;
    }
    if (!n) { setStatus("dgx-vision returned no label that matched a layer."); return; }
    commit(next, "Label layers (DGX)");
    setStatus(`Labeled ${n} layer(s). Model labels are untrusted data and are marked as such for agents.`, "ok");
  });
}

// ── agent ops ────────────────────────────────────────────────────────────────

async function pushStateNow(): Promise<void> {
  const d = st.doc;
  if (!d) return;
  let thumbB64: string | undefined;
  try {
    const snap = viewport.snapshot(d, 256, st.time);
    thumbB64 = bytesToB64(new Uint8Array(await (await snap.convertToBlob({ type: "image/png" })).arrayBuffer()));
  } catch { thumbB64 = undefined; }
  const r = await bridge.designPushState({ doc: d, manifest: buildAgentManifest(d), ...(thumbB64 ? { thumbB64 } : {}) });
  if (!r.ok && root?.isConnected) setStatus(`Agents cannot see this document: ${r.error ?? "the state route refused it"}.`, "error");
}

async function pullOps(): Promise<void> {
  if (!root?.isConnected) { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } return; }
  const d = st.doc;
  if (!d || st.busy || dragState) return;
  const r = await bridge.designPullOps(st.opsSince);
  if (!r.ok || !r.data) return;
  for (const batch of r.data.ops) {
    if (batch.seq <= st.opsSince) continue;
    st.opsSince = batch.seq;
    const cur = st.doc;
    if (!cur || batch.docId !== cur.id) continue;
    const res = applyOps(cur, batch.ops, "agent");
    if (res.applied > 0) commit(res.doc, "Agent edit");
    for (const req of res.requests) {
      if (st.requests.length >= 32) break;
      st.requests.push({ key: `${batch.seq}-${st.requests.length}`, kind: req.kind, ...(req.target ? { target: cleanText(req.target, 64) } : {}), ...(req.params ? { params: req.params } : {}), op: req });
    }
    if (res.applied > 0 || res.requests.length) {
      showToast({
        title: "Agent edit",
        desc: `${res.applied} change${res.applied === 1 ? "" : "s"} applied${res.errors.length ? `, ${res.errors.length} refused` : ""}${res.requests.length ? `; ${res.requests.length} request${res.requests.length === 1 ? "" : "s"} waiting for your Allow` : ""}.`,
        tone: res.errors.length ? "warn" : "info",
        timeout: 5200,
        actions: res.applied > 0 ? [{ label: "Undo", run: () => undo() }] : [{ label: "OK" }],
      });
      paintAll();
    }
    void bridge.designAckOps({ seq: batch.seq, applied: res.applied, errors: res.errors.slice(0, 50).map((e) => cleanText(e, 300)) });
  }
  st.opsSince = Math.max(st.opsSince, r.data.latest);
}

async function allowRequest(key: string): Promise<void> {
  const i = st.requests.findIndex((r) => r.key === key);
  if (i < 0) return;
  const { op } = st.requests[i]!;
  st.requests.splice(i, 1);
  paintSide();
  switch (op.kind) {
    case "decompose": return runDecompose(op.params);
    case "segment-hint": {
      const h = st.doc?.hints.find((x) => x.id === op.target) ?? st.doc?.hints[st.doc.hints.length - 1];
      if (!h) { setStatus("The agent asked to refine a hint that does not exist.", "error"); return; }
      return refineMask(h.maskId, h.strokes);
    }
    case "matte": return runMatte(op.target);
    case "upscale": return runUpscale(op.target, Number(op.params?.scale));
    case "vectorize": return runVectorize(op.target);
    case "label": return runLabel();
  }
}

// ── events ───────────────────────────────────────────────────────────────────

function setMode(m: DesignMode): void {
  st.mode = m;
  if (!MODE_TOOLS[m].includes(st.tool)) st.tool = MODE_TOOLS[m][0]!;
  if (m !== "motion" && st.playing) stopPlay();
  paintAll();
}

function setTool(t: DesignTool): void {
  // A shortcut for another mode's tool (P in Image mode) switches to that mode.
  if (!MODE_TOOLS[st.mode].includes(t)) st.mode = (["image", "vector", "motion"] as const).find((m) => MODE_TOOLS[m].includes(t)) ?? st.mode;
  st.tool = t;
  if (t !== "pen") st.pen = [];
  if (t !== "crop") st.crop = null;
  const over = q<HTMLCanvasElement>("[data-dsn-overlay]");
  if (over) over.dataset.tool = t;
  paintAll();
}

function layerAction(t: HTMLElement): boolean {
  const d = st.doc;
  if (!d) return false;
  const attr = (name: string) => t.closest<HTMLElement>(`[${name}]`)?.getAttribute(name) ?? null;
  const vis = attr("data-dsn-layer-visible");
  if (vis) { const l = d.layers[vis]; if (l) userOps([{ op: "visible", id: vis, value: !l.visible }], l.visible ? "Hide layer" : "Show layer"); return true; }
  const lock = attr("data-dsn-layer-lock");
  if (lock) { const l = d.layers[lock]; if (l) commit(replaceLayer(d, { ...l, locked: !l.locked }), l.locked ? "Unlock layer" : "Lock layer"); return true; }
  const up = attr("data-dsn-layer-up");
  if (up) { const { index } = topLevelIndex(d, up); userOps([{ op: "reorder", id: up, index: index + 1 }], "Raise layer"); return true; }
  const down = attr("data-dsn-layer-down");
  if (down) { const { index } = topLevelIndex(d, down); if (index > 0) userOps([{ op: "reorder", id: down, index: index - 1 }], "Lower layer"); return true; }
  const del = attr("data-dsn-layer-delete");
  if (del) { userOps([{ op: "delete", id: del }], "Delete layer"); st.selected = ""; return true; }
  if (t.closest("[data-dsn-group]")) {
    const ids = [...st.multi].filter((id) => d.layers[id]);
    if (ids.length > 1) { userOps([{ op: "group", ids, name: "Group" }], "Group layers"); st.multi.clear(); }
    return true;
  }
  const ungroup = attr("data-dsn-ungroup");
  if (ungroup) { userOps([{ op: "ungroup", id: ungroup }], "Ungroup"); st.selected = ""; return true; }
  return false;
}

function selectLayerRow(id: string, additive: boolean): void {
  if (additive) { if (st.multi.has(id)) st.multi.delete(id); else st.multi.add(id); }
  else { st.multi.clear(); st.multi.add(id); }
  st.selected = id;
  st.shapeId = "";
  paintAll();
}

function guarded<E extends Event>(fn: (e: E) => void): (e: E) => void {
  return (e) => {
    try { fn(e); }
    catch (err) { setStatus(err instanceof Error ? err.message : String(err), "error"); paintAll(); }
  };
}

function onClick(e: MouseEvent): void {
  const t = e.target as HTMLElement;
  const has = (a: string) => !!t.closest(`[${a}]`);
  const mode = t.closest<HTMLElement>("[data-dsn-mode]")?.dataset.dsnMode;
  if (mode === "image" || mode === "vector" || mode === "motion") { setMode(mode); return; }
  const tool = t.closest<HTMLElement>("[data-dsn-tool]")?.dataset.dsnTool as DesignTool | undefined;
  if (tool && (Object.values(MODE_TOOLS).flat() as string[]).includes(tool)) { setTool(tool); return; }
  if (has("data-dsn-new")) { st.newForm = true; paintSide(); return; }
  if (has("data-dsn-new-cancel")) { st.newForm = false; paintSide(); return; }
  if (has("data-dsn-new-create")) {
    const w = Math.round(Number(q<HTMLInputElement>("[data-dsn-new-w]")?.value)), h = Math.round(Number(q<HTMLInputElement>("[data-dsn-new-h]")?.value));
    const bg = q<HTMLSelectElement>("[data-dsn-new-bg]")?.value || null;
    try { resetForDoc(createDoc("Untitled", w, h, bg)); pushState.fire(); setStatus(`New ${w} x ${h} document.`, "ok"); }
    catch (err) { setStatus(err instanceof Error ? err.message : String(err), "error"); }
    paintAll();
    return;
  }
  if (has("data-dsn-open")) { q<HTMLInputElement>("[data-dsn-file]")?.click(); return; }
  if (has("data-dsn-place")) { q<HTMLInputElement>("[data-dsn-place-file]")?.click(); return; }
  if (has("data-dsn-svg")) { q<HTMLInputElement>("[data-dsn-svg-file]")?.click(); return; }
  if (has("data-dsn-undo")) { undo(); return; }
  if (has("data-dsn-redo")) { redo(); return; }
  const stage = q("[data-dsn-stage]");
  const cx = (stage?.clientWidth ?? 800) / 2, cy = (stage?.clientHeight ?? 600) / 2;
  if (has("data-dsn-zoom-in")) { st.view = zoomAbout(st.view, st.view.zoom * 1.25, cx, cy); paintBar(); requestDraw(); return; }
  if (has("data-dsn-zoom-out")) { st.view = zoomAbout(st.view, st.view.zoom / 1.25, cx, cy); paintBar(); requestDraw(); return; }
  if (has("data-dsn-fit")) { fitToStage(); paintBar(); requestDraw(); return; }
  if (has("data-dsn-100")) { st.view = zoomAbout(st.view, 1, cx, cy); paintBar(); requestDraw(); return; }
  if (has("data-dsn-cancel")) { st.cancelRequested = true; worker.cancel(); return; }
  const bm = t.closest<HTMLElement>("[data-dsn-brush-mode]")?.dataset.dsnBrushMode;
  if (bm === "add" || bm === "subtract") { st.brushMode = bm; paintSide(); return; }
  if (has("data-dsn-new-mask")) { st.activeMaskId = ""; st.pendingStrokes = []; st.traced = false; st.traceRect = null; paintAll(); return; }
  if (has("data-dsn-clear-mask")) { discardTrace(); return; }
  if (has("data-dsn-crop-apply")) { applyCrop(); return; }
  if (has("data-dsn-crop-cancel")) { st.crop = null; paintSide(); drawOverlay(); return; }
  if (has("data-dsn-resize")) { void resizeFromForm(); return; }
  if (has("data-dsn-layer-from-mask")) { void layerFromMask(); return; }
  if (has("data-dsn-trace")) { void traceToVector(); return; }
  if (has("data-dsn-new-vector")) {
    const d = st.doc;
    if (!d) return;
    const v = vectorLayer(`Vector ${Object.keys(d.layers).length + 1}`);
    const added = addLayer(d, v);
    if ("error" in added) { setStatus(added.error, "error"); return; }
    st.selected = v.id;
    commit(added.doc, "New vector layer");
    return;
  }
  if (has("data-dsn-delete-shape")) { deleteShape(); return; }
  if (has("data-dsn-hint-create")) { createHint(); return; }
  if (has("data-dsn-hint-discard")) { discardTrace(); return; }
  if (has("data-dsn-hint-refine-pending")) { void refineMask(st.activeMaskId, st.pendingStrokes); return; }
  const hintAttr = (a: string) => t.closest<HTMLElement>(`[${a}]`)?.getAttribute(a) ?? null;
  const show = hintAttr("data-dsn-hint-show");
  if (show) { const h = st.doc?.hints.find((x) => x.id === show); if (h) { st.activeMaskId = h.maskId; st.showMask = true; st.traced = false; st.pendingStrokes = []; paintAll(); } return; }
  const refine = hintAttr("data-dsn-hint-refine");
  if (refine) { const h = st.doc?.hints.find((x) => x.id === refine); if (h) void refineMask(h.maskId, h.strokes); return; }
  const hdel = hintAttr("data-dsn-hint-delete");
  if (hdel && st.doc) { commit(removeHint(st.doc, hdel), "Delete hint"); return; }
  if (has("data-dsn-dgx-decompose")) { void runDecompose(); return; }
  if (has("data-dsn-dgx-matte")) { void runMatte(); return; }
  if (has("data-dsn-dgx-refine")) { const h = st.doc?.hints.find((x) => x.maskId === st.activeMaskId); void refineMask(st.activeMaskId, st.pendingStrokes.length ? st.pendingStrokes : h?.strokes ?? []); return; }
  if (has("data-dsn-dgx-upscale")) { void runUpscale(); return; }
  if (has("data-dsn-dgx-vectorize")) { void runVectorize(); return; }
  if (has("data-dsn-dgx-label")) { void runLabel(); return; }
  const allow = hintAttr("data-dsn-req-allow");
  if (allow) { void allowRequest(allow); return; }
  const dismiss = hintAttr("data-dsn-req-dismiss");
  if (dismiss) { st.requests = st.requests.filter((r) => r.key !== dismiss); paintSide(); return; }
  if (has("data-dsn-export")) { void doExport(); return; }
  if (layerAction(t)) return;
  const row = t.closest<HTMLElement>("[data-dsn-layer]");
  if (row && !t.closest("button,input,select")) selectLayerRow(row.getAttribute("data-dsn-layer") ?? "", e.ctrlKey || e.metaKey);
}

function deleteShape(): void {
  const d = st.doc;
  const l = d?.layers[st.selected];
  if (!d || l?.kind !== "vector" || !st.shapeId || l.locked) return;
  const shapes = l.shapes.filter((s) => s.id !== st.shapeId);
  st.shapeId = "";
  commit(replaceLayer(d, { ...l, shapes }), "Delete shape");
}

function onInput(e: Event): void {
  const t = e.target as HTMLInputElement;
  if (t.matches("[data-dsn-brush-size]")) { st.brushSize = sliderToBrush(Number(t.value)); syncBrushControls(); return; }
  if (t.matches("[data-dsn-hint-label]")) { st.hintLabel = t.value.slice(0, 200); return; }
}

function onChange(e: Event): void {
  const t = e.target as HTMLInputElement;
  const d = st.doc;
  const file = t.files?.[0];
  if (file && t.matches("[data-dsn-file]")) { void openFile(file, "open"); t.value = ""; return; }
  if (file && t.matches("[data-dsn-place-file]")) { void openFile(file, "place"); t.value = ""; return; }
  if (file && t.matches("[data-dsn-svg-file]")) { void file.text().then((x) => importSvgText(x, file.name)); t.value = ""; return; }
  if (t.matches("[data-dsn-hardness]")) { st.hardness = Number(t.value) / 100; paintSide(); return; }
  if (t.matches("[data-dsn-tint]")) { st.tint = t.value; requestDraw(); return; }
  if (t.matches("[data-dsn-tint-alpha]")) { st.tintAlpha = Number(t.value) / 100; requestDraw(); return; }
  if (t.matches("[data-dsn-show-mask]")) { st.showMask = t.checked; requestDraw(); return; }
  if (t.matches("[data-dsn-wand-tol]")) { st.wandTolerance = Number(t.value); paintSide(); return; }
  if (t.matches("[data-dsn-wand-contig]")) { st.wandContiguous = t.checked; return; }
  if (t.matches("[data-dsn-keep-aspect]")) { st.keepAspect = t.checked; return; }
  if (t.matches("[data-dsn-trace-colors]")) { st.traceColors = Number(t.value) || 8; return; }
  if (t.matches("[data-dsn-autokey]")) { st.autoKey = t.checked; return; }
  if (t.matches("[data-dsn-hint-intent]")) { const v = t.value; if (v === "isolate" || v === "remove" || v === "keep" || v === "refine") st.hintIntent = v; return; }
  if (t.matches("[data-dsn-upscale-scale]")) { st.upscale = Number(t.value) || 4; return; }
  if (t.matches("[data-dsn-export-kind]")) { st.exportKind = t.value as ExportKind; paintSide(); return; }
  if (t.matches("[data-dsn-export-max]")) { st.exportMax = Math.max(16, Math.min(4096, Number(t.value) || 1024)); return; }
  if (t.matches("[data-dsn-gif-dither]")) { const v = t.value; if (v === "none" || v === "floyd-steinberg" || v === "bayer4") st.gifDither = v; return; }
  if (t.matches("[data-dsn-gif-palette]")) { const v = t.value; if (v === "global" || v === "per-frame") st.gifPalette = v; return; }
  // Paint panel: update the defaults and the selected shape.
  const paintField = ["data-dsn-fill", "data-dsn-fill-none", "data-dsn-stroke", "data-dsn-stroke-none", "data-dsn-stroke-width", "data-dsn-paint-opacity"].find((a) => t.hasAttribute(a));
  if (paintField) {
    if (paintField === "data-dsn-fill") st.fill = t.value;
    if (paintField === "data-dsn-fill-none") st.fillNone = t.checked;
    if (paintField === "data-dsn-stroke") st.stroke = t.value;
    if (paintField === "data-dsn-stroke-none") st.strokeNone = t.checked;
    if (paintField === "data-dsn-stroke-width") st.strokeWidth = Math.max(0, Math.min(500, Number(t.value) || 0));
    if (paintField === "data-dsn-paint-opacity") st.paintOpacity = Math.max(0, Math.min(1, Number(t.value) / 100));
    if (selectedShape()) updateSelectedShape((s) => ({ ...s, paint: s.kind === "text" ? paint(true) : paint() }), "Paint");
    return;
  }
  if (t.matches("[data-dsn-text-family]")) { const v = t.value; if (v === "sans-serif" || v === "serif" || v === "monospace") st.textFamily = v; return; }
  if (t.matches("[data-dsn-text-size]")) { st.textSize = Math.max(4, Math.min(2000, Number(t.value) || 48)); return; }
  if (t.matches("[data-dsn-freehand]")) { st.freehandMode = t.value === "smooth" ? "smooth" : "ink"; return; }
  if (!d) return;
  const id = (a: string) => t.getAttribute(a);
  if (t.hasAttribute("data-dsn-layer-name")) { userOps([{ op: "rename", id: id("data-dsn-layer-name")!, name: t.value.slice(0, 200) }], "Rename layer"); return; }
  if (t.hasAttribute("data-dsn-layer-label")) {
    const lid = id("data-dsn-layer-label")!;
    const l = d.layers[lid];
    if (!l) return;
    const label = cleanText(t.value, 200);
    commit(replaceLayer(d, { ...l, meta: { ...l.meta, ...(label ? { label, labelSource: "user" as const } : { label: undefined, labelSource: undefined }) } }), "Label layer");
    return;
  }
  if (t.hasAttribute("data-dsn-layer-opacity")) { userOps([{ op: "opacity", id: id("data-dsn-layer-opacity")!, value: Number(t.value) / 100 }], "Layer opacity"); return; }
  if (t.hasAttribute("data-dsn-layer-blend")) {
    const v = BLEND_MODES.find((b) => b === t.value);
    if (v) userOps([{ op: "blend", id: id("data-dsn-layer-blend")!, value: v }], "Blend mode");
  }
}

async function doExport(): Promise<void> {
  const d = st.doc;
  if (!d) return;
  if (st.playing) stopPlay();
  const kind = st.exportKind;
  await busyRun(`Export ${kind}`, async () => {
    const out = await runExport(kind, { doc: d, store, worker, t: st.time, progress: progressCb }, { fps: d.timeline.fps, dither: st.gifDither, palette: st.gifPalette, maxSide: st.exportMax });
    if (out.jobId) setStatus(`HyperFrames project written; MP4 render queued as job ${out.jobId}. It lands in the Creator library.`, "ok");
    else if (out.errors.length) setStatus(`Downloaded ${out.downloaded.length} file(s); not stored: ${out.errors.slice(0, 2).join("; ")}`, "error");
    else setStatus(`Exported ${out.downloaded.join(", ")} (stored in the Creator library).`, "ok");
  });
}

// Layer drag-reorder within the same parent (HTML5 drag and drop on the rows).
let dragLayer = "";
function onDragStart(e: DragEvent): void {
  const row = (e.target as HTMLElement).closest<HTMLElement>("[data-dsn-layer]");
  if (!row) return;
  dragLayer = row.getAttribute("data-dsn-layer") ?? "";
  e.dataTransfer?.setData("text/plain", "layer");
}
function onDrop(e: DragEvent): void {
  const row = (e.target as HTMLElement).closest<HTMLElement>("[data-dsn-layer]");
  const d = st.doc;
  if (row && d && dragLayer) {
    e.preventDefault();
    const target = row.getAttribute("data-dsn-layer") ?? "";
    const a = topLevelIndex(d, dragLayer), b = topLevelIndex(d, target);
    if (target !== dragLayer && a.siblings === b.siblings) userOps([{ op: "reorder", id: dragLayer, index: b.index }], "Reorder layers");
    dragLayer = "";
    return;
  }
  dragLayer = "";
  const file = e.dataTransfer?.files?.[0];
  if (file && (e.target as HTMLElement).closest("[data-dsn-stage]")) {
    e.preventDefault();
    if (/\.svg$/i.test(file.name) || file.type === "image/svg+xml") void file.text().then((x) => importSvgText(x, file.name));
    else void openFile(file, st.doc ? "place" : "open");
  }
}

// Registered when this module loads, i.e. before app.ts installs its own shortcuts, so a key the pane
// consumes (Escape ending a pen path, a tool letter) stops here instead of also closing the Studio.
document.addEventListener("keydown", (e) => {
  if (!root?.isConnected) return;
  const consume = () => { e.preventDefault(); e.stopImmediatePropagation(); };
  if (e.key === " " && !fieldFocused()) { st.spaceDown = true; return; }
  const input = q<HTMLInputElement>("[data-dsn-text-in]");
  if (input && !input.hidden && document.activeElement === input) {
    if (e.key === "Enter") { consume(); commitTextInput(); }
    if (e.key === "Escape") { consume(); input.hidden = true; }
    return;
  }
  if (fieldFocused()) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "z") { consume(); if (e.shiftKey) redo(); else undo(); return; }
  if (mod && e.key.toLowerCase() === "y") { consume(); redo(); return; }
  if (mod || e.altKey || !st.doc) return;
  if (e.key === "[" || e.key === "]") { consume(); st.brushSize = stepBrush(st.brushSize, e.key === "]" ? 1 : -1); syncBrushControls(); drawOverlay(); return; }
  if (e.key === "Enter" && st.pen.length) { consume(); finishPen(false); return; }
  if (e.key === "Escape" && (st.pen.length || st.crop || dragState)) { consume(); st.pen = []; st.crop = null; dragState = null; paintSide(); drawOverlay(); return; }
  if ((e.key === "Delete" || e.key === "Backspace") && st.shapeId) { consume(); deleteShape(); return; }
  const tool = TOOL_BY_KEY[e.key.toLowerCase()];
  if (tool) { consume(); setTool(tool); }
});
document.addEventListener("keyup", (e) => { if (e.key === " ") st.spaceDown = false; });
document.addEventListener("paste", (e) => {
  if (!root?.isConnected || fieldFocused()) return;
  const file = [...(e.clipboardData?.files ?? [])][0];
  if (!file) return;
  e.preventDefault();
  void openFile(file, st.doc ? "place" : "open");
});

function sizeCanvases(): void {
  const stage = q("[data-dsn-stage]");
  const c = canvasPair();
  if (!stage || !c) return;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(stage.clientWidth * dpr)), h = Math.max(1, Math.round(stage.clientHeight * dpr));
  for (const cv of [c.main, c.over]) {
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    cv.style.width = `${stage.clientWidth}px`;
    cv.style.height = `${stage.clientHeight}px`;
  }
  requestDraw();
}

/** Attach to a freshly painted `creatorDesignHtml()` and restore the open document, if any. */
export function mountDesignPane(host: HTMLElement): void {
  const el = host.querySelector<HTMLElement>("[data-dsn-root]");
  if (!el) return;
  root = el;
  el.addEventListener("click", guarded(onClick));
  el.addEventListener("change", guarded(onChange));
  el.addEventListener("input", guarded(onInput));
  el.addEventListener("dragstart", onDragStart);
  el.addEventListener("dragover", (e) => e.preventDefault());
  el.addEventListener("drop", onDrop);
  const over = el.querySelector<HTMLCanvasElement>("[data-dsn-overlay]");
  if (over) {
    over.dataset.tool = st.tool;
    over.addEventListener("pointerdown", onPointerDown);
    over.addEventListener("pointermove", onPointerMove);
    over.addEventListener("pointerup", onPointerUp);
    over.addEventListener("pointercancel", onPointerUp);
    over.addEventListener("pointerleave", () => { st.cursor = null; drawOverlay(); });
    over.addEventListener("wheel", onWheel, { passive: false });
  }
  resizeObs?.disconnect();
  const stage = el.querySelector<HTMLElement>("[data-dsn-stage]");
  if (stage) { resizeObs = new ResizeObserver(() => sizeCanvases()); resizeObs.observe(stage); }
  paintAll();
  sizeCanvases();
  void refreshDgx();
  if (!pollTimer) pollTimer = setInterval(() => { void pullOps(); }, 2000);
}
