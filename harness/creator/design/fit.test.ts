// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/creator/design/fit.test.ts - Schneider bezier fitting: error bound, degenerate input, scale.

import { describe, expect, test } from "bun:test";
import { FIT_MAX_POINTS, fitBezier } from "./fit.ts";
import type { PathCmd } from "./types.ts";

function cubicAt(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const m = 1 - t;
  return m * m * m * p0 + 3 * m * m * t * p1 + 3 * m * t * t * p2 + t * t * t * p3;
}

/** Dense polyline sampling of an [M, C, ...] path. */
function sample(cmds: PathCmd[], perCurve: number): { xs: Float64Array; ys: Float64Array } {
  const xs: number[] = [], ys: number[] = [];
  let px = 0, py = 0;
  for (const c of cmds) {
    if (c.c === "M") { px = c.x; py = c.y; xs.push(px); ys.push(py); continue; }
    if (c.c !== "C") throw new Error(`unexpected ${c.c}`);
    for (let k = 1; k <= perCurve; k++) {
      const t = k / perCurve;
      xs.push(cubicAt(px, c.x1, c.x2, c.x, t));
      ys.push(cubicAt(py, c.y1, c.y2, c.y, t));
    }
    px = c.x; py = c.y;
  }
  return { xs: Float64Array.from(xs), ys: Float64Array.from(ys) };
}

function maxDeviation(points: [number, number][], cmds: PathCmd[]): number {
  const { xs, ys } = sample(cmds, 2000);
  let worst = 0;
  for (const [x, y] of points) {
    let best = Infinity;
    for (let i = 0; i < xs.length; i++) {
      const d = (xs[i]! - x) ** 2 + (ys[i]! - y) ** 2;
      if (d < best) best = d;
    }
    worst = Math.max(worst, Math.sqrt(best));
  }
  return worst;
}

describe("fitBezier", () => {
  test("points sampled from a known cubic stay within sqrt(maxError)", () => {
    const pts: [number, number][] = [];
    for (let i = 0; i <= 60; i++) {
      const t = i / 60;
      pts.push([cubicAt(0, 30, 70, 100, t), cubicAt(0, 100, 100, 0, t)]);
    }
    const cmds = fitBezier(pts, 1);
    expect(cmds[0]).toEqual({ c: "M", x: 0, y: 0 });
    expect(cmds.slice(1).every((c) => c.c === "C")).toBe(true);
    expect(maxDeviation(pts, cmds)).toBeLessThanOrEqual(1 + 0.05);
    const last = cmds[cmds.length - 1]!;
    if (last.c !== "C") throw new Error("expected cubic");
    expect([last.x, last.y]).toEqual([100, 0]);
  });

  test("circle arc points stay within sqrt(maxError) and need several curves", () => {
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i <= 120; i++) {
      const a = (i / 120) * 1.5 * Math.PI;
      pts.push({ x: 200 + 100 * Math.cos(a), y: 200 + 100 * Math.sin(a) });
    }
    const maxError = 0.25;
    const cmds = fitBezier(pts, maxError);
    expect(cmds.length).toBeGreaterThan(2);
    expect(maxDeviation(pts.map((p) => [p.x, p.y]), cmds)).toBeLessThanOrEqual(Math.sqrt(maxError) + 0.05);
  });

  test("two points produce exactly one cubic along the chord", () => {
    const cmds = fitBezier([[0, 0], [30, 0]], 1);
    expect(cmds).toEqual([
      { c: "M", x: 0, y: 0 },
      { c: "C", x1: 10, y1: 0, x2: 20, y2: 0, x: 30, y: 0 },
    ]);
  });

  test("consecutive duplicates are removed before fitting", () => {
    expect(fitBezier([[1, 1], [1, 1], [1, 1]], 1)).toEqual([]);
    expect(fitBezier([], 1)).toEqual([]);
    const cmds = fitBezier([[0, 0], [0, 0], [30, 0], [30, 0]], 1);
    expect(cmds.length).toBe(2);
  });

  test("non-finite points and oversize input are refused", () => {
    expect(() => fitBezier([[0, 0], [Number.NaN, 1]], 1)).toThrow();
    const many: [number, number][] = Array.from({ length: FIT_MAX_POINTS + 1 }, (_, i) => [i, 0]);
    expect(() => fitBezier(many, 1)).toThrow();
  });

  test("100k-point noisy line fits without overflowing the stack", () => {
    const pts: [number, number][] = [];
    for (let i = 0; i < FIT_MAX_POINTS; i++) pts.push([i * 0.1, 3 * Math.sin(i * 12.9898)]);
    const cmds = fitBezier(pts, 1);
    expect(cmds[0]!.c).toBe("M");
    const last = cmds[cmds.length - 1]!;
    if (last.c !== "C") throw new Error("expected cubic");
    expect(last.x).toBeCloseTo((FIT_MAX_POINTS - 1) * 0.1, 9);
    for (const c of cmds) {
      if (c.c === "C") expect(Number.isFinite(c.x1 + c.y1 + c.x2 + c.y2 + c.x + c.y)).toBe(true);
    }
  }, 60_000);
});
