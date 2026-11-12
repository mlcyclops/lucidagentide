// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/creator/design/mask.test.ts - brush coverage, morphology, contours, RDP, hints, SAM prompts.

import { describe, expect, test } from "bun:test";
import {
  applyMask, combineMasks, featherMask, growShrinkMask, hintFromStrokes, invertMask, maskArea, maskBBox,
  rasterizeStroke, simplifyPolyline, strokesToPrompts, traceContours,
} from "./mask.ts";
import type { MaskData } from "./types.ts";
import { ID_RE } from "./util.ts";

const blank = (w: number, h: number): MaskData => ({ width: w, height: h, alpha: new Uint8Array(w * h) });

function fillRect(m: MaskData, x0: number, y0: number, w: number, h: number, v = 255): MaskData {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) m.alpha[y * m.width + x] = v;
  return m;
}

const at = (m: MaskData, x: number, y: number): number => m.alpha[y * m.width + x]!;

/** Distance from (px, py) to the segment (ax, ay)-(bx, by). */
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax, vy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy)));
  return Math.hypot(px - ax - t * vx, py - ay - t * vy);
}

describe("rasterizeStroke", () => {
  test("a horizontal stroke covers its centerline and nothing beyond radius + 1", () => {
    const m = blank(100, 40);
    rasterizeStroke(m, { points: [{ x: 10, y: 20 }, { x: 50, y: 20 }, { x: 90, y: 20 }], radius: 5, hardness: 1, mode: "add" }, 0, 0);
    for (let x = 10; x < 90; x++) {
      expect(at(m, x, 19)).toBe(255);
      expect(at(m, x, 20)).toBe(255);
    }
    for (let y = 0; y < 40; y++) {
      for (let x = 0; x < 100; x++) {
        if (segDist(x + 0.5, y + 0.5, 10, 20, 90, 20) > 6) expect(at(m, x, y)).toBe(0);
      }
    }
  });

  test("the mask offset maps doc coordinates into mask pixels", () => {
    const m = blank(20, 20);
    rasterizeStroke(m, { points: [{ x: 110, y: 210 }], radius: 3, hardness: 1, mode: "add" }, 100, 200);
    expect(at(m, 9, 9)).toBe(255);
    expect(at(m, 10, 10)).toBe(255);
    expect(at(m, 0, 0)).toBe(0);
    expect(maskBBox(m)).not.toBeNull();
  });

  test("subtract clears what add painted", () => {
    const m = blank(100, 40);
    const points = [{ x: 10, y: 20 }, { x: 90, y: 20 }];
    rasterizeStroke(m, { points, radius: 5, hardness: 0.5, mode: "add" }, 0, 0);
    expect(maskArea(m, 1)).toBeGreaterThan(0);
    rasterizeStroke(m, { points, radius: 8, hardness: 1, mode: "subtract" }, 0, 0);
    expect(maskArea(m, 1)).toBe(0);
  });

  test("soft brushes fall off monotonically from the axis", () => {
    const m = blank(60, 60);
    rasterizeStroke(m, { points: [{ x: 30, y: 30 }], radius: 20, hardness: 0, mode: "add" }, 0, 0);
    for (let x = 30; x < 59; x++) expect(at(m, x + 1, 30)).toBeLessThanOrEqual(at(m, x, 30));
    expect(at(m, 30, 30)).toBeGreaterThan(240);
    expect(at(m, 50, 30)).toBe(0);
  });

  test("refuses bad radii and ignores non-finite points", () => {
    const m = blank(10, 10);
    expect(() => rasterizeStroke(m, { points: [{ x: 1, y: 1 }], radius: 0, hardness: 1, mode: "add" }, 0, 0)).toThrow();
    expect(() => rasterizeStroke(m, { points: [{ x: 1, y: 1 }], radius: 5000, hardness: 1, mode: "add" }, 0, 0)).toThrow();
    expect(() => rasterizeStroke(m, { points: [{ x: 1, y: 1 }], radius: Number.NaN, hardness: 1, mode: "add" }, 0, 0)).toThrow();
    rasterizeStroke(m, { points: [{ x: Number.NaN, y: 1 }, { x: 5, y: Number.POSITIVE_INFINITY }], radius: 2, hardness: 1, mode: "add" }, 0, 0);
    expect(maskArea(m, 1)).toBe(0);
  });
});

describe("featherMask and growShrinkMask", () => {
  test("feather is monotonic across an edge and keeps a far interior filled", () => {
    const m = fillRect(blank(80, 80), 16, 16, 48, 48);
    const f = featherMask(m, 6);
    for (let x = 40; x < 79; x++) expect(at(f, x + 1, 40)).toBeLessThanOrEqual(at(f, x, 40));
    expect(at(f, 40, 40)).toBe(255);
    expect(at(f, 0, 0)).toBe(0);
    expect(at(f, 63, 40)).toBeGreaterThan(0);
    expect(at(f, 63, 40)).toBeLessThan(255);
    expect(Array.from(featherMask(m, 0).alpha)).toEqual(Array.from(m.alpha));
  });

  test("grow then shrink by the same amount restores a square", () => {
    const m = fillRect(blank(64, 64), 20, 20, 20, 20);
    const grown = growShrinkMask(m, 5);
    expect(maskArea(grown)).toBe(30 * 30);
    expect(maskBBox(grown)).toEqual({ x: 15, y: 15, w: 30, h: 30 });
    const back = growShrinkMask(grown, -5);
    expect(Math.abs(maskArea(back) - 400)).toBeLessThanOrEqual(8);
    const shrunk = growShrinkMask(m, -3);
    expect(maskBBox(shrunk)).toEqual({ x: 23, y: 23, w: 14, h: 14 });
  });
});

describe("maskBBox / maskArea", () => {
  test("known shapes", () => {
    const m = fillRect(blank(12, 12), 3, 5, 5, 5);
    m.alpha[0] = 50;
    expect(maskBBox(m, 128)).toEqual({ x: 3, y: 5, w: 5, h: 5 });
    expect(maskBBox(m)).toEqual({ x: 0, y: 0, w: 8, h: 10 });
    expect(maskArea(m)).toBe(25);
    expect(maskArea(m, 1)).toBe(26);
    expect(maskBBox(blank(5, 5))).toBeNull();
  });
});

describe("traceContours", () => {
  test("a filled rectangle yields one closed contour on the edge lattice", () => {
    const m = fillRect(blank(10, 10), 2, 3, 4, 5);
    const cs = traceContours(m);
    expect(cs.length).toBe(1);
    const c = cs[0]!;
    const xs = c.map((p) => p.x), ys = c.map((p) => p.y);
    expect(Math.min(...xs)).toBe(2);
    expect(Math.max(...xs)).toBe(6);
    expect(Math.min(...ys)).toBe(3);
    expect(Math.max(...ys)).toBe(8);
    const first = c[0]!, last = c[c.length - 1]!;
    expect(first.x === last.x && first.y === last.y).toBe(false);
    for (let i = 0; i < c.length; i++) {
      const a = c[i]!, b = c[(i + 1) % c.length]!;
      expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeLessThanOrEqual(1 + 1e-9);
      expect(Number.isInteger(a.x * 2) && Number.isInteger(a.y * 2)).toBe(true);
    }
    const keys = new Set(c.map((p) => `${p.x},${p.y}`));
    expect(keys.size).toBe(c.length);
  });

  test("a ring yields an outer contour and a hole", () => {
    const m = fillRect(blank(20, 20), 3, 3, 14, 14);
    fillRect(m, 7, 7, 6, 6, 0);
    expect(traceContours(m).length).toBe(2);
  });

  test("a shape touching the mask border still closes, and an empty mask has none", () => {
    const m = fillRect(blank(5, 5), 0, 0, 5, 5);
    const cs = traceContours(m);
    expect(cs.length).toBe(1);
    const xs = cs[0]!.map((p) => p.x);
    expect(Math.min(...xs)).toBe(0);
    expect(Math.max(...xs)).toBe(5);
    expect(traceContours(blank(5, 5))).toEqual([]);
  });

  test("diagonal pixels are separate contours (4-connected foreground)", () => {
    const m = blank(4, 4);
    m.alpha[1 * 4 + 1] = 255;
    m.alpha[2 * 4 + 2] = 255;
    expect(traceContours(m).length).toBe(2);
  });
});

describe("simplifyPolyline", () => {
  test("collapses collinear points and keeps corners", () => {
    const line = Array.from({ length: 11 }, (_, i) => ({ x: i, y: 0 }));
    expect(simplifyPolyline(line, 0.1)).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }]);
    const corner = [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 10, y: 10 }];
    expect(simplifyPolyline(corner, 0.1)).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]);
  });

  test("handles 100k points and maximally unbalanced splits without recursion", () => {
    // A zigzag peels one point per split: a recursive RDP would nest 30k frames deep here.
    const pts = Array.from({ length: 30_000 }, (_, i) => ({ x: i, y: (i % 2) * 3 }));
    const out = simplifyPolyline(pts, 1);
    expect(out.length).toBe(30_000);
    expect(out[0]).toEqual({ x: 0, y: 0 });
    expect(out[out.length - 1]).toEqual(pts[pts.length - 1]!);
    const smooth = Array.from({ length: 100_000 }, (_, i) => ({ x: i, y: Math.sin(i / 5000) * 100 }));
    const s = simplifyPolyline(smooth, 0.5);
    expect(s.length).toBeGreaterThan(2);
    expect(s.length).toBeLessThan(1000);
  });
});

describe("applyMask / invertMask / combineMasks", () => {
  test("alpha is scaled by coverage and zero outside the placed mask", () => {
    const rgba = new Uint8ClampedArray(3 * 1 * 4).fill(200);
    const out = applyMask({ width: 3, height: 1, rgba }, { width: 1, height: 1, alpha: new Uint8Array([128]) }, 1, 0);
    expect(Array.from(out.rgba)).toEqual([200, 200, 200, 0, 200, 200, 200, 100, 200, 200, 200, 0]);
    expect(rgba[3]).toBe(200);
  });

  test("invert and combine", () => {
    const a = { width: 2, height: 1, alpha: new Uint8Array([200, 10]) };
    const b = { width: 2, height: 1, alpha: new Uint8Array([100, 50]) };
    expect(Array.from(invertMask(a).alpha)).toEqual([55, 245]);
    expect(Array.from(combineMasks(a, b, "add").alpha)).toEqual([200, 50]);
    expect(Array.from(combineMasks(a, b, "subtract").alpha)).toEqual([155, 10]);
    expect(Array.from(combineMasks(a, b, "intersect").alpha)).toEqual([100, 10]);
    expect(() => combineMasks(a, blank(1, 2), "add")).toThrow();
  });
});

describe("hintFromStrokes", () => {
  test("cleans the label, shifts bbox to doc coords, refuses a bad mask id", () => {
    const m = fillRect(blank(20, 20), 4, 5, 3, 2);
    const strokes = [{ points: [{ x: 1, y: 2 }, { x: Number.NaN, y: 0 }], radius: 4, hardness: 0.5, mode: "add" as const }];
    const h = hintFromStrokes("mask_1", strokes, "cat\u0000\u202E head\u0007", "isolate", m, 100, 50);
    expect(ID_RE.test(h.id)).toBe(true);
    expect(h.id.startsWith("hint_")).toBe(true);
    expect(h.label).toBe("cat head");
    expect(h.bbox).toEqual({ x: 104, y: 55, w: 3, h: 2 });
    expect(h.area).toBe(6);
    expect(h.strokes[0]!.points).toEqual([{ x: 1, y: 2 }]);
    expect(h.strokes[0]!.points).not.toBe(strokes[0]!.points);
    expect(() => hintFromStrokes("bad id!", strokes, "x", "isolate", m, 0, 0)).toThrow();
    expect(hintFromStrokes("m", [], "x", "keep", blank(3, 3), 0, 0).bbox).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });
});

describe("strokesToPrompts", () => {
  test("respects max and separates add from subtract", () => {
    const strokes = [
      { points: [{ x: 0, y: 0 }, { x: 1000, y: 0 }], radius: 10, hardness: 1, mode: "add" as const },
      { points: [{ x: 0, y: 50 }, { x: 100, y: 50 }], radius: 10, hardness: 1, mode: "subtract" as const },
    ];
    const p = strokesToPrompts(strokes, 20);
    expect(p.positive.length + p.negative.length).toBe(20);
    expect(p.negative.length).toBeGreaterThanOrEqual(1);
    expect(p.positive.every(([, y]) => y === 0)).toBe(true);
    expect(p.negative.every(([, y]) => y === 50)).toBe(true);
    expect(p.box).toEqual([-10, -10, 1010, 10]);
    const all = [...p.positive, ...p.negative];
    expect(all.every(([x, y]) => Number.isInteger(x) && Number.isInteger(y))).toBe(true);
  });

  test("spacing is radius-aware and the box falls back to all strokes", () => {
    const p = strokesToPrompts([{ points: [{ x: 0, y: 0 }, { x: 100, y: 0 }], radius: 25, hardness: 1, mode: "subtract" }]);
    expect(p.positive).toEqual([]);
    expect(p.negative).toEqual([[0, 0], [25, 0], [50, 0], [75, 0], [100, 0]]);
    expect(p.box).toEqual([-25, -25, 125, 25]);
  });

  test("every non-empty stroke gets a point while the budget allows", () => {
    const strokes = Array.from({ length: 5 }, (_, i) => ({ points: [{ x: i * 10, y: 0 }], radius: 2, hardness: 1, mode: "add" as const }));
    expect(strokesToPrompts(strokes, 3).positive.length).toBe(3);
    expect(strokesToPrompts(strokes, 64).positive.length).toBe(5);
    expect(strokesToPrompts(strokes, 0).positive.length).toBe(0);
  });
});
