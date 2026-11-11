// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/plugins_flyout.test.ts - P-PLUGINS.1 (ADR-0461): where the drawer lands. It must open from the
// Preview panel's left edge at min(1180px, 88vw), and never slide under the left rail.

import { describe, expect, test } from "bun:test";
import { drawerGeometry } from "./plugins_flyout.ts";

describe("drawerGeometry", () => {
  test("a wide window: 1180 px, right edge on the Preview panel's left edge", () => {
    expect(drawerGeometry(2560, 1800, 56)).toEqual({ left: 620, width: 1180 });
  });

  test("a common window: 88vw wins, and when the chat column is narrower the drawer overlaps the panel instead of shrinking", () => {
    const g = drawerGeometry(1280, 640, 56);
    expect(g.width).toBe(1126);
    expect(g.left).toBe(56);
    expect(g.left + g.width).toBeGreaterThan(640);
  });

  test("never under the rail, never wider than the space right of it", () => {
    const g = drawerGeometry(900, 450, 56);
    expect(g.left).toBe(56);
    expect(g.left + g.width).toBeLessThanOrEqual(900);
  });
});
