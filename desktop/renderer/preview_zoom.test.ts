// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, test } from "bun:test";
import { PREVIEW_CONTENT_MAX_PX, PREVIEW_ZOOM_MIN, previewLayout, PreviewWheelSteps, stepPreviewZoom } from "./preview_zoom.ts";

const pct = (z: number): number => Math.round(z * 100);

test("an off-grid zoom snaps to the next whole 10% in the direction asked (214% -> 220% / 210%)", () => {
  expect(pct(stepPreviewZoom(2.14, 1))).toBe(220);
  expect(pct(stepPreviewZoom(2.14, -1))).toBe(210);
});

test("on the grid, each step is exactly 10 points, float noise included", () => {
  expect(pct(stepPreviewZoom(1, 1))).toBe(110);
  expect(pct(stepPreviewZoom(1, -1))).toBe(90);
  expect(pct(stepPreviewZoom(0.1 + 0.2 + 0.4, 1))).toBe(80); // 0.7000000000000001
  expect(pct(stepPreviewZoom(2.0999999999, -1))).toBe(200);
});

test("the range clamps: 25% is the floor, 400% the ceiling, and up from 25% lands on 30%", () => {
  expect(pct(stepPreviewZoom(0.3, -1))).toBe(25);
  expect(pct(stepPreviewZoom(0.25, -1))).toBe(25);
  expect(pct(stepPreviewZoom(0.25, 1))).toBe(30);
  expect(pct(stepPreviewZoom(4, 1))).toBe(400);
});

test("wheel: a notch is one step at any display scaling; small trackpad deltas add up; a reversal starts over", () => {
  const w = new PreviewWheelSteps();
  expect([w.feed(-100), w.feed(-80), w.feed(120)]).toEqual([1, 1, -1]); // 100% and 125% scaling notches, then out
  expect([w.feed(-30), w.feed(-30), w.feed(-30), w.feed(-30)]).toEqual([0, 0, 0, 1]);
  expect(w.feed(40)).toBe(0); // reversal: the leftover -20 is dropped, not subtracted
  expect([w.feed(40), w.feed(40)]).toEqual([0, -1]);
});

describe("P-PREVIEW.FIT1 previewLayout", () => {
  const card = { w: 1920, h: 1080, fixed: true };
  test("an oversized fixed card fits the panel whole by default, in a frame as large as the card", () => {
    const L = previewLayout({ viewportW: 780, viewportH: 700, content: card, fit: true, manualZoom: 1 });
    expect(L.zoom).toBeCloseTo(780 / 1920, 5);
    expect(L.stageW).toBeGreaterThanOrEqual(1920);
    expect(L.stageH).toBeGreaterThanOrEqual(1080);
    expect(L.stageW * L.zoom).toBeCloseTo(780, 3); // fills the panel width exactly, nothing cut off
  });
  test("at a picked 100% the whole card is still laid out, so the panel scrolls and pans across all of it", () => {
    const L = previewLayout({ viewportW: 780, viewportH: 700, content: card, fit: false, manualZoom: 1 });
    expect(L.zoom).toBe(1);
    expect(L.stageW).toBe(1920);
    expect(L.stageH).toBe(1080);
  });
  test("a page that fits keeps 100% and the panel's own size (no behavior change for ordinary pages)", () => {
    expect(previewLayout({ viewportW: 780, viewportH: 700, content: null, fit: true, manualZoom: 1 })).toEqual({ stageW: 780, stageH: 700, zoom: 1, fitZoom: 1 });
    // a long scrolling article scrolls inside its own frame: only a fixed document's height is laid out whole
    expect(previewLayout({ viewportW: 780, viewportH: 700, content: { w: 0, h: 5000, fixed: false }, fit: true, manualZoom: 1 }).stageH).toBe(700);
  });
  test("zoomed out, the frame grows to keep the panel filled; zoomed in, the page is magnified as before", () => {
    expect(previewLayout({ viewportW: 800, viewportH: 600, content: null, fit: false, manualZoom: 0.5 })).toMatchObject({ stageW: 1600, stageH: 1200, zoom: 0.5 });
    expect(previewLayout({ viewportW: 800, viewportH: 600, content: null, fit: false, manualZoom: 2 })).toMatchObject({ stageW: 800, stageH: 600, zoom: 2 });
  });
  test("a runaway size is capped and the fit never goes below the zoom floor", () => {
    const L = previewLayout({ viewportW: 300, viewportH: 300, content: { w: 1e6, h: 1e6, fixed: true }, fit: true, manualZoom: 1 });
    expect(L.stageW).toBeLessThanOrEqual(PREVIEW_CONTENT_MAX_PX);
    expect(L.zoom).toBe(PREVIEW_ZOOM_MIN);
  });
});
