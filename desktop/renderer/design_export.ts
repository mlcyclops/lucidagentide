// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/design_export.ts - the Design exports: PNG (tiled stream), animated GIF, APNG, static and
// animated SVG, PSD/PSB, layer PNGs, a design file, and a HyperFrames project rendered to MP4.
//
// Pixels are encoded in the design worker; the SVG is built by the engine's exportSvg and must pass the
// engine's svgSafetyCheck here before it leaves the renderer (the server checks again). Every export is
// stored through /api/creator/design/export (magic bytes, metadata chunks and SVG safety checked there)
// and downloaded locally from the same bytes. No source metadata ever reaches an encoder: every frame is
// re-rendered from the document.

import type { DesignDoc, Layer, MaskData, RasterData } from "../../harness/creator/design/types.ts";
import { readMaskRect, readRect, type TileStore } from "../../harness/creator/design/tiles.ts";
import { exportSvg } from "../../harness/creator/design/svg_export.ts";
import { svgSafetyCheck } from "../../harness/creator/design/svg_check.ts";
import { frameTimes } from "../../harness/creator/design/anim.ts";
import { DESIGN_LIMITS } from "../../harness/creator/design/limits.ts";
import { bridge } from "./bridge.ts";
import type { DesignExportKind } from "./design_api.ts";
import type { RenderScene } from "./design_tasks.ts";
import type { DesignWorkerClient } from "./design_worker_client.ts";
import type { ExportKind } from "./design_view.ts";
import { hfAssetPath, hfLayerOrder, hyperframesIndexHtml, type HfLayerAsset } from "./design_hyperframes.ts";
import { bytesToB64, copyRecord, safeFileStem } from "./design_logic.ts";

export interface ExportOptions { fps: number; dither: "none" | "floyd-steinberg" | "bayer4"; palette: "global" | "per-frame"; maxSide: number }
export interface ExportCtx {
  doc: DesignDoc;
  store: TileStore;
  worker: DesignWorkerClient;
  t: number;
  progress(fraction: number, note: string): void;
}
export interface ExportOutcome { stored: string[]; downloaded: string[]; errors: string[]; projectDir?: string; jobId?: string }

const MIME: Record<string, string> = { png: "image/png", gif: "image/gif", apng: "image/png", svg: "image/svg+xml", psd: "image/vnd.adobe.photoshop", psb: "application/octet-stream", design: "application/json" };

export function download(bytes: Uint8Array, name: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }));
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** A worker scene: every raster layer's pixels and every referenced mask, freshly copied out of the tiles. */
export function buildScene(doc: DesignDoc, store: TileStore): { scene: RenderScene; transfer: ArrayBuffer[] } {
  const rasters = new Map<string, RasterData>();
  const masks = new Map<string, MaskData>();
  const transfer: ArrayBuffer[] = [];
  for (const id of Object.keys(doc.layers)) {
    const l = doc.layers[id]!;
    if (l.kind === "raster") {
      const r = readRect(store, l.id, l.width, l.height, { x: 0, y: 0, w: l.width, h: l.height });
      rasters.set(l.id, r);
      transfer.push(r.rgba.buffer as ArrayBuffer);
    }
    const rec = l.maskId ? doc.masks[l.maskId] : undefined;
    if (rec && !masks.has(rec.id)) {
      const m = readMaskRect(store, `mask:${rec.id}`, rec.width, rec.height, { x: 0, y: 0, w: rec.width, h: rec.height });
      masks.set(rec.id, m);
      transfer.push(m.alpha.buffer as ArrayBuffer);
    }
  }
  return { scene: { doc, rasters, masks }, transfer };
}

async function pngOf(worker: DesignWorkerClient, r: RasterData): Promise<Uint8Array> {
  const copy: RasterData = { width: r.width, height: r.height, rgba: r.rgba.slice() };
  return worker.run<Uint8Array>({ op: "encodePng", src: copy }, { transfer: [copy.rgba.buffer as ArrayBuffer] });
}

/** A one-layer document with the layer at identity (its own coordinates), for per-layer SVG assets. */
function soloDoc(doc: DesignDoc, l: Layer): DesignDoc {
  const layers = copyRecord<Layer>({});
  layers[l.id] = { ...l, x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, visible: true, blend: "normal", parentId: undefined, maskId: undefined };
  return { ...doc, layers, order: [l.id], masks: copyRecord({}), hints: [], timeline: { ...doc.timeline, tracks: [] } };
}

/** The doc's SVG with raster layers inlined as PNG data URLs. Refused unless svgSafetyCheck passes. */
async function svgText(ctx: ExportCtx, animate: boolean, doc = ctx.doc): Promise<string> {
  const hrefs = new Map<string, string>();
  const rasters = Object.keys(doc.layers).map((id) => doc.layers[id]!).filter((l) => l.kind === "raster");
  for (let i = 0; i < rasters.length; i++) {
    const l = rasters[i]!;
    if (l.kind !== "raster") continue;
    ctx.progress(i / Math.max(1, rasters.length), "encoding layers");
    const png = await pngOf(ctx.worker, readRect(ctx.store, l.id, l.width, l.height, { x: 0, y: 0, w: l.width, h: l.height }));
    hrefs.set(l.id, `data:image/png;base64,${bytesToB64(png)}`);
  }
  const svg = exportSvg(doc, { rasterHref: (id) => hrefs.get(id) ?? null, animate });
  const check = svgSafetyCheck(svg);
  if (!check.ok) throw new Error(`The SVG export failed its safety check: ${check.reason}`);
  return svg;
}

async function store(kind: DesignExportKind, name: string, bytes: Uint8Array, out: ExportOutcome): Promise<void> {
  download(bytes, name, MIME[kind] ?? "application/octet-stream");
  out.downloaded.push(name);
  const r = await bridge.designExport({ kind, name, dataB64: bytesToB64(bytes) });
  if (r.ok && r.data?.artifact) out.stored.push(r.data.artifact.id);
  else out.errors.push(`${name}: ${r.error ?? "not stored"}`);
}

/** Run one export end to end. Throws on a refusal before anything was produced. */
export async function runExport(kind: ExportKind, ctx: ExportCtx, o: ExportOptions): Promise<ExportOutcome> {
  const doc = ctx.doc;
  const stem = safeFileStem(doc.name);
  const out: ExportOutcome = { stored: [], downloaded: [], errors: [] };
  const enc = new TextEncoder();
  const times = frameTimes(doc.timeline);
  const onProgress = (f: number, note: string) => ctx.progress(f, note);
  switch (kind) {
    case "png": {
      const { scene, transfer } = buildScene(doc, ctx.store);
      const bytes = await ctx.worker.run<Uint8Array>({ op: "png", scene, t: ctx.t }, { transfer, onProgress });
      await store("png", `${stem}.png`, bytes, out);
      break;
    }
    case "gif": {
      if (times.length > DESIGN_LIMITS.maxGifFrames) throw new Error(`A GIF holds at most ${DESIGN_LIMITS.maxGifFrames} frames; shorten the timeline or lower the fps.`);
      const { scene, transfer } = buildScene(doc, ctx.store);
      const bytes = await ctx.worker.run<Uint8Array>({ op: "gif", scene, opts: { fps: doc.timeline.fps, loop: doc.timeline.loop ? 0 : 1, dither: o.dither, palette: o.palette, maxSide: o.maxSide, times } }, { transfer, onProgress });
      await store("gif", `${stem}.gif`, bytes, out);
      break;
    }
    case "apng": {
      const { scene, transfer } = buildScene(doc, ctx.store);
      const bytes = await ctx.worker.run<Uint8Array>({ op: "apng", scene, times, fps: doc.timeline.fps, loop: doc.timeline.loop ? 0 : 1, maxSide: o.maxSide }, { transfer, onProgress });
      await store("apng", `${stem}.apng.png`, bytes, out);
      break;
    }
    case "svg":
    case "svg-animated": {
      const svg = await svgText(ctx, kind === "svg-animated");
      await store("svg", `${stem}${kind === "svg-animated" ? "-animated" : ""}.svg`, enc.encode(svg), out);
      break;
    }
    case "psd":
    case "psb": {
      const { scene, transfer } = buildScene(doc, ctx.store);
      const psb = kind === "psb" || doc.width > 30000 || doc.height > 30000;
      const bytes = await ctx.worker.run<Uint8Array>({ op: "psd", scene, psb }, { transfer, onProgress });
      await store(psb ? "psb" : "psd", `${stem}.${psb ? "psb" : "psd"}`, bytes, out);
      break;
    }
    case "layers": {
      const ids = hfLayerOrder(doc);
      for (let i = 0; i < ids.length; i++) {
        const l = doc.layers[ids[i]!]!;
        ctx.progress(i / ids.length, `layer ${i + 1} / ${ids.length}`);
        let png: Uint8Array;
        if (l.kind === "raster") png = await pngOf(ctx.worker, readRect(ctx.store, l.id, l.width, l.height, { x: 0, y: 0, w: l.width, h: l.height }));
        else {
          const { scene, transfer } = buildScene(doc, ctx.store);
          const r = await ctx.worker.run<RasterData>({ op: "rasterizeLayer", scene, layerId: l.id, t: ctx.t }, { transfer });
          png = await pngOf(ctx.worker, r);
        }
        await store("png", `${stem}-${String(i + 1).padStart(2, "0")}-${safeFileStem(l.name, "layer")}.png`, png, out);
      }
      break;
    }
    case "design": {
      await store("design", `${stem}.lucid-design.json`, enc.encode(JSON.stringify(doc)), out);
      break;
    }
    case "hyperframes": {
      const ids = hfLayerOrder(doc);
      const files: { path: string; dataB64: string }[] = [];
      const assets: HfLayerAsset[] = [];
      for (let i = 0; i < ids.length; i++) {
        const l = doc.layers[ids[i]!]!;
        ctx.progress(i / Math.max(1, ids.length), `asset ${i + 1} / ${ids.length}`);
        if (l.kind === "raster") {
          let r = readRect(ctx.store, l.id, l.width, l.height, { x: 0, y: 0, w: l.width, h: l.height });
          const rec = l.maskId ? doc.masks[l.maskId] : undefined;
          if (rec) {
            // Bake the doc-space mask into the layer's own pixels at its resting position.
            const m = readMaskRect(ctx.store, `mask:${rec.id}`, rec.width, rec.height, { x: 0, y: 0, w: rec.width, h: rec.height });
            r = await ctx.worker.run<RasterData>({ op: "applyMask", src: r, mask: m, dx: Math.round(rec.x - l.x), dy: Math.round(rec.y - l.y) }, { transfer: [r.rgba.buffer as ArrayBuffer, m.alpha.buffer as ArrayBuffer] });
          }
          files.push({ path: hfAssetPath(i, "png"), dataB64: bytesToB64(await pngOf(ctx.worker, r)) });
          assets.push({ layerId: l.id, ext: "png", width: l.width, height: l.height });
        } else if (l.kind === "vector") {
          const svg = await svgText(ctx, false, soloDoc(doc, l));
          files.push({ path: hfAssetPath(i, "svg"), dataB64: bytesToB64(enc.encode(svg)) });
          assets.push({ layerId: l.id, ext: "svg", width: doc.width, height: doc.height });
        }
      }
      files.unshift({ path: "index.html", dataB64: bytesToB64(enc.encode(hyperframesIndexHtml(doc, assets))) });
      const r = await bridge.designExport({ kind: "hyperframes", name: stem, files });
      if (!r.ok || !r.data?.projectDir) throw new Error(r.error ?? "The engine did not write the HyperFrames project.");
      out.projectDir = r.data.projectDir;
      const job = await bridge.creatorHyperframesRender({ projectDir: r.data.projectDir, format: "mp4", quality: "standard" });
      if (!job.ok || !job.data) throw new Error(job.error ?? "The HyperFrames renderer did not start.");
      out.jobId = job.data.jobId;
      break;
    }
  }
  return out;
}
