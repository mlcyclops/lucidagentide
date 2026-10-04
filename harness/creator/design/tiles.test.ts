// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/creator/design/tiles.test.ts - tile store budget, LRU eviction, and blit round trips.

import { describe, expect, test } from "bun:test";
import { DesignBudgetError, readMaskRect, readRect, TILE, TileStore, writeMask, writeRaster } from "./tiles.ts";
import type { RasterData } from "./types.ts";

const RGBA_TILE = TILE * TILE * 4;
const MASK_TILE = TILE * TILE;

function pattern(w: number, h: number): RasterData {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = i % 251;
    rgba[i * 4 + 1] = (i * 7) % 253;
    rgba[i * 4 + 2] = (i * 13) % 255;
    rgba[i * 4 + 3] = 1 + (i % 255);
  }
  return { width: w, height: h, rgba };
}

describe("writeRaster / readRect", () => {
  test("round trip across tile boundaries with an offset", () => {
    const store = new TileStore(64 * RGBA_TILE);
    const src = pattern(300, 10);
    writeRaster(store, "L1", src, 200, 250);
    expect(store.tilesOf("L1")).toEqual([{ tx: 0, ty: 0 }, { tx: 1, ty: 0 }, { tx: 0, ty: 1 }, { tx: 1, ty: 1 }]);
    expect(store.bytes()).toBe(4 * RGBA_TILE);
    const back = readRect(store, "L1", 600, 600, { x: 200, y: 250, w: 300, h: 10 });
    expect(back.width).toBe(300);
    expect(back.height).toBe(10);
    expect(Array.from(back.rgba)).toEqual(Array.from(src.rgba));
  });

  test("a shifted read sees transparent pixels left of the blit and outside the layer", () => {
    const store = new TileStore(64 * RGBA_TILE);
    const src = pattern(20, 2);
    writeRaster(store, "L1", src, 10, 0);
    const r = readRect(store, "L1", 25, 2, { x: 5, y: 0, w: 30, h: 2 });
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 30; x++) {
        const lx = x + 5;
        const o = (y * 30 + x) * 4;
        const got = Array.from(r.rgba.subarray(o, o + 4));
        if (lx < 10 || lx >= 25) expect(got).toEqual([0, 0, 0, 0]);
        else {
          const s = (y * 20 + (lx - 10)) * 4;
          expect(got).toEqual(Array.from(src.rgba.subarray(s, s + 4)));
        }
      }
    }
  });

  test("negative offsets clip", () => {
    const store = new TileStore(64 * RGBA_TILE);
    const src = pattern(4, 4);
    writeRaster(store, "L1", src, -2, -3);
    const r = readRect(store, "L1", 10, 10, { x: 0, y: 0, w: 2, h: 1 });
    expect(Array.from(r.rgba.subarray(0, 4))).toEqual(Array.from(src.rgba.subarray((3 * 4 + 2) * 4, (3 * 4 + 2) * 4 + 4)));
  });

  test("missing tiles and unknown keys read transparent", () => {
    const store = new TileStore(64 * RGBA_TILE);
    const r = readRect(store, "nope", 1000, 1000, { x: 100, y: 300, w: 400, h: 3 });
    expect(r.rgba.every((v) => v === 0)).toBe(true);
  });

  test("refuses malformed rects", () => {
    const store = new TileStore(RGBA_TILE);
    expect(() => readRect(store, "a", 10, 10, { x: 0.5, y: 0, w: 1, h: 1 })).toThrow();
    expect(() => readRect(store, "a", 10, 10, { x: 0, y: 0, w: -1, h: 1 })).toThrow();
    expect(() => readRect(store, "a", 10, 10, { x: 0, y: 0, w: 65535, h: 65535 })).toThrow();
  });
});

describe("TileStore budget", () => {
  test("overflow throws DesignBudgetError and leaves the store unchanged", () => {
    const store = new TileStore(2 * RGBA_TILE);
    store.set("a", 0, 0, new Uint8ClampedArray(RGBA_TILE));
    store.set("a", 1, 0, new Uint8ClampedArray(RGBA_TILE));
    let err: unknown;
    try { store.set("a", 2, 0, new Uint8ClampedArray(RGBA_TILE)); } catch (e) { err = e; }
    if (!(err instanceof DesignBudgetError)) throw new Error("expected DesignBudgetError");
    expect(err.name).toBe("DesignBudgetError");
    expect(err.needed).toBe(3 * RGBA_TILE);
    expect(err.budget).toBe(2 * RGBA_TILE);
    expect(store.bytes()).toBe(2 * RGBA_TILE);
    expect(store.get("a", 2, 0)).toBeUndefined();
    expect(store.tilesOf("a").length).toBe(2);
  });

  test("writeRaster over budget throws before writing any tile", () => {
    const store = new TileStore(RGBA_TILE);
    expect(() => writeRaster(store, "a", pattern(300, 1), 0, 0)).toThrow(DesignBudgetError);
    expect(store.bytes()).toBe(0);
    expect(store.keys()).toEqual([]);
  });

  test("replacing a tile accounts the size delta", () => {
    const store = new TileStore(RGBA_TILE);
    store.set("a", 0, 0, new Uint8ClampedArray(MASK_TILE));
    store.set("a", 0, 0, new Uint8ClampedArray(RGBA_TILE));
    expect(store.bytes()).toBe(RGBA_TILE);
    store.set("a", 0, 0, new Uint8ClampedArray(MASK_TILE));
    expect(store.bytes()).toBe(MASK_TILE);
  });

  test("onEvict evicts least recently used tiles in LRU order, never the tile being set", () => {
    const store = new TileStore(3 * RGBA_TILE);
    const evicted: string[] = [];
    store.onEvict = (key, tx, ty, data) => {
      expect(data.length).toBe(RGBA_TILE);
      evicted.push(`${key}:${tx},${ty}`);
    };
    store.set("a", 0, 0, new Uint8ClampedArray(RGBA_TILE));
    store.set("b", 1, 0, new Uint8ClampedArray(RGBA_TILE));
    store.set("c", 2, 0, new Uint8ClampedArray(RGBA_TILE));
    store.get("a", 0, 0); // a is now most recent
    store.set("d", 3, 0, new Uint8ClampedArray(RGBA_TILE));
    expect(evicted).toEqual(["b:1,0"]);
    store.set("e", 4, 0, new Uint8ClampedArray(RGBA_TILE));
    expect(evicted).toEqual(["b:1,0", "c:2,0"]);
    // Replacing an existing tile with the same size needs no eviction.
    store.set("e", 4, 0, new Uint8ClampedArray(RGBA_TILE));
    expect(evicted.length).toBe(2);
    expect(store.bytes()).toBe(3 * RGBA_TILE);
    expect(store.get("b", 1, 0)).toBeUndefined();
    expect(store.get("a", 0, 0)).toBeDefined();
  });

  test("a tile larger than the whole budget throws even with onEvict, evicting nothing", () => {
    const store = new TileStore(MASK_TILE);
    const evicted: number[] = [];
    store.onEvict = (_k, tx) => evicted.push(tx);
    store.set("m", 0, 0, new Uint8ClampedArray(MASK_TILE));
    expect(() => store.set("x", 1, 0, new Uint8ClampedArray(RGBA_TILE))).toThrow(DesignBudgetError);
    expect(evicted).toEqual([]);
    expect(store.bytes()).toBe(MASK_TILE);
  });

  test("deleteTile and delete keep byte accounting exact", () => {
    const store = new TileStore(10 * RGBA_TILE);
    store.set("a", 0, 0, new Uint8ClampedArray(RGBA_TILE));
    store.set("a", 0, 1, new Uint8ClampedArray(RGBA_TILE));
    store.set("mask:m", 0, 0, new Uint8ClampedArray(MASK_TILE));
    expect(store.bytes()).toBe(2 * RGBA_TILE + MASK_TILE);
    store.deleteTile("a", 0, 1);
    expect(store.bytes()).toBe(RGBA_TILE + MASK_TILE);
    store.deleteTile("a", 5, 5);
    expect(store.bytes()).toBe(RGBA_TILE + MASK_TILE);
    store.delete("a");
    expect(store.bytes()).toBe(MASK_TILE);
    expect(store.keys()).toEqual(["mask:m"]);
    store.delete("mask:m");
    expect(store.bytes()).toBe(0);
    expect(store.keys()).toEqual([]);
  });

  test("rejects bad tile sizes and coordinates", () => {
    const store = new TileStore(10 * RGBA_TILE);
    expect(() => store.set("a", 0, 0, new Uint8ClampedArray(100))).toThrow();
    expect(() => store.set("a", -1, 0, new Uint8ClampedArray(RGBA_TILE))).toThrow();
    expect(() => store.set("a", 256, 0, new Uint8ClampedArray(RGBA_TILE))).toThrow();
    expect(() => store.set("a", 0.5, 0, new Uint8ClampedArray(RGBA_TILE))).toThrow();
    expect(store.bytes()).toBe(0);
  });
});

describe("mask tiles", () => {
  test("writeMask / readMaskRect round trip across a tile boundary", () => {
    const store = new TileStore(10 * RGBA_TILE);
    const alpha = new Uint8Array(300 * 3);
    for (let i = 0; i < alpha.length; i++) alpha[i] = (i * 31) % 256;
    writeMask(store, "mask:m1", { width: 300, height: 3, alpha }, 250, 0);
    expect(store.bytes()).toBe(3 * MASK_TILE);
    const back = readMaskRect(store, "mask:m1", 1000, 10, { x: 250, y: 0, w: 300, h: 3 });
    expect(Array.from(back.alpha)).toEqual(Array.from(alpha));
    const before = readMaskRect(store, "mask:m1", 1000, 10, { x: 240, y: 0, w: 10, h: 3 });
    expect(before.alpha.every((v) => v === 0)).toBe(true);
  });

  test("RGBA and mask tiles under one key do not mix", () => {
    const store = new TileStore(10 * RGBA_TILE);
    writeMask(store, "k", { width: 2, height: 2, alpha: new Uint8Array(4).fill(9) }, 0, 0);
    expect(() => readRect(store, "k", 10, 10, { x: 0, y: 0, w: 2, h: 2 })).toThrow();
    expect(() => writeRaster(store, "k", pattern(2, 2), 0, 0)).toThrow();
  });
});
