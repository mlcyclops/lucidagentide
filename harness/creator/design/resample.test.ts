// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/creator/design/resample.test.ts - Lanczos-3 resize, resize planning, unsharp mask.

import { describe, expect, test } from "bun:test";
import { planResize, resampleLanczos3, unsharp } from "./resample.ts";
import type { RasterData } from "./types.ts";

function solid(w: number, h: number, px: [number, number, number, number]): RasterData {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) rgba.set(px, i * 4);
  return { width: w, height: h, rgba };
}

describe("resampleLanczos3", () => {
  test("identity size is a byte-exact copy", () => {
    const src = solid(7, 5, [1, 2, 3, 4]);
    for (let i = 0; i < src.rgba.length; i++) src.rgba[i] = (i * 37) % 256;
    const out = resampleLanczos3(src, 7, 5);
    expect(Array.from(out.rgba)).toEqual(Array.from(src.rgba));
    expect(out.rgba).not.toBe(src.rgba);
  });

  test("output dimensions for up and down scaling", () => {
    const src = solid(10, 8, [9, 9, 9, 255]);
    const up = resampleLanczos3(src, 25, 3);
    expect([up.width, up.height, up.rgba.length]).toEqual([25, 3, 25 * 3 * 4]);
    const down = resampleLanczos3(src, 1, 1);
    expect([down.width, down.height, down.rgba.length]).toEqual([1, 1, 4]);
  });

  test("a constant color stays constant (within 1) after up and down scaling", () => {
    const color: [number, number, number, number] = [200, 100, 50, 255];
    const src = solid(17, 13, color);
    for (const [w, h] of [[40, 30], [5, 4], [17, 2], [3, 50]] as const) {
      const out = resampleLanczos3(src, w, h);
      for (let i = 0; i < out.rgba.length; i++) expect(Math.abs(out.rgba[i]! - color[i % 4]!)).toBeLessThanOrEqual(1);
    }
  });

  test("premultiplied filtering: red next to transparent black keeps its hue", () => {
    const src: RasterData = { width: 2, height: 1, rgba: new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 0, 0]) };
    for (const w of [8, 3]) {
      const out = resampleLanczos3(src, w, 1);
      let partial = 0;
      for (let x = 0; x < w; x++) {
        const a = out.rgba[x * 4 + 3]!;
        if (a === 0) continue;
        if (a < 255) partial++;
        expect(out.rgba[x * 4]!).toBeGreaterThanOrEqual(254);
        expect(out.rgba[x * 4 + 1]!).toBe(0);
        expect(out.rgba[x * 4 + 2]!).toBe(0);
      }
      expect(partial).toBeGreaterThan(0);
    }
  });

  test("refuses invalid targets", () => {
    const src = solid(2, 2, [0, 0, 0, 255]);
    expect(() => resampleLanczos3(src, 0, 2)).toThrow();
    expect(() => resampleLanczos3(src, 1.5, 2)).toThrow();
    expect(() => resampleLanczos3(src, 70000, 1)).toThrow();
    expect(() => resampleLanczos3(src, 65535, 65535)).toThrow();
  });
});

describe("planResize", () => {
  test("keepAspect derives the missing side", () => {
    expect(planResize(1000, 500, { width: 200, keepAspect: true })).toEqual({ width: 200, height: 100 });
    expect(planResize(1000, 500, { height: 50, keepAspect: true })).toEqual({ width: 100, height: 50 });
    expect(planResize(1000, 500, { width: 333, keepAspect: true })).toEqual({ width: 333, height: 167 });
    expect(planResize(1000, 1, { width: 10, keepAspect: true })).toEqual({ width: 10, height: 1 });
    expect(planResize(1000, 500, { width: 200, keepAspect: false })).toEqual({ width: 200, height: 500 });
    expect(planResize(1000, 500, { width: 200, height: 300, keepAspect: true })).toEqual({ width: 200, height: 300 });
  });

  test("scale wins over width and height", () => {
    expect(planResize(1000, 500, { width: 1, height: 1, scale: 0.5, keepAspect: true })).toEqual({ width: 500, height: 250 });
    expect(planResize(3, 3, { scale: 0.01, keepAspect: true })).toEqual({ width: 1, height: 1 });
  });

  test("refusals", () => {
    const bad: Parameters<typeof planResize>[2][] = [
      { keepAspect: true },
      { width: 0, keepAspect: true },
      { width: -5, keepAspect: true },
      { width: Number.NaN, keepAspect: true },
      { height: Number.POSITIVE_INFINITY, keepAspect: true },
      { width: 70000, keepAspect: false },
      { scale: 0, keepAspect: true },
      { scale: -1, keepAspect: true },
      { width: 65535, height: 65535, keepAspect: false },
      { width: 100, keepAspect: true, scale: 1000 },
    ];
    for (const req of bad) expect("error" in planResize(1000, 500, req)).toBe(true);
    expect("error" in planResize(0, 500, { width: 10, keepAspect: true })).toBe(true);
  });
});

describe("unsharp", () => {
  test("a constant image is unchanged and alpha is untouched", () => {
    const src = solid(9, 9, [120, 60, 30, 77]);
    const out = unsharp(src, 1.5, 4);
    expect(Array.from(out.rgba)).toEqual(Array.from(src.rgba));
  });

  test("an edge gains contrast on both sides", () => {
    const src = solid(20, 4, [50, 50, 50, 255]);
    for (let y = 0; y < 4; y++) for (let x = 10; x < 20; x++) src.rgba.set([200, 200, 200, 255], (y * 20 + x) * 4);
    const out = unsharp(src, 1, 3);
    expect(out.rgba[(1 * 20 + 10) * 4]!).toBeGreaterThan(200);
    expect(out.rgba[(1 * 20 + 9) * 4]!).toBeLessThan(50);
    expect(out.rgba[(1 * 20 + 9) * 4 + 3]!).toBe(255);
    expect(Array.from(unsharp(src, 0, 3).rgba)).toEqual(Array.from(src.rgba));
  });
});
