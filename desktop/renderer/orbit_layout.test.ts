// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/orbit_layout.test.ts - P-FLEET.L17: the orbit geometry and the switch-menu model,
// proven headless. The invariants that matter to a user: every lane gets a seat, seats never collide
// at readable fleet sizes, the layout is deterministic (a lane must not hop seats between polls), and
// the glance wording names the USER's next move in the two states that block on a human.

import { describe, expect, test } from "bun:test";
import { ORBIT_NODE_W, hubEntries, hubLanes, orbitSlots, spokeClose, spokeGlance, switchEntries } from "./orbit_layout.ts";

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

  test("every slot lies on its ring's ellipse, and a ring at 12 o'clock is never a zero-width line (#575)", () => {
    for (const n of [1, 2, 5, 8, 14, 30]) {
      for (const s of orbitSlots(n, W, H)) {
        expect(s.ringRx).toBeGreaterThan(100);
        expect(s.ringRy).toBeGreaterThan(100);
        expect((s.x / s.ringRx) ** 2 + (s.y / s.ringRy) ** 2).toBeCloseTo(1, 9);
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
    expect(spokeGlance(lane("needs-approval"), false)).toBe("needs your approval");
    expect(spokeGlance(lane("awaiting-input"), false)).toBe("ready for your prompt");
  });
  test("working shows the turn IN FLIGHT, not the settled count", () => {
    expect(spokeGlance(lane("working", 2), false)).toBe("working \u00b7 turn 3");
  });
  test("a staged queue is visible from orbit", () => {
    expect(spokeGlance(lane("awaiting-input", 2, 2), false)).toBe("ready for your prompt \u00b7 2 queued");
  });
  test("error tells the user the way back", () => {
    expect(spokeGlance(lane("error"), false)).toContain("respawn");
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

// P-PROGRESS.1: a spoke in line for its folder names whom it waits for; a running spoke with history shows
// its estimated percent, labeled as an estimate, and every older glance string is unchanged.
describe("spokeGlance (P-PROGRESS.1)", () => {
  test("waiting names the holder; a percent rides only a working spoke", () => {
    const base = { turns: 2, queued: [] as unknown[] };
    expect(spokeGlance({ ...base, status: "working", waiting: { on: { name: "alpha" } } }, true)).toBe("waiting for alpha");
    expect(spokeGlance({ ...base, status: "working", progress: { estimate: { percent: 40 } } }, true)).toBe("working \u00b7 turn 3 \u00b7 40% (est.)");
    // P-PROGRESS.3: the estimate is opt-in; with it off no percent reaches the glance.
    expect(spokeGlance({ ...base, status: "working", progress: { estimate: { percent: 40 } } }, false)).toBe("working \u00b7 turn 3");
    expect(spokeGlance({ ...base, status: "working", progress: { estimate: { percent: null } } }, true)).toBe("working \u00b7 turn 3");
    expect(spokeGlance({ ...base, status: "done", progress: { estimate: { percent: 40 } } }, true)).toBe("done \u00b7 2 turns");
  });

  // P-STUCK-SHOW.1 (ADR-0519): the orbit never says plain "working" over a call the evidence doubts.
  test("a likely-stuck call names itself and the way out; a call gone flat says it might be stuck", () => {
    const base = { turns: 2, queued: [] as unknown[] };
    const stuck = { estimate: { percent: 40 }, liveness: { state: "stuck", label: "likely stuck: no activity for 13 m", flatMs: 780_000 } };
    expect(spokeGlance({ ...base, status: "working", progress: stuck }, true)).toBe("likely stuck \u00b7 quiet 13 m");
    const flat = { estimate: { percent: null }, liveness: { state: "working", label: "might be stuck: no activity for 7 m \u00b7 waiting on task for 9 m", flatMs: 420_000 } };
    expect(spokeGlance({ ...base, status: "working", progress: flat }, false)).toBe("might be stuck \u00b7 quiet 7 m");
    // An open call that is merely waiting (no flat evidence yet) keeps the ordinary glance.
    const waiting = { estimate: { percent: null }, liveness: { state: "working", label: "waiting on bash for 40 s" } };
    expect(spokeGlance({ ...base, status: "working", progress: waiting }, false)).toBe("working \u00b7 turn 3");
    // A settled lane never inherits a stale stuck verdict.
    expect(spokeGlance({ ...base, status: "awaiting-input", progress: stuck }, false)).toBe("ready for your prompt");
  });
});

// P-SWITCH.3 (ADR-0410): a new session is a new hub; the previous session keeps its spokes.
describe("hubLanes / hubEntries", () => {
  const lanes = [
    { id: "a", name: "api", status: "working" as const, cwd: "C:\\code\\shop", hubSessionId: "s1", lastActivityAt: 10 },
    { id: "b", name: "docs", status: "needs-approval" as const, cwd: "C:\\code\\shop", hubSessionId: "s1", lastActivityAt: 50 },
    { id: "c", name: "tests", status: "awaiting-input" as const, cwd: "/srv/blog", hubSessionId: "s2", lastActivityAt: 30 },
    { id: "d", name: "old", status: "done" as const, cwd: "/srv/blog", hubSessionId: null, lastActivityAt: 5 },
  ];
  test("a fresh session's orbit shows none of the previous session's spokes", () => {
    expect(hubLanes(lanes, "s3").map((l) => l.id)).toEqual(["d"]); // only the hubless legacy spoke rides along
  });
  test("each hub shows exactly its own spokes, and hubless spokes ride the current hub", () => {
    expect(hubLanes(lanes, "s1").map((l) => l.id)).toEqual(["a", "b", "d"]);
    expect(hubLanes(lanes, "s2").map((l) => l.id)).toEqual(["c", "d"]);
    expect(hubLanes(lanes, null).map((l) => l.id)).toEqual(["d"]);
  });
  // P-HUB-PICK.1 (ADR-0516): the Hubs menu lists every hub, the one on screen first.
  test("the current hub comes first, even empty; the other hubs follow by newest activity, counting who waits", () => {
    const hubs = hubEntries(lanes, "s3");
    expect(hubs.map((h) => [h.sessionId, h.current])).toEqual([["s3", true], ["s1", false], ["s2", false]]);
    expect(hubs[0]!.lanes.map((l) => l.id)).toEqual(["d"]); // the hubless spoke rides the current hub, as on the orbit
    expect(hubs[1]!.lanes.map((l) => l.id)).toEqual(["a", "b"]);
    expect(hubs.map((h) => h.waiting)).toEqual([0, 1, 1]);
    expect(hubEntries(lanes, "s1").map((h) => h.sessionId)).toEqual(["s1", "s2"]);
  });
  test("each hub names the distinct codebases its spokes work on", () => {
    const hubs = hubEntries(lanes, "s2");
    expect(hubs.find((h) => h.sessionId === "s1")!.repos.map((r) => r.name)).toEqual(["shop"]);
    expect(hubs.find((h) => h.sessionId === "s2")!.repos.map((r) => r.name)).toEqual(["blog"]); // c and hubless d share one
  });
  test("with no Main session, hubless spokes form no hub and nothing is current", () => {
    expect(hubEntries([lanes[3]!], null)).toEqual([]);
    expect(hubEntries(lanes, null).some((h) => h.current)).toBe(false);
  });
});
