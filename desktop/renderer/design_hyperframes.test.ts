// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, test } from "bun:test";
import { applyOps, createDoc } from "../../harness/creator/design/doc.ts";
import type { DesignDoc, RasterLayer } from "../../harness/creator/design/types.ts";
import { addLayer } from "./design_logic.ts";
import { hfAssetPath, hfLayerOrder, hyperframesIndexHtml } from "./design_hyperframes.ts";

const raster = (id: string, name: string, over: Partial<RasterLayer> = {}): RasterLayer => ({
  id, name, kind: "raster", visible: true, locked: false, opacity: 1, blend: "normal", x: 0, y: 0, scale: 1, rotation: 0,
  anchorX: 0, anchorY: 0, width: 20, height: 10, ...over,
});

function doc(): DesignDoc {
  let d = createDoc("promo", 320, 180, "#102030");
  for (const l of [raster("bg", "Background"), raster("logo", `"><script>alert(1)</script> http://evil.example//x`, { x: 10, y: 20, blend: "multiply" })]) {
    const r = addLayer(d, l);
    if ("error" in r) throw new Error(r.error);
    d = r.doc;
  }
  const r = applyOps(d, [
    { op: "keyframe", id: "logo", prop: "x", t: 0, v: 10 },
    { op: "keyframe", id: "logo", prop: "x", t: 1000, v: 110 },
  ], "user");
  return { ...r.doc, timeline: { ...r.doc.timeline, fps: 10, durationMs: 1000 } };
}

describe("HyperFrames composition", () => {
  const d = doc();
  const ids = hfLayerOrder(d);
  const html = hyperframesIndexHtml(d, ids.map((id) => ({ layerId: id, ext: "png" as const, width: 20, height: 10 })));

  test("declares the composition root and one timed clip per layer, in paint order", () => {
    expect(ids).toEqual(["bg", "logo"]);
    expect(html).toContain('data-composition-id="lucid-design" data-width="320" data-height="180" data-fps="10" data-start="0" data-duration="1"');
    expect(html.match(/class="clip layer/g)?.length).toBe(2);
    expect(html).toContain('data-track-index="1"');
    expect(html).toContain(`src="${hfAssetPath(1, "png")}"`);
    expect(html).toContain("background:#102030");
  });

  test("motion is a CSS keyframe per frame; a static layer has a fixed transform", () => {
    const k1 = /@keyframes k1\{([^}]*\}){10}\}/.exec(html);
    expect(k1).not.toBeNull();
    expect(html).toContain("0%{transform:matrix(1,0,0,1,10,20);opacity:1}");
    expect(html).toContain("90%{transform:matrix(1,0,0,1,100,20);opacity:1}");
    expect(html).toContain(".l1{mix-blend-mode:multiply;animation:k1 1000ms linear 0ms 1 both}");
    expect(html).not.toContain("@keyframes k0");
  });

  test("no layer name, script, or URL reaches the markup (it must pass the engine's project checks)", () => {
    expect(html).not.toContain("script");
    expect(html).not.toContain("Background");
    expect(html).not.toContain("http");
    expect(html).not.toContain("//");
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toContain("url(");
  });

  test("a hidden layer is left out", () => {
    const hidden = applyOps(d, [{ op: "visible", id: "bg", value: false }], "user").doc;
    expect(hfLayerOrder(hidden)).toEqual(["logo"]);
  });
});
