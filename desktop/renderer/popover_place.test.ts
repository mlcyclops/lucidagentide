// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/popover_place.test.ts - P-ASKPLUS.1 (ADR-0632): a menu opened from a high layer (Ask Lucid,
// z 250) opens in front of it, and a prompt bar's menu prefers the side above the bar.

import { describe, expect, test } from "bun:test";

import { placePopover, popoverLayer, POPOVER_Z } from "./popover_place.ts";

const VIEW = { width: 1270, height: 860 };
const MENU = { width: 236, height: 100 };

describe("popoverLayer", () => {
  test("a menu inside Ask Lucid (z 250) is lifted in front of the panel, below the tooltip layer", () => {
    expect(popoverLayer([Number.NaN, 3, 250, Number.NaN])).toBe(251);
  });
  test("an anchor in a layer under the popover base keeps the base layer", () => {
    expect(popoverLayer([Number.NaN, 55, 5])).toBeNull();
    expect(popoverLayer([])).toBeNull();
  });
  test("a layer level with the base still gets lifted, and the lift never reaches the tooltip layer", () => {
    expect(popoverLayer([POPOVER_Z])).toBe(POPOVER_Z + 1);
    expect(popoverLayer([5000])).toBe(259);
  });
});

describe("placePopover prefer", () => {
  // The floating Ask Lucid's "+" sits mid-window: both sides have room.
  const mid = { top: 594, bottom: 634, left: 456 };
  test("a prompt bar's menu opens above when it fits there", () => {
    const p = placePopover({ anchor: mid, card: MENU, viewport: VIEW, prefer: "above" });
    expect(p.side).toBe("above");
    expect(p.top + p.maxHeight).toBeLessThanOrEqual(mid.top);
  });
  test("without a preference the reading-order default (below) is kept", () => {
    expect(placePopover({ anchor: mid, card: MENU, viewport: VIEW }).side).toBe("below");
  });
  test("prefer above falls back below when only below fits", () => {
    const nearTop = { top: 60, bottom: 96, left: 40 };
    expect(placePopover({ anchor: nearTop, card: MENU, viewport: VIEW, prefer: "above" }).side).toBe("below");
  });
  test("when neither side fits, prefer above takes the roomier side and caps the height", () => {
    const p = placePopover({ anchor: { top: 300, bottom: 340, left: 10 }, card: { width: 236, height: 900 }, viewport: VIEW, prefer: "above" });
    expect(p.side).toBe("below");
    expect(p.maxHeight).toBe(VIEW.height - 340 - 8 - 10);
  });
});
