// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/design_viewport.ts - the Design canvas: tile-based drawing at any zoom (1%..6400%).
//
// Pixels live in the engine TileStore (256 px tiles). The viewport keeps a bounded LRU of tile canvases
// (RGBA tiles as-is; 1-channel mask tiles expanded to an alpha or a tint canvas) and draws only the tiles
// a layer shows on screen, through the layer's full matrix (groups included) and its blend mode. Far-out
// zoom levels use a nearest-neighbour preview (at most 2048 px on the long side) sampled straight from the
// tiles, so a 65k px document never builds thousands of tile canvases just to show a thumbnail.

import type { DesignDoc, Layer, RasterLayer } from "../../harness/creator/design/types.ts";
import { TILE, type TileStore } from "../../harness/creator/design/tiles.ts";
import { parseColor } from "../../harness/creator/design/color.ts";
import { CANVAS_BLEND, drawVectorLayer, type Ctx2D } from "./design_draw.ts";
import { invertMat, layerWorld, mulMat, paintList, snappedRect, tileRange, type Mat } from "./design_logic.ts";

const TILE_CACHE_MAX = 768;
const PREVIEW_MAX = 2048;
/** Largest layer-space region (px) assembled for a rotated layer before falling back to the preview. */
const REGION_MAX = 16_777_216;

export interface DrawOpts {
  t: number;
  /** The mask being traced, drawn as a tinted overlay. */
  overlayMaskId?: string;
  tint?: string;
  tintAlpha?: number;
}

type Kind = "rgba" | "alpha" | "tint";

export class DesignViewport {
  private tiles = new Map<string, OffscreenCanvas>();
  private versions = new Map<string, number>();
  private previews = new Map<string, { ver: number; canvas: OffscreenCanvas; p: number }>();
  private scratch: OffscreenCanvas | null = null;
  private scratchMask: OffscreenCanvas | null = null;
  /** Layer-space assembly canvas for rotated/skewed layers (reused, grows only). */
  private region: OffscreenCanvas | null = null;
  private checker: CanvasPattern | null = null;
  private tintKey = "";

  constructor(private readonly store: () => TileStore) {}

  /** Forget cached canvases for one tile (after a pixel edit) or a whole key. */
  invalidate(key: string, tx?: number, ty?: number): void {
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
    if (tx === undefined || ty === undefined) {
      for (const k of [...this.tiles.keys()]) if (k.startsWith(`${key}|`)) this.tiles.delete(k);
      return;
    }
    for (const kind of ["rgba", "alpha", "tint"] as Kind[]) this.tiles.delete(`${key}|${kind}|${tx}|${ty}`);
  }

  clear(): void { this.tiles.clear(); this.previews.clear(); this.versions.clear(); }

  version(key: string): number { return this.versions.get(key) ?? 0; }

  private tileCanvas(key: string, kind: Kind, tx: number, ty: number, tint: [number, number, number, number]): OffscreenCanvas | null {
    const ck = `${key}|${kind}|${tx}|${ty}`;
    const hit = this.tiles.get(ck);
    if (hit) { this.tiles.delete(ck); this.tiles.set(ck, hit); return hit; }
    const data = this.store().get(key, tx, ty);
    if (!data) return null;
    const c = new OffscreenCanvas(TILE, TILE);
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    let rgba: Uint8ClampedArray;
    if (kind === "rgba") rgba = data;
    else {
      rgba = new Uint8ClampedArray(TILE * TILE * 4);
      const [r, g, b, a] = tint;
      for (let i = 0, j = 0; i < data.length; i++, j += 4) {
        const cov = data[i]!;
        if (!cov) continue;
        if (kind === "alpha") rgba[j + 3] = cov;
        else { rgba[j] = r; rgba[j + 1] = g; rgba[j + 2] = b; rgba[j + 3] = (cov * a) / 255; }
      }
    }
    ctx.putImageData(new ImageData(rgba.slice() as Uint8ClampedArray<ArrayBuffer>, TILE, TILE), 0, 0);
    this.tiles.set(ck, c);
    while (this.tiles.size > TILE_CACHE_MAX) this.tiles.delete(this.tiles.keys().next().value!);
    return c;
  }

  /** A nearest-neighbour preview of a whole key (RGBA layer, mask alpha, or tinted mask), rebuilt when the
   *  key changes. */
  preview(key: string, w: number, h: number, kind: Kind, maxSide = PREVIEW_MAX, tint: [number, number, number, number] = [0, 0, 0, 0]): { canvas: OffscreenCanvas; p: number } | null {
    const ver = this.version(key);
    const isMask = kind !== "rgba";
    const pk = `${key}|${kind}|${kind === "tint" ? tint.join(",") : ""}|${maxSide}`;
    const hit = this.previews.get(pk);
    if (hit && hit.ver === ver) return hit;
    const p = Math.min(1, maxSide / Math.max(w, h));
    const pw = Math.max(1, Math.ceil(w * p)), ph = Math.max(1, Math.ceil(h * p));
    const out = new Uint8ClampedArray(pw * ph * 4);
    const store = this.store();
    let tile: Uint8ClampedArray | undefined, ttx = -1, tty = -1;
    for (let y = 0; y < ph; y++) {
      const sy = Math.min(h - 1, Math.floor(y / p));
      const ty = Math.floor(sy / TILE), iy = sy - ty * TILE;
      for (let x = 0; x < pw; x++) {
        const sx = Math.min(w - 1, Math.floor(x / p));
        const tx = Math.floor(sx / TILE), ix = sx - tx * TILE;
        if (tx !== ttx || ty !== tty) { tile = store.get(key, tx, ty); ttx = tx; tty = ty; }
        if (!tile) continue;
        const o = (y * pw + x) * 4;
        if (isMask) {
          const cov = tile[iy * TILE + ix]!;
          if (kind === "tint") { out[o] = tint[0]; out[o + 1] = tint[1]; out[o + 2] = tint[2]; out[o + 3] = (cov * tint[3]) / 255; }
          else out[o + 3] = cov;
          continue;
        }
        const s = (iy * TILE + ix) * 4;
        out[o] = tile[s]!; out[o + 1] = tile[s + 1]!; out[o + 2] = tile[s + 2]!; out[o + 3] = tile[s + 3]!;
      }
    }
    const c = new OffscreenCanvas(pw, ph);
    c.getContext("2d")?.putImageData(new ImageData(out, pw, ph), 0, 0);
    const entry = { ver, canvas: c, p };
    this.previews.set(pk, entry);
    return entry;
  }

  private checkerPattern(ctx: Ctx2D): CanvasPattern | null {
    if (this.checker) return this.checker;
    const c = new OffscreenCanvas(16, 16);
    const g = c.getContext("2d");
    if (!g) return null;
    g.fillStyle = "#ffffff"; g.fillRect(0, 0, 16, 16);
    g.fillStyle = "#d9dce1"; g.fillRect(0, 0, 8, 8); g.fillRect(8, 8, 8, 8);
    this.checker = ctx.createPattern(c, "repeat");
    return this.checker;
  }

  /** Draw tiles (or the preview) of `key` through `full` (key px -> device px), clipped to the screen. */
  private drawKey(ctx: Ctx2D, key: string, w: number, h: number, full: Mat, kind: Kind, screenW: number, screenH: number, tint: [number, number, number, number]): void {
    const inv = invertMat(full);
    if (!inv) return;
    const pts = [[0, 0], [screenW, 0], [0, screenH], [screenW, screenH]].map(([x, y]) => ({ x: inv[0] * x! + inv[2] * y! + inv[4], y: inv[1] * x! + inv[3] * y! + inv[5] }));
    const x0 = Math.min(...pts.map((p) => p.x)), y0 = Math.min(...pts.map((p) => p.y));
    const x1 = Math.max(...pts.map((p) => p.x)), y1 = Math.max(...pts.map((p) => p.y));
    const range = tileRange({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, w, h, TILE);
    if (!range) return;
    const scale = Math.sqrt(Math.abs(full[0] * full[3] - full[1] * full[2]));
    const count = (range.tx1 - range.tx0 + 1) * (range.ty1 - range.ty0 + 1);
    ctx.setTransform(...full);
    ctx.imageSmoothingEnabled = scale < 1;
    // The 1:1 region the visible tiles cover, in key pixels.
    const rx = range.tx0 * TILE, ry = range.ty0 * TILE;
    const rw = Math.min(w, (range.tx1 + 1) * TILE) - rx, rh = Math.min(h, (range.ty1 + 1) * TILE) - ry;
    const axisAligned = full[1] === 0 && full[2] === 0 && full[0] > 0 && full[3] > 0;
    // Zoomed out, more tiles on screen than the canvas cache holds, or (rotated) a region too large to
    // assemble: draw the preview instead.
    if ((scale < 0.5 && count > 16) || count > TILE_CACHE_MAX - 128 || (!axisAligned && rw * rh > REGION_MAX)) {
      const pv = this.preview(key, w, h, kind, PREVIEW_MAX, tint);
      if (pv) { ctx.drawImage(pv.canvas, 0, 0, pv.canvas.width / pv.p, pv.canvas.height / pv.p); return; }
    }
    if (axisAligned) {
      // Seam-free: every tile edge is mapped to device pixels and ROUNDED, so neighbours share the exact
      // same edge (no anti-aliased half-covered column or row between tiles at fractional zoom).
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      for (let ty = range.ty0; ty <= range.ty1; ty++) {
        for (let tx = range.tx0; tx <= range.tx1; tx++) {
          const c = this.tileCanvas(key, kind, tx, ty, tint);
          if (!c) continue;
          // Edge tiles are full 256x256 in the store; clip to the key's own size so bytes past it never show.
          const cw = Math.min(TILE, w - tx * TILE), ch = Math.min(TILE, h - ty * TILE);
          const d = snappedRect(full, tx * TILE, ty * TILE, tx * TILE + cw, ty * TILE + ch);
          if (d.w > 0 && d.h > 0) ctx.drawImage(c, 0, 0, cw, ch, d.x, d.y, d.w, d.h);
        }
      }
      return;
    }
    // Rotated or skewed: assemble the visible tiles 1:1 at integer offsets (no seams possible), then draw
    // the region once through the layer matrix.
    let region = this.region;
    if (!region || region.width < rw || region.height < rh) {
      region = new OffscreenCanvas(Math.max(rw, region?.width ?? 0), Math.max(rh, region?.height ?? 0));
      this.region = region;
    }
    const rctx = region.getContext("2d");
    if (!rctx) return;
    rctx.setTransform(1, 0, 0, 1, 0, 0);
    rctx.clearRect(0, 0, rw, rh);
    for (let ty = range.ty0; ty <= range.ty1; ty++) {
      for (let tx = range.tx0; tx <= range.tx1; tx++) {
        const c = this.tileCanvas(key, kind, tx, ty, tint);
        if (!c) continue;
        const cw = Math.min(TILE, w - tx * TILE), ch = Math.min(TILE, h - ty * TILE);
        rctx.drawImage(c, 0, 0, cw, ch, tx * TILE - rx, ty * TILE - ry, cw, ch);
      }
    }
    ctx.setTransform(...mulMat(full, [1, 0, 0, 1, rx, ry]));
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(region, 0, 0, rw, rh, 0, 0, rw, rh);
  }

  private scratchCtx(w: number, h: number, which: "layer" | "mask"): OffscreenCanvasRenderingContext2D | null {
    let c = which === "layer" ? this.scratch : this.scratchMask;
    if (!c || c.width !== w || c.height !== h) {
      c = new OffscreenCanvas(w, h);
      if (which === "layer") this.scratch = c; else this.scratchMask = c;
    }
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, w, h);
    return ctx;
  }

  private paintLayer(ctx: Ctx2D, l: Layer, full: Mat, opacity: number, screenW: number, screenH: number): void {
    if (l.kind === "raster") this.drawKey(ctx, l.id, l.width, l.height, full, "rgba", screenW, screenH, [0, 0, 0, 0]);
    else if (l.kind === "vector") { ctx.setTransform(...full); drawVectorLayer(ctx, l, opacity); }
  }

  /** Draw the whole document. `base` maps doc px to device px (view zoom/pan times devicePixelRatio). */
  draw(ctx: Ctx2D, screenW: number, screenH: number, doc: DesignDoc, base: Mat, o: DrawOpts): void {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, screenW, screenH);
    ctx.setTransform(...base);
    const pat = this.checkerPattern(ctx);
    if (pat) {
      // The checker stays a constant screen size: draw it in device space over the doc's screen rect.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = pat;
      const x = base[4], y = base[5];
      ctx.fillRect(x, y, doc.width * base[0], doc.height * base[3]);
      ctx.setTransform(...base);
    }
    const bg = doc.background ? parseColor(doc.background) : null;
    if (bg) { ctx.fillStyle = `rgba(${bg[0]},${bg[1]},${bg[2]},${bg[3] / 255})`; ctx.fillRect(0, 0, doc.width, doc.height); }
    const none: [number, number, number, number] = [0, 0, 0, 0];
    for (const item of paintList(doc)) {
      if (!item.visible) continue;
      const l = doc.layers[item.id];
      if (!l || l.kind === "group") continue;
      const { m, opacity } = layerWorld(doc, item, o.t);
      if (opacity <= 0) continue;
      const full = mulMat(base, m);
      const rec = l.maskId ? doc.masks[l.maskId] : undefined;
      if (rec) {
        // Masked layer: paint into a screen-size scratch, cut by the mask, then composite with its blend.
        // destination-in is unbounded (it clears outside what is drawn), so the mask tiles are first
        // gathered into their own scratch and applied in ONE draw.
        const mctx = this.scratchCtx(screenW, screenH, "mask");
        const s = this.scratchCtx(screenW, screenH, "layer");
        if (!s || !mctx) continue;
        this.drawKey(mctx, `mask:${rec.id}`, rec.width, rec.height, mulMat(base, [1, 0, 0, 1, rec.x, rec.y]), "alpha", screenW, screenH, none);
        mctx.setTransform(1, 0, 0, 1, 0, 0);
        this.paintLayer(s, l, full, 1, screenW, screenH);
        s.setTransform(1, 0, 0, 1, 0, 0);
        s.globalCompositeOperation = "destination-in";
        s.drawImage(this.scratchMask!, 0, 0);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = opacity;
        ctx.globalCompositeOperation = CANVAS_BLEND[l.blend];
        ctx.drawImage(this.scratch!, 0, 0);
      } else {
        ctx.globalAlpha = l.kind === "raster" ? opacity : 1;
        ctx.globalCompositeOperation = CANVAS_BLEND[l.blend];
        this.paintLayer(ctx, l, full, opacity, screenW, screenH);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    }
    const mrec = o.overlayMaskId ? doc.masks[o.overlayMaskId] : undefined;
    if (mrec) {
      const c = parseColor(o.tint ?? "#ff3366") ?? [255, 51, 102, 255];
      const tint: [number, number, number, number] = [c[0], c[1], c[2], Math.round(255 * Math.max(0.05, Math.min(1, o.tintAlpha ?? 0.45)))];
      const tk = tint.join(",");
      if (tk !== this.tintKey) {
        for (const k of [...this.tiles.keys()]) if (k.includes("|tint|")) this.tiles.delete(k);
        this.tintKey = tk;
      }
      this.drawKey(ctx, `mask:${mrec.id}`, mrec.width, mrec.height, mulMat(base, [1, 0, 0, 1, mrec.x, mrec.y]), "tint", screenW, screenH, tint);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** A small PNG-able snapshot of the document (agent thumbnail, layer panel), at most `maxSide` px. */
  snapshot(doc: DesignDoc, maxSide: number, t: number): OffscreenCanvas {
    const s = Math.min(1, maxSide / Math.max(doc.width, doc.height));
    const w = Math.max(1, Math.round(doc.width * s)), h = Math.max(1, Math.round(doc.height * s));
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext("2d");
    if (ctx) this.draw(ctx, w, h, doc, [s, 0, 0, s, 0, 0], { t });
    return c;
  }

  /** A layer thumbnail drawn into `target` (a small canvas in the layers panel). */
  thumb(target: HTMLCanvasElement, doc: DesignDoc, l: Layer): void {
    const ctx = target.getContext("2d");
    if (!ctx) return;
    const tw = target.width, th = target.height;
    ctx.clearRect(0, 0, tw, th);
    if (l.kind === "raster") {
      const r = l as RasterLayer;
      const pv = this.preview(r.id, r.width, r.height, "rgba", 96);
      if (!pv) return;
      const s = Math.min(tw / pv.canvas.width, th / pv.canvas.height);
      ctx.drawImage(pv.canvas, (tw - pv.canvas.width * s) / 2, (th - pv.canvas.height * s) / 2, pv.canvas.width * s, pv.canvas.height * s);
    } else if (l.kind === "vector") {
      const s = Math.min(tw / doc.width, th / doc.height);
      ctx.setTransform(s, 0, 0, s, (tw - doc.width * s) / 2, (th - doc.height * s) / 2);
      drawVectorLayer(ctx, l, 1);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
  }
}
