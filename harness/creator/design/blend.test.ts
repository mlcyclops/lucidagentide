// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/creator/design/blend.test.ts - W3C Compositing and Blending L1 spot values and source-over.

import { describe, expect, test } from "bun:test";
import { blendChannel, blendNonSeparable, compositeInto } from "./blend.ts";
import type { RasterData } from "./types.ts";

const lum = (c: [number, number, number]): number => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];

function solid(w: number, h: number, px: [number, number, number, number]): RasterData {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) rgba.set(px, i * 4);
  return { width: w, height: h, rgba };
}

const pixel = (r: RasterData, x: number, y: number): number[] => Array.from(r.rgba.subarray((y * r.width + x) * 4, (y * r.width + x) * 4 + 4));

describe("separable blend modes", () => {
  test("multiply, screen, darken, lighten", () => {
    expect(blendChannel("multiply", 0.5, 0.5)).toBeCloseTo(0.25, 12);
    expect(blendChannel("screen", 0.5, 0.5)).toBeCloseTo(0.75, 12);
    expect(blendChannel("darken", 0.3, 0.6)).toBe(0.3);
    expect(blendChannel("lighten", 0.3, 0.6)).toBe(0.6);
    expect(blendChannel("normal", 0.3, 0.6)).toBe(0.6);
  });

  test("overlay is hard-light with arguments swapped", () => {
    expect(blendChannel("overlay", 0.25, 0.8)).toBeCloseTo(0.4, 12); // Multiply(Cs, 2Cb)
    expect(blendChannel("overlay", 0.75, 0.2)).toBeCloseTo(0.6, 12); // Screen(Cs, 2Cb - 1)
    expect(blendChannel("hard-light", 0.8, 0.25)).toBeCloseTo(0.4, 12);
    expect(blendChannel("hard-light", 0.2, 0.75)).toBeCloseTo(0.6, 12);
  });

  test("color-dodge edge cases", () => {
    expect(blendChannel("color-dodge", 0, 1)).toBe(0);
    expect(blendChannel("color-dodge", 0.5, 1)).toBe(1);
    expect(blendChannel("color-dodge", 0.25, 0.5)).toBeCloseTo(0.5, 12);
    expect(blendChannel("color-dodge", 0.75, 0.5)).toBe(1);
  });

  test("color-burn edge cases", () => {
    expect(blendChannel("color-burn", 1, 0)).toBe(1);
    expect(blendChannel("color-burn", 0.5, 0)).toBe(0);
    expect(blendChannel("color-burn", 0.75, 0.5)).toBeCloseTo(0.5, 12);
    expect(blendChannel("color-burn", 0.25, 0.5)).toBe(0);
  });

  test("soft-light both Cs branches and both D(Cb) branches", () => {
    expect(blendChannel("soft-light", 0.5, 0.25)).toBeCloseTo(0.375, 12);
    // Cs > 0.5, Cb <= 0.25: D = ((16Cb - 12)Cb + 4)Cb = 0.448
    expect(blendChannel("soft-light", 0.2, 0.75)).toBeCloseTo(0.324, 12);
    // Cs > 0.5, Cb > 0.25: D = sqrt(Cb) = 0.8
    expect(blendChannel("soft-light", 0.64, 0.75)).toBeCloseTo(0.72, 12);
    expect(blendChannel("soft-light", 0.3, 0.5)).toBeCloseTo(0.3, 12);
  });

  test("difference and exclusion", () => {
    expect(blendChannel("difference", 0.2, 0.7)).toBeCloseTo(0.5, 12);
    expect(blendChannel("difference", 0.7, 0.2)).toBeCloseTo(0.5, 12);
    expect(blendChannel("exclusion", 0.2, 0.7)).toBeCloseTo(0.62, 12);
    expect(blendChannel("exclusion", 0.5, 0.5)).toBeCloseTo(0.5, 12);
  });

  test("non-separable modes are refused", () => {
    expect(() => blendChannel("hue", 0.5, 0.5)).toThrow();
    expect(() => blendChannel("luminosity", 0.5, 0.5)).toThrow();
  });
});

describe("non-separable blend modes", () => {
  const inRange = (c: number[]): boolean => c.every((v) => v >= -1e-12 && v <= 1 + 1e-12);

  test("luminosity keeps Lum(Cs) and color keeps Lum(Cb)", () => {
    const cb: [number, number, number] = [0.2, 0.6, 0.9];
    const cs: [number, number, number] = [0.9, 0.1, 0.3];
    expect(lum(blendNonSeparable("luminosity", cb, cs))).toBeCloseTo(lum(cs), 10);
    expect(lum(blendNonSeparable("color", cb, cs))).toBeCloseTo(lum(cb), 10);
  });

  test("ClipColor keeps channels in 0..1 while preserving the target luminosity", () => {
    // SetLum([1, 0, 0], 0.9) overshoots red to 1.6 before ClipColor.
    const out = blendNonSeparable("color", [0.9, 0.9, 0.9], [1, 0, 0]);
    expect(inRange(out)).toBe(true);
    expect(lum(out)).toBeCloseTo(0.9, 10);
    expect(out[0]).toBeCloseTo(1, 10);
    // Pushing a dark color down produces negatives before ClipColor.
    const dark = blendNonSeparable("luminosity", [0, 0, 1], [0.02, 0.02, 0.02]);
    expect(inRange(dark)).toBe(true);
    expect(lum(dark)).toBeCloseTo(0.02, 10);
  });

  test("hue takes the source hue with backdrop saturation and luminosity", () => {
    const out = blendNonSeparable("hue", [0, 0.5, 0], [1, 0, 0]);
    expect(out[0]).toBeCloseTo(0.645, 10);
    expect(out[1]).toBeCloseTo(0.145, 10);
    expect(out[2]).toBeCloseTo(0.145, 10);
  });

  test("saturation of a gray backdrop stays gray at the backdrop luminosity", () => {
    const out = blendNonSeparable("saturation", [0.4, 0.4, 0.4], [1, 0, 0]);
    expect(out[0]).toBeCloseTo(0.4, 10);
    expect(out[1]).toBeCloseTo(0.4, 10);
    expect(out[2]).toBeCloseTo(0.4, 10);
  });
});

describe("compositeInto", () => {
  test("normal at opacity 0.5 over opaque black", () => {
    const dst = solid(1, 1, [0, 0, 0, 255]);
    compositeInto(dst, solid(1, 1, [255, 0, 0, 255]), { blend: "normal", opacity: 0.5, dx: 0, dy: 0 });
    expect(pixel(dst, 0, 0)).toEqual([128, 0, 0, 255]);
  });

  test("source-over alpha of two 50% layers is 0.75", () => {
    const dst = solid(1, 1, [0, 0, 0, 0]);
    const src = solid(1, 1, [10, 20, 30, 255]);
    compositeInto(dst, src, { blend: "normal", opacity: 0.5, dx: 0, dy: 0 });
    compositeInto(dst, src, { blend: "normal", opacity: 0.5, dx: 0, dy: 0 });
    expect(Math.abs(pixel(dst, 0, 0)[3]! - 0.75 * 255)).toBeLessThanOrEqual(1);
    expect(pixel(dst, 0, 0).slice(0, 3)).toEqual([10, 20, 30]);
  });

  test("multiply over an opaque backdrop applies B(Cb, Cs)", () => {
    const dst = solid(1, 1, [128, 255, 0, 255]);
    compositeInto(dst, solid(1, 1, [128, 128, 255, 255]), { blend: "multiply", opacity: 1, dx: 0, dy: 0 });
    expect(pixel(dst, 0, 0)).toEqual([64, 128, 0, 255]);
  });

  test("a blend mode over a transparent backdrop is plain source", () => {
    const dst = solid(1, 1, [0, 0, 0, 0]);
    compositeInto(dst, solid(1, 1, [200, 100, 50, 255]), { blend: "difference", opacity: 1, dx: 0, dy: 0 });
    expect(pixel(dst, 0, 0)).toEqual([200, 100, 50, 255]);
  });

  test("mask coverage 0 (or outside the mask) leaves dst unchanged", () => {
    const dst = solid(2, 1, [5, 6, 7, 200]);
    const before = Array.from(dst.rgba);
    const mask = { width: 1, height: 1, alpha: new Uint8Array([0]) };
    compositeInto(dst, solid(2, 1, [255, 255, 255, 255]), { blend: "screen", opacity: 1, dx: 0, dy: 0, mask });
    expect(Array.from(dst.rgba)).toEqual(before);
  });

  test("mask placement selects which pixels receive the source", () => {
    const dst = solid(3, 1, [0, 0, 0, 255]);
    const mask = { width: 1, height: 1, alpha: new Uint8Array([255]) };
    compositeInto(dst, solid(3, 1, [255, 255, 255, 255]), { blend: "normal", opacity: 1, dx: 0, dy: 0, mask, maskDx: 1, maskDy: 0 });
    expect(pixel(dst, 0, 0)).toEqual([0, 0, 0, 255]);
    expect(pixel(dst, 1, 0)).toEqual([255, 255, 255, 255]);
    expect(pixel(dst, 2, 0)).toEqual([0, 0, 0, 255]);
  });

  test("offset placement clips at every edge", () => {
    const src = solid(2, 2, [255, 0, 0, 255]);
    const a = solid(3, 3, [0, 0, 0, 0]);
    compositeInto(a, src, { blend: "normal", opacity: 1, dx: 2, dy: 2 });
    const b = solid(3, 3, [0, 0, 0, 0]);
    compositeInto(b, src, { blend: "normal", opacity: 1, dx: -1, dy: -1 });
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 3; x++) {
        expect(pixel(a, x, y)).toEqual(x === 2 && y === 2 ? [255, 0, 0, 255] : [0, 0, 0, 0]);
        expect(pixel(b, x, y)).toEqual(x === 0 && y === 0 ? [255, 0, 0, 255] : [0, 0, 0, 0]);
      }
    }
    const c = solid(3, 3, [0, 0, 0, 0]);
    compositeInto(c, src, { blend: "normal", opacity: 1, dx: 5, dy: 0 });
    expect(c.rgba.every((v) => v === 0)).toBe(true);
  });

  test("opacity is clamped and non-integer offsets are refused", () => {
    const dst = solid(1, 1, [0, 0, 0, 255]);
    compositeInto(dst, solid(1, 1, [255, 255, 255, 255]), { blend: "normal", opacity: 7, dx: 0, dy: 0 });
    expect(pixel(dst, 0, 0)).toEqual([255, 255, 255, 255]);
    expect(() => compositeInto(dst, dst, { blend: "normal", opacity: 1, dx: 0.5, dy: 0 })).toThrow();
  });
});
