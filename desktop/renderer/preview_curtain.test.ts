// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, test } from "bun:test";
import {
  CURTAIN, canvasShows, canvasVerdict, chipAfterHide, chipCardAt, chipStackAt, chipTarget, chipText, chipView, classifyCurtain, curtainLabel, curtainMotion, dropCurtain,
  headChip, nodeOnStage, paintCommand, paintContentful, parsePaint, probeConcurrency, settleCurtain, shouldReprobe, swingOrigin, thumbFor, upsertCurtain,
  type CanvasSample, type CurtainInput, type PaintStats,
} from "./preview_curtain.ts";

const E = CURTAIN.sampleEdge;
/** A sample grid filled by `at(x, y)` -> RGBA. */
function grid(at: (x: number, y: number) => [number, number, number, number]): CanvasSample {
  const px: number[] = [];
  for (let y = 0; y < E; y++) for (let x = 0; x < E; x++) px.push(...at(x, y));
  return { w: 800, h: 600, px };
}
const solid = (r: number, g: number, b: number, a = 255) => grid(() => [r, g, b, a]);

const EMPTY_PAINT: PaintStats = { title: "", textChars: 0, media: 0, boxes: 0, canvases: [], errors: 0, scriptError: false, blockedRefs: false };
const paint = (p: Partial<PaintStats>): PaintStats => ({ ...EMPTY_PAINT, ...p });
const HTML = { resolves: true, kind: "html", bytes: 2048 };
const input = (p: Partial<CurtainInput>): CurtainInput => ({ probe: HTML, paint: null, looks: 0, loaded: true, elapsedMs: 0, ...p });

describe("canvasVerdict: the pixel check", () => {
  test("an all-white canvas is uniform and near-white", () => {
    const v = canvasVerdict(solid(255, 255, 255));
    expect(v.verdict).toBe("uniform");
    expect(v.nearWhite).toBe(true);
  });
  test("one solid non-white color is uniform too, but not near-white", () => {
    const v = canvasVerdict(solid(12, 14, 30));
    expect(v.verdict).toBe("uniform");
    expect(v.nearWhite).toBe(false);
  });
  test("noise within tolerance of one fill is still one color (a bucket edge cannot split it)", () => {
    // 0x7f / 0x80 straddle a quantization bucket edge.
    const v = canvasVerdict(grid((x) => (x % 2 ? [127, 127, 127, 255] : [129, 129, 129, 255])));
    expect(v.verdict).toBe("uniform");
  });
  test("a drawn scene is content", () => {
    const v = canvasVerdict(grid((x, y) => ((x + y) % 7 === 0 ? [240, 30, 30, 255] : [10, 10, 10, 255])));
    expect(v.verdict).toBe("content");
  });
  test("a small drawing on a white page crosses the threshold once it covers more than 1.5%", () => {
    const tiny = canvasVerdict(grid((x, y) => (x === 0 && y < 10 ? [0, 0, 0, 255] : [255, 255, 255, 255]))); // 10 / 2304
    expect(tiny.verdict).toBe("uniform");
    const drawn = canvasVerdict(grid((x, y) => (x < 3 && y < 20 ? [0, 0, 0, 255] : [255, 255, 255, 255]))); // 60 / 2304
    expect(drawn.verdict).toBe("content");
  });
  test("an all-clear readback is transparent; half clear, half colored is content", () => {
    expect(canvasVerdict(solid(0, 0, 0, 0)).verdict).toBe("transparent");
    expect(canvasVerdict(grid((x) => (x < E / 2 ? [0, 0, 0, 0] : [200, 0, 0, 255]))).verdict).toBe("content");
  });
  test("a refused readback and a zero-sized canvas are named, not guessed", () => {
    expect(canvasVerdict({ w: 300, h: 150, px: null }).verdict).toBe("unreadable");
    expect(canvasVerdict({ w: 0, h: 150, px: [] }).verdict).toBe("empty");
  });
});

describe("canvasShows", () => {
  test("a clear readback gets the benefit of the doubt (WebGL) only on a page with no errors", () => {
    const clear = solid(0, 0, 0, 0);
    expect(canvasShows(clear, 0)).toBe(true);
    expect(canvasShows(clear, 1)).toBe(false); // the P-PREVIEW.13 dead canvas
  });
  test("a tainted canvas did draw; a solid one did not", () => {
    expect(canvasShows({ w: 10, h: 10, px: null }, 0)).toBe(true);
    expect(canvasShows(solid(255, 255, 255), 0)).toBe(false);
  });
});

describe("paintContentful", () => {
  test("nothing at all is not content", () => expect(paintContentful(EMPTY_PAINT)).toBe(false));
  test("a stray character or two is not content, a word is", () => {
    expect(paintContentful(paint({ textChars: 2 }))).toBe(false);
    expect(paintContentful(paint({ textChars: 3 }))).toBe(true);
  });
  test("media and painted boxes count", () => {
    expect(paintContentful(paint({ media: 1 }))).toBe(true);
    expect(paintContentful(paint({ boxes: 1 }))).toBe(true);
  });
  test("a page that is only a solid canvas is not content", () => {
    expect(paintContentful(paint({ canvases: [solid(0, 0, 0)] }))).toBe(false);
  });
});

describe("classifyCurtain", () => {
  test("no probe answer yet is loading", () => {
    expect(classifyCurtain(input({ probe: null })).verdict).toBe("loading");
  });
  test("a target that does not resolve is an error, with the engine's reason", () => {
    const r = classifyCurtain(input({ probe: { resolves: false, error: "file not found or unreadable" } }));
    expect(r).toEqual({ verdict: "error", reason: "file not found or unreadable" });
    expect(classifyCurtain(input({ probe: { resolves: false, status: 502 } })).reason).toBe("HTTP 502");
  });
  test("an empty file is blank without loading anything", () => {
    expect(classifyCurtain(input({ probe: { resolves: true, kind: "html", bytes: 0 }, loaded: false })).verdict).toBe("blank");
  });
  test("non-HTML kinds are ready on the probe alone (no bridge in those documents)", () => {
    for (const kind of ["svg", "image", "pdf", "markdown", "text", "remote"]) {
      expect(classifyCurtain(input({ probe: { resolves: true, kind, bytes: 10 }, loaded: false })).verdict).toBe("ready");
    }
  });
  test("HTML waits for load, and a load that never comes is an error", () => {
    expect(classifyCurtain(input({ loaded: false, elapsedMs: 100 })).verdict).toBe("loading");
    expect(classifyCurtain(input({ loaded: false, elapsedMs: CURTAIN.loadTimeoutMs })).verdict).toBe("error");
  });
  test("a page with content is ready on the first look", () => {
    expect(classifyCurtain(input({ looks: 1, paint: paint({ textChars: 40 }) })).verdict).toBe("ready");
  });
  test("an empty first look earns a second look before any verdict", () => {
    expect(classifyCurtain(input({ looks: 1, paint: EMPTY_PAINT })).verdict).toBe("loading");
    expect(classifyCurtain(input({ looks: 1, paint: null })).verdict).toBe("loading");
  });
  test("still nothing after two looks: blank, or error when the page says why", () => {
    expect(classifyCurtain(input({ looks: 2, paint: EMPTY_PAINT })).verdict).toBe("blank");
    expect(classifyCurtain(input({ looks: 2, paint: paint({ scriptError: true, errors: 1 }) })).verdict).toBe("error");
    expect(classifyCurtain(input({ looks: 2, paint: paint({ blockedRefs: true }) })).verdict).toBe("error");
  });
  test("a page that never answers a look (a served error page has no bridge) is an error", () => {
    expect(classifyCurtain(input({ looks: 2, paint: null })).verdict).toBe("error");
  });
  test("a dead canvas page (script threw, canvas clear) is an error, not ready", () => {
    const dead = paint({ canvases: [solid(0, 0, 0, 0)], errors: 1, scriptError: true });
    expect(classifyCurtain(input({ looks: 2, paint: dead })).verdict).toBe("error");
  });
});

describe("shouldReprobe: a write announced before it lands", () => {
  test("missing, empty, refused and HTTP errors are asked again, up to the retry budget", () => {
    expect(shouldReprobe({ resolves: false, error: "file not found or unreadable" }, 0)).toBe(true);
    expect(shouldReprobe({ resolves: true, kind: "html", bytes: 0 }, 2)).toBe(true);
    expect(shouldReprobe({ resolves: false, error: "connection refused or timed out" }, 1)).toBe(true);
    expect(shouldReprobe({ resolves: false, status: 503, error: "HTTP 503" }, 1)).toBe(true);
    expect(shouldReprobe({ resolves: false, error: "file not found or unreadable" }, CURTAIN.probeRetries)).toBe(false);
  });
  test("a policy or kind refusal is final at once, and a non-empty target needs no second ask", () => {
    for (const error of ["the site is not approved for preview", "not a previewable file (html, svg, image, markdown, text, or pdf)", "file too large to preview (over 5 MB)", "not a local file path"]) {
      expect(shouldReprobe({ resolves: false, error }, 0)).toBe(false);
    }
    expect(shouldReprobe({ resolves: true, kind: "html", bytes: 10 }, 0)).toBe(false);
  });
});

describe("parsePaint: the frame's answer is untrusted", () => {
  test("a timeout note, an error, or a wrong shape is no answer", () => {
    expect(parsePaint({ error: "the preview didn't respond" })).toBeNull();
    expect(parsePaint(null)).toBeNull();
    expect(parsePaint([1, 2])).toBeNull();
    expect(parsePaint({ textChars: "lots", canvases: [] })).toBeNull();
  });
  test("counts are clamped and an oversized pixel array reads as a refused readback", () => {
    const p = parsePaint({ textChars: -5, media: Number.NaN, boxes: 2, errors: 1, canvases: [{ w: 10, h: 10, px: new Array(4 * 96 * 96 + 4).fill(0) }], scriptError: "yes", title: 7 });
    expect(p).toEqual({ title: "", textChars: 0, media: 0, boxes: 2, errors: 1, canvases: [{ w: 10, h: 10, px: null }], scriptError: false, blockedRefs: false });
  });
  test("a well-formed look survives intact", () => {
    const look = { title: "Snake", textChars: 12, media: 0, boxes: 3, errors: 0, canvases: [solid(1, 2, 3)], scriptError: false, blockedRefs: false, thumb: "data:image/png;base64,AA" };
    expect(parsePaint(look)).toEqual(look);
  });
});

describe("thumbFor", () => {
  const png = "data:image/png;base64,AAAA";
  test("only a canvas that shows content lends its thumbnail", () => {
    expect(thumbFor(paint({ thumb: png, canvases: [grid((x) => (x % 2 ? [0, 0, 0, 255] : [255, 0, 0, 255]))] }))).toBe(png);
    expect(thumbFor(paint({ thumb: png, canvases: [solid(0, 0, 0, 0)] }))).toBe("");
  });
  test("anything but a PNG data URL is refused", () => {
    expect(thumbFor(paint({ thumb: "javascript:alert(1)", canvases: [grid((x) => (x % 2 ? [0, 0, 0, 255] : [255, 0, 0, 255]))] }))).toBe("");
    expect(thumbFor(null)).toBe("");
  });
});

describe("the chip registry", () => {
  const a = { key: "agent", path: "/w/a.html", label: "a.html", seq: 1 };
  const b = { key: "lane:x", path: "/w/b.html", label: "b.html", seq: 2 };
  test("newest first, one entry per tab, a rewrite restarts it at the front", () => {
    let l = upsertCurtain([], a);
    l = upsertCurtain(l, b);
    expect(l.map((e) => e.key)).toEqual(["lane:x", "agent"]);
    l = upsertCurtain(l, { ...a, path: "/w/a2.html", seq: 3 });
    expect(l.map((e) => e.path)).toEqual(["/w/a2.html", "/w/b.html"]);
    expect(l.every((e) => e.phase === "loading")).toBe(true);
  });
  test("ready keeps the entry; blank and error retire it quietly", () => {
    let l = upsertCurtain(upsertCurtain([], a), b);
    l = settleCurtain(l, "agent", a.path, "ready", { title: "Game" });
    expect(l.find((e) => e.key === "agent")).toMatchObject({ phase: "ready", title: "Game" });
    expect(settleCurtain(l, "lane:x", b.path, "blank").map((e) => e.key)).toEqual(["agent"]);
    expect(settleCurtain(l, "lane:x", b.path, "error").map((e) => e.key)).toEqual(["agent"]);
  });
  test("a settle for a superseded path changes nothing", () => {
    const l = upsertCurtain([], { ...a, path: "/w/new.html" });
    expect(settleCurtain(l, "agent", "/w/old.html", "error")).toEqual(l);
  });
  test("the chip shows the newest READY entry over a newer spinner, and counts the rest", () => {
    let l = upsertCurtain([], a);
    l = settleCurtain(l, "agent", a.path, "ready");
    l = upsertCurtain(l, b); // b is newer but still loading
    const v = chipView(l);
    expect(v.head?.key).toBe("agent");
    expect(v.more).toBe(1);
    expect(v.ready).toBe(1);
    expect(chipView(dropCurtain(dropCurtain(l, "agent"), "lane:x"))).toEqual({ head: null, more: 0, ready: 0 });
  });
});

describe("small decisions", () => {
  test("labels name the file, or the host of a URL", () => {
    expect(curtainLabel("C:\\work\\game\\index.html")).toBe("index.html");
    expect(curtainLabel("/tmp/x.pdf")).toBe("x.pdf");
    expect(curtainLabel("http://localhost:5173/app")).toBe("localhost:5173");
  });
  test("probe frames are throttled by the perf tier", () => {
    expect(probeConcurrency("full")).toBe(3);
    expect(probeConcurrency("reduced")).toBe(2);
    expect(probeConcurrency("minimal")).toBe(1);
  });
  test("motion follows reduced-motion first, then the tier", () => {
    expect(curtainMotion("full", true)).toBe("still");
    expect(curtainMotion("minimal", false)).toBe("still");
    expect(curtainMotion("reduced", false)).toBe("calm");
    expect(curtainMotion("full", false)).toBe("full");
  });
  test("the swing hinges at the panel point nearest the chip, clamped to the panel", () => {
    const panel = { left: 600, top: 40, width: 500, height: 700 };
    expect(swingOrigin({ left: 520, top: 60, width: 60, height: 40 }, panel)).toEqual({ x: 0, y: 40 });
    expect(swingOrigin({ left: 700, top: 300, width: 20, height: 20 }, panel)).toEqual({ x: 110, y: 270 });
    expect(swingOrigin(null, panel)).toEqual({ x: 0, y: 0 });
  });
  test("the paint command carries the thresholds the bridge needs", () => {
    expect(paintCommand()).toEqual({ what: "paint", minBoxPx: CURTAIN.minBoxPx, fullFrac: CURTAIN.fullFrac, sampleEdge: CURTAIN.sampleEdge, thumbW: CURTAIN.thumbW, thumbH: CURTAIN.thumbH });
  });
});

describe("P-PREVIEW.CHIP1: one chip on every surface", () => {
  const a = { key: "agent", path: "/w/a.html", label: "a.html", seq: 1 };
  const b = { key: "lane:x", path: "/w/b.html", label: "b.html", seq: 2 };
  test("a tab key names its chip's target: the Agent tab is Main, a lane tab its lane, other tabs none", () => {
    expect(chipTarget("agent")).toBe("main");
    expect(chipTarget("lane:abc")).toBe("abc");
    expect(chipTarget("lane:")).toBeNull();
    expect(chipTarget("yours")).toBeNull();
    expect(chipTarget("plugin:x")).toBeNull();
    expect(chipTarget("asklucid")).toBeNull();
  });
  test("the composer chip is the registry's head with the count behind it", () => {
    expect(headChip([])).toBeNull();
    expect(headChip(upsertCurtain([], a))).toEqual({ phase: "loading", label: "a.html", path: "/w/a.html" });
    let l = settleCurtain(upsertCurtain([], a), "agent", a.path, "ready", { title: "Game", thumb: "data:image/png;base64,AA" });
    l = upsertCurtain(l, b);
    expect(headChip(l)).toEqual({ phase: "ready", label: "a.html", path: "/w/a.html", title: "Game", thumb: "data:image/png;base64,AA", more: 1 });
  });
  test("one wording: the page title over the file name, the waiting count only when there is one", () => {
    const ready = chipText({ phase: "ready", label: "a.html", path: "/w/a.html", title: "Game", more: 2 });
    expect(ready.k).toBe("Preview ready");
    expect(ready.name).toBe("Game");
    expect(ready.aria).toBe("Open the preview of Game, 2 more waiting");
    expect(ready.tipTitle).toBe("Open the preview");
    expect(ready.tipDesc.endsWith(" 2 more waiting.")).toBe(true);
    const loading = chipText({ phase: "loading", label: "a.html", path: "/w/a.html" });
    expect(loading).toMatchObject({ k: "Preparing preview", name: "a.html", aria: "Preparing a preview of a.html", tipTitle: "Preparing a preview" });
    expect(chipText({ phase: "ready", label: "b.html", path: "/w/b.html" }).aria).toBe("Open the preview of b.html");
  });
  test("over a node the chip centers above its frame and stacks over the artifact chip without touching it", () => {
    const box = { x: 500, y: 400, r: 30 };
    const stage = { left: 100, top: 50 };
    const art = chipStackAt(box, stage, { w: 140, h: 28 }); // the artifact chip's own spot
    expect(art).toEqual({ x: 330, y: 286 });
    const alone = chipStackAt(box, stage, { w: 120, h: 34 });
    expect(alone).toEqual({ x: 340, y: 280 });
    const stacked = chipStackAt(box, stage, { w: 120, h: 34 }, 28 + 6);
    expect(stacked).toEqual({ x: 340, y: 246 });
    expect(stacked.y + 34).toBeLessThanOrEqual(art.y - 6);
    expect(chipStackAt(box, stage, { w: 120, h: 34 }, -50)).toEqual(alone);
  });
  test("a node near the stage's top keeps its chips on the stage, stacked without overlapping", () => {
    const stage = { left: 0, top: 100, width: 800, height: 500 };
    const box = { x: 790, y: 130, r: 20 }; // near the top-right corner: the natural spot is above the stage and off its right
    const art = chipStackAt(box, stage, { w: 140, h: 28 });
    expect(art).toEqual({ x: 656, y: 4 });
    const chip = chipStackAt(box, stage, { w: 120, h: 34 }, 28 + 6);
    expect(chip.x).toBe(676);
    expect(chip.y).toBeGreaterThanOrEqual(art.y + 28 + 6); // under the artifact chip, never onto it
    expect(chipStackAt(box, stage, { w: 120, h: 34 }).y).toBe(4);
    // without the stage's size (callers that only pass the origin) nothing is clamped
    expect(chipStackAt(box, { left: 0, top: 100 }, { w: 120, h: 34 }).y).toBeLessThan(0);
  });
  test("the hover card sits above its chip when it fits, else below, always inside the stage", () => {
    const stage = { width: 800, height: 600 };
    const card = { w: 300, h: 160 };
    expect(chipCardAt({ left: 340, top: 246, width: 120, height: 34 }, card, stage)).toEqual({ left: 250, top: 78 });
    expect(chipCardAt({ left: 340, top: 40, width: 120, height: 34 }, card, stage)).toEqual({ left: 250, top: 82 });
    expect(chipCardAt({ left: 0, top: 300, width: 120, height: 34 }, card, stage).left).toBe(8);
    expect(chipCardAt({ left: 760, top: 300, width: 120, height: 34 }, card, stage).left).toBe(492);
    expect(chipCardAt({ left: 60, top: 20, width: 120, height: 34 }, card, { width: 200, height: 100 })).toEqual({ left: 8, top: 8 });
  });
});

describe("chipAfterHide: a lane chip closed with its red x (P-PREVIEW.CHIPX1)", () => {
  const page = (path: string, phase: "loading" | "ready" = "ready") => ({ phase, label: path, path });
  test("the same page stays hidden whether it loads again or turns ready again", () => {
    expect(chipAfterHide("games/a.html", page("games/a.html", "loading"))).toEqual({ show: null, hidden: "games/a.html" });
    expect(chipAfterHide("games/a.html", page("games/a.html"))).toEqual({ show: null, hidden: "games/a.html" });
  });
  test("a different page shows and ends the hide", () => {
    expect(chipAfterHide("games/a.html", page("games/b.html"))).toEqual({ show: page("games/b.html"), hidden: undefined });
  });
  test("no chip to show keeps the hide, so the page coming back later stays hidden", () => {
    expect(chipAfterHide("games/a.html", null)).toEqual({ show: null, hidden: "games/a.html" });
  });
  test("no hide paints what it is given", () => {
    expect(chipAfterHide(undefined, page("games/a.html"))).toEqual({ show: page("games/a.html"), hidden: undefined });
  });
});

describe("nodeOnStage: a chip over a node that left the stage hides (P-PREVIEW.CHIPOFF1)", () => {
  const stage = { left: 0, top: 92, width: 1584, height: 852 };
  test("a node on the stage keeps its chip, its edges included", () => {
    expect(nodeOnStage({ x: 792, y: 500 }, stage)).toBe(true);
    expect(nodeOnStage({ x: 0, y: 92 }, stage)).toBe(true);
    expect(nodeOnStage({ x: 1584, y: 944 }, stage)).toBe(true);
  });
  test("a node panned off any side (under the header included) has no chip", () => {
    for (const box of [{ x: -40, y: 500 }, { x: 1700, y: 500 }, { x: 792, y: 60 }, { x: 792, y: 990 }]) expect(nodeOnStage(box, stage)).toBe(false);
  });
});
