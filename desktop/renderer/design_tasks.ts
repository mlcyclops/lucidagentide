// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/design_tasks.ts - the Design suite's heavy pixel work: decode, flatten/composite, frame
// rendering, Lanczos resample, magic wand, raster-to-vector trace, and the GIF / APNG / PNG / PSD encoders.
//
// It runs inside the design worker (design_worker.ts, served same-origin from /design_worker.js, so the
// CSP needs no blob:, no eval, no CDN). Every task is a plain message in and a plain value out; progress is
// reported through a callback, and cancellation is the client terminating the worker.
//
// Compositing is the engine's compositeInto (W3C Compositing and Blending L1). A layer that is translated
// by whole pixels composites directly from its pixels; a scaled, rotated or vector layer is first drawn
// into a doc-space scratch canvas (OffscreenCanvas, same transform the viewport and the SVG export use).

import type { DesignDoc, Layer, MaskData, RasterData, RasterLayer, VShape } from "../../harness/creator/design/types.ts";
import { compositeInto } from "../../harness/creator/design/blend.ts";
import { resampleLanczos3 } from "../../harness/creator/design/resample.ts";
import { TRACE_MAX_PIXELS, traceRaster } from "../../harness/creator/design/trace.ts";
import { encodeAnimatedGif } from "../../harness/creator/design/gif.ts";
import { encodeApng } from "../../harness/creator/design/apng.ts";
import { encodePngTiled } from "../../harness/creator/design/png_stream.ts";
import { writePsd } from "../../harness/creator/design/psd.ts";
import { applyMask } from "../../harness/creator/design/mask.ts";
import { parseColor } from "../../harness/creator/design/color.ts";
import { DESIGN_LIMITS } from "../../harness/creator/design/limits.ts";
import { drawVectorLayer } from "./design_draw.ts";
import { decodeMaskPng, encodeMaskPng } from "./design_png.ts";
import { floodFillMask, integerTranslation, layerWorld, paintList, scaleShape, type Mat } from "./design_logic.ts";

/** Pixels a scene carries: whole raster layers keyed by layer id, whole masks keyed by mask id. */
export interface RenderScene { doc: DesignDoc; rasters: Map<string, RasterData>; masks: Map<string, MaskData> }
export interface DecodedImage { width: number; height: number; strips: { y: number; rows: number; rgba: Uint8ClampedArray }[] }
export interface GifTaskOpts { fps: number; loop: number; dither: "none" | "floyd-steinberg" | "bayer4"; palette: "global" | "per-frame"; maxSide: number; times: number[] }

export type DesignTask =
  | { op: "decode"; bytes: ArrayBuffer; mime: string }
  /** A mask PNG decoded without canvas: exact samples, one coverage value per pixel, size checked. */
  | { op: "decodeMask"; bytes: ArrayBuffer; width: number; height: number }
  | { op: "resample"; src: RasterData; width: number; height: number }
  | { op: "trace"; src: RasterData; colors: number; minArea: number; tolerance: number }
  | { op: "wand"; src: RasterData; x: number; y: number; tolerance: number; contiguous: boolean }
  | { op: "applyMask"; src: RasterData; mask: MaskData; dx: number; dy: number }
  | { op: "flatten"; scene: RenderScene; t: number }
  | { op: "frames"; scene: RenderScene; times: number[]; maxSide: number }
  | { op: "gif"; scene: RenderScene; opts: GifTaskOpts }
  | { op: "apng"; scene: RenderScene; times: number[]; fps: number; loop: number; maxSide: number }
  | { op: "png"; scene: RenderScene; t: number }
  | { op: "psd"; scene: RenderScene; psb: boolean }
  | { op: "encodePng"; src: RasterData }
  | { op: "maskPng"; mask: MaskData }
  | { op: "rasterizeLayer"; scene: RenderScene; layerId: string; t: number };

export type DesignTaskResult = RasterData | MaskData | DecodedImage | VShape[] | Uint8Array | RasterData[];
export type Progress = (fraction: number, note?: string) => void;

const imageDataOf = (r: RasterData): ImageData => new ImageData(r.rgba as Uint8ClampedArray<ArrayBuffer>, r.width, r.height);

function ctx2d(c: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("This environment has no 2D canvas.");
  return ctx;
}

/** Decode an image in horizontal strips so no single canvas exceeds Chromium's area limit. */
async function decode(bytes: ArrayBuffer, mime: string, progress: Progress): Promise<DecodedImage> {
  const bmp = await createImageBitmap(new Blob([bytes], { type: mime || "application/octet-stream" }), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
  try {
    const w = bmp.width, h = bmp.height;
    if (w < 1 || h < 1 || w > DESIGN_LIMITS.maxSide || h > DESIGN_LIMITS.maxSide || w * h > DESIGN_LIMITS.maxRasterPixels) throw new Error(`The decoded image is ${w}x${h}, beyond the decode budget.`);
    const rowsPer = Math.max(1, Math.min(h, Math.floor(16_777_216 / w)));
    const strips: DecodedImage["strips"] = [];
    const c = new OffscreenCanvas(w, rowsPer);
    const ctx = ctx2d(c);
    for (let y = 0; y < h; y += rowsPer) {
      const rows = Math.min(rowsPer, h - y);
      ctx.clearRect(0, 0, w, rowsPer);
      ctx.drawImage(bmp, 0, -y);
      strips.push({ y, rows, rgba: ctx.getImageData(0, 0, w, rows).data });
      progress((y + rows) / h);
    }
    return { width: w, height: h, strips };
  } finally { bmp.close(); }
}

/** Renders a scene at doc resolution, a band of rows at a time when asked. Layer canvases are built once. */
export class SceneRenderer {
  private canvases = new Map<string, OffscreenCanvas>();
  private scratch: OffscreenCanvas | null = null;
  constructor(readonly scene: RenderScene) {}

  private layerCanvas(l: RasterLayer): OffscreenCanvas | null {
    let c = this.canvases.get(l.id);
    if (c) return c;
    const r = this.scene.rasters.get(l.id);
    if (!r) return null;
    c = new OffscreenCanvas(r.width, r.height);
    ctx2d(c).putImageData(imageDataOf(r), 0, 0);
    this.canvases.set(l.id, c);
    return c;
  }

  /** A non-group layer drawn through its full matrix into a doc-space band (rows [oy, oy + rows)). */
  layerInDocSpace(id: string, m: Mat, oy: number, rows: number): RasterData | null {
    const doc = this.scene.doc;
    const l = doc.layers[id];
    if (!l || l.kind === "group") return null;
    const w = doc.width;
    if (!this.scratch || this.scratch.width !== w || this.scratch.height !== rows) this.scratch = new OffscreenCanvas(w, rows);
    const ctx = ctx2d(this.scratch);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, rows);
    ctx.setTransform(1, 0, 0, 1, 0, -oy);
    ctx.transform(...m);
    if (l.kind === "raster") {
      const c = this.layerCanvas(l);
      if (!c) return null;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(c, 0, 0);
    } else drawVectorLayer(ctx, l, 1);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return { width: w, height: rows, rgba: ctx.getImageData(0, 0, w, rows).data };
  }

  /** Composite the document at time `t` into rows [oy, oy + rows) at doc resolution. */
  frame(t: number, oy = 0, rows = this.scene.doc.height): RasterData {
    const doc = this.scene.doc;
    const w = doc.width;
    const dst: RasterData = { width: w, height: rows, rgba: new Uint8ClampedArray(w * rows * 4) };
    const bg = doc.background ? parseColor(doc.background) : null;
    if (bg) {
      const [r, g, b, a] = bg;
      for (let i = 0; i < dst.rgba.length; i += 4) { dst.rgba[i] = r; dst.rgba[i + 1] = g; dst.rgba[i + 2] = b; dst.rgba[i + 3] = a; }
    }
    for (const item of paintList(doc)) {
      if (!item.visible) continue;
      const l = doc.layers[item.id];
      if (!l || l.kind === "group") continue;
      const { m, opacity } = layerWorld(doc, item, t);
      if (opacity <= 0) continue;
      const rec = l.maskId ? doc.masks[l.maskId] : undefined;
      const maskData = rec ? this.scene.masks.get(rec.id) : undefined;
      const maskOpts = rec && maskData ? { mask: maskData, maskDx: Math.round(rec.x), maskDy: Math.round(rec.y) - oy } : {};
      const direct = l.kind === "raster" ? integerTranslation(m) : null;
      if (direct) {
        const src = this.scene.rasters.get(l.id);
        if (!src) continue;
        compositeInto(dst, src, { blend: l.blend, opacity, dx: direct.dx, dy: direct.dy - oy, ...maskOpts });
      } else {
        const src = this.layerInDocSpace(item.id, m, oy, rows);
        if (src) compositeInto(dst, src, { blend: l.blend, opacity, dx: 0, dy: 0, ...maskOpts });
      }
    }
    return dst;
  }
}

/** Output size for a frame export capped at `maxSide` on the long edge (never upscaled). */
export function exportSize(w: number, h: number, maxSide: number): { width: number; height: number } {
  const s = Math.min(1, maxSide / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}

function renderFrames(scene: RenderScene, times: readonly number[], maxSide: number, progress: Progress): RasterData[] {
  const r = new SceneRenderer(scene);
  const { width, height } = exportSize(scene.doc.width, scene.doc.height, maxSide);
  const out: RasterData[] = [];
  times.forEach((t, i) => {
    const f = r.frame(t);
    out.push(width === f.width && height === f.height ? f : resampleLanczos3(f, width, height));
    progress((i + 1) / times.length, `frame ${i + 1} / ${times.length}`);
  });
  return out;
}

async function encodePng(src: RasterData): Promise<Uint8Array> {
  const c = new OffscreenCanvas(src.width, src.height);
  ctx2d(c).putImageData(imageDataOf(src), 0, 0);
  return new Uint8Array(await (await c.convertToBlob({ type: "image/png" })).arrayBuffer());
}

/** A layer rasterized to doc size (vector layers, transformed rasters) for PSD and layer-PNG exports. */
function rasterizeLayer(scene: RenderScene, id: string, t: number): RasterData | null {
  const item = paintList(scene.doc).find((p) => p.id === id);
  if (!item) return null;
  return new SceneRenderer(scene).layerInDocSpace(id, layerWorld(scene.doc, item, t).m, 0, scene.doc.height);
}

/** A baked doc-space raster layer standing in for a vector or transformed layer (same id, name, blend). */
function bakedLayer(l: Layer, r: RasterData): RasterLayer {
  return {
    id: l.id, name: l.name, kind: "raster", visible: l.visible, locked: l.locked, opacity: l.opacity, blend: l.blend,
    x: 0, y: 0, scale: 1, rotation: 0, anchorX: 0, anchorY: 0, width: r.width, height: r.height,
    ...(l.maskId ? { maskId: l.maskId } : {}), ...(l.meta ? { meta: l.meta } : {}),
  };
}

/** PSD layers are pixels at t = 0. Groups are flattened away (PSD folders would need the group transform
 *  baked into every child anyway): every paintable layer is a top-level PSD layer, and any layer that is
 *  not a whole-pixel translated raster (vector, scaled, rotated, inside a moved group) is baked to a
 *  doc-size raster first. Group opacity multiplies into the layer. */
function psdBytes(scene: RenderScene, psb: boolean, progress: Progress): Uint8Array {
  const doc = scene.doc;
  const renderer = new SceneRenderer(scene);
  const composite = renderer.frame(0);
  progress(0.3, "composite");
  const pixels = new Map<string, RasterData>();
  const layers = Object.create(null) as DesignDoc["layers"];
  const order: string[] = [];
  for (const item of paintList(doc)) {
    const l = doc.layers[item.id];
    if (!l || l.kind === "group") continue;
    const { m, opacity } = layerWorld(doc, item, 0);
    const direct = l.kind === "raster" ? integerTranslation(m) : null;
    const own = scene.rasters.get(l.id);
    if (direct && own) {
      layers[l.id] = { ...l, x: direct.dx, y: direct.dy, scale: 1, rotation: 0, opacity, visible: item.visible, parentId: undefined };
      pixels.set(l.id, own);
    } else {
      const r = renderer.layerInDocSpace(l.id, m, 0, doc.height);
      if (!r) continue;
      layers[l.id] = { ...bakedLayer(l, r), opacity, visible: item.visible };
      pixels.set(l.id, r);
    }
    order.push(l.id);
  }
  progress(0.6, "layers");
  const flat: DesignDoc = { ...doc, layers, order };
  return writePsd(flat, (id) => pixels.get(id) ?? null, { psb, composite });
}

/** Run one task. Throws with a user-readable message on refusal. */
export async function runDesignTask(task: DesignTask, progress: Progress): Promise<DesignTaskResult> {
  switch (task.op) {
    case "decode": return decode(task.bytes, task.mime, progress);
    case "decodeMask": return decodeMaskPng(new Uint8Array(task.bytes), task.width, task.height);
    case "resample": return resampleLanczos3(task.src, task.width, task.height);
    case "trace": {
      // Tracing is O(pixels * colors): a raster over the tracer's cap is traced at a reduced size and the
      // shapes are scaled back to layer pixels.
      const src = task.src;
      const s = Math.min(1, Math.sqrt(TRACE_MAX_PIXELS / Math.max(1, src.width * src.height)));
      if (s >= 1) return traceRaster(src, { colors: task.colors, minArea: task.minArea, tolerance: task.tolerance });
      const w = Math.max(1, Math.floor(src.width * s)), h = Math.max(1, Math.floor(src.height * s));
      progress(0.2, "downscaling");
      const small = resampleLanczos3(src, w, h);
      return traceRaster(small, { colors: task.colors, minArea: task.minArea, tolerance: task.tolerance }).map((sh) => scaleShape(sh, src.width / w, src.height / h));
    }
    case "wand": return floodFillMask(task.src, task.x, task.y, task.tolerance, task.contiguous);
    case "applyMask": return applyMask(task.src, task.mask, task.dx, task.dy);
    case "flatten": return new SceneRenderer(task.scene).frame(task.t);
    case "frames": return renderFrames(task.scene, task.times, task.maxSide, progress);
    case "gif": {
      const o = task.opts;
      const frames = renderFrames(task.scene, o.times.slice(0, DESIGN_LIMITS.maxGifFrames), o.maxSide, (f, n) => progress(f * 0.8, n));
      progress(0.85, "quantizing");
      return encodeAnimatedGif(frames, { delayMs: Math.round(1000 / o.fps), loop: o.loop, dither: o.dither, palette: o.palette });
    }
    case "apng": {
      const frames = renderFrames(task.scene, task.times.slice(0, DESIGN_LIMITS.maxFrames), task.maxSide, (f, n) => progress(f * 0.8, n));
      progress(0.85, "deflate");
      return encodeApng(frames, { delayMs: Math.round(1000 / task.fps), loop: task.loop });
    }
    case "png": {
      const doc = task.scene.doc;
      const r = new SceneRenderer(task.scene);
      return encodePngTiled(doc.width, doc.height, (y0, rows) => {
        progress((y0 + rows) / doc.height, "rows");
        return r.frame(task.t, y0, rows).rgba;
      });
    }
    case "psd": return psdBytes(task.scene, task.psb, progress);
    case "encodePng": return encodePng(task.src);
    case "maskPng": return encodeMaskPng(task.mask);
    case "rasterizeLayer": {
      const r = rasterizeLayer(task.scene, task.layerId, task.t);
      if (!r) throw new Error("That layer has no pixels to export.");
      return r;
    }
  }
}

/** Buffers worth transferring back (zero-copy) out of a result. */
export function transferablesOf(r: DesignTaskResult): Transferable[] {
  if (r instanceof Uint8Array) return [r.buffer as ArrayBuffer];
  if (Array.isArray(r)) return r.flatMap((x) => ("rgba" in x ? [x.rgba.buffer as ArrayBuffer] : []));
  if ("strips" in r) return r.strips.map((s) => s.rgba.buffer as ArrayBuffer);
  if ("rgba" in r) return [r.rgba.buffer as ArrayBuffer];
  if ("alpha" in r) return [r.alpha.buffer as ArrayBuffer];
  return [];
}
