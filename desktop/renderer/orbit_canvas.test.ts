// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/orbit_canvas.test.ts - P-ORBIT-CANVAS.1 (ADR-0522): the spoke layer's resource contract.
// The canvas exists to stop the map from repainting at display rate; these pin when it may draw at all.

import { describe, expect, test } from "bun:test";
import type { LaneStatus } from "./bridge.ts";
import { FLOW_TICK_MS, frameDelay, RING_TICK_MS, spokeStyle, type OrbitScene } from "./orbit_canvas.ts";

const spoke = (status: LaneStatus) => ({ x: 100, y: 0, status, promoted: false });
const ring = { rx: 300, ry: 200 };
const scene = (statuses: LaneStatus[], rings = 1): OrbitScene => ({ spokes: statuses.map(spoke), rings: Array(rings).fill(ring) });

describe("frameDelay", () => {
  test("a moving spoke ticks at the flow rate, below display rate", () => {
    for (const s of ["working", "starting", "awaiting-input", "needs-approval"] as const) {
      expect(frameDelay(scene(["done", s]), "motion", false)).toBe(FLOW_TICK_MS);
    }
    expect(FLOW_TICK_MS).toBeGreaterThan(1000 / 60);
  });
  test("still spokes leave only the ring drift, on the slow tick; no rings and nothing moving parks", () => {
    expect(frameDelay(scene(["done", "error", "stopped"]), "motion", false)).toBe(RING_TICK_MS);
    expect(frameDelay(scene(["done"], 0), "motion", false)).toBeNull();
    expect(frameDelay(scene([], 0), "motion", false)).toBeNull();
  });
  test("Lite and reduced motion never schedule a frame, however busy the fleet", () => {
    const busy = scene(["working", "needs-approval", "starting"]);
    expect(frameDelay(busy, "static", false)).toBeNull();
    expect(frameDelay(busy, "motion", true)).toBeNull();
  });
});

describe("spokeStyle", () => {
  test("Lite drops motion and every dash except starting's, so starting still reads apart from stopped", () => {
    expect(spokeStyle("working", "static", false)).toMatchObject({ dash: [], motion: { kind: "none" } });
    expect(spokeStyle("error", "static", false).dash).toEqual([]);
    expect(spokeStyle("starting", "static", false)).toMatchObject({ dash: [2, 6], motion: { kind: "none" } });
  });
  test("reduced motion in motion mode keeps the dashes and stops them", () => {
    expect(spokeStyle("working", "motion", true)).toMatchObject({ dash: [7, 9], motion: { kind: "none" } });
    expect(spokeStyle("working", "motion", false).motion.kind).toBe("flow");
    expect(spokeStyle("needs-approval", "motion", false).motion.kind).toBe("pulse");
  });
});
