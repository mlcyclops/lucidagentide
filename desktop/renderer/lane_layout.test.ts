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
  widthFromDrag, maxCardW, heightFromDrag, clampSize, snapSlot, reorder, reconcile, loadLayout, saveLayout,
  resizeShape,
  CARD_COL_W, CARD_GAP, CARD_MIN_H, CARD_MAX_H, CARD_MIN_W, CARD_MAX_W, CARD_DEF_W,
  type CardRect, type LaneLayout,
} from "./lane_layout.ts";

const MIN_W = 296, MIN_H = 200;
const START = { x: 100, y: 100, w: 400, h: 300 };

// P-FLEET.L12 retired `gridCols`: the panel is a wrapping flex row now, so there are no tracks to count.
// CARD_COL_W and CARD_GAP survive as the DEFAULT card width and the flex gap, and as the arithmetic the
// legacy span migration below reads, so their values are still pinned here.
describe("the surviving track constants (P-FLEET.L12)", () => {
  it("keeps the values the stylesheet and the span migration both depend on", () => {
    expect(CARD_COL_W).toBe(300);
    expect(CARD_GAP).toBe(10);
    expect(CARD_DEF_W).toBe(CARD_COL_W);
  });
});

describe("widthFromDrag (P-FLEET.L12: continuous, no snap)", () => {
  it("THE FIX: the edge tracks the pointer 1:1, with no deadzone and no track step", () => {
    // The old span model quantized this to a 300px track with a half-track deadzone: a 149px drag moved
    // NOTHING and a 150px drag jumped a full 300px. Reported as "more adjustable right side handlers, not
    // just snap". Every pixel of drag must now land.
    expect(widthFromDrag(400, 1, 2000)).toBe(401);
    expect(widthFromDrag(400, 149, 2000)).toBe(549);
    expect(widthFromDrag(400, 150, 2000)).toBe(550);
    expect(widthFromDrag(400, -1, 2000)).toBe(399);
    expect(widthFromDrag(400, 0, 2000)).toBe(400);
  });

  it("clamps down to CARD_MIN_W", () => {
    expect(widthFromDrag(400, -400, 2000)).toBe(CARD_MIN_W);
    expect(widthFromDrag(400, -99999, 2000)).toBe(CARD_MIN_W);
    expect(widthFromDrag(CARD_MIN_W, -1, 2000)).toBe(CARD_MIN_W);
  });

  it("clamps up to the narrower of the panel body and CARD_MAX_W", () => {
    expect(widthFromDrag(400, 9000, 900)).toBe(900); // never wider than the panel it lives in
    expect(widthFromDrag(400, 9000, 99999)).toBe(CARD_MAX_W);
    expect(widthFromDrag(400, 9000, 100)).toBe(CARD_MIN_W); // a panel narrower than one minimum card
  });

  it("never returns NaN from an unusable drag or start", () => {
    expect(widthFromDrag(400, Number.NaN, 2000)).toBe(400);
    expect(widthFromDrag(400, Number.POSITIVE_INFINITY, 2000)).toBe(400);
    expect(widthFromDrag(Number.NaN, 0, 2000)).toBe(CARD_DEF_W);
    // An unmeasurable ceiling must not clamp the drag down (see maxCardW below).
    expect(widthFromDrag(400, 100, Number.NaN)).toBe(500);
  });
});

describe("maxCardW (P-FLEET.L12)", () => {
  it("a measured panel body IS the ceiling, floored at one minimum card", () => {
    expect(maxCardW(900)).toBe(900);
    expect(maxCardW(100)).toBe(CARD_MIN_W);
    expect(maxCardW(99999)).toBe(CARD_MAX_W);
  });

  it("an UNMEASURABLE body does not clamp: it must never rewrite the user's sizes", () => {
    // rect.width reads 0 while the panel is hidden or pre-layout. Clamping to the MINIMUM there would
    // shrink every card the user had sized to 260px off one bad measurement, which is unrecoverable;
    // being briefly too permissive is free, because CSS shrinks an over-wide card and the next real
    // measurement re-clamps it. The DIRECTION of this fallback is the assertion.
    expect(maxCardW(0)).toBe(CARD_MAX_W);
    expect(maxCardW(-50)).toBe(CARD_MAX_W);
    expect(maxCardW(Number.NaN)).toBe(CARD_MAX_W);
    expect(maxCardW(Number.POSITIVE_INFINITY)).toBe(CARD_MAX_W);
    expect(maxCardW(undefined as unknown as number)).toBe(CARD_MAX_W);
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

describe("clampSize (P-FLEET.L12)", () => {
  it("clamps both axes and returns a NEW object", () => {
    const s = { w: 99999, h: 99999 };
    const c = clampSize(s, 99999);
    expect(c).toEqual({ w: CARD_MAX_W, h: CARD_MAX_H });
    expect(c).not.toBe(s);
    expect(clampSize({ w: 0, h: 10 }, 2000)).toEqual({ w: CARD_MIN_W, h: CARD_MIN_H });
    expect(clampSize({ w: 1200, h: 300 }, 900)).toEqual({ w: 900, h: 300 }); // capped by the panel body
  });

  it("substitutes the default width and minimum height for an unreadable size, never NaN", () => {
    expect(clampSize({ w: Number.NaN, h: Number.NaN }, 2000)).toEqual({ w: CARD_DEF_W, h: CARD_MIN_H });
    expect(clampSize(undefined as unknown as { w: number; h: number }, 2000)).toEqual({ w: CARD_DEF_W, h: CARD_MIN_H });
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
    const l: LaneLayout = { order: ["a"], size: { a: { w: 610, h: 300 } } };
    const r = reconcile(l, ["a", "b", "c"]);
    expect(r.order).toEqual(["a", "b", "c"]);
    expect(r.size).toEqual({ a: { w: 610, h: 300 } });
  });

  it("drops a vanished lane from BOTH order and size", () => {
    const l: LaneLayout = { order: ["a", "b"], size: { a: { w: 610, h: 300 }, b: { w: 300, h: 200 } } };
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
    const l: LaneLayout = { order: ["a"], size: { a: { w: 610, h: 300 } } };
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
      size: { "lane-1": { w: 610, h: 320 }, "lane-2": { w: 300, h: 150 } },
    };
    const raw = saveLayout(l);
    expect(loadLayout(raw)).toEqual(l);
    expect(saveLayout(loadLayout(raw))).toBe(raw);
  });

  it("clamps a persisted size that is out of range", () => {
    const r = loadLayout('{"order":["a"],"size":{"a":{"w":99999,"h":99999}}}');
    expect(r.size.a).toEqual({ w: CARD_MAX_W, h: CARD_MAX_H });
  });

  it("drops an unreadable size entry rather than inventing a number, keeping the order", () => {
    const r = loadLayout('{"order":["a","b"],"size":{"a":{"w":"x","h":null},"b":{"w":610,"h":300}}}');
    expect(r.order).toEqual(["a", "b"]);
    expect(r.size.a).toBeUndefined();
    expect(r.size.b).toEqual({ w: 610, h: 300 });
  });

  it("releases a size entry for a lane that is not in the order, so the store cannot grow forever", () => {
    const r = loadLayout('{"order":["a"],"size":{"a":{"w":300,"h":200},"ghost":{"w":610,"h":300}}}');
    expect(Object.keys(r.size)).toEqual(["a"]);
  });

  it("saveLayout normalizes duplicates and clamps, so equal layouts serialize equally", () => {
    expect(saveLayout({ order: ["a", "a"], size: { a: { w: 610, h: 300 } } }))
      .toBe(saveLayout({ order: ["a"], size: { a: { w: 610, h: 300 } } }));
    expect(saveLayout({ order: ["a"], size: { a: { w: 99999, h: 1 } } }))
      .toBe(JSON.stringify({ order: ["a"], size: { a: { w: CARD_MAX_W, h: CARD_MIN_H } } }));
  });

  // P-FLEET.L12 MIGRATION: a layout written by the SPAN build must be converted, not discarded. Dropping
  // it would silently reset every card the user had already sized, which is the same class of loss as the
  // unmeasurable-panel clamp above.
  it("migrates a legacy `cols` span to pixels, gaps included, preserving height", () => {
    const r = loadLayout('{"order":["a","b","c"],"size":{"a":{"cols":2,"h":320},"b":{"cols":1,"h":150},"c":{"cols":3,"h":400}}}');
    expect(r.size.a).toEqual({ w: 2 * CARD_COL_W + CARD_GAP, h: 320 });      // 610
    expect(r.size.b).toEqual({ w: CARD_COL_W, h: 150 });                     // 300, no gap for one track
    expect(r.size.c).toEqual({ w: 3 * CARD_COL_W + 2 * CARD_GAP, h: 400 });  // 920
  });

  it("prefers an explicit `w` over a stale `cols` when a payload somehow carries both", () => {
    const r = loadLayout('{"order":["a"],"size":{"a":{"w":480,"cols":6,"h":300}}}');
    expect(r.size.a).toEqual({ w: 480, h: 300 });
  });

  it("a legacy entry with an unreadable span is still DROPPED, not invented", () => {
    const r = loadLayout('{"order":["a"],"size":{"a":{"cols":"wide","h":300}}}');
    expect(r.size.a).toBeUndefined();
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
