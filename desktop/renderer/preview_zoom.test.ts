// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { expect, test } from "bun:test";
import { PreviewWheelSteps, stepPreviewZoom } from "./preview_zoom.ts";

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
