// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/creator/design/freehand.test.ts - freehand stroke outline geometry and path conversion.

import { describe, expect, test } from "bun:test";
import { getStroke, strokeToPath } from "./freehand.ts";
import { DESIGN_MAX_POINTS_PER_STROKE } from "./limits.ts";

function bounds(pts: [number, number][]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

describe("getStroke", () => {
  test("straight horizontal drag: height is the stroke size, width covers the drag", () => {
    const pts: number[][] = [];
    for (let x = 0; x <= 200; x += 2) pts.push([x, 100]);
    const size = 16;
    const outline = getStroke(pts, { size, thinning: 0, last: true });
    expect(outline.length).toBeGreaterThan(10);
    for (const [x, y] of outline) expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
    const b = bounds(outline);
    expect(b.maxY - b.minY).toBeGreaterThan(size * 0.9);
    expect(b.maxY - b.minY).toBeLessThan(size * 1.1);
    expect(Math.abs((b.maxY + b.minY) / 2 - 100)).toBeLessThan(1);
    expect(b.minX).toBeLessThanOrEqual(1);
    expect(b.maxX).toBeGreaterThanOrEqual(199);
    // the polygon closes on itself: the start cap ends next to where the left side begins
    const first = outline[0]!, last = outline[outline.length - 1]!;
    expect(Math.hypot(first[0] - last[0], first[1] - last[1])).toBeLessThan(size);
  });

  test("object points with pressure are accepted", () => {
    const outline = getStroke([{ x: 0, y: 0, pressure: 0.5 }, { x: 50, y: 0, pressure: 0.5 }, { x: 100, y: 0, pressure: 0.5 }], { size: 8, last: true });
    const b = bounds(outline);
    expect(b.maxX - b.minX).toBeGreaterThan(100);
  });

  test("single point yields a small dot polygon around it", () => {
    const outline = getStroke([[50, 50]], { size: 10 });
    expect(outline.length).toBeGreaterThanOrEqual(8);
    for (const [x, y] of outline) expect(Math.hypot(x - 50, y - 50)).toBeLessThan(10);
    const b = bounds(outline);
    expect(b.maxX - b.minX).toBeGreaterThan(2);
    expect(b.maxY - b.minY).toBeGreaterThan(2);
  });

  test("empty input, zero size, and oversize input", () => {
    expect(getStroke([])).toEqual([]);
    expect(getStroke([[0, 0], [10, 0]], { size: 0 })).toEqual([]);
    const many = Array.from({ length: DESIGN_MAX_POINTS_PER_STROKE + 1 }, (_, i) => [i, 0]);
    expect(() => getStroke(many)).toThrow();
    expect(() => getStroke([[0, 0], [Number.NaN, 0]])).toThrow();
  });
});

describe("strokeToPath", () => {
  test("closed quadratic path through outline midpoints", () => {
    const cmds = strokeToPath([[0, 0], [10, 0], [10, 10]]);
    expect(cmds).toEqual([
      { c: "M", x: 0, y: 0 },
      { c: "Q", x1: 0, y1: 0, x: 5, y: 0 },
      { c: "Q", x1: 10, y1: 0, x: 10, y: 5 },
      { c: "Q", x1: 10, y1: 10, x: 5, y: 5 },
      { c: "Z" },
    ]);
  });

  test("a real outline starts with M and ends with Z", () => {
    const cmds = strokeToPath(getStroke([[0, 0], [40, 10], [80, 0]], { size: 6 }));
    expect(cmds[0]!.c).toBe("M");
    expect(cmds[cmds.length - 1]!.c).toBe("Z");
    expect(cmds.slice(1, -1).every((c) => c.c === "Q")).toBe(true);
  });

  test("empty outline is an empty path", () => {
    expect(strokeToPath([])).toEqual([]);
  });
});
