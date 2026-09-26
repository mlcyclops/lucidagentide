// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/scroll_jump.test.ts - the shared catch-up math. These exist because a NaN scroll
// target is INVISIBLE: assigning it to scrollTop silently does nothing, so the button just reads as
// broken with no error anywhere.

import { describe, expect, test } from "bun:test";
import {
  JUMP_SHOW_PX, LANE_JUMP_SHOW_PX, belowFold, pageDownTarget, pageStep, shouldShowJump,
} from "./scroll_jump.ts";

const m = (scrollHeight: number, scrollTop: number, clientHeight: number) => ({ scrollHeight, scrollTop, clientHeight });

describe("belowFold", () => {
  test("measures the content under the fold", () => {
    expect(belowFold(m(1000, 0, 400))).toBe(600);
    expect(belowFold(m(1000, 600, 400))).toBe(0);
  });

  test("never negative: an over-scrolled or mid-layout element must not read as 'lots left'", () => {
    expect(belowFold(m(1000, 900, 400))).toBe(0);
    expect(belowFold(m(0, 0, 0))).toBe(0);
  });

  test("unusable metrics collapse to 0 rather than NaN", () => {
    expect(belowFold(m(Number.NaN, 0, 400))).toBe(0);
    expect(belowFold(m(1000, Number.NaN, 400))).toBe(1000 - 0 - 400);
    expect(belowFold(undefined as unknown as { scrollHeight: number; scrollTop: number; clientHeight: number })).toBe(0);
  });
});

describe("shouldShowJump", () => {
  test("hides until there is more than a threshold below the fold", () => {
    expect(shouldShowJump(m(1000, 0, 900))).toBe(false);          // 100 below, under 140
    expect(shouldShowJump(m(1000, 0, 800))).toBe(true);           // 200 below
    expect(shouldShowJump(m(1000, 0, 1000 - JUMP_SHOW_PX))).toBe(false); // exactly at the line is not over it
  });

  test("a lane transcript uses its own smaller threshold, or the buttons would never appear", () => {
    // A 180px-tall lane scroller with 100px below the fold: invisible under the chat threshold, correct
    // under the lane one. This is the whole reason the second constant exists.
    expect(shouldShowJump(m(280, 0, 180))).toBe(false);
    expect(shouldShowJump(m(280, 0, 180), LANE_JUMP_SHOW_PX)).toBe(true);
    expect(LANE_JUMP_SHOW_PX).toBeLessThan(JUMP_SHOW_PX);
  });

  test("a garbage threshold falls back rather than showing always or never", () => {
    expect(shouldShowJump(m(1000, 0, 800), Number.NaN)).toBe(true);
    expect(shouldShowJump(m(1000, 0, 900), Number.NaN)).toBe(false);
    expect(shouldShowJump(m(1000, 0, 800), -50)).toBe(true); // a negative threshold clamps to 0
  });
});

describe("pageStep", () => {
  test("one viewport minus a line of overlap, so the reader resumes on a line already read", () => {
    expect(pageStep(400, 28)).toBe(400 - 28 - 8);
  });

  test("floors in a short scroller, which is exactly the lane case", () => {
    // 180px lane, 18px line: 154 is fine. But a 60px scroller would yield 24, too small to be useful.
    expect(pageStep(180, 18)).toBe(180 - 18 - 8);
    expect(pageStep(60, 18)).toBe(80);
  });

  test("an unloaded font (NaN line height) still yields a usable step, never NaN", () => {
    const s = pageStep(400, Number.NaN);
    expect(Number.isNaN(s)).toBe(false);
    expect(s).toBe(400 - 0 - 8);
    expect(pageStep(Number.NaN, Number.NaN)).toBe(80);
  });
});

describe("pageDownTarget", () => {
  test("advances a page and clamps to the bottom so a smooth scroll cannot overshoot", () => {
    expect(pageDownTarget(m(2000, 0, 400), 28)).toBe(364);
    expect(pageDownTarget(m(500, 400, 400), 28)).toBe(500); // clamped, no rubber-band spring-back
  });

  test("never returns NaN, whatever the scroller reports mid-layout", () => {
    for (const t of [pageDownTarget(m(Number.NaN, Number.NaN, Number.NaN), Number.NaN), pageDownTarget(m(0, 0, 0), 0)]) {
      expect(Number.isNaN(t)).toBe(false);
    }
  });
});
