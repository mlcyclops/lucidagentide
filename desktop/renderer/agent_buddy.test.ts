// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/agent_buddy.test.ts - P-BUDDY.1 (ADR-0667): the pure parts of the floating Agent buddies: the
// canvas geometry (clamp, fractions, the default spot on the composer's corner), the stored spots and settings
// (tolerant of garbage), when ideas are fetched on their own or again, the drift phase and the Ask Lucid framing.

import { describe, expect, it } from "bun:test";
import {
  askFraming, AUTO_GAP_MS, buddyTip, clampToCanvas, defaultSpot, GLOW_S, glowDelay, fromFraction, ideaCount, isStale, loadPositions,
  readBuddySettings, saveBuddySettings, savePositions, shouldAutoSuggest, STALE_MS, toFraction,
} from "./agent_buddy.ts";

const size = { w: 32, h: 24 };
const canvas = { w: 800, h: 600 };

describe("clampToCanvas", () => {
  it("keeps a point inside unchanged", () => {
    expect(clampToCanvas({ x: 100, y: 200 }, size, canvas)).toEqual({ x: 100, y: 200 });
  });
  it("pulls the box back inside every edge, margin included", () => {
    expect(clampToCanvas({ x: -50, y: -9 }, size, canvas)).toEqual({ x: 2, y: 2 });
    expect(clampToCanvas({ x: 5000, y: 5000 }, size, canvas)).toEqual({ x: 800 - 32 - 2, y: 600 - 24 - 2 });
    expect(clampToCanvas({ x: 5000, y: 5000 }, size, canvas, 0)).toEqual({ x: 768, y: 576 });
  });
  it("pins to the margin when the canvas is smaller than the buddy", () => {
    expect(clampToCanvas({ x: 40, y: 40 }, size, { w: 10, h: 10 })).toEqual({ x: 2, y: 2 });
  });
  it("treats non-numbers as 0", () => {
    expect(clampToCanvas({ x: Number.NaN, y: Number.POSITIVE_INFINITY }, size, canvas)).toEqual({ x: 2, y: 2 });
  });
});

describe("toFraction / fromFraction", () => {
  it("round-trips a position on the same canvas", () => {
    const f = toFraction({ x: 384, y: 288 }, size, canvas);
    expect(f).toEqual({ fx: 384 / 768, fy: 288 / 576 });
    expect(fromFraction(f, size, canvas)).toEqual({ x: 384, y: 288 });
  });
  it("lands in the same relative place after a resize", () => {
    const f = toFraction({ x: 768, y: 0 }, size, canvas);
    expect(f).toEqual({ fx: 1, fy: 0 });
    expect(fromFraction(f, size, { w: 400, h: 300 })).toEqual({ x: 400 - 32 - 2, y: 2 });
  });
  it("clamps fractions to 0..1", () => {
    expect(toFraction({ x: -100, y: 9999 }, size, canvas)).toEqual({ fx: 0, fy: 1 });
    expect(fromFraction({ fx: 7, fy: -3 }, size, canvas)).toEqual({ x: 766, y: 2 });
  });
  it("survives a canvas no bigger than the buddy", () => {
    expect(toFraction({ x: 10, y: 10 }, size, { w: 32, h: 24 })).toEqual({ fx: 1, fy: 1 });
    expect(fromFraction({ fx: 0.5, fy: 0.5 }, size, { w: 20, h: 20 })).toEqual({ x: 2, y: 2 });
  });
});

describe("defaultSpot", () => {
  const canvasRect = { left: 100, top: 50, width: 800, height: 600 };
  it("sits just above the composer's top-left edge, a little in from its left", () => {
    const anchor = { left: 100, top: 550, width: 800, height: 100 };
    expect(defaultSpot(anchor, canvasRect, size)).toEqual({ x: 6, y: 500 - 24 - 2 });
  });
  it("stays on the canvas when the composer is at its very top", () => {
    const anchor = { left: 100, top: 50, width: 300, height: 60 };
    expect(defaultSpot(anchor, canvasRect, size)).toEqual({ x: 6, y: 2 });
  });
  it("converts client px to canvas px under a zoom", () => {
    const zoomed = { left: 0, top: 0, width: 1600, height: 1200 };
    const anchor = { left: 200, top: 1000, width: 1000, height: 100 };
    expect(defaultSpot(anchor, zoomed, size, 2)).toEqual({ x: 106, y: 500 - 26 });
  });
});

describe("loadPositions / savePositions", () => {
  it("round-trips fractions and offsets", () => {
    const spots = { main: { fx: 0.25, fy: 0.75 }, "lane:c:/w/app": { fx: 0, fy: 1 }, "world:c:/w/app": { dx: -12, dy: 30 } };
    expect(loadPositions(savePositions(spots))).toEqual(spots);
  });
  it("is empty for garbage", () => {
    for (const raw of [null, undefined, "", "{", "null", "42", "[]", '{"spots":[]}', '{"spots":"x"}', '{"v":1}']) expect(loadPositions(raw)).toEqual({});
  });
  it("drops malformed entries and clamps fractions", () => {
    const raw = JSON.stringify({ v: 1, spots: { a: { fx: 2, fy: -1 }, b: { fx: "1", fy: 0 }, c: null, d: { dx: 3 }, e: { dx: 1, dy: 2 }, "": { fx: 0, fy: 0 } } });
    expect(loadPositions(raw)).toEqual({ a: { fx: 1, fy: 0 }, e: { dx: 1, dy: 2 } });
  });
});

describe("readBuddySettings", () => {
  it("defaults both on", () => {
    for (const raw of [null, "", "nope", "[]", "{}", '{"show":"no"}']) expect(readBuddySettings(raw)).toEqual({ show: true, auto: true });
  });
  it("turns off only on an explicit false, and round-trips", () => {
    expect(readBuddySettings('{"show":false}')).toEqual({ show: false, auto: true });
    expect(readBuddySettings(saveBuddySettings({ show: true, auto: false }))).toEqual({ show: true, auto: false });
  });
});

describe("shouldAutoSuggest", () => {
  const now = 10_000_000;
  it("fetches after a new turn once the gap passed, visible and enabled", () => {
    expect(shouldAutoSuggest(now - AUTO_GAP_MS, now, 3, 4, true, true)).toBe(true);
    expect(shouldAutoSuggest(0, now, 0, 1, true, true)).toBe(true);
  });
  it("waits out the gap", () => {
    expect(shouldAutoSuggest(now - AUTO_GAP_MS + 1, now, 3, 4, true, true)).toBe(false);
  });
  it("needs a turn the ideas have not seen", () => {
    expect(shouldAutoSuggest(0, now, 4, 4, true, true)).toBe(false);
  });
  it("never runs hidden or switched off", () => {
    expect(shouldAutoSuggest(0, now, 3, 4, false, true)).toBe(false);
    expect(shouldAutoSuggest(0, now, 3, 4, true, false)).toBe(false);
  });
});

describe("isStale", () => {
  const now = 5_000_000;
  it("is stale with no fetch, after STALE_MS, or after a turn", () => {
    expect(isStale(0, now, 0, 0)).toBe(true);
    expect(isStale(now - STALE_MS - 1, now, 2, 2)).toBe(true);
    expect(isStale(now - 1000, now, 2, 3)).toBe(true);
  });
  it("is fresh within STALE_MS on the same turn", () => {
    expect(isStale(now - STALE_MS, now, 2, 2)).toBe(false);
  });
});

describe("glowDelay", () => {
  it("is a stable negative phase within one breath", () => {
    for (const k of ["main", "lane:a", "world:b", ""]) {
      const v = glowDelay(k);
      expect(v).toBeLessThanOrEqual(0);
      expect(v).toBeGreaterThan(-GLOW_S);
      expect(glowDelay(k)).toBe(v);
    }
    expect(glowDelay("lane:a")).not.toBe(glowDelay("lane:b"));
  });
});

describe("buddyTip", () => {
  const reply = (n: number, withheld = false) => ({ ok: true, doing: "x", withheld, ideas: Array.from({ length: n }, (_, i) => ({ id: `i${i + 1}`, title: "t", prompt: "p" })) });
  it("says what the agent is doing, then whether ideas are waiting and what a click does", () => {
    expect(buddyTip("Typing · Main composer", { reply: reply(2), loading: null })).toBe("Typing · Main composer. 2 ideas ready: click to see them. Drag to move it, double-click to put it back.");
    expect(buddyTip("Meditating · idle", { reply: reply(1), loading: null })).toContain("1 idea ready: click to see it.");
  });
  it("never promises ideas it does not have", () => {
    for (const s of [{ reply: null, loading: null }, { reply: reply(0), loading: null }, { reply: reply(3, true), loading: null }]) {
      expect(buddyTip("Meditating · idle", s)).toContain("they only appear when one would help");
    }
    expect(buddyTip("Meditating · idle", { reply: reply(2), loading: Promise.resolve() })).toContain("Looking for ideas...");
  });
});

describe("ideaCount / askFraming", () => {
  it("counts in words", () => {
    expect(ideaCount(1)).toBe("1 idea");
    expect(ideaCount(2)).toBe("2 ideas");
  });
  it("names the agent, the folder, the idea's title and prompt", () => {
    const t = askFraming("api", "C:/work/api", { title: "Add retries", prompt: "Wrap the fetch in a retry with backoff." });
    expect(t).toContain("api (working in C:/work/api)");
    expect(t).toContain("Add retries");
    expect(t).toContain("Wrap the fetch in a retry with backoff.");
    expect(t).not.toContain("\u2014");
  });
});
