// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, test } from "bun:test";
import { cubicBezierEase, easeFn, frameTimes, layerMatrix, layerStateAt, sampleTrack } from "./anim.ts";
import { createDoc } from "./doc.ts";
import type { RasterLayer, Track } from "./types.ts";

describe("easing (CSS Easing L1)", () => {
  test("cubic-bezier hits its endpoints and the identity curve is linear", () => {
    const f = cubicBezierEase(0.25, 0.1, 0.25, 1);
    expect(f(0)).toBe(0);
    expect(f(1)).toBe(1);
    const lin = cubicBezierEase(0, 0, 1, 1);
    for (const t of [0.1, 0.33, 0.5, 0.9]) expect(lin(t)).toBeCloseTo(t, 6);
  });

  test("ease-in-out is point-symmetric about (0.5, 0.5)", () => {
    const f = easeFn("ease-in-out");
    expect(f(0.5)).toBeCloseTo(0.5, 5);
    for (const t of [0.1, 0.25, 0.4]) expect(f(t) + f(1 - t)).toBeCloseTo(1, 5);
  });

  test("the solved curve matches the parametric definition", () => {
    // For parameter s, B(s) = (x(s), y(s)); the ease at x(s) must equal y(s).
    const [x1, y1, x2, y2] = [0.42, 0, 0.58, 1];
    const f = cubicBezierEase(x1, y1, x2, y2);
    for (const s of [0.1, 0.3, 0.6, 0.85]) {
      const bx = 3 * (1 - s) ** 2 * s * x1 + 3 * (1 - s) * s * s * x2 + s ** 3;
      const by = 3 * (1 - s) ** 2 * s * y1 + 3 * (1 - s) * s * s * y2 + s ** 3;
      expect(f(bx)).toBeCloseTo(by, 5);
    }
  });

  test("ease, ease-in, ease-out are monotonic for in-range control points; overshoot curves may leave 0..1", () => {
    for (const name of ["ease", "ease-in", "ease-out"] as const) {
      const f = easeFn(name);
      let prev = 0;
      for (let i = 1; i <= 100; i++) {
        const v = f(i / 100);
        expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
        prev = v;
      }
    }
    const back = easeFn({ cubic: [0.3, -0.6, 0.7, 1.6] });
    let min = 1, max = 0;
    for (let i = 1; i < 100; i++) { const v = back(i / 100); min = Math.min(min, v); max = Math.max(max, v); }
    expect(min).toBeLessThan(0);
    expect(max).toBeGreaterThan(1);
  });

  test("malformed cubic falls back to linear", () => {
    const f = easeFn({ cubic: [Number.NaN, 0, 1, 1] });
    expect(f(0.3)).toBeCloseTo(0.3, 9);
  });
});

describe("sampleTrack", () => {
  const track: Track = {
    layerId: "a", prop: "x",
    keys: [{ t: 0, v: 0, ease: "linear" }, { t: 1000, v: 100, ease: "hold" }, { t: 2000, v: 300, ease: "linear" }],
  };
  test("clamps outside the keys and interpolates inside", () => {
    expect(sampleTrack(track, -50)).toBe(0);
    expect(sampleTrack(track, 250)).toBeCloseTo(25, 9);
    expect(sampleTrack(track, 5000)).toBe(300);
    expect(sampleTrack({ ...track, keys: [] }, 10)).toBeUndefined();
  });
  test("hold keeps the key value until the next key", () => {
    expect(sampleTrack(track, 1000)).toBe(100);
    expect(sampleTrack(track, 1999)).toBe(100);
    expect(sampleTrack(track, 2000)).toBe(300);
  });
});

describe("layer state and matrix", () => {
  const doc = createDoc("anim", 200, 200);
  const layer: RasterLayer = {
    id: "a", name: "a", kind: "raster", width: 10, height: 10, visible: true, locked: false, opacity: 0.5, blend: "normal",
    x: 5, y: 6, scale: 1, rotation: 0, anchorX: 5, anchorY: 5,
  };
  doc.layers.a = layer;
  doc.order = ["a"];
  doc.timeline = { fps: 10, durationMs: 1000, loop: true, tracks: [{ layerId: "a", prop: "x", keys: [{ t: 0, v: 0, ease: "linear" }, { t: 1000, v: 100, ease: "linear" }] }] };

  test("tracks override base props; untracked props keep the layer value; loop wraps time", () => {
    expect(layerStateAt(doc, "a", 500)).toEqual({ x: 50, y: 6, scale: 1, rotation: 0, opacity: 0.5 });
    expect(layerStateAt(doc, "a", 1250).x).toBeCloseTo(25, 9);
    expect(layerStateAt(doc, "missing", 0)).toEqual({ x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 });
  });

  test("frameTimes covers the duration at the timeline fps", () => {
    const t = frameTimes(doc.timeline);
    expect(t).toHaveLength(10);
    expect(t[0]).toBe(0);
    expect(t[9]).toBeCloseTo(900, 9);
    expect(frameTimes({ fps: 30, durationMs: 0, loop: false, tracks: [] })).toEqual([0]);
    expect(frameTimes({ fps: 120, durationMs: 3_600_000, loop: false, tracks: [] })).toHaveLength(1000);
  });

  test("rotation turns about the anchor, clockwise on a y-down screen", () => {
    const m = layerMatrix({ ...layer, rotation: 90, x: 0, y: 0 });
    const ap = (px: number, py: number): [number, number] => [m[0] * px + m[2] * py + m[4], m[1] * px + m[3] * py + m[5]];
    const [ax, ay] = ap(5, 5);
    expect(ax).toBeCloseTo(5, 9);
    expect(ay).toBeCloseTo(5, 9);
    const [rx, ry] = ap(10, 5); // a point right of the anchor moves below it
    expect(rx).toBeCloseTo(5, 9);
    expect(ry).toBeCloseTo(10, 9);
    const s = layerMatrix({ ...layer, scale: 2, x: 0, y: 0, anchorX: 0, anchorY: 0 });
    expect(s.map((v) => v + 0)).toEqual([2, 0, 0, 2, 0, 0]); // + 0 folds -0
  });
});
