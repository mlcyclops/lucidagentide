// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/creator/design/trace.test.ts - raster tracing: geometry, transparency, determinism, caps.

import { describe, expect, test } from "bun:test";
import { pathBBox } from "./path.ts";
import { TRACE_MAX_PIXELS, traceRaster } from "./trace.ts";
import type { RasterData } from "./types.ts";

function raster(w: number, h: number, px: (x: number, y: number) => [number, number, number, number]): RasterData {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) rgba.set(px(x, y), (y * w + x) * 4);
  }
  return { width: w, height: h, rgba };
}

const inSquare = (x: number, y: number): boolean => x >= 8 && x < 24 && y >= 8 && y < 24;
const redOnWhite = (): RasterData =>
  raster(32, 32, (x, y) => (inSquare(x, y) ? [255, 0, 0, 255] : [255, 255, 255, 255]));

describe("traceRaster", () => {
  test("a red square on white traces to a red path with the square's bounds", () => {
    const shapes = traceRaster(redOnWhite(), { colors: 4, minArea: 4, tolerance: 1 });
    const red = shapes.filter((s) => s.paint.fill === "#ff0000");
    expect(red.length).toBeGreaterThanOrEqual(1);
    const b = pathBBox(red[0]!.d!);
    expect(Math.abs(b.x - 8)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(b.y - 8)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(b.w - 16)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(b.h - 16)).toBeLessThanOrEqual(1.5);
    for (const s of shapes) {
      expect(s.kind).toBe("path");
      expect(s.id).toMatch(/^t\d+$/);
      expect(s.paint.stroke).toBeNull();
      expect(s.d!.every((c) => c.c === "M" || c.c === "L" || c.c === "Q" || c.c === "Z")).toBe(true);
    }
  });

  test("the surrounding color carries the enclosed region as a hole subpath", () => {
    const shapes = traceRaster(redOnWhite(), { colors: 4, minArea: 4, tolerance: 1 });
    const white = shapes.find((s) => s.paint.fill === "#ffffff");
    expect(white).toBeDefined();
    expect(white!.d!.filter((c) => c.c === "M").length).toBe(2);
    const b = pathBBox(white!.d!);
    expect(b).toEqual({ x: 0, y: 0, w: 32, h: 32 });
  });

  test("fully transparent image yields no shapes", () => {
    expect(traceRaster(raster(16, 16, () => [255, 0, 0, 0]), { colors: 8, minArea: 0, tolerance: 1 })).toEqual([]);
  });

  test("transparent pixels never become shapes", () => {
    const src = raster(20, 20, (x) => (x < 10 ? [0, 0, 255, 255] : [0, 0, 0, 10]));
    const shapes = traceRaster(src, { colors: 4, minArea: 1, tolerance: 1 });
    expect(shapes.length).toBeGreaterThanOrEqual(1);
    for (const s of shapes) {
      expect(s.paint.fill).toBe("#0000ff");
      const b = pathBBox(s.d!);
      expect(b.x + b.w).toBeLessThanOrEqual(10.5);
    }
  });

  test("minArea drops small regions", () => {
    const src = raster(32, 32, (x, y) => (x >= 4 && x < 6 && y >= 4 && y < 6 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    const kept = traceRaster(src, { colors: 2, minArea: 1, tolerance: 1 });
    expect(kept.some((s) => s.paint.fill === "#000000")).toBe(true);
    const dropped = traceRaster(src, { colors: 2, minArea: 10, tolerance: 1 });
    expect(dropped.some((s) => s.paint.fill === "#000000")).toBe(false);
  });

  test("deterministic: two runs on the same image are identical", () => {
    const src = raster(48, 40, (x, y) => [
      (x * 5) & 255,
      (y * 7) & 255,
      (x * y) % 200,
      (x + y) % 17 === 0 ? 0 : 255,
    ]);
    const opts = { colors: 12, minArea: 2, tolerance: 0.5 };
    const a = traceRaster(src, opts);
    const b = traceRaster(src, opts);
    expect(a.length).toBeGreaterThan(0);
    expect(b).toEqual(a);
  });

  test("refuses rasters over the pixel cap and malformed rasters", () => {
    const side = Math.sqrt(TRACE_MAX_PIXELS);
    expect(() => traceRaster({ width: side + 1, height: side, rgba: new Uint8ClampedArray(4) }, { colors: 2, minArea: 0, tolerance: 1 })).toThrow();
    expect(() => traceRaster({ width: 4, height: 4, rgba: new Uint8ClampedArray(8) }, { colors: 2, minArea: 0, tolerance: 1 })).toThrow();
    expect(() => traceRaster({ width: 0, height: 4, rgba: new Uint8ClampedArray(0) }, { colors: 2, minArea: 0, tolerance: 1 })).toThrow();
  });
});
