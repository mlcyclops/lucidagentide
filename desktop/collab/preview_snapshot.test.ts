// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/preview_snapshot.test.ts - P-PREVIEW-PWA.1 (ADR-0237): the pure downscale sizing.

import { describe, expect, it } from "bun:test";
import { fitWithin, MAX_SNAPSHOT_EDGE, penWidthFor, toNormPoint } from "./preview_snapshot.ts";

describe("fitWithin (P-PREVIEW-PWA.1)", () => {
  it("never upscales an already-small image", () => {
    expect(fitWithin(800, 600, 1280)).toEqual({ w: 800, h: 600 });
    expect(fitWithin(1280, 720, 1280)).toEqual({ w: 1280, h: 720 }); // exactly at the cap
  });

  it("caps the longest edge, preserving aspect (landscape + portrait)", () => {
    expect(fitWithin(2560, 1440, 1280)).toEqual({ w: 1280, h: 720 });
    expect(fitWithin(1440, 2560, 1280)).toEqual({ w: 720, h: 1280 });
  });

  it("rounds to integer dimensions", () => {
    expect(fitWithin(1000, 333, 500)).toEqual({ w: 500, h: 167 }); // scale 0.5 -> 166.5 rounds to 167
  });

  it("degrades a zero / negative / non-positive-max input to {0,0}", () => {
    expect(fitWithin(0, 100, 1280)).toEqual({ w: 0, h: 0 });
    expect(fitWithin(100, -1, 1280)).toEqual({ w: 0, h: 0 });
    expect(fitWithin(100, 100, 0)).toEqual({ w: 0, h: 0 });
  });

  it("defaults to MAX_SNAPSHOT_EDGE", () => {
    expect(fitWithin(4000, 2000)).toEqual(fitWithin(4000, 2000, MAX_SNAPSHOT_EDGE));
    expect(MAX_SNAPSHOT_EDGE).toBeGreaterThan(0);
  });
});

describe("toNormPoint / penWidthFor (P-PREVIEW-PWA.2)", () => {
  const rect = { left: 100, top: 50, width: 200, height: 100 };

  it("maps a pointer position into normalized image space", () => {
    expect(toNormPoint(100, 50, rect)).toEqual({ x: 0, y: 0 });
    expect(toNormPoint(300, 150, rect)).toEqual({ x: 1, y: 1 });
    expect(toNormPoint(200, 100, rect)).toEqual({ x: 0.5, y: 0.5 });
  });

  it("CLAMPS a stroke that wanders off the image edge (never outside the composite)", () => {
    expect(toNormPoint(50, 20, rect)).toEqual({ x: 0, y: 0 });
    expect(toNormPoint(999, 999, rect)).toEqual({ x: 1, y: 1 });
  });

  it("degrades a degenerate rect to 0, never NaN", () => {
    const p = toNormPoint(10, 10, { left: 0, top: 0, width: 0, height: 0 });
    expect(p).toEqual({ x: 0, y: 0 });
  });

  it("pen width scales with the image, floored at 3", () => {
    expect(penWidthFor(100)).toBe(3);   // tiny capture still legible
    expect(penWidthFor(1280)).toBe(6);  // the MAX_SNAPSHOT_EDGE case
    expect(penWidthFor(2560)).toBe(12); // scales linearly
  });
});
