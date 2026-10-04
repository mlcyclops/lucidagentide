// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/creator/design/path.test.ts - path data parse/serialize/bbox/transform behavior and refusals.

import { describe, expect, test } from "bun:test";
import { DESIGN_LIMITS } from "./limits.ts";
import { parsePathData, pathBBox, serializePath, transformPath } from "./path.ts";
import type { PathCmd } from "./types.ts";

function parseOk(d: string): PathCmd[] {
  const r = parsePathData(d);
  if (!r.ok) throw new Error(`expected ok for ${JSON.stringify(d)}: ${r.error}`);
  return r.cmds;
}

/** Flatten commands into [letter, ...numbers] for numeric comparison. */
function flat(cmds: PathCmd[]): (string | number)[] {
  const out: (string | number)[] = [];
  for (const c of cmds) {
    out.push(c.c);
    if (c.c === "M" || c.c === "L") out.push(c.x, c.y);
    else if (c.c === "C") out.push(c.x1, c.y1, c.x2, c.y2, c.x, c.y);
    else if (c.c === "Q") out.push(c.x1, c.y1, c.x, c.y);
  }
  return out;
}

function expectClose(a: PathCmd[], b: PathCmd[], tol: number): void {
  const fa = flat(a), fb = flat(b);
  expect(fa.length).toBe(fb.length);
  for (let i = 0; i < fa.length; i++) {
    const x = fa[i]!, y = fb[i]!;
    if (typeof x === "string") expect(y).toBe(x);
    else expect(Math.abs(x - (y as number))).toBeLessThanOrEqual(tol);
  }
}

function cubicAt(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const m = 1 - t;
  return m * m * m * p0 + 3 * m * m * t * p1 + 3 * m * t * t * p2 + t * t * t * p3;
}

describe("parsePathData", () => {
  test("relative and shorthand commands resolve to absolute M/L/C/Q/Z", () => {
    const cmds = parseOk("m10 10 h5 v5 H0 V0 l1 1 c1 0 2 1 2 2 s1 2 3 3 q1 1 2 0 t2 0 z");
    expect(flat(cmds)).toEqual([
      "M", 10, 10,
      "L", 15, 10,
      "L", 15, 15,
      "L", 0, 15,
      "L", 0, 0,
      "L", 1, 1,
      "C", 2, 1, 3, 2, 3, 3,
      // S reflects the previous second control (3,2) about (3,3) -> (3,4)
      "C", 3, 4, 4, 5, 6, 6,
      "Q", 7, 7, 8, 6,
      // T reflects (7,7) about (8,6) -> (9,5)
      "Q", 9, 5, 10, 6,
      "Z",
    ]);
  });

  test("implicit repetition: extra M pairs become L, relative to the moving point", () => {
    expect(flat(parseOk("m1 1 2 2 3 3"))).toEqual(["M", 1, 1, "L", 3, 3, "L", 6, 6]);
    expect(flat(parseOk("M0,0L1,1,2,2"))).toEqual(["M", 0, 0, "L", 1, 1, "L", 2, 2]);
  });

  test("number syntax: signs, decimals, exponents, adjacency", () => {
    expect(flat(parseOk("M.5.5L-1-2l1e1-2E-1"))).toEqual(["M", 0.5, 0.5, "L", -1, -2, "L", 9, -2.2]);
  });

  test("Z returns to the subpath start for following relative commands", () => {
    expect(flat(parseOk("M5 5 l10 0 z l1 1"))).toEqual(["M", 5, 5, "L", 15, 5, "Z", "L", 6, 6]);
  });

  test("S without a preceding cubic uses the current point as first control", () => {
    expect(flat(parseOk("M0 0 S5 5 10 0"))).toEqual(["M", 0, 0, "C", 0, 0, 5, 5, 10, 0]);
  });

  test("semicircle arc: exact endpoint, midpoint on the circle, side follows sweep", () => {
    for (const [sweep, midY] of [[1, -50], [0, 50]] as const) {
      const cmds = parseOk(`M0 0 A50 50 0 0 ${sweep} 100 0`);
      expect(cmds.every((c) => c.c === "M" || c.c === "C")).toBe(true);
      expect(cmds.length).toBe(3); // 180 degrees -> two segments of 90
      const last = cmds[cmds.length - 1]!;
      if (last.c !== "C") throw new Error("expected cubic");
      expect(last.x).toBe(100);
      expect(last.y).toBe(0);
      const mid = cmds[1]!;
      if (mid.c !== "C") throw new Error("expected cubic");
      expect(Math.abs(mid.x - 50)).toBeLessThan(0.5);
      expect(Math.abs(mid.y - midY)).toBeLessThan(0.5);
      // every point of the approximation stays near radius 50 around (50, 0)
      let px = 0, py = 0;
      for (const c of cmds.slice(1)) {
        if (c.c !== "C") continue;
        for (let t = 0; t <= 1; t += 0.05) {
          const x = cubicAt(px, c.x1, c.x2, c.x, t), y = cubicAt(py, c.y1, c.y2, c.y, t);
          expect(Math.abs(Math.hypot(x - 50, y) - 50)).toBeLessThan(0.1);
        }
        px = c.x; py = c.y;
      }
    }
  });

  test("arc flags packed without separators", () => {
    const cmds = parseOk("M0 0 a1 1 0 00 1 1");
    const last = cmds[cmds.length - 1]!;
    if (last.c !== "C") throw new Error("expected cubic");
    expect(last.x).toBe(1);
    expect(last.y).toBe(1);
    const large = parseOk("M0 0a10 10 0 1110 0");
    const end = large[large.length - 1]!;
    if (end.c !== "C") throw new Error("expected cubic");
    expect(end.x).toBe(10);
    expect(large.length).toBeGreaterThan(3); // large arc: more than 180 degrees
  });

  test("degenerate arcs: zero radius is a line, same endpoint is skipped", () => {
    expect(flat(parseOk("M0 0 A0 5 0 0 1 10 10"))).toEqual(["M", 0, 0, "L", 10, 10]);
    expect(flat(parseOk("M3 3 A5 5 0 0 1 3 3"))).toEqual(["M", 3, 3]);
  });

  test("radii too small are scaled up so the arc still reaches its endpoint", () => {
    const cmds = parseOk("M0 0 A1 1 0 0 1 100 0");
    const last = cmds[cmds.length - 1]!;
    if (last.c !== "C") throw new Error("expected cubic");
    expect(last.x).toBe(100);
    const mid = cmds[1]!;
    if (mid.c !== "C") throw new Error("expected cubic");
    expect(Math.abs(mid.y + 50)).toBeLessThan(0.5);
  });

  test("empty and whitespace input is an empty path", () => {
    expect(parseOk("")).toEqual([]);
    expect(parseOk(" \n\t ")).toEqual([]);
  });

  test("malformed input is refused with an offset", () => {
    for (const bad of ["M 10", "L 1 2", "M 1 2 X", "M 1e999 2", "M --1 2", "M 1 2,", "M,1 2", "M1 2 Z 3", "M 0 0 A 1 1 0 2 0 5 5", "M1 2e"]) {
      const r = parsePathData(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("offset");
    }
  });

  test("overflowing coordinates from finite inputs are refused", () => {
    expect(parsePathData("M1e308 0 l1e308 0").ok).toBe(false);
  });

  test("command count over the cap is refused", () => {
    const d = "M0 0" + " L1 1".repeat(DESIGN_LIMITS.maxPathCmds);
    expect(parsePathData(d).ok).toBe(false);
    const fits = "M0 0" + " L1 1".repeat(DESIGN_LIMITS.maxPathCmds - 1);
    expect(parsePathData(fits).ok).toBe(true);
  });
});

describe("serializePath", () => {
  test("round trip parse -> serialize -> parse is stable within precision", () => {
    for (const d of [
      "M10 20 L30 40 C1 2 3 4 5 6 Q7 8 9 10 Z",
      "m10.12345 20.98765 h5 v-5 s1 2 3 4 t5 6 l-1.5 .25 z",
      "M0 0 A25 40 30 1 0 50 -10",
    ]) {
      const a = parseOk(d);
      const b = parseOk(serializePath(a, 3));
      expectClose(a, b, 0.0005 + 1e-9);
    }
  });

  test("output is limited to the safe alphabet and never emits NaN, Infinity, or -0", () => {
    const s = serializePath([
      { c: "M", x: Number.NaN, y: -0 },
      { c: "L", x: Number.POSITIVE_INFINITY, y: -0.0001 },
      { c: "C", x1: 1e25, y1: -1e25, x2: 1.23456, y2: 0.1 + 0.2, x: -5, y: 2.5 },
      { c: "Q", x1: 0, y1: 0, x: 1, y: 1 },
      { c: "Z" },
    ]);
    expect(s).not.toContain("NaN");
    expect(s).not.toContain("Infinity");
    expect(s).not.toMatch(/-0(?![.\d])/);
    expect(s).toMatch(/^[MLCQZ0-9 .e-]*$/);
    expect(s.startsWith("M 0 0 L 0 0 C 1e25 -1e25 1.235 0.3 -5 2.5 Q 0 0 1 1 Z")).toBe(true);
  });

  test("precision controls decimals and trims trailing zeros", () => {
    expect(serializePath([{ c: "M", x: 1.5, y: 2 }, { c: "L", x: 1.23456, y: 7.1 }], 2)).toBe("M 1.5 2 L 1.23 7.1");
    expect(serializePath([{ c: "M", x: 1.5, y: 2.49 }], 0)).toBe("M 2 2");
  });
});

describe("pathBBox", () => {
  test("cubic extremum beyond its endpoints is included", () => {
    // y extremum at t = 0.5: 0.75 * 100 = 75
    const b = pathBBox(parseOk("M0 0 C0 100 100 100 100 0"));
    expect(b.x).toBe(0);
    expect(b.y).toBe(0);
    expect(b.w).toBeCloseTo(100, 9);
    expect(b.h).toBeCloseTo(75, 9);
  });

  test("quadratic extremum and empty path", () => {
    const b = pathBBox(parseOk("M0 0 Q50 -100 100 0"));
    expect(b.y).toBeCloseTo(-50, 9);
    expect(b.h).toBeCloseTo(50, 9);
    expect(pathBBox([])).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });

  test("control points outside the curve do not inflate the box", () => {
    const b = pathBBox(parseOk("M0 0 C50 0 50 0 100 0"));
    expect(b).toEqual({ x: 0, y: 0, w: 100, h: 0 });
  });
});

describe("transformPath", () => {
  test("translate and scale apply to anchors and controls", () => {
    const src = parseOk("M1 2 C3 4 5 6 7 8 Q9 10 11 12 Z");
    expect(flat(transformPath(src, [1, 0, 0, 1, 10, 20]))).toEqual(["M", 11, 22, "C", 13, 24, 15, 26, 17, 28, "Q", 19, 30, 21, 32, "Z"]);
    expect(flat(transformPath(src, [2, 0, 0, 3, 0, 0]))).toEqual(["M", 2, 6, "C", 6, 12, 10, 18, 14, 24, "Q", 18, 30, 22, 36, "Z"]);
  });

  test("matrix uses SVG order: x' = a x + c y + e, y' = b x + d y + f", () => {
    expect(flat(transformPath([{ c: "M", x: 1, y: 2 }], [0, 1, -1, 0, 5, 6]))).toEqual(["M", 3, 7]);
  });
});
