// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// The Ask Lucid header mascot's halo follows the palette it paints with (mascot_mini.ts, P-MINI.3 (ADR-0596)):
// the brand green for the Lucid themes, the theme's accent otherwise, and a season's accent while one is live.

import { describe, expect, it } from "bun:test";
import { MASCOT_PALETTE } from "./mascot.ts";
import { accentRgb } from "./mascot_mini.ts";
import { mascotPaletteFor } from "./mascot_theme.ts";

describe("accentRgb", () => {
  it("is the brand green for the brand palette", () => {
    expect(accentRgb(MASCOT_PALETTE)).toBe("65, 255, 139");
  });
  it("is the theme's accent for a color theme", () => {
    expect(accentRgb(mascotPaletteFor("ember", "#ff8040", "#a04020"))).toBe("255, 128, 64");
  });
  it("falls back to the brand green when the accent is not a #rrggbb color", () => {
    expect(accentRgb({ ...MASCOT_PALETTE, G: "rgb(1, 2, 3)" })).toBe("65, 255, 139");
    expect(accentRgb({})).toBe("65, 255, 139");
  });
});
