// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/orbit_layout_cycle.test.ts - P-FLEET.L17: the Ctrl/Cmd+Alt+Arrow spoke cycle. The
// contract a hotkey user feels: fleet order, wrap-around, entry point from Main, and never landing on
// a lane the attach would refuse (promoteRefusal is the single authority the cycle defers to).

import { describe, expect, test } from "bun:test";
import { cycleSpoke } from "./orbit_layout.ts";
import type { LaneStatus } from "./bridge.ts";

const lane = (id: string, status: LaneStatus) => ({ id, status });
const fleet = [
  lane("a", "working"),
  lane("b", "needs-approval"), // refusal state - skipped
  lane("c", "awaiting-input"),
  lane("d", "error"), // refusal state - skipped
  lane("e", "done"),
];

describe("cycleSpoke", () => {
  test("walks promotable lanes in fleet order and wraps", () => {
    expect(cycleSpoke(fleet, "a", 1)).toBe("c");
    expect(cycleSpoke(fleet, "c", 1)).toBe("e");
    expect(cycleSpoke(fleet, "e", 1)).toBe("a"); // wrap
    expect(cycleSpoke(fleet, "a", -1)).toBe("e"); // wrap backward
  });
  test("from Main it enters at the first promotable spoke going right, the last going left", () => {
    expect(cycleSpoke(fleet, null, 1)).toBe("a");
    expect(cycleSpoke(fleet, null, -1)).toBe("e");
  });
  test("never lands on a lane the attach would refuse", () => {
    expect(cycleSpoke(fleet, "a", 1)).not.toBe("b");
    expect(cycleSpoke([lane("x", "stopped"), lane("y", "starting")], null, 1)).toBeNull();
  });
  test("a current lane that just became unpromotable still cycles from the top", () => {
    expect(cycleSpoke(fleet, "b", 1)).toBe("a"); // current not in the promotable list -> entry rule
  });
  test("an empty fleet cycles nowhere", () => {
    expect(cycleSpoke([], null, 1)).toBeNull();
  });
});
