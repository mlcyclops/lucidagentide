// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/lane_layout.test.ts - P-FLEET.L9: the pure geometry behind resizable + reorderable fleet
// lane cards. The load-bearing pins here are the two INVERSIONS that come from bottom-anchored cards
// (`align-self: end`): dragging the top edge UP is a negative dy that GROWS the card, and a north dock
// resize holds `y + h` fixed. Both are easy to get backwards and both make the panel feel broken when wrong.
// The rest pins fail-closed behavior: no NaN escapes, no throw on a corrupt store, no silent drop on reorder.

import { describe, expect, it } from "bun:test";
import { clampToViewport } from "./share_dock.ts";
import {
  gridCols, colsFromDrag, heightFromDrag, clampSize, snapSlot, reorder, reconcile, loadLayout, saveLayout,
  resizeShape,
  CARD_COL_W, CARD_GAP, CARD_MIN_H, CARD_MAX_H, CARD_MIN_COLS, CARD_MAX_COLS,
  type CardRect, type LaneLayout,
} from "./lane_layout.ts";

const MIN_W = 296, MIN_H = 200;
const START = { x: 100, y: 100, w: 400, h: 300 };

describe("gridCols (P-FLEET.L9)", () => {
  it("never reports fewer than one track, whatever the width", () => {
    expect(gridCols(0)).toBe(1);
    expect(gridCols(-500)).toBe(1);
    expect(gridCols(Number.NaN)).toBe(1);
    expect(gridCols(Number.POSITIVE_INFINITY)).toBe(1); // unusable width falls back, never Infinity tracks
    expect(gridCols(undefined as unknown as number)).toBe(1);
  });

  it("counts tracks with the gap between them, not after the last one", () => {
    expect(gridCols(300)).toBe(1);
    expect(gridCols(609)).toBe(1); // one px short of two tracks
    expect(gridCols(610)).toBe(2); // 300 + 10 + 300
    expect(gridCols(920)).toBe(3);
    expect(CARD_COL_W).toBe(300);
    expect(CARD_GAP).toBe(10);
  });

  it("honors an explicit track width and gap", () => {
    expect(gridCols(1000, 200, 0)).toBe(5);
    expect(gridCols(1000, 0, 0)).toBe(3); // a zero track width is nonsense, fall back to CARD_COL_W
  });
});

describe("colsFromDrag (P-FLEET.L9)", () => {
  it("has a half-track deadzone so a resting pointer never jitters the span", () => {
    expect(colsFromDrag(2, 0, 6)).toBe(2);
    expect(colsFromDrag(2, 149, 6)).toBe(2);
    expect(colsFromDrag(2, -149, 6)).toBe(2);
    expect(colsFromDrag(2, 150, 6)).toBe(3);
  });

  it("rounds a multi-track drag", () => {
    expect(colsFromDrag(1, 450, 6)).toBe(3); // +1.5 tracks rounds to +2
  });

  it("clamps down to CARD_MIN_COLS", () => {
    expect(colsFromDrag(1, -400, 6)).toBe(CARD_MIN_COLS);
    expect(colsFromDrag(2, -400, 6)).toBe(CARD_MIN_COLS);
    expect(colsFromDrag(3, -99999, 6)).toBe(CARD_MIN_COLS);
  });

  it("clamps up to the narrower of maxCols and CARD_MAX_COLS", () => {
    expect(colsFromDrag(1, 5 * CARD_COL_W, 2)).toBe(2);
    expect(colsFromDrag(6, 5 * CARD_COL_W, 99)).toBe(CARD_MAX_COLS);
    expect(colsFromDrag(1, 5 * CARD_COL_W, 0)).toBe(CARD_MIN_COLS); // a dock too narrow for a track
  });

  it("never returns NaN from an unusable drag or start", () => {
    expect(colsFromDrag(2, Number.NaN, 6)).toBe(2);
    expect(colsFromDrag(2, Number.POSITIVE_INFINITY, 6)).toBe(2);
    expect(colsFromDrag(Number.NaN, 0, 6)).toBe(CARD_MIN_COLS);
    expect(colsFromDrag(2, 150, Number.NaN)).toBe(3);
  });
});

describe("heightFromDrag (P-FLEET.L9)", () => {
  it("GROWS on a positive dy: the BOTTOM edge is the grow handle and follows the cursor", () => {
    // Sign is load-bearing. The handle sits on the bottom edge, so dragging DOWN reports dy > 0 and must
    // make the card TALLER. Backwards here and the gesture fights the pointer.
    expect(heightFromDrag(300, 100)).toBe(400);
    expect(heightFromDrag(300, 100)).toBeGreaterThan(300);
  });

  it("shrinks on a negative dy", () => {
    expect(heightFromDrag(300, -100)).toBe(200);
    expect(heightFromDrag(300, -100)).toBeLessThan(300);
  });

  it("clamps at both ends", () => {
    expect(heightFromDrag(CARD_MIN_H, -500)).toBe(CARD_MIN_H);
    expect(heightFromDrag(CARD_MAX_H, 500)).toBe(CARD_MAX_H);
    expect(heightFromDrag(200, 99999)).toBe(CARD_MAX_H);
    expect(heightFromDrag(-50, 0)).toBe(CARD_MIN_H); // a negative persisted height is not a height
  });

  it("returns the clamped start height for an unusable drag, never NaN", () => {
    const nan = heightFromDrag(300, Number.NaN);
    expect(nan).toBe(300);
    expect(Number.isNaN(nan)).toBe(false);
    expect(heightFromDrag(300, Number.POSITIVE_INFINITY)).toBe(300);
    expect(heightFromDrag(300, Number.NEGATIVE_INFINITY)).toBe(300);
    expect(heightFromDrag(Number.NaN, 0)).toBe(CARD_MIN_H);
  });
});

describe("clampSize (P-FLEET.L9)", () => {
  it("clamps both axes and returns a NEW object", () => {
    const s = { cols: 99, h: 99999 };
    const c = clampSize(s, 6);
    expect(c).toEqual({ cols: CARD_MAX_COLS, h: CARD_MAX_H });
    expect(c).not.toBe(s);
    expect(clampSize({ cols: 0, h: 10 }, 6)).toEqual({ cols: CARD_MIN_COLS, h: CARD_MIN_H });
    expect(clampSize({ cols: 4, h: 300 }, 2)).toEqual({ cols: 2, h: 300 });
  });

  it("substitutes the minimum for an unreadable size instead of propagating NaN", () => {
    expect(clampSize({ cols: Number.NaN, h: Number.NaN }, 6)).toEqual({ cols: CARD_MIN_COLS, h: CARD_MIN_H });
    expect(clampSize(undefined as unknown as { cols: number; h: number }, 6)).toEqual({ cols: CARD_MIN_COLS, h: CARD_MIN_H });
  });
});

describe("snapSlot (P-FLEET.L9)", () => {
  // A 2x2 grid of 300x200 cards with a 10px gap.
  const grid: CardRect[] = [
    { id: "a", x: 0, y: 0, w: 300, h: 200 },
    { id: "b", x: 310, y: 0, w: 300, h: 200 },
    { id: "c", x: 0, y: 210, w: 300, h: 200 },
    { id: "d", x: 310, y: 210, w: 300, h: 200 },
  ];

  it("returns the slot under the pointer for every quadrant", () => {
    expect(snapSlot(grid, 100, 100)).toBe(0);
    expect(snapSlot(grid, 450, 100)).toBe(1);
    expect(snapSlot(grid, 100, 300)).toBe(2);
    expect(snapSlot(grid, 450, 300)).toBe(3);
  });

  it("snaps to the last slot below every row and the first slot above every row", () => {
    expect(snapSlot(grid, 100, 9999)).toBe(3);
    expect(snapSlot(grid, 450, 9999)).toBe(3);
    expect(snapSlot(grid, 450, -50)).toBe(0);
    expect(snapSlot(grid, 100, -9999)).toBe(0);
  });

  it("groups a row by its TOP edge, because top-anchored cards in one row have different bottoms", () => {
    const mixed: CardRect[] = [
      { id: "a", x: 0, y: 0, w: 300, h: 400 },     // row 1, top 0, TALL
      { id: "b", x: 310, y: 0, w: 300, h: 100 },   // row 1, top 0, short
      { id: "c", x: 0, y: 410, w: 300, h: 100 },   // row 2, top 410
      { id: "d", x: 310, y: 410, w: 300, h: 100 }, // row 2, top 410
    ];
    // The differentiating case: the pointer is low down (y 350) but over b's COLUMN (x 460). Both cards
    // are in row 1, so the answer is b. Keying rows by the bottom edge would split a (bottom 400) and b
    // (bottom 100) into separate rows, land the pointer in a's band alone, and hand back "a" instead.
    expect(snapSlot(mixed, 460, 350)).toBe(1);
    expect(snapSlot(mixed, 100, 350)).toBe(0);
    expect(snapSlot(mixed, 460, 440)).toBe(3);
    expect(snapSlot(mixed, 100, 440)).toBe(2);
  });

  it("crossing a row boundary snaps to that row", () => {
    expect(snapSlot(grid, 100, 195)).toBe(0);
    expect(snapSlot(grid, 100, 215)).toBe(2);
  });

  it("returns -1 only for an empty grid", () => {
    expect(snapSlot([], 100, 100)).toBe(-1);
    expect(snapSlot([grid[0]], 9999, 9999)).toBe(0);
  });

  it("survives unusable rectangles and pointers without throwing or returning NaN", () => {
    const junk: CardRect[] = [
      { id: "a", x: Number.NaN, y: Number.NaN, w: Number.NaN, h: Number.NaN },
      { id: "b", x: 310, y: 0, w: 300, h: 200 },
    ];
    expect(Number.isNaN(snapSlot(junk, Number.NaN, Number.NaN))).toBe(false);
    expect(snapSlot(grid, Number.NaN, Number.NaN)).toBeGreaterThanOrEqual(0);
  });
});

describe("reorder (P-FLEET.L9)", () => {
  const order = ["a", "b", "c"];

  it("moves the first card to last and the last card to first", () => {
    expect(reorder(order, "a", 2)).toEqual(["b", "c", "a"]);
    expect(reorder(order, "c", 0)).toEqual(["c", "a", "b"]);
    expect(reorder(order, "a", 1)).toEqual(["b", "a", "c"]);
  });

  it("never mutates the input", () => {
    reorder(order, "a", 2);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("an unknown id is a no-op that still returns a NEW array", () => {
    const out = reorder(order, "ghost", 0);
    expect(out).toEqual(order);
    expect(out).not.toBe(order);
  });

  it("an out-of-range slot is a no-op, never a throw and never a drop", () => {
    for (const to of [-1, -99, order.length, order.length + 5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const out = reorder(order, "a", to);
      expect(out).toEqual(order);
      expect(out).not.toBe(order);
      expect(out).toContain("a");
    }
  });

  it("moving a card to the slot it already holds returns a new equal array", () => {
    const out = reorder(order, "b", 1);
    expect(out).toEqual(order);
    expect(out).not.toBe(order);
  });
});

describe("reconcile (P-FLEET.L9)", () => {
  it("appends unknown lanes in server order", () => {
    const l: LaneLayout = { order: ["a"], size: { a: { cols: 2, h: 300 } } };
    const r = reconcile(l, ["a", "b", "c"]);
    expect(r.order).toEqual(["a", "b", "c"]);
    expect(r.size).toEqual({ a: { cols: 2, h: 300 } });
  });

  it("drops a vanished lane from BOTH order and size", () => {
    const l: LaneLayout = { order: ["a", "b"], size: { a: { cols: 2, h: 300 }, b: { cols: 1, h: 200 } } };
    const r = reconcile(l, ["a"]);
    expect(r.order).toEqual(["a"]);
    expect(Object.keys(r.size)).toEqual(["a"]);
    expect(r.size.b).toBeUndefined();
  });

  it("preserves the user's order against a reshuffled server list", () => {
    const l: LaneLayout = { order: ["c", "a", "b"], size: {} };
    expect(reconcile(l, ["a", "b", "c"]).order).toEqual(["c", "a", "b"]);
    expect(reconcile(l, ["b", "c", "a", "d"]).order).toEqual(["c", "a", "b", "d"]);
  });

  it("a lane listed twice by the server appears once", () => {
    expect(reconcile({ order: [], size: {} }, ["a", "a", "b"]).order).toEqual(["a", "b"]);
    expect(reconcile({ order: ["a", "a"], size: {} }, ["a"]).order).toEqual(["a"]);
  });

  it("returns NEW objects even on the no-op path", () => {
    const l: LaneLayout = { order: ["a"], size: { a: { cols: 2, h: 300 } } };
    const r = reconcile(l, ["a"]);
    expect(r).toEqual(l);
    expect(r).not.toBe(l);
    expect(r.order).not.toBe(l.order);
    expect(r.size).not.toBe(l.size);
    expect(r.size.a).not.toBe(l.size.a);
  });

  it("ignores junk lane ids from the server", () => {
    const r = reconcile({ order: [], size: {} }, ["a", "", null as unknown as string, "b"]);
    expect(r.order).toEqual(["a", "b"]);
  });
});

describe("loadLayout / saveLayout (P-FLEET.L9)", () => {
  it("yields an EMPTY layout for every corrupt or absent payload, never a throw", () => {
    const empty = { order: [], size: {} };
    for (const raw of [null, "", "not json", "{}", '{"order":"nope"}', '{"order":[1,2]}']) {
      expect(loadLayout(raw)).toEqual(empty);
    }
    // A broken store must not brick the panel, so the same doctrine covers the shapes not on the list.
    for (const raw of [undefined, "null", "[]", "7", '{"order":["a"],"size":7}', '{"order":["a",""]}']) {
      expect(loadLayout(raw)).toEqual(empty);
    }
  });

  it("round-trips a saved layout byte-identically", () => {
    const l: LaneLayout = {
      order: ["lane-1", "lane-2"],
      size: { "lane-1": { cols: 2, h: 320 }, "lane-2": { cols: 1, h: 150 } },
    };
    const raw = saveLayout(l);
    expect(loadLayout(raw)).toEqual(l);
    expect(saveLayout(loadLayout(raw))).toBe(raw);
  });

  it("clamps a persisted size that is out of range", () => {
    const r = loadLayout('{"order":["a"],"size":{"a":{"cols":99,"h":99999}}}');
    expect(r.size.a).toEqual({ cols: CARD_MAX_COLS, h: CARD_MAX_H });
  });

  it("drops an unreadable size entry rather than inventing a number, keeping the order", () => {
    const r = loadLayout('{"order":["a","b"],"size":{"a":{"cols":"x","h":null},"b":{"cols":2,"h":300}}}');
    expect(r.order).toEqual(["a", "b"]);
    expect(r.size.a).toBeUndefined();
    expect(r.size.b).toEqual({ cols: 2, h: 300 });
  });

  it("releases a size entry for a lane that is not in the order, so the store cannot grow forever", () => {
    const r = loadLayout('{"order":["a"],"size":{"a":{"cols":1,"h":200},"ghost":{"cols":2,"h":300}}}');
    expect(Object.keys(r.size)).toEqual(["a"]);
  });

  it("saveLayout normalizes duplicates and clamps, so equal layouts serialize equally", () => {
    expect(saveLayout({ order: ["a", "a"], size: { a: { cols: 2, h: 300 } } }))
      .toBe(saveLayout({ order: ["a"], size: { a: { cols: 2, h: 300 } } }));
    expect(saveLayout({ order: ["a"], size: { a: { cols: 99, h: 1 } } }))
      .toBe(JSON.stringify({ order: ["a"], size: { a: { cols: CARD_MAX_COLS, h: CARD_MIN_H } } }));
  });
});

describe("resizeShape (P-FLEET.L9)", () => {
  it("north keeps the BOTTOM edge fixed: y and h move together", () => {
    const r = resizeShape("n", START, 0, -50, MIN_W, MIN_H);
    expect(r).toEqual({ x: 100, y: 50, w: 400, h: 350 });
    // The invariant, not just the deltas: the bottom edge does not move, so nothing below the dock shifts.
    expect(r.y + r.h).toBe(START.y + START.h);
    const shrink = resizeShape("n", START, 0, 50, MIN_W, MIN_H);
    expect(shrink).toEqual({ x: 100, y: 150, w: 400, h: 250 });
    expect(shrink.y + shrink.h).toBe(START.y + START.h);
  });

  it("west keeps the RIGHT edge fixed: x and w move together", () => {
    const r = resizeShape("w", START, -60, 0, MIN_W, MIN_H);
    expect(r).toEqual({ x: 40, y: 100, w: 460, h: 300 });
    expect(r.x + r.w).toBe(START.x + START.w);
  });

  it("east grows w only, south grows h only", () => {
    expect(resizeShape("e", START, 40, 0, MIN_W, MIN_H)).toEqual({ x: 100, y: 100, w: 440, h: 300 });
    expect(resizeShape("e", START, 40, 999, MIN_W, MIN_H).h).toBe(START.h);
    expect(resizeShape("s", START, 999, 40, MIN_W, MIN_H)).toEqual({ x: 100, y: 100, w: 400, h: 340 });
  });

  it("corners move both axes", () => {
    expect(resizeShape("ne", START, 40, -50, MIN_W, MIN_H)).toEqual({ x: 100, y: 50, w: 440, h: 350 });
    expect(resizeShape("nw", START, -60, -50, MIN_W, MIN_H)).toEqual({ x: 40, y: 50, w: 460, h: 350 });
    expect(resizeShape("se", START, 40, 50, MIN_W, MIN_H)).toEqual({ x: 100, y: 100, w: 440, h: 350 });
    expect(resizeShape("SW", START, -60, 50, MIN_W, MIN_H)).toEqual({ x: 40, y: 100, w: 460, h: 350 });
  });

  it("pins h at minH past the minimum and stops y there, bottom edge still fixed", () => {
    const r = resizeShape("n", START, 0, 500, MIN_W, MIN_H);
    expect(r.h).toBe(MIN_H);
    expect(r.y).toBe(START.y + START.h - MIN_H);
    expect(r.y + r.h).toBe(START.y + START.h);
    const further = resizeShape("n", START, 0, 900, MIN_W, MIN_H);
    expect(further).toEqual(r); // y has stopped: dragging further does nothing
  });

  it("pins w at minW past the minimum and stops x there, right edge still fixed", () => {
    const r = resizeShape("w", START, 200, 0, MIN_W, MIN_H);
    expect(r.w).toBe(MIN_W);
    expect(r.x).toBe(START.x + START.w - MIN_W);
    expect(r.x + r.w).toBe(START.x + START.w);
  });

  it("an unknown, empty, or self-contradictory dir returns an equal NEW shape", () => {
    for (const dir of ["", "banana", "x", "up", "ns", "ew", "n s", undefined as unknown as string]) {
      const r = resizeShape(dir, START, 40, -50, MIN_W, MIN_H);
      expect(r).toEqual(START);
      expect(r).not.toBe(START);
    }
  });

  it("always returns a NEW shape and never mutates the start", () => {
    const start = { ...START };
    const r = resizeShape("n", start, 0, -50, MIN_W, MIN_H);
    expect(r).not.toBe(start);
    expect(start).toEqual(START);
  });

  it("never emits NaN from an unusable drag, start, or minimum", () => {
    expect(resizeShape("nw", START, Number.NaN, Number.NaN, MIN_W, MIN_H)).toEqual(START);
    expect(resizeShape("ne", START, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, MIN_W, MIN_H)).toEqual(START);
    const junk = resizeShape("n", { x: Number.NaN, y: Number.NaN, w: Number.NaN, h: Number.NaN }, 0, -50, Number.NaN, Number.NaN);
    for (const v of [junk.x, junk.y, junk.w, junk.h]) expect(Number.isFinite(v)).toBe(true);
    expect(junk.w).toBeGreaterThan(0);
    expect(junk.h).toBeGreaterThan(0);
  });

  it("composes with share_dock.clampToViewport, which owns the viewport", () => {
    // resizeShape deliberately does NOT clamp to the screen, so a big north-west drag goes off-canvas here
    // and is corrected by the one function that knows the viewport.
    const off = resizeShape("nw", { x: 20, y: 20, w: 400, h: 300 }, -500, -500, MIN_W, MIN_H);
    expect(off.x).toBeLessThan(0);
    expect(off.y).toBeLessThan(0);
    const on = clampToViewport(off, 1440, 900);
    expect(on.x).toBeGreaterThanOrEqual(0);
    expect(on.y).toBeGreaterThanOrEqual(0);
    expect(on.x + on.w).toBeLessThanOrEqual(1440);
    expect(on.y + on.h).toBeLessThanOrEqual(900);
  });
});
