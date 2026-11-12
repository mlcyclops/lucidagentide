// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/creator/design/svg_import.test.ts - SvgNode tree to VShape conversion, caps, hostile input.

import { describe, expect, test } from "bun:test";
import { DESIGN_MAX_TEXT } from "./limits.ts";
import { type SvgNode, SVG_IMPORT_MAX_DEPTH, parseTransform, svgNodesToShapes } from "./svg_import.ts";
import type { VShape } from "./types.ts";

function el(tag: string, attrs: Record<string, string> = {}, children: SvgNode[] = [], text?: string): SvgNode {
  const node: SvgNode = { tag, attrs: new Map(Object.entries(attrs)), children };
  if (text !== undefined) node.text = text;
  return node;
}

const svg = (...children: SvgNode[]): SvgNode => el("svg", {}, children);

function one(node: SvgNode): VShape {
  const r = svgNodesToShapes(svg(node));
  expect(r.shapes.length).toBe(1);
  return r.shapes[0]!;
}

/** Every number reachable from the value is finite. */
function allFinite(v: unknown): boolean {
  const stack: unknown[] = [v];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (typeof cur === "number") { if (!Number.isFinite(cur)) return false; continue; }
    if (cur !== null && typeof cur === "object") for (const x of Object.values(cur)) stack.push(x);
  }
  return true;
}

describe("svgNodesToShapes: elements", () => {
  test("rect with rx and fill", () => {
    const s = one(el("rect", { x: "1", y: "2", width: "30", height: "40", rx: "5", fill: "#f00" }));
    expect(s).toEqual({
      id: "s0",
      kind: "rect",
      rect: { x: 1, y: 2, w: 30, h: 40 },
      rx: 5,
      paint: { fill: "#ff0000", stroke: null, strokeWidth: 1, opacity: 1 },
    });
  });

  test("CSS named colors resolve instead of falling back to black", () => {
    const r = svgNodesToShapes(svg(el("rect", { width: "1", height: "1", fill: "White", stroke: "rebeccapurple" })));
    expect(r.shapes[0]!.paint.fill).toBe("#ffffff");
    expect(r.shapes[0]!.paint.stroke).toBe("#663399");
    expect(r.warnings).toEqual([]);
  });

  test("circle and ellipse become ellipse shapes with their bounding box", () => {
    expect(one(el("circle", { cx: "10", cy: "20", r: "5" })).rect).toEqual({ x: 5, y: 15, w: 10, h: 10 });
    const e = one(el("ellipse", { cx: "10", cy: "20", rx: "4", ry: "2" }));
    expect(e.kind).toBe("ellipse");
    expect(e.rect).toEqual({ x: 6, y: 18, w: 8, h: 4 });
  });

  test("path uses the SVG default black fill and parsed commands", () => {
    const s = one(el("path", { d: "M0 0 L10 10 z", stroke: "rgb(0, 0, 255)", "stroke-width": "2px", "stroke-linecap": "round" }));
    expect(s.kind).toBe("path");
    expect(s.d).toEqual([{ c: "M", x: 0, y: 0 }, { c: "L", x: 10, y: 10 }, { c: "Z" }]);
    expect(s.paint).toEqual({ fill: "#000000", stroke: "#0000ff", strokeWidth: 2, opacity: 1, lineCap: "round" });
  });

  test("polygon closes, polyline does not, line has no fill", () => {
    const pg = one(el("polygon", { points: "0,0 10,0 10,10" }));
    expect(pg.d).toEqual([{ c: "M", x: 0, y: 0 }, { c: "L", x: 10, y: 0 }, { c: "L", x: 10, y: 10 }, { c: "Z" }]);
    const pl = one(el("polyline", { points: "0 0, 5 5 9,1" }));
    expect(pl.d).toEqual([{ c: "M", x: 0, y: 0 }, { c: "L", x: 5, y: 5 }, { c: "L", x: 9, y: 1 }]);
    const ln = one(el("line", { x1: "1", y1: "2", x2: "3", y2: "4", stroke: "#000" }));
    expect(ln.d).toEqual([{ c: "M", x: 1, y: 2 }, { c: "L", x: 3, y: 4 }]);
    expect(ln.paint.fill).toBeNull();
  });

  test("plain text: concatenated content, size, mapped family, anchor", () => {
    const s = one(el("text", { x: "5", y: "6 7", "font-size": "12", "font-family": "'Courier New', monospace" }, [
      el("tspan", {}, [], " world"),
    ], "Hello"));
    expect(s.kind).toBe("text");
    expect(s.text).toEqual({ content: "Hello world", size: 12, family: "monospace" });
    expect(s.rect).toEqual({ x: 5, y: 6, w: 0, h: 0 });
    expect(one(el("text", { "font-family": "Times New Roman" }, [], "a")).text!.family).toBe("serif");
    expect(one(el("text", { "font-family": "Arial" }, [], "a")).text!.family).toBe("sans-serif");
  });

  test("text content gets control and bidi characters stripped and is capped", () => {
    const s = one(el("text", {}, [], "Hi\u0000\u202E there\u0007\n  !"));
    expect(s.text!.content).toBe("Hi there !");
    const long = one(el("text", {}, [], "x".repeat(DESIGN_MAX_TEXT * 3)));
    expect(long.text!.content.length).toBe(DESIGN_MAX_TEXT);
  });
});

describe("svgNodesToShapes: inheritance and transforms", () => {
  test("paint inherits from ancestors, opacity multiplies, fill-opacity folds into the color", () => {
    const r = svgNodesToShapes(svg(
      el("g", { fill: "#00ff00", opacity: "0.5", stroke: "#123456" }, [
        el("rect", { width: "1", height: "1", opacity: "0.5" }),
        el("rect", { width: "1", height: "1", fill: "#ff0000", "fill-opacity": "0.5", stroke: "none" }),
      ]),
    ));
    expect(r.shapes.map((s) => s.paint)).toEqual([
      { fill: "#00ff00", stroke: "#123456", strokeWidth: 1, opacity: 0.25 },
      { fill: "#ff000080", stroke: null, strokeWidth: 1, opacity: 0.5 },
    ]);
    expect(r.shapes.map((s) => s.id)).toEqual(["s0", "s1"]);
  });

  test("nested g translate + scale compose into the shape transform", () => {
    const r = svgNodesToShapes(svg(
      el("g", { transform: "translate(10,20)" }, [
        el("g", { transform: "scale(2)" }, [el("rect", { width: "1", height: "1" })]),
      ]),
    ));
    expect(r.shapes[0]!.transform).toEqual([2, 0, 0, 2, 10, 20]);
  });

  test("identity transforms are omitted", () => {
    expect(one(el("rect", { width: "1", height: "1", transform: "translate(0)" })).transform).toBeUndefined();
  });

  test("transform lists compose left to right", () => {
    // translate then rotate about a point: the point itself must stay fixed after rotate(90, 5, 5)
    const m = parseTransform("translate(1 1) rotate(90 5 5)")!;
    const x = m[0] * 5 + m[2] * 5 + m[4], y = m[1] * 5 + m[3] * 5 + m[5];
    expect(x).toBeCloseTo(6, 12);
    expect(y).toBeCloseTo(6, 12);
    expect(parseTransform("matrix(1,2,3,4,5,6) skewX(0)")).toEqual([1, 2, 3, 4, 5, 6]);
    expect(parseTransform("scale(2 3)")).toEqual([2, 0, 0, 3, 0, 0]);
    for (const bad of ["matrix(1 2 3)", "rotate(1 2)", "translate(1", "evil(1)", "scale()", "translate(1e999)"]) {
      expect(parseTransform(bad)).toBeNull();
    }
  });
});

describe("svgNodesToShapes: dropped and hostile input", () => {
  test("unsupported elements are dropped with one warning per tag and their children are not imported", () => {
    const r = svgNodesToShapes(svg(
      el("script", {}, [], "alert(1)"),
      el("script"),
      el("foreignObject", {}, [el("rect", { width: "5", height: "5" })]),
      el("image", { href: "http://x/y.png" }),
      el("use", { href: "#a" }),
      el("rect", { width: "2", height: "2" }),
    ));
    expect(r.shapes.length).toBe(1);
    expect(r.shapes[0]!.rect).toEqual({ x: 0, y: 0, w: 2, h: 2 });
    for (const tag of ["script", "foreignobject", "image", "use"]) {
      expect(r.warnings.filter((w) => w.includes(`<${tag}>`)).length).toBe(1);
    }
  });

  test("hostile attribute values never throw and never produce non-finite numbers", () => {
    const r = svgNodesToShapes(svg(
      el("rect", { width: "10", height: "10", fill: "url(javascript:x)" }),
      el("rect", { width: "10", height: "10", transform: "matrix(1e999 0 0 1 0 0)" }),
      el("rect", { width: "1e308", height: "10", x: "1e308", transform: "scale(1e200) scale(1e200)" }),
      el("path", { d: "M 0 0 L garbage" }),
      el("path", { d: "M1e308 0 l1e308 0" }),
      el("polygon", { points: "0,0 1e999,5 3,3" }),
      el("circle", { r: "NaN" }),
      el("rect", { width: "5", height: "5", "stroke-width": "1e999", opacity: "-Infinity", stroke: "url(#g)" }),
      el("text", { "font-size": "1e999", x: "Infinity" }, [], "t"),
    ));
    expect(allFinite(r)).toBe(true);
    expect(r.shapes[0]!.paint.fill).toBe("#000000");
    expect(r.shapes[1]!.transform).toBeUndefined();
    const last = r.shapes[r.shapes.length - 1]!;
    expect(last.text!.size).toBe(16);
    const stroked = r.shapes.find((s) => s.rect?.w === 5)!;
    expect(stroked.paint.strokeWidth).toBe(1);
    expect(stroked.paint.stroke).toBeNull();
    expect(r.warnings.length).toBeGreaterThan(0);
    for (const s of r.shapes) expect(s.id).toMatch(/^s\d+$/);
  });

  test("malformed nodes are skipped with a warning", () => {
    const bad = { tag: "svg", attrs: {}, children: [] } as unknown as SvgNode;
    const r = svgNodesToShapes(bad);
    expect(r.shapes).toEqual([]);
    expect(r.warnings.length).toBe(1);
    const mixed = svg(null as unknown as SvgNode, el("rect", { width: "1", height: "1" }));
    expect(svgNodesToShapes(mixed).shapes.length).toBe(1);
  });

  test("deep nesting is capped without recursion", () => {
    let node: SvgNode = el("rect", { width: "1", height: "1" });
    for (let i = 0; i < 10_000; i++) node = el("g", {}, [node]);
    const r = svgNodesToShapes(svg(node, el("rect", { width: "3", height: "3" })));
    expect(r.shapes.length).toBe(1);
    expect(r.shapes[0]!.rect!.w).toBe(3);
    expect(r.warnings.some((w) => w.includes(String(SVG_IMPORT_MAX_DEPTH)))).toBe(true);

    let ok: SvgNode = el("rect", { width: "1", height: "1" });
    for (let i = 0; i < SVG_IMPORT_MAX_DEPTH - 1; i++) ok = el("g", {}, [ok]);
    expect(svgNodesToShapes(svg(ok)).shapes.length).toBe(1);
  });

  test("warnings are deduplicated and capped", () => {
    const kids: SvgNode[] = [];
    for (let i = 0; i < 500; i++) kids.push(el(`x-${i}`));
    const r = svgNodesToShapes(svg(...kids));
    expect(r.warnings.length).toBe(50);
  });
});
