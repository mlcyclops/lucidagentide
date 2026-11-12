// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, test } from "bun:test";
import { createDoc } from "../../harness/creator/design/doc.ts";
import type { DesignDoc, GroupLayer, Layer, PathCmd, RasterData, RasterLayer } from "../../harness/creator/design/types.ts";
import {
  BRUSH_MAX, BRUSH_MIN, History, addLayer, b64ToBytes, brushToSlider, bytesToB64, cropDoc, debounce, floodFillMask,
  integerTranslation, layerWorld, moveKey, moveNode, paintList, penToPath, safeFileStem, scaleDocStructure, screenToDoc,
  setTimeline, sliderToBrush, snappedRect, stepBrush, zoomAbout, type TilePatch,
} from "./design_logic.ts";

const raster = (id: string, over: Partial<RasterLayer> = {}): RasterLayer => ({
  id, name: id, kind: "raster", visible: true, locked: false, opacity: 1, blend: "normal", x: 0, y: 0, scale: 1, rotation: 0,
  anchorX: 0, anchorY: 0, width: 10, height: 10, ...over,
});

function withLayers(doc: DesignDoc, ...layers: Layer[]): DesignDoc {
  let d = doc;
  for (const l of layers) {
    const r = addLayer(d, l);
    if ("error" in r) throw new Error(r.error);
    d = r.doc;
  }
  return d;
}

/** A w x h raster where pixel (x, y) gets color(x, y). */
function img(w: number, h: number, color: (x: number, y: number) => [number, number, number, number]): RasterData {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgba.set(color(x, y), (y * w + x) * 4);
  return { width: w, height: h, rgba };
}

describe("brush size slider", () => {
  test("is logarithmic over 1..2000 px and round-trips", () => {
    expect(sliderToBrush(0)).toBe(BRUSH_MIN);
    expect(sliderToBrush(1000)).toBe(BRUSH_MAX);
    // Half the travel lands near the geometric middle (sqrt(2000) ~ 45), not the linear one (1000).
    expect(sliderToBrush(500)).toBeGreaterThan(40);
    expect(sliderToBrush(500)).toBeLessThan(50);
    for (const s of [1, 3, 17, 100, 640, 2000]) expect(Math.abs(sliderToBrush(brushToSlider(s)) - s) / s).toBeLessThan(0.01);
  });

  test("[ and ] always move by at least one pixel and stay clamped", () => {
    expect(stepBrush(1, 1)).toBe(2);
    expect(stepBrush(2, -1)).toBe(1);
    expect(stepBrush(1, -1)).toBe(1);
    expect(stepBrush(2000, 1)).toBe(2000);
    expect(stepBrush(100, 1)).toBe(112);
  });
});

describe("viewport math", () => {
  test("zooming keeps the doc point under the cursor fixed and clamps to 1%..6400%", () => {
    const v = { zoom: 1, panX: 30, panY: -12 };
    const before = screenToDoc(v, 200, 150);
    const z = zoomAbout(v, 3.7, 200, 150);
    const after = screenToDoc(z, 200, 150);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
    expect(zoomAbout(v, 1e9, 0, 0).zoom).toBe(64);
    expect(zoomAbout(v, 0, 0, 0).zoom).toBe(0.01);
  });
});

describe("seam-free tile placement", () => {
  test("neighbouring 256 px tiles share device edges exactly at fractional zooms and offsets", () => {
    for (const zoom of [1.15, 0.73, 2.333, 1.5 * 1.25, 6.4]) {
      for (const off of [0, 0.37, -13.62, 101.5]) {
        const m = [zoom, 0, 0, zoom, off, off * 0.7];
        for (let t = 0; t < 6; t++) {
          const a = snappedRect(m, t * 256, t * 256, (t + 1) * 256, (t + 1) * 256);
          const b = snappedRect(m, (t + 1) * 256, (t + 1) * 256, (t + 2) * 256, (t + 2) * 256);
          expect(a.x + a.w).toBe(b.x);
          expect(a.y + a.h).toBe(b.y);
          expect(Number.isInteger(a.x) && Number.isInteger(a.w)).toBe(true);
        }
        // The tiles together cover exactly the rounded extent of the whole span.
        const all = snappedRect(m, 0, 0, 6 * 256, 6 * 256);
        const sum = Array.from({ length: 6 }, (_, t) => snappedRect(m, t * 256, 0, (t + 1) * 256, 1).w).reduce((x, y) => x + y, 0);
        expect(sum).toBe(all.w);
      }
    }
  });
});

describe("magic wand flood fill", () => {
  // Left half red, right half blue, with a red island inside the blue half.
  const src = img(8, 4, (x, y) => (x < 4 || (x === 6 && y === 1) ? [255, 0, 0, 255] : [0, 0, 255, 255]));

  test("contiguous mode stops at a color edge and does not reach a same-colored island", () => {
    const m = floodFillMask(src, 0, 0, 10, true);
    expect(m.alpha.reduce((n, a) => n + (a ? 1 : 0), 0)).toBe(16);
    expect(m.alpha[1 * 8 + 6]).toBe(0);
  });

  test("global mode picks every pixel of the color, the island included", () => {
    const m = floodFillMask(src, 0, 0, 10, false);
    expect(m.alpha.reduce((n, a) => n + (a ? 1 : 0), 0)).toBe(17);
  });

  test("tolerance widens the match and a seed outside the raster selects nothing", () => {
    const grad = img(10, 1, (x) => [x * 10, 0, 0, 255]);
    expect(floodFillMask(grad, 0, 0, 25, true).alpha.reduce((n, a) => n + (a ? 1 : 0), 0)).toBe(3);
    expect(floodFillMask(grad, -1, 0, 255, true).alpha.every((a) => a === 0)).toBe(true);
  });

  test("a large fill runs without recursion", () => {
    const big = img(1500, 1500, () => [9, 9, 9, 255]);
    expect(floodFillMask(big, 750, 750, 0, true).alpha.every((a) => a === 255)).toBe(true);
  });
});

describe("undo history byte cap", () => {
  const tile = (n: number): Uint8ClampedArray => new Uint8ClampedArray(n);
  const patch = (bytes: number): TilePatch => ({ key: "k", tx: 0, ty: 0, before: tile(bytes / 2), after: tile(bytes / 2) });

  test("drops the oldest steps once the byte cap is exceeded, never the newest", () => {
    const h = new History<string>(10_000, 0);
    h.push({ label: "a", before: "0", after: "1", patches: [patch(4000)] });
    h.push({ label: "b", before: "1", after: "2", patches: [patch(4000)] });
    const r = h.push({ label: "c", before: "2", after: "3", patches: [patch(4000)] });
    expect(r.dropped).toBe(1);
    expect(h.undo()?.label).toBe("c");
    expect(h.undo()?.label).toBe("b");
    expect(h.undo()).toBeNull();
  });

  test("a single step larger than the cap clears the history instead of half-recording it", () => {
    const h = new History<string>(10_000, 0);
    h.push({ label: "a", before: "0", after: "1" });
    const r = h.push({ label: "huge", before: "1", after: "2", patches: [patch(20_000)] });
    expect(r.oversize).toBe(true);
    expect(h.canUndo()).toBe(false);
    expect(h.bytes()).toBe(0);
  });

  test("a new step after an undo discards the redo branch and its bytes", () => {
    const h = new History<string>(1_000_000, 0);
    h.push({ label: "a", before: "0", after: "1", patches: [patch(1000)] });
    h.push({ label: "b", before: "1", after: "2", patches: [patch(1000)] });
    h.undo();
    expect(h.canRedo()).toBe(true);
    h.push({ label: "c", before: "1", after: "3" });
    expect(h.canRedo()).toBe(false);
    expect(h.bytes()).toBeLessThan(2 * 1064);
  });
});

describe("debounce", () => {
  test("only the last of a burst runs, and flush runs a pending call now", () => {
    const timers: { fn: () => void; ms: number; live: boolean }[] = [];
    const api = { set: (fn: () => void, ms: number) => { const t = { fn, ms, live: true }; timers.push(t); return t; }, clear: (h: unknown) => { (h as { live: boolean }).live = false; } };
    let runs = 0;
    const d = debounce(() => { runs++; }, 1000, api);
    d.fire(); d.fire(); d.fire();
    for (const t of timers) if (t.live) t.fn();
    expect(runs).toBe(1);
    d.fire();
    d.flush();
    expect(runs).toBe(2);
    d.flush();
    expect(runs).toBe(2);
  });
});

describe("pen and node editing", () => {
  test("corners become lines, dragged anchors become cubics, closing adds the return segment and Z", () => {
    const cmds = penToPath([{ x: 0, y: 0 }, { x: 10, y: 0, hin: { x: 8, y: -2 }, hout: { x: 12, y: 2 } }, { x: 10, y: 10 }], true);
    expect(cmds.map((c) => c.c)).toEqual(["M", "C", "C", "L", "Z"]);
    expect(cmds[1]).toEqual({ c: "C", x1: 0, y1: 0, x2: 8, y2: -2, x: 10, y: 0 });
    expect(penToPath([{ x: 1, y: 1 }], false)).toEqual([{ c: "M", x: 1, y: 1 }]);
  });

  test("moving a closed path's start anchor moves the closing segment end with it", () => {
    const sq: PathCmd[] = [{ c: "M", x: 0, y: 0 }, { c: "L", x: 10, y: 0 }, { c: "L", x: 10, y: 10 }, { c: "L", x: 0, y: 0 }, { c: "Z" }];
    const out = moveNode(sq, { cmd: 0, part: "p" }, -5, -5);
    expect(out[0]).toEqual({ c: "M", x: -5, y: -5 });
    expect(out[3]).toEqual({ c: "L", x: -5, y: -5 });
    expect(sq[0]).toEqual({ c: "M", x: 0, y: 0 });
  });

  test("moving an anchor carries its in handle and the next segment's out handle", () => {
    const p: PathCmd[] = [{ c: "M", x: 0, y: 0 }, { c: "C", x1: 1, y1: 0, x2: 4, y2: 0, x: 5, y: 0 }, { c: "C", x1: 6, y1: 0, x2: 9, y2: 0, x: 10, y: 0 }];
    const out = moveNode(p, { cmd: 1, part: "p" }, 5, 3);
    expect(out[1]).toMatchObject({ x2: 4, y2: 3, x: 5, y: 3 });
    expect(out[2]).toMatchObject({ x1: 6, y1: 3, x: 10, y: 0 });
  });
});

describe("document edits", () => {
  test("crop shifts layers, masks, hints and x/y keys by the crop origin", () => {
    let d = withLayers(createDoc("d", 100, 80), raster("a", { x: 30, y: 20 }));
    d = { ...d, masks: Object.assign(Object.create(null), { m: { id: "m", x: 0, y: 0, width: 100, height: 80 } }) };
    d = { ...d, timeline: { ...d.timeline, tracks: [{ layerId: "a", prop: "x", keys: [{ t: 0, v: 30, ease: "linear" }] }, { layerId: "a", prop: "opacity", keys: [{ t: 0, v: 0.5, ease: "linear" }] }] } };
    const r = cropDoc(d, { x: 10, y: 5, w: 50, h: 40 });
    if ("error" in r) throw new Error(r.error);
    expect([r.doc.width, r.doc.height]).toEqual([50, 40]);
    expect(r.doc.layers.a).toMatchObject({ x: 20, y: 15 });
    expect(r.doc.masks.m).toMatchObject({ x: -10, y: -5, width: 100 });
    expect(r.doc.timeline.tracks[0]!.keys[0]!.v).toBe(20);
    expect(r.doc.timeline.tracks[1]!.keys[0]!.v).toBe(0.5);
    expect(Object.getPrototypeOf(r.doc.layers)).toBeNull();
    expect("error" in cropDoc(d, { x: 0, y: 0, w: 0, h: 10 })).toBe(true);
  });

  test("resize scales raster sizes, offsets and vector geometry together", () => {
    const vec: Layer = { ...raster("v"), kind: "vector", shapes: [{ id: "s", kind: "rect", rect: { x: 10, y: 10, w: 20, h: 20 }, paint: { fill: "#000000", stroke: null, strokeWidth: 2, opacity: 1 } }] } as Layer;
    const d = withLayers(createDoc("d", 100, 50), raster("a", { x: 10, y: 4, width: 50, height: 25 }), vec);
    const s = scaleDocStructure(d, 200, 100);
    expect(s.layers.a).toMatchObject({ x: 20, y: 8, width: 100, height: 50 });
    const v = s.layers.v;
    expect(v?.kind === "vector" && v.shapes[0]!.rect).toEqual({ x: 20, y: 20, w: 40, h: 40 });
    expect(d.layers.a).toMatchObject({ width: 50 });
  });

  test("moving a key onto another key's time replaces it and keeps the track sorted", () => {
    let d = createDoc("d", 10, 10);
    d = { ...d, timeline: { ...d.timeline, tracks: [{ layerId: "a", prop: "x", keys: [{ t: 0, v: 0, ease: "linear" }, { t: 500, v: 5, ease: "linear" }, { t: 1000, v: 10, ease: "linear" }] }] } };
    const out = moveKey(d, "a", "x", 0, 1000);
    expect(out.timeline.tracks[0]!.keys).toEqual([{ t: 500, v: 5, ease: "linear" }, { t: 1000, v: 0, ease: "linear" }]);
  });

  test("timeline settings never allow more frames than the frame cap", () => {
    const d = setTimeline(createDoc("d", 10, 10), { fps: 60, durationMs: 600_000 });
    expect(d.timeline.fps).toBe(60);
    expect((d.timeline.durationMs * d.timeline.fps) / 1000).toBeLessThanOrEqual(1000);
    expect(setTimeline(d, { fps: 0 }).timeline.fps).toBe(1);
  });
});

describe("paint order and group transforms", () => {
  test("a group's offset and opacity reach its children; hidden groups hide them", () => {
    const g: GroupLayer = { ...raster("g"), kind: "group", children: ["c"], x: 5, opacity: 0.5 } as unknown as GroupLayer;
    let d = withLayers(createDoc("d", 100, 100), raster("bottom"), g);
    d = { ...d, layers: Object.assign(Object.create(null), d.layers, { c: raster("c", { x: 10, y: 20, parentId: "g", opacity: 0.8 }) }) };
    const list = paintList(d);
    expect(list.map((p) => p.id)).toEqual(["bottom", "c"]);
    const c = list[1]!;
    expect(c.groups).toEqual(["g"]);
    const w = layerWorld(d, c, 0);
    expect(integerTranslation(w.m)).toEqual({ dx: 15, dy: 20 });
    expect(w.opacity).toBeCloseTo(0.4, 9);
    const hidden = { ...d, layers: Object.assign(Object.create(null), d.layers, { g: { ...g, visible: false } }) };
    expect(paintList(hidden)[1]!.visible).toBe(false);
  });

  test("a rotated layer has no whole-pixel fast path", () => {
    const d = withLayers(createDoc("d", 100, 100), raster("r", { rotation: 30 }));
    expect(integerTranslation(layerWorld(d, paintList(d)[0]!, 0).m)).toBeNull();
  });
});

describe("names and bytes", () => {
  test("file stems lose path separators, control characters and leading dots", () => {
    expect(safeFileStem("../../etc/passwd")).toBe("_.._etc_passwd");
    expect(safeFileStem("..hidden")).toBe("hidden");
    expect(safeFileStem("a\u0000b<c>.png")).toBe("a_b_c_.png");
    expect(safeFileStem("")).toBe("design");
    expect(safeFileStem("x".repeat(300)).length).toBe(80);
  });

  test("base64 round-trips and refuses anything outside the alphabet", () => {
    const bytes = new Uint8Array(70_000).map((_, i) => (i * 31) & 255);
    expect(b64ToBytes(bytesToB64(bytes))).toEqual(bytes);
    expect(b64ToBytes("ab=c")).toBeNull();
    expect(b64ToBytes("abc")).toBeNull();
    expect(b64ToBytes("ab\ncd==")).toBeNull();
  });
});
