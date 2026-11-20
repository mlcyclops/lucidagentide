// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_director.test.ts - P-VIZ.2 (ADR-0623): the auto camera's director. It looks where the
// action is most, never flicks between two busy nodes, lets a kill or a tool failure grab it briefly, goes
// back to the overview when everything is quiet, and its spring settles without overshoot.

import { describe, expect, test } from "bun:test";
import {
  angleDelta, createDirector, cue, directorStep, frameDistance, GRAB_MIN_MS, GRAB_MS, HOLD_MS, springStep, type DirectorNode,
} from "./viz_director.ts";

const T0 = 1_000_000;
const n = (id: string, activity: number): DirectorNode => ({ id, activity });

describe("focus", () => {
  test("the busiest node takes the focus; nothing happening means the overview", () => {
    expect(directorStep(createDirector(T0), [n("main", 0.1), n("a", 0.8), n("b", 0.3)], T0)).toBe("a");
    expect(directorStep(createDirector(T0), [n("main", 0), n("a", 0.01)], T0)).toBeNull();
  });

  test("ties are stable: the current focus keeps a tie, else the earlier node in order", () => {
    const d = createDirector(T0);
    expect(directorStep(d, [n("a", 0.5), n("b", 0.5)], T0)).toBe("a");
    expect(directorStep(d, [n("b", 0.5), n("a", 0.5)], T0 + HOLD_MS * 3)).toBe("a");
    expect(directorStep(createDirector(T0), [n("b", 0.5), n("a", 0.5)], T0)).toBe("b");
  });

  test("hysteresis: a small lead never switches, a clear lead switches only after the hold", () => {
    const d = createDirector(T0);
    expect(directorStep(d, [n("a", 0.5), n("b", 0.3)], T0)).toBe("a");
    expect(directorStep(d, [n("a", 0.5), n("b", 0.6)], T0 + HOLD_MS + 1000)).toBe("a"); // leads, but not clearly
    const d2 = createDirector(T0);
    directorStep(d2, [n("a", 0.5), n("b", 0.1)], T0);
    expect(directorStep(d2, [n("a", 0.5), n("b", 1)], T0 + 1000)).toBe("a"); // clear lead, hold not over
    expect(directorStep(d2, [n("a", 0.5), n("b", 1)], T0 + 2500)).toBe("a");
    expect(directorStep(d2, [n("a", 0.5), n("b", 1)], T0 + HOLD_MS)).toBe("b");
  });

  test("a kill grabs the focus at once, holds it briefly, then the busy node wins it back", () => {
    const d = createDirector(T0);
    expect(directorStep(d, [n("a", 0.9), n("b", 0)], T0)).toBe("a");
    cue(d, "b", "killed", T0 + 500);
    expect(directorStep(d, [n("a", 0.9), n("b", 0)], T0 + 600)).toBe("b");
    expect(directorStep(d, [n("a", 0.9), n("b", 0)], T0 + 500 + GRAB_MS - 10)).toBe("b");
    expect(directorStep(d, [n("a", 0.9), n("b", 0)], T0 + 500 + GRAB_MS + 10)).toBe("b"); // the hold from the grab still runs
    expect(directorStep(d, [n("a", 0.9), n("b", 0)], T0 + 500 + HOLD_MS + 100)).toBe("a");
  });

  test("a second grab inside GRAB_MIN_MS is ignored; after it, it takes over", () => {
    const d = createDirector(T0);
    directorStep(d, [n("a", 0.9), n("b", 0), n("c", 0)], T0);
    cue(d, "b", "killed", T0 + 100);
    cue(d, "c", "tool-failed", T0 + 100 + GRAB_MIN_MS - 100);
    expect(directorStep(d, [n("a", 0.9), n("b", 0), n("c", 0)], T0 + 100 + GRAB_MIN_MS - 50)).toBe("b");
    cue(d, "c", "tool-failed", T0 + 100 + GRAB_MIN_MS + 100);
    expect(directorStep(d, [n("a", 0.9), n("b", 0), n("c", 0)], T0 + 100 + GRAB_MIN_MS + 150)).toBe("c");
  });

  test("a surge on a quiet scene draws the camera, and its heat fades back to the overview", () => {
    const d = createDirector(T0);
    const quiet = [n("main", 0), n("a", 0), n("b", 0)];
    expect(directorStep(d, quiet, T0)).toBeNull();
    cue(d, "b", "surge", T0 + 100);
    expect(directorStep(d, quiet, T0 + 200)).toBe("b");
    let t = T0 + 200;
    while (t < T0 + 5000) { t += 250; directorStep(d, quiet, t); }
    expect(d.focus).toBe("b");
    while (t < T0 + 20_000) { t += 250; directorStep(d, quiet, t); }
    expect(d.focus).toBeNull();
  });

  test("a focused node that leaves is replaced at once", () => {
    const d = createDirector(T0);
    expect(directorStep(d, [n("a", 0.9), n("b", 0.4)], T0)).toBe("a");
    expect(directorStep(d, [n("b", 0.4)], T0 + 100)).toBe("b");
  });
});

describe("camera math", () => {
  test("the spring settles without overshoot and is frame-rate independent", () => {
    let x = 0, v = 0, peak = 0;
    for (let i = 0; i < 180; i++) { [x, v] = springStep(x, v, 1, 4, 1 / 60); peak = Math.max(peak, x); }
    expect(peak).toBeLessThanOrEqual(1);
    expect(x).toBeGreaterThan(0.99);
    const [big] = springStep(0, 0, 1, 4, 0.1);
    let s: [number, number] = [0, 0];
    for (let i = 0; i < 10; i++) s = springStep(s[0], s[1], 1, 4, 0.01);
    expect(s[0]).toBeCloseTo(big, 6);
  });

  test("frameDistance puts the object at the asked share of the view height", () => {
    expect(frameDistance(1, 90, 0.5)).toBeCloseTo(1, 6);
    const d = frameDistance(1.5, 45, 0.45);
    expect(1.5 / (2 * d * Math.tan((45 * Math.PI) / 360))).toBeCloseTo(0.45, 6);
  });

  test("angleDelta takes the short way around", () => {
    expect(angleDelta(3, -3)).toBeCloseTo(2 * Math.PI - 6, 6);
    expect(angleDelta(-3, 3)).toBeCloseTo(6 - 2 * Math.PI, 6);
    expect(angleDelta(0.2, 0.5)).toBeCloseTo(0.3, 6);
  });
});
