// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/preview_capture.test.ts - the zoom-aware preview crop. The regression these guard is specific:
// at 118% zoom the preview snip bled sideways into the chat/composer column and sliced the right edge off
// the previewed app, because a CSS-pixel rect was used as a DIP crop.

import { describe, expect, test } from "bun:test";
import { captureCropFromCssRect } from "./preview_capture.ts";

describe("captureCropFromCssRect", () => {
  test("zoom 1.0 is the identity case - a never-zoomed window is unaffected", () => {
    expect(captureCropFromCssRect({ x: 663, y: 30, width: 659, height: 590 }, 1)).toEqual({
      x: 663, y: 30, width: 659, height: 590,
    });
  });

  test("THE BUG: at 118% zoom the origin moves RIGHT onto the panel and the box grows to cover it", () => {
    // The preview iframe measures 663 CSS px from the left; on screen it starts at 663 * 1.18 = 782 DIP.
    // Cropping at 663 started 119 DIP inside the chat/composer column - that is the leak the user saw.
    const crop = captureCropFromCssRect({ x: 663, y: 30, width: 659, height: 590 }, 1.18);
    expect(crop.x).toBe(782);
    expect(crop.x + crop.width).toBe(1560); // flush with the panel's right edge, so nothing is sliced off
    expect(crop.width).toBe(778);
    expect(crop.y).toBe(35);
    expect(crop.y + crop.height).toBe(732);
  });

  test("the crop never starts left of the measured element (the composer-bleed direction)", () => {
    for (const z of [1, 1.1, 1.18, 1.25, 1.5, 2]) {
      const crop = captureCropFromCssRect({ x: 400, y: 100, width: 500, height: 300 }, z);
      expect(crop.x).toBeGreaterThanOrEqual(400);
      expect(crop.width).toBeGreaterThanOrEqual(500);
    }
  });

  test("edges are scaled then rounded, so a fractional zoom cannot shave the far edge", () => {
    // Scaling a rounded WIDTH instead loses the sub-pixel at the origin: round(333*1.1)=366,
    // round(1.1*100)=110 -> 366+110=476, one px short of the true right edge round(433*1.1)=476... the
    // failure mode this asserts against is the accumulated variant, so pin the exact edge arithmetic.
    const crop = captureCropFromCssRect({ x: 333, y: 77, width: 100, height: 55 }, 1.1);
    expect(crop.x).toBe(Math.round(333 * 1.1));
    expect(crop.x + crop.width).toBe(Math.round(433 * 1.1));
    expect(crop.y + crop.height).toBe(Math.round(132 * 1.1));
  });

  test("a zoomed-OUT window shrinks the crop to match", () => {
    const crop = captureCropFromCssRect({ x: 200, y: 100, width: 400, height: 200 }, 0.5);
    expect(crop).toEqual({ x: 100, y: 50, width: 200, height: 100 });
  });

  test("an unusable zoom degrades to unscaled, never to a zero-area crop", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, null, undefined, "1.18", {}]) {
      expect(captureCropFromCssRect({ x: 10, y: 20, width: 30, height: 40 }, bad)).toEqual({
        x: 10, y: 20, width: 30, height: 40,
      });
    }
  });

  test("garbage rect fields collapse to 0 instead of throwing or capturing the whole page", () => {
    expect(captureCropFromCssRect({ x: Number.NaN, y: -5, width: "600", height: null }, 1.18)).toEqual({
      x: 0, y: 0, width: 0, height: 0,
    });
    expect(captureCropFromCssRect(null, 1.18)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(captureCropFromCssRect(undefined, 2)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});
