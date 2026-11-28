// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, test } from "bun:test";
import { PANEL_GAP, PANEL_HYSTERESIS, PANEL_MARGIN, panelCovers, placePanel } from "./viz_panel_place.ts";

const stage = { w: 1200, h: 700 };
const panel = { w: 340, h: 300 };

describe("placePanel side", () => {
  test("a node left of the middle gets the panel on its right, beside it and not over it", () => {
    const p = placePanel(stage, panel, { x: 300, y: 350, r: 40 }, null);
    expect(p.side).toBe("right");
    expect(p.left).toBe(300 + 40 + PANEL_GAP);
    expect(p.left).toBeGreaterThan(300 + 40); // clear of the node's frame
  });

  test("a node right of the middle gets the panel on its left", () => {
    const p = placePanel(stage, panel, { x: 900, y: 350, r: 40 }, null);
    expect(p.side).toBe("left");
    expect(p.left + panel.w).toBe(900 - 40 - PANEL_GAP);
  });

  test("a node on the middle exactly goes right", () => {
    expect(placePanel(stage, panel, { x: 600, y: 350, r: 30 }, null).side).toBe("right");
  });

  test("the side the panel does not fit on gives way to one it does", () => {
    // Just right of the middle (inside the band, so hysteresis alone would keep it right) on a narrow stage.
    const small = { w: 800, h: 600 };
    const p = placePanel(small, panel, { x: 420, y: 300, r: 30 }, "right"); // right room 800-10-(420+30+14) = 326 < 340
    expect(p.side).toBe("left");
  });

  test("the tilt leans the edge nearest the node back", () => {
    expect(placePanel(stage, panel, { x: 300, y: 350, r: 40 }, null).ry).toBeLessThan(0);
    expect(placePanel(stage, panel, { x: 900, y: 350, r: 40 }, null).ry).toBeGreaterThan(0);
  });
});

describe("placePanel hysteresis", () => {
  test("a node drifting across the middle inside the band keeps its side", () => {
    const mid = stage.w / 2;
    expect(placePanel(stage, panel, { x: mid + PANEL_HYSTERESIS - 1, y: 350, r: 30 }, "right").side).toBe("right");
    expect(placePanel(stage, panel, { x: mid - PANEL_HYSTERESIS + 1, y: 350, r: 30 }, "left").side).toBe("left");
  });

  test("past the band it flips", () => {
    const mid = stage.w / 2;
    expect(placePanel(stage, panel, { x: mid + PANEL_HYSTERESIS + 1, y: 350, r: 30 }, "right").side).toBe("left");
    expect(placePanel(stage, panel, { x: mid - PANEL_HYSTERESIS - 1, y: 350, r: 30 }, "left").side).toBe("right");
  });

  test("a node jittering a pixel either side of the middle never flickers", () => {
    let side = placePanel(stage, panel, { x: 600, y: 350, r: 30 }, null).side;
    for (let i = 0; i < 40; i++) {
      side = placePanel(stage, panel, { x: 600 + (i % 2 ? 9 : -9), y: 350, r: 30 }, side).side;
      expect(side).toBe("right");
    }
  });
});

describe("placePanel clamping", () => {
  test("vertically centered on the node when there is room", () => {
    const p = placePanel(stage, panel, { x: 300, y: 350, r: 40 }, null);
    expect(p.top).toBe(350 - panel.h / 2);
    expect(p.tailY).toBe(panel.h / 2);
  });

  test("a node near the top or bottom keeps the panel inside the stage, the tail still aimed at it", () => {
    const hi = placePanel(stage, panel, { x: 300, y: 20, r: 40 }, null);
    expect(hi.top).toBe(PANEL_MARGIN);
    expect(hi.tailY).toBeLessThan(panel.h / 2);
    const lo = placePanel(stage, panel, { x: 300, y: 690, r: 40 }, null);
    expect(lo.top + panel.h).toBe(stage.h - PANEL_MARGIN);
    expect(lo.tailY).toBeGreaterThan(panel.h / 2);
  });

  test("a stage too small for the panel pins it to the margin instead of a negative position", () => {
    const p = placePanel({ w: 300, h: 200 }, panel, { x: 150, y: 100, r: 20 }, null);
    expect(p.left).toBe(PANEL_MARGIN);
    expect(p.top).toBe(PANEL_MARGIN);
  });
});

describe("placePanel off screen", () => {
  test("a node off the left docks the panel at the left edge, tail pointing left", () => {
    const p = placePanel(stage, panel, { x: -400, y: 350, r: 40 }, "left");
    expect(p.docked).toBe(true);
    expect(p.side).toBe("right");
    expect(p.left).toBe(PANEL_GAP);
  });

  test("a node off the right docks the panel at the right edge", () => {
    const p = placePanel(stage, panel, { x: 2400, y: 350, r: 40 }, "right");
    expect(p.docked).toBe(true);
    expect(p.side).toBe("left");
    expect(p.left + panel.w).toBe(stage.w - PANEL_GAP);
  });

  test("a node above the stage keeps the panel on screen at the top", () => {
    const p = placePanel(stage, panel, { x: 300, y: -900, r: 40 }, null);
    expect(p.docked).toBe(true);
    expect(p.top).toBe(PANEL_MARGIN);
    expect(p.left).toBeGreaterThanOrEqual(PANEL_MARGIN);
  });

  test("never off screen, wherever the node is", () => {
    for (const x of [-5000, -1, 0, 120, 600, 1100, 1200, 9000]) {
      for (const y of [-3000, 0, 350, 700, 4000]) {
        const p = placePanel(stage, panel, { x, y, r: 60 }, null);
        expect(p.left).toBeGreaterThanOrEqual(PANEL_MARGIN);
        expect(p.left + panel.w).toBeLessThanOrEqual(stage.w - PANEL_MARGIN);
        expect(p.top).toBeGreaterThanOrEqual(PANEL_MARGIN);
        expect(p.top + panel.h).toBeLessThanOrEqual(stage.h - PANEL_MARGIN);
      }
    }
  });
});

describe("panelCovers (P-OVERLAP.1)", () => {
  // The role legend: 14 px in from the stage's bottom-left corner.
  const legend = { left: 14, top: stage.h - 14 - 22, w: 118, h: 22 };
  test("a panel docked at the stage's bottom-left (node off the left edge) covers the legend", () => {
    const p = placePanel(stage, panel, { x: -200, y: stage.h, r: 40 }, null);
    expect(panelCovers({ left: p.left, top: p.top, w: panel.w, h: panel.h }, legend)).toBe(true);
  });
  test("a panel beside a node mid-stage, or one just touching the legend's edge, does not", () => {
    const p = placePanel(stage, panel, { x: 600, y: 200, r: 40 }, null);
    expect(panelCovers({ left: p.left, top: p.top, w: panel.w, h: panel.h }, legend)).toBe(false);
    expect(panelCovers({ left: legend.left + legend.w, top: legend.top, w: 100, h: 100 }, legend)).toBe(false);
  });
  test("an empty legend (no roles yet) is never covered", () => {
    expect(panelCovers({ left: 0, top: 0, w: stage.w, h: stage.h }, { left: 14, top: 600, w: 0, h: 0 })).toBe(false);
  });
});
