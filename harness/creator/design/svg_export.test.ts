// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, test } from "bun:test";
import { createDoc } from "./doc.ts";
import { svgSafetyCheck } from "./svg_check.ts";
import { exportSvg } from "./svg_export.ts";
import type { DesignDoc, GroupLayer, RasterLayer, VectorLayer } from "./types.ts";

const base = { visible: true, locked: false, opacity: 1, blend: "normal" as const, x: 0, y: 0, scale: 1, rotation: 0, anchorX: 0, anchorY: 0 };
const HOSTILE = "\"><script>alert(1)</script><foreignObject onload='x()'> javascript:alert(1) url(http://evil.example/x)";

/** A doc built WITHOUT validation, so the exporter's own escaping is what is under test. */
function hostileDoc(): DesignDoc {
  const doc = createDoc("x", 100, 50, "#123456");
  const v: VectorLayer = {
    ...base, id: "v1", name: HOSTILE, kind: "vector", opacity: 0.5, blend: "multiply",
    meta: { label: HOSTILE, labelSource: "model" },
    shapes: [
      { id: "s1", kind: "rect", rect: { x: 1, y: 2, w: 3, h: 4 }, rx: 1, paint: { fill: "url(javascript:alert(1))", stroke: "\" onload=\"x()", strokeWidth: 2, opacity: 1 } },
      { id: "s2", kind: "text", rect: { x: 5, y: 20, w: 0, h: 0 }, text: { content: HOSTILE, size: 12, family: "serif" }, paint: { fill: "#00ff0080", stroke: null, strokeWidth: 0, opacity: 0.25 } },
      { id: "s3", kind: "path", d: [{ c: "M", x: 0, y: 0 }, { c: "L", x: Number.NaN, y: 1e300 }, { c: "Z" }], paint: { fill: null, stroke: "#000", strokeWidth: 1, opacity: 1, lineCap: "round" } },
      { id: "s4", kind: "ellipse", rect: { x: 10, y: 10, w: 20, h: 10 }, paint: { fill: "rgb(255, 0, 0)", stroke: null, strokeWidth: 0, opacity: 1 } },
    ],
  };
  const r: RasterLayer = { ...base, id: "r1", name: HOSTILE, kind: "raster", width: 2, height: 2, x: 3, y: 4 };
  const bad: RasterLayer = { ...base, id: "a\"b", name: "bad id", kind: "raster", width: 2, height: 2 };
  const hidden: RasterLayer = { ...base, id: "h1", name: "hidden", kind: "raster", width: 2, height: 2, visible: false };
  const g: GroupLayer = { ...base, id: "g1", name: HOSTILE, kind: "group", children: ["r1"], x: 10 };
  doc.layers.v1 = v;
  doc.layers.r1 = { ...r, parentId: "g1" };
  doc.layers.g1 = g;
  doc.layers["a\"b"] = bad;
  doc.layers.h1 = hidden;
  doc.order = ["g1", "v1", "a\"b", "h1"];
  return doc;
}

// Constructs, not words: escaped prose may still spell "onload" or "foreignObject" harmlessly.
const FORBIDDEN = ["<script", "<foreignobject", "javascript:", "onload=\"", "onload='", "onclick=", "http://evil", "url(http", "<!doctype", "<!entity"];

function assertSafe(svg: string): void {
  const lower = svg.toLowerCase();
  for (const f of FORBIDDEN) if (lower.includes(f)) throw new Error(`emitted forbidden construct ${f}`);
  const v = svgSafetyCheck(svg);
  if (!v.ok) throw new Error(`exporter output fails svgSafetyCheck: ${v.reason}`);
}

describe("exportSvg", () => {
  test("hostile layer names, labels, colors, and text never produce forbidden constructs", () => {
    const svg = exportSvg(hostileDoc(), { rasterHref: () => "data:image/png;base64,iVBORw0KGgo=", animate: false });
    assertSafe(svg);
    expect(svg).toContain("<rect x=\"1\" y=\"2\" width=\"3\" height=\"4\" rx=\"1\" fill=\"none\" stroke=\"none\"");
    expect(svg).toContain("fill=\"#00ff00\" fill-opacity=\"0.502\"");
    expect(svg).toContain("<ellipse cx=\"20\" cy=\"15\" rx=\"10\" ry=\"5\" fill=\"#ff0000\"");
    expect(svg).toContain("&quot;&gt;&lt;script&gt;");
    expect(svg).not.toContain("NaN");
    expect(svg).not.toContain("Infinity");
    expect(svg).toContain("style=\"mix-blend-mode:multiply\"");
    expect(svg).toContain("<rect width=\"100\" height=\"50\" fill=\"#123456\"/>");
  });

  test("layers with invalid ids and hidden layers are omitted; groups nest with their transform", () => {
    const svg = exportSvg(hostileDoc(), { rasterHref: () => "data:image/png;base64,AAAA", animate: false });
    expect(svg).not.toContain("bad id");
    expect(svg).not.toContain("lc-h1");
    expect(svg).toMatch(/<g id="lc-g1" transform="matrix\(1 0 0 1 10 0\)"><g id="lc-r1" transform="matrix\(1 0 0 1 3 4\)"><image /);
  });

  test("raster hrefs other than clean PNG data URLs are dropped", () => {
    for (const href of ["http://evil.example/x.png", "data:image/svg+xml;base64,AAAA", "data:image/png;base64,AA\"onload=\"x", "javascript:alert(1)", "", null]) {
      const svg = exportSvg(hostileDoc(), { rasterHref: () => href, animate: false });
      expect(svg).not.toContain("<image");
      assertSafe(svg);
    }
  });

  test("animation is CSS keyframes over transform and opacity with generated names", () => {
    const doc = hostileDoc();
    doc.timeline = {
      fps: 10, durationMs: 1000, loop: true,
      tracks: [
        { layerId: "v1", prop: "x", keys: [{ t: 0, v: 0, ease: "linear" }, { t: 1000, v: 50, ease: "linear" }] },
        { layerId: "v1", prop: "opacity", keys: [{ t: 0, v: 1, ease: "linear" }, { t: 500, v: 0, ease: "ease-in" }] },
      ],
    };
    const svg = exportSvg(doc, { rasterHref: () => null, animate: true });
    assertSafe(svg);
    const style = svg.slice(svg.indexOf("<style>") + 7, svg.indexOf("</style>"));
    expect(style).toContain("@keyframes lc-k0{0%{transform:translate(0px,0px) rotate(0deg) scale(1) translate(0px,0px);opacity:1}");
    expect(style).toContain(".lc-a0{animation:lc-k0 1s linear infinite both}");
    // Only transform, opacity, and animation declarations appear.
    for (const decl of style.match(/[a-z-]+(?=:)/g) ?? []) expect(["transform", "opacity", "animation"]).toContain(decl);
    expect(svg).toContain("<g id=\"lc-v1\" class=\"lc-a0\"");
    expect(exportSvg(doc, { rasterHref: () => null, animate: false })).not.toContain("<style>");
  });

  test("a hostile id prefix falls back to the default", () => {
    const svg = exportSvg(hostileDoc(), { rasterHref: () => null, animate: false, idPrefix: "\"><script>" });
    expect(svg).toContain("id=\"lc-v1\"");
    assertSafe(svg);
  });
});
