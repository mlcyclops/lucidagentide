// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/creator/design/tiles.ts - budgeted 256x256 tile storage for layer pixels and masks.
//
// A layer's pixels never live in one giant buffer: they are split into TILE x TILE tiles keyed by layer
// id (RGBA, 4 bytes per pixel) or by "mask:" + id (1-channel coverage). The store tracks a byte budget
// across every key and keeps one LRU order over all tiles. Over budget it either evicts the least recently
// used tiles through `onEvict` (the caller pages them out) or, with no handler, throws DesignBudgetError and
// leaves the store untouched. Missing tiles read as transparent / zero coverage.

import { DESIGN_LIMITS } from "./limits.ts";
import type { MaskData, RasterData, Rect } from "./types.ts";

export const TILE = 256;
/** Tiles per side needed to cover a maxSide layer (pixel coords 0..65535 -> tile 0..255). */
export const TILES_PER_SIDE = Math.ceil((DESIGN_LIMITS.maxSide + 1) / TILE);
const RGBA_TILE_BYTES = TILE * TILE * 4;
const MASK_TILE_BYTES = TILE * TILE;
/** First pixel coordinate past the addressable tile grid. */
const PIXEL_LIMIT = TILES_PER_SIDE * TILE;

export class DesignBudgetError extends Error {
  readonly needed: number;
  readonly budget: number;
  constructor(needed: number, budget: number) {
    super(`design tile budget exceeded: need ${needed} bytes, budget ${budget} bytes`);
    this.name = "DesignBudgetError";
    this.needed = needed;
    this.budget = budget;
  }
}

interface TileEntry { key: string; tx: number; ty: number; data: Uint8ClampedArray }

function tileIndex(tx: number, ty: number): number {
  if (!Number.isInteger(tx) || !Number.isInteger(ty) || tx < 0 || ty < 0 || tx >= TILES_PER_SIDE || ty >= TILES_PER_SIDE) {
    throw new Error(`tile coordinate out of range: ${String(tx)},${String(ty)}`);
  }
  return ty * 65536 + tx;
}

const lruKey = (key: string, idx: number): string => `${idx}:${key}`;

export class TileStore {
  readonly budgetBytes: number;
  /** Called for each tile evicted to make room (LRU first). When unset, overflow throws DesignBudgetError. */
  onEvict?: (key: string, tx: number, ty: number, data: Uint8ClampedArray) => void;
  private readonly byKey = new Map<string, Map<number, TileEntry>>();
  /** Insertion order is recency: first entry is least recently used. */
  private readonly lru = new Map<string, TileEntry>();
  private used = 0;

  constructor(budgetBytes: number) {
    if (typeof budgetBytes !== "number" || !Number.isFinite(budgetBytes) || budgetBytes < 0) {
      throw new Error("tile budget must be a finite number >= 0");
    }
    this.budgetBytes = budgetBytes;
  }

  get(key: string, tx: number, ty: number): Uint8ClampedArray | undefined {
    const idx = tileIndex(tx, ty);
    const entry = this.byKey.get(key)?.get(idx);
    if (!entry) return undefined;
    const lk = lruKey(key, idx);
    this.lru.delete(lk);
    this.lru.set(lk, entry);
    return entry.data;
  }

  /** True when the tile exists, without touching LRU order. */
  has(key: string, tx: number, ty: number): boolean {
    return this.byKey.get(key)?.has(tileIndex(tx, ty)) ?? false;
  }

  set(key: string, tx: number, ty: number, data: Uint8ClampedArray): void {
    if (typeof key !== "string" || key.length === 0) throw new Error("tile key must be a non-empty string");
    const idx = tileIndex(tx, ty);
    if (!(data instanceof Uint8ClampedArray) || (data.length !== RGBA_TILE_BYTES && data.length !== MASK_TILE_BYTES)) {
      throw new Error(`tile data must be ${RGBA_TILE_BYTES} (RGBA) or ${MASK_TILE_BYTES} (mask) bytes`);
    }
    const lk = lruKey(key, idx);
    const existing = this.byKey.get(key)?.get(idx);
    const oldBytes = existing ? existing.data.byteLength : 0;
    const needed = this.used - oldBytes + data.byteLength;
    if (needed > this.budgetBytes) {
      // Nothing is touched until we know the tile can fit (all other tiles evicted at worst).
      if (!this.onEvict || data.byteLength > this.budgetBytes) throw new DesignBudgetError(needed, this.budgetBytes);
      // Evict while the new size does not fit. Our own tile's old bytes stay counted until replaced.
      let projected = needed;
      for (const [k, entry] of this.lru) {
        if (projected <= this.budgetBytes) break;
        if (k === lk) continue;
        this.removeEntry(entry, k);
        projected -= entry.data.byteLength;
        this.onEvict(entry.key, entry.tx, entry.ty, entry.data);
      }
    }
    let tiles = this.byKey.get(key);
    if (!tiles) { tiles = new Map(); this.byKey.set(key, tiles); }
    const entry: TileEntry = { key, tx, ty, data };
    tiles.set(idx, entry);
    this.used += data.byteLength - oldBytes;
    this.lru.delete(lk);
    this.lru.set(lk, entry);
  }

  /** Remove every tile of `key`. */
  delete(key: string): void {
    const tiles = this.byKey.get(key);
    if (!tiles) return;
    for (const [idx, entry] of tiles) {
      this.lru.delete(lruKey(key, idx));
      this.used -= entry.data.byteLength;
    }
    this.byKey.delete(key);
  }

  deleteTile(key: string, tx: number, ty: number): void {
    const idx = tileIndex(tx, ty);
    const entry = this.byKey.get(key)?.get(idx);
    if (entry) this.removeEntry(entry, lruKey(key, idx));
  }

  bytes(): number {
    return this.used;
  }

  /** Distinct keys holding at least one tile. */
  keys(): string[] {
    return [...this.byKey.keys()];
  }

  /** Tiles of `key` in row-major order (ty, then tx). */
  tilesOf(key: string): { tx: number; ty: number }[] {
    const tiles = this.byKey.get(key);
    if (!tiles) return [];
    const idxs = [...tiles.keys()].sort((a, b) => a - b);
    return idxs.map((i) => ({ tx: i % 65536, ty: Math.floor(i / 65536) }));
  }

  private removeEntry(entry: TileEntry, lk: string): void {
    const tiles = this.byKey.get(entry.key);
    if (!tiles) return;
    tiles.delete(tileIndex(entry.tx, entry.ty));
    if (tiles.size === 0) this.byKey.delete(entry.key);
    this.lru.delete(lk);
    this.used -= entry.data.byteLength;
  }
}

function checkInt(v: number, what: string): void {
  if (!Number.isInteger(v)) throw new Error(`${what} must be an integer`);
}

function checkPlane(width: number, height: number, length: number, channels: number, what: string): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 0 || height < 0 || width > DESIGN_LIMITS.maxSide || height > DESIGN_LIMITS.maxSide) {
    throw new Error(`${what} dimensions out of range`);
  }
  if (width * height > DESIGN_LIMITS.maxRasterPixels) throw new Error(`${what} exceeds the pixel limit`);
  if (length !== width * height * channels) throw new Error(`${what} buffer length does not match its dimensions`);
}

/** Blit `src` (width x height, `channels` per pixel) into the tiles of `key` at integer offset (dx, dy). */
function writePlane(store: TileStore, key: string, src: ArrayLike<number> & { subarray(a: number, b: number): ArrayLike<number> }, width: number, height: number, channels: number, dx: number, dy: number): void {
  checkInt(dx, "dx");
  checkInt(dy, "dy");
  const tileBytes = TILE * TILE * channels;
  const x0 = Math.max(0, dx), y0 = Math.max(0, dy);
  const x1 = Math.min(PIXEL_LIMIT, dx + width), y1 = Math.min(PIXEL_LIMIT, dy + height);
  if (x0 >= x1 || y0 >= y1) return;
  const tx0 = Math.floor(x0 / TILE), tx1 = Math.floor((x1 - 1) / TILE);
  const ty0 = Math.floor(y0 / TILE), ty1 = Math.floor((y1 - 1) / TILE);
  // Fail before writing anything when the new tiles cannot fit and nothing may be evicted.
  if (!store.onEvict) {
    let missing = 0;
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) if (!store.has(key, tx, ty)) missing++;
    const needed = store.bytes() + missing * tileBytes;
    if (needed > store.budgetBytes) throw new DesignBudgetError(needed, store.budgetBytes);
  }
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      let tile = store.get(key, tx, ty);
      if (tile && tile.length !== tileBytes) throw new Error(`tile ${key} ${tx},${ty} has the wrong channel count`);
      if (!tile) {
        tile = new Uint8ClampedArray(tileBytes);
        store.set(key, tx, ty, tile);
      }
      const px0 = Math.max(x0, tx * TILE), px1 = Math.min(x1, tx * TILE + TILE);
      const py0 = Math.max(y0, ty * TILE), py1 = Math.min(y1, ty * TILE + TILE);
      const run = (px1 - px0) * channels;
      for (let py = py0; py < py1; py++) {
        const s = ((py - dy) * width + (px0 - dx)) * channels;
        const d = ((py - ty * TILE) * TILE + (px0 - tx * TILE)) * channels;
        tile.set(src.subarray(s, s + run), d);
      }
    }
  }
}

function checkRect(rect: Rect): void {
  if (!rect || !Number.isInteger(rect.x) || !Number.isInteger(rect.y) || !Number.isInteger(rect.w) || !Number.isInteger(rect.h)) {
    throw new Error("rect fields must be integers");
  }
  if (rect.w < 0 || rect.h < 0 || rect.w > DESIGN_LIMITS.maxSide || rect.h > DESIGN_LIMITS.maxSide) throw new Error("rect size out of range");
  if (rect.w * rect.h > DESIGN_LIMITS.maxRasterPixels) throw new Error("rect exceeds the pixel limit");
}

/** Copy `rect` of a planeW x planeH plane into `out` (already zeroed, rect validated by the caller). */
function readPlane(store: TileStore, key: string, planeW: number, planeH: number, rect: Rect, channels: number, out: Uint8ClampedArray | Uint8Array): void {
  if (!Number.isInteger(planeW) || !Number.isInteger(planeH) || planeW < 0 || planeH < 0) throw new Error("layer size must be integers >= 0");
  const tileBytes = TILE * TILE * channels;
  const x0 = Math.max(0, rect.x), y0 = Math.max(0, rect.y);
  const x1 = Math.min(planeW, PIXEL_LIMIT, rect.x + rect.w), y1 = Math.min(planeH, PIXEL_LIMIT, rect.y + rect.h);
  if (x0 >= x1 || y0 >= y1) return;
  const tx0 = Math.floor(x0 / TILE), tx1 = Math.floor((x1 - 1) / TILE);
  const ty0 = Math.floor(y0 / TILE), ty1 = Math.floor((y1 - 1) / TILE);
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const tile = store.get(key, tx, ty);
      if (!tile) continue;
      if (tile.length !== tileBytes) throw new Error(`tile ${key} ${tx},${ty} has the wrong channel count`);
      const px0 = Math.max(x0, tx * TILE), px1 = Math.min(x1, tx * TILE + TILE);
      const py0 = Math.max(y0, ty * TILE), py1 = Math.min(y1, ty * TILE + TILE);
      const run = (px1 - px0) * channels;
      for (let py = py0; py < py1; py++) {
        const s = ((py - ty * TILE) * TILE + (px0 - tx * TILE)) * channels;
        const d = ((py - rect.y) * rect.w + (px0 - rect.x)) * channels;
        out.set(tile.subarray(s, s + run), d);
      }
    }
  }
}

/** Blit a straight RGBA raster into `key`'s RGBA tiles at integer layer offset (dx, dy); negative coords clip. */
export function writeRaster(store: TileStore, key: string, raster: RasterData, dx: number, dy: number): void {
  checkPlane(raster.width, raster.height, raster.rgba.length, 4, "raster");
  writePlane(store, key, raster.rgba, raster.width, raster.height, 4, dx, dy);
}

/** Read `rect` (layer pixel space) of a layerW x layerH layer; outside the layer or missing tiles read 0,0,0,0. */
export function readRect(store: TileStore, key: string, layerW: number, layerH: number, rect: Rect): RasterData {
  checkRect(rect);
  const rgba = new Uint8ClampedArray(rect.w * rect.h * 4);
  readPlane(store, key, layerW, layerH, rect, 4, rgba);
  return { width: rect.w, height: rect.h, rgba };
}

/** Blit a coverage mask into `key`'s 1-channel tiles at integer offset (dx, dy); negative coords clip. */
export function writeMask(store: TileStore, key: string, mask: MaskData, dx: number, dy: number): void {
  checkPlane(mask.width, mask.height, mask.alpha.length, 1, "mask");
  writePlane(store, key, mask.alpha, mask.width, mask.height, 1, dx, dy);
}

/** Read `rect` of a maskW x maskH mask; outside the mask or missing tiles read 0 coverage. */
export function readMaskRect(store: TileStore, key: string, maskW: number, maskH: number, rect: Rect): MaskData {
  checkRect(rect);
  const alpha = new Uint8Array(rect.w * rect.h);
  readPlane(store, key, maskW, maskH, rect, 1, alpha);
  return { width: rect.w, height: rect.h, alpha };
}
