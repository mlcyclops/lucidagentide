// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/agents_rail.test.ts - P-RAIL.AGENTS1: the pure geometry behind the rail's Agents view: where
// the hover module goes (left of the rail, clamped on screen, nub on the box), the arrow steps (3 Agents a click,
// a full page a double-click, snapped to whole boxes), the drop slot, and who looks at a moved box which way.
// The art module is covered for escaping-free inputs and unique gradient ids.

import { describe, expect, it } from "bun:test";
import { arrowState, glanceDelay, lookDirs, loopDelay, pageTarget, passedIds, placeModule, readView, scrollTarget, slotFor, SCROLL_STEP } from "./agents_rail.ts";
import { agentArt, huePalette, paletteOf, paletteStyle, themePalette } from "./agents_rail_art.ts";

const view = { w: 1600, h: 1000 };
const box = (left: number, top: number) => ({ left, top, right: left + 76, width: 76, height: 49 });

describe("placeModule", () => {
  it("prefers the left of the box and centers on it, nub at the box center", () => {
    const p = placeModule(box(1500, 400), { w: 272, h: 300 }, view);
    expect(p.side).toBe("l");
    expect(p.x).toBe(1500 - 12 - 272);
    expect(p.y).toBe(424.5 - 150);
    expect(p.nubX).toBe(p.x + 272 - 6.5);
    expect(p.nubY).toBe(424.5 - 6);
  });
  it("clamps inside the viewport at the top and bottom; the nub stays inside the module", () => {
    const top = placeModule(box(1500, 10), { w: 272, h: 400 }, view);
    expect(top.y).toBe(8);
    const bottom = placeModule(box(1500, 950), { w: 272, h: 400 }, view);
    expect(bottom.y).toBe(1000 - 8 - 400);
    expect(bottom.nubY + 6).toBe(bottom.y + 400 - 18);
  });
  it("caps a module taller than the window", () => {
    const p = placeModule(box(1500, 400), { w: 272, h: 2000 }, view);
    expect(p.maxH).toBe(984);
    expect(p.y).toBe(8);
  });
  it("flips right only when the left has no room, and never leaves the screen", () => {
    expect(placeModule(box(100, 400), { w: 272, h: 300 }, view)).toMatchObject({ side: "r", x: 188, nubX: 182.5 });
    const tiny = placeModule(box(50, 100), { w: 272, h: 300 }, { w: 200, h: 600 });
    expect(tiny.side).toBe("l");
    expect(tiny.x).toBe(8);
  });
});

describe("arrow steps", () => {
  const pitch = 56;
  it(`one click scrolls ${SCROLL_STEP} Agents, snapped to whole boxes, clamped at both ends`, () => {
    expect(scrollTarget(0, 500, 2000, pitch, 1)).toBe(3 * pitch);
    expect(scrollTarget(170, 500, 2000, pitch, 1)).toBe(6 * pitch);
    expect(scrollTarget(1400, 500, 2000, pitch, 1)).toBe(1500);
    expect(scrollTarget(100, 500, 2000, pitch, -1)).toBe(0);
    expect(scrollTarget(100, 500, 2000, 0, 1)).toBe(100);
  });
  it("a double-click jumps a full page: every box that fits", () => {
    expect(pageTarget(0, 500, 2000, pitch, 7, 1)).toBe(9 * pitch);
    expect(pageTarget(9 * pitch, 500, 2000, pitch, 7, -1)).toBe(0);
    expect(pageTarget(1400, 500, 2000, pitch, 7, 1)).toBe(1500);
  });
  it("arrows show only when there is more that way", () => {
    expect(arrowState(0, 500, 2000)).toEqual({ up: false, down: true });
    expect(arrowState(1500, 500, 2000)).toEqual({ up: true, down: false });
    expect(arrowState(0, 500, 400)).toEqual({ up: false, down: false });
  });
});

describe("reorder geometry", () => {
  it("the drop slot counts the other boxes above the dragged center", () => {
    expect(slotFor([10, 60, 110], 5)).toBe(0);
    expect(slotFor([10, 60, 110], 70)).toBe(2);
    expect(slotFor([10, 60, 110], 200)).toBe(3);
  });
  it("passedIds lists the boxes a move crossed, either direction", () => {
    const before = ["a", "b", "c", "d", "e"];
    expect(passedIds(before, ["b", "c", "d", "a", "e"], "a")).toEqual(["b", "c", "d"]);
    expect(passedIds(before, ["a", "e", "b", "c", "d"], "e")).toEqual(["b", "c", "d"]);
    expect(passedIds(before, before, "c")).toEqual([]);
  });
  it("boxes above the moved one look down at it, boxes below look up, the moved one is not in the map", () => {
    const after = ["b", "c", "d", "a", "e"];
    const dirs = lookDirs(after, "a", ["b", "c", "d"]);
    expect(Object.fromEntries(dirs)).toEqual({ b: "down", c: "down", d: "down", e: "up" });
    expect(Object.fromEntries(lookDirs(["a", "b", "c"], "a", []))).toEqual({ b: "up" });
  });
});

describe("motion cadence", () => {
  it("glances about once a minute, jittered", () => {
    expect(glanceDelay(0, true)).toBe(5000);
    expect(glanceDelay(1, true)).toBe(55000);
    expect(glanceDelay(0, false)).toBe(52000);
    expect(glanceDelay(0.5, false)).toBe(60000);
    expect(glanceDelay(Number.NaN, false)).toBe(52000);
  });
  it("loop delays are stable per folder and within one breath", () => {
    expect(loopDelay("/w/a")).toBe(loopDelay("/w/a"));
    for (const id of ["/w/a", "/w/b", "c:/x/y"]) { expect(loopDelay(id)).toBeLessThanOrEqual(0); expect(loopDelay(id)).toBeGreaterThan(-4.8); }
  });
  it("readView defaults to metrics", () => {
    expect(readView(null)).toBe("metrics");
    expect(readView("agents")).toBe("agents");
    expect(readView("junk")).toBe("metrics");
  });
});

describe("art", () => {
  it("each brick gets its own gradient ids and a state class", () => {
    const a = agentArt("idle", -1), b = agentArt("work", -2);
    const idOf = (s: string) => /id="(agr\d+)b"/.exec(s)?.[1];
    expect(idOf(a)).toBeTruthy();
    expect(idOf(a)).not.toBe(idOf(b));
    expect(a).toContain("agr-idle");
    expect(b).toContain("agr-work");
    expect(b).toContain("agr-kb-b"); // the keyboard only while typing
    expect(a).not.toContain("agr-kb-b");
  });
  it("palettes come from the mascot themes or a clamped hue", () => {
    expect(themePalette("lucid").G).toBe("#41ff8b");
    expect(huePalette(-30).hue).toBe(330);
    expect(paletteOf({ theme: null, hue: 200 }).G).toBe("hsl(200 100% 63%)");
    expect(paletteStyle(themePalette("ember"))).toBe("--K:#492a32;--D:#2c1b28;--L:#87504b;--G:#ff9354;--g:#a94732");
  });
});
