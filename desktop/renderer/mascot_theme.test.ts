// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/mascot_theme.test.ts - P-MINI.3 (ADR-0596): the ninja's colors follow the color theme.

import { describe, expect, test } from "bun:test";
import { MASCOT_PALETTE } from "./mascot.ts";
import { mascotPaletteFor } from "./mascot_theme.ts";

describe("mascotPaletteFor", () => {
  test("the Lucid themes and an unset theme keep the brand palette as drawn", () => {
    for (const id of ["lucid-dark", "lucid-light", undefined]) {
      expect(mascotPaletteFor(id, "#f2653a", "#b8401f")).toBe(MASCOT_PALETTE);
    }
  });

  test("another theme gives him its accent on the headband, belt and scarf, and a tint of it on the gi", () => {
    const p = mascotPaletteFor("ember", " #f2653a", "#b8401f ");
    expect(p.G).toBe("#f2653a");
    expect(p.g).toBe("#b8401f");
    for (const k of ["K", "D", "L"]) {
      expect(p[k]).not.toBe(MASCOT_PALETTE[k]);
      expect(p[k]).not.toBe(p.G);
    }
    // Skin, eyes, ink and steel keep their contrast in every theme.
    for (const k of ["k", "S", "s", "W", "B", "M"]) expect(p[k]).toBe(MASCOT_PALETTE[k]);
  });

  test("an accent that is not a #rrggbb color leaves the brand palette, never a broken color", () => {
    expect(mascotPaletteFor("ember", "", "")).toBe(MASCOT_PALETTE);
    expect(mascotPaletteFor("ember", "rgb(1 2 3)", "#b8401f")).toBe(MASCOT_PALETTE);
    expect(mascotPaletteFor("toString", "#f2653a", "#b8401f").G).toBe("#f2653a"); // not mistaken for a brand theme
  });
});
