// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_panel_size.test.ts - P-VIZ.LANE1 (ADR-0683): the Agent Worlds node panel's user size.

import { describe, expect, test } from "bun:test";
import { PANEL_MARGIN } from "./viz_panel_place.ts";
import { clampPanelSize, dragPanelSize, loadPanelSize, PANEL_MIN_H, PANEL_MIN_W, PANEL_SIZE_KEY, PANEL_STEP, savePanelSize, stepPanelSize, type SizeStore } from "./viz_panel_size.ts";

const room = { w: 1200, h: 800 };

function memStore(): SizeStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v); }, removeItem: (k) => { map.delete(k); } };
}

describe("clampPanelSize", () => {
  test("never under the minimum, never past the stage less a margin on each side", () => {
    expect(clampPanelSize({ w: 100, h: 50 }, room)).toEqual({ w: PANEL_MIN_W, h: PANEL_MIN_H });
    expect(clampPanelSize({ w: 5000, h: 5000 }, room)).toEqual({ w: room.w - 2 * PANEL_MARGIN, h: room.h - 2 * PANEL_MARGIN });
    expect(clampPanelSize({ w: 500.4, h: 400.6 }, room)).toEqual({ w: 500, h: 401 });
  });

  test("a stage smaller than the minimum still gets the minimum (placement clamps the position)", () => {
    expect(clampPanelSize({ w: 900, h: 900 }, { w: 200, h: 150 })).toEqual({ w: PANEL_MIN_W, h: PANEL_MIN_H });
  });
});

describe("dragPanelSize", () => {
  const start = { w: 400, h: 300 };
  test("the outer edge widens outward on either side of the node", () => {
    expect(dragPanelSize(start, "x", "right", 60, 0, room).w).toBe(460);
    expect(dragPanelSize(start, "x", "left", -60, 0, room).w).toBe(460); // left of its node: the outer edge is the left one
    expect(dragPanelSize(start, "x", "left", 60, 0, room).w).toBe(340);
  });

  test("the bottom edge follows the pointer on a panel centered on its node (twice the drag)", () => {
    expect(dragPanelSize(start, "y", "right", 0, 50, room)).toEqual({ w: 400, h: 400 });
    expect(dragPanelSize(start, "y", "right", 90, 50, room).w).toBe(400); // a sideways wobble does not change the width
    expect(dragPanelSize(start, "x", "right", 0, 50, room).h).toBe(300);
  });

  test("the corner changes both, clamped", () => {
    expect(dragPanelSize(start, "xy", "right", 30, 20, room)).toEqual({ w: 430, h: 340 });
    expect(dragPanelSize(start, "xy", "right", -900, -900, room)).toEqual({ w: PANEL_MIN_W, h: PANEL_MIN_H });
    expect(dragPanelSize(start, "xy", "right", 5000, 5000, room)).toEqual({ w: room.w - 2 * PANEL_MARGIN, h: room.h - 2 * PANEL_MARGIN });
  });
});

describe("stepPanelSize", () => {
  const cur = { w: 400, h: 300 };
  test("arrows resize by a step, Shift by four", () => {
    expect(stepPanelSize(cur, "ArrowRight", false, room)).toEqual({ w: 400 + PANEL_STEP, h: 300 });
    expect(stepPanelSize(cur, "ArrowLeft", false, room)).toEqual({ w: 400 - PANEL_STEP, h: 300 });
    expect(stepPanelSize(cur, "ArrowDown", true, room)).toEqual({ w: 400, h: 300 + 4 * PANEL_STEP });
    expect(stepPanelSize(cur, "ArrowUp", false, room)).toEqual({ w: 400, h: 300 - PANEL_STEP });
  });

  test("other keys are not the grip's, and steps stay clamped", () => {
    expect(stepPanelSize(cur, "Enter", false, room)).toBeNull();
    expect(stepPanelSize({ w: PANEL_MIN_W, h: PANEL_MIN_H }, "ArrowUp", true, room)).toEqual({ w: PANEL_MIN_W, h: PANEL_MIN_H });
  });
});

describe("persistence", () => {
  test("a saved size comes back on the next open; null forgets it", () => {
    const s = memStore();
    savePanelSize(s, { w: 520.2, h: 610.7 });
    expect(JSON.parse(s.map.get(PANEL_SIZE_KEY)!)).toEqual({ w: 520, h: 611 });
    expect(loadPanelSize(s)).toEqual({ w: 520, h: 611 });
    savePanelSize(s, null);
    expect(s.map.has(PANEL_SIZE_KEY)).toBe(false);
    expect(loadPanelSize(s)).toBeNull();
  });

  test("anything but two positive finite numbers reads as no size", () => {
    const s = memStore();
    for (const raw of ["not json", "null", "[]", '{"w":400}', '{"w":"400","h":300}', '{"w":-1,"h":300}', '{"w":0,"h":300}', '{"w":1e999,"h":300}']) {
      s.map.set(PANEL_SIZE_KEY, raw);
      expect(loadPanelSize(s)).toBeNull();
    }
  });

  test("a storage that throws neither breaks the panel nor loses the size for this session", () => {
    const broken: SizeStore = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("quota"); }, removeItem: () => { throw new Error("denied"); } };
    expect(loadPanelSize(broken)).toBeNull();
    expect(() => savePanelSize(broken, { w: 400, h: 300 })).not.toThrow();
    expect(() => savePanelSize(broken, null)).not.toThrow();
  });
});
