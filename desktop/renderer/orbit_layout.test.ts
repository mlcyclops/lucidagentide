// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/orbit_layout.test.ts - P-FLEET.L17: the orbit geometry and the switch-menu model,
// proven headless. The invariants that matter to a user: every lane gets a seat, seats never collide
// at readable fleet sizes, the layout is deterministic (a lane must not hop seats between polls), and
// the glance wording names the USER's next move in the two states that block on a human.

import { describe, expect, test } from "bun:test";
import { ORBIT_NODE_W, hubLanes, orbitSlots, otherHubs, spokeClose, spokeGlance, switchEntries } from "./orbit_layout.ts";

const W = 1600, H = 900;

describe("orbitSlots", () => {
  test("zero lanes is an empty layout, one lane sits at 12 o'clock", () => {
    expect(orbitSlots(0, W, H)).toEqual([]);
    const [only] = orbitSlots(1, W, H);
    expect(only!.angle).toBe(-90);
    expect(Math.abs(only!.x)).toBeLessThan(1e-9);
    expect(only!.y).toBeLessThan(0);
  });

  test("every lane gets exactly one seat, deterministically", () => {
    for (const n of [1, 2, 5, 8, 13, 30, 60]) {
      const a = orbitSlots(n, W, H);
      expect(a.length).toBe(n);
      expect(orbitSlots(n, W, H)).toEqual(a); // same census, same seats - no seat-hopping between polls
    }
  });

  test("a small fleet stays on one wide ring; a big one nests instead of overlapping", () => {
    expect(orbitSlots(6, W, H).every((s) => s.ring === 0)).toBe(true);
    const big = orbitSlots(30, W, H);
    expect(new Set(big.map((s) => s.ring)).size).toBeGreaterThan(1);
  });

  test("no two seats collide at a readable fleet size", () => {
    const slots = orbitSlots(10, W, H);
    for (let i = 0; i < slots.length; i++) {
      for (let j = i + 1; j < slots.length; j++) {
        const d = Math.hypot(slots[i]!.x - slots[j]!.x, slots[i]!.y - slots[j]!.y);
        expect(d).toBeGreaterThanOrEqual(ORBIT_NODE_W * 0.8);
      }
    }
  });

  test("a tiny stage floors the radii instead of folding spokes onto the hub", () => {
    for (const s of orbitSlots(4, 240, 200)) {
      expect(Number.isFinite(s.x) && Number.isFinite(s.y)).toBe(true);
      expect(Math.hypot(s.x, s.y)).toBeGreaterThan(100); // never inside the hub disc
    }
  });
});

describe("spokeGlance", () => {
  const lane = (status: Parameters<typeof spokeGlance>[0]["status"], turns = 2, queued = 0) =>
    ({ status, turns, queued: new Array(queued).fill(0) });
  test("the two human-blocking states name the user's next move", () => {
    expect(spokeGlance(lane("needs-approval"))).toBe("needs your approval");
    expect(spokeGlance(lane("awaiting-input"))).toBe("ready for your prompt");
  });
  test("working shows the turn IN FLIGHT, not the settled count", () => {
    expect(spokeGlance(lane("working", 2))).toBe("working \u00b7 turn 3");
  });
  test("a staged queue is visible from orbit", () => {
    expect(spokeGlance(lane("awaiting-input", 2, 2))).toBe("ready for your prompt \u00b7 2 queued");
  });
  test("error tells the user the way back", () => {
    expect(spokeGlance(lane("error"))).toContain("respawn");
  });
});

describe("spokeClose", () => {
  test("only an already-stopped spoke dismisses; every live state stops first", () => {
    expect(spokeClose("stopped").act).toBe("dismiss");
    for (const s of ["starting", "working", "needs-approval", "awaiting-input", "done", "error"] as const) {
      expect(spokeClose(s).act).toBe("stop");
    }
  });
  test("the stop tip announces the second step, so dismissal is never a surprise", () => {
    expect(spokeClose("working").tip).toContain("Click again once stopped to dismiss");
  });
});

describe("switchEntries", () => {
  const lanes = [
    { id: "a", name: "api-refactor", status: "working" as const },
    { id: "b", name: "docs", status: "awaiting-input" as const },
  ];
  test("Main first, whole-fleet second, then every spoke by its user-given name", () => {
    const rows = switchEntries(lanes, "b");
    expect(rows[0]).toEqual({ kind: "master", label: "Main \u00b7 master session", current: false });
    expect(rows[1]!.kind).toBe("orbit");
    expect(rows.slice(2).map((r) => (r.kind === "lane" ? r.label : ""))).toEqual(["api-refactor", "docs"]);
  });
  test("exactly the current surface is marked, and Main is current when no lane is", () => {
    const onLane = switchEntries(lanes, "b");
    expect(onLane.filter((r) => "current" in r && r.current).map((r) => (r.kind === "lane" ? r.laneId : r.kind))).toEqual(["b"]);
    const onMaster = switchEntries(lanes, null);
    expect(onMaster[0]!.kind === "master" && onMaster[0]!.current).toBe(true);
  });
});

// P-PROGRESS.1: a spoke in line for its folder names whom it waits for, and only while it is working.
describe("spokeGlance (P-PROGRESS.1)", () => {
  test("waiting names the holder on a working spoke; a settled spoke says what it did", () => {
    const base = { turns: 2, queued: [] as unknown[] };
    expect(spokeGlance({ ...base, status: "working", waiting: { on: { name: "alpha" } } })).toBe("waiting for alpha");
    expect(spokeGlance({ ...base, status: "done", waiting: { on: { name: "alpha" } } })).toBe("done \u00b7 2 turns");
  });
});

// P-SWITCH.3 (ADR-0410): a new session is a new hub; the previous session keeps its spokes.
describe("hubLanes / otherHubs", () => {
  const lanes = [
    { id: "a", name: "api", status: "working" as const, hubSessionId: "s1", lastActivityAt: 10 },
    { id: "b", name: "docs", status: "needs-approval" as const, hubSessionId: "s1", lastActivityAt: 50 },
    { id: "c", name: "tests", status: "awaiting-input" as const, hubSessionId: "s2", lastActivityAt: 30 },
    { id: "d", name: "old", status: "done" as const, hubSessionId: null, lastActivityAt: 5 },
  ];
  test("a fresh session's orbit shows none of the previous session's spokes", () => {
    expect(hubLanes(lanes, "s3").map((l) => l.id)).toEqual(["d"]); // only the hubless legacy spoke rides along
  });
  test("each hub shows exactly its own spokes, and hubless spokes ride the current hub", () => {
    expect(hubLanes(lanes, "s1").map((l) => l.id)).toEqual(["a", "b", "d"]);
    expect(hubLanes(lanes, "s2").map((l) => l.id)).toEqual(["c", "d"]);
    expect(hubLanes(lanes, null).map((l) => l.id)).toEqual(["d"]);
  });
  test("the other hubs keep every live spoke, newest activity first, counting the ones that wait on a human", () => {
    const others = otherHubs(lanes, "s3");
    expect(others.map((h) => h.sessionId)).toEqual(["s1", "s2"]);
    expect(others[0]!.lanes.map((l) => l.id)).toEqual(["a", "b"]);
    expect(others[0]!.waiting).toBe(1);
    expect(others[1]!.waiting).toBe(1);
    expect(otherHubs(lanes, "s1").map((h) => h.sessionId)).toEqual(["s2"]); // the current hub is never "other"
  });
  test("hubless spokes never form a hub of their own", () => {
    expect(otherHubs([lanes[3]!], "s1")).toEqual([]);
  });
});
