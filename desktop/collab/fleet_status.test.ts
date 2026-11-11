// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/fleet_status.test.ts - P-PWA-FLEET.2: the shared lane roll-up.
//
// This module exists so the desktop's minimized dock pill and the phone's collapsed fleet bar cannot drift
// apart, which makes the ORDER and the ATTENTION rule the load-bearing properties here: a lane blocked on a
// human must sort first and must be the only thing that earns the alarm, on both surfaces, forever.
//
// The other property worth pinning is that an unrecognized status is never dropped. A newer host reporting a
// state this build has no copy for must still be COUNTED (silently undercounting work in flight is the worst
// failure this roll-up can have) while never being promoted to attention, because a state we cannot reason
// about must not light the alarm.

import { describe, expect, it } from "bun:test";
import { LANE_STATUS_ORDER, LANE_STATUS_WORDS, displayStatus, laneRollup, newlyStuck } from "./fleet_status.ts";

const lane = (status: string, name: string) => ({ id: `id-${name}`, status, name });

describe("fleet_status: laneRollup", () => {
  it("sorts attention first, then running, then settled - whatever order the host sent", () => {
    const roll = laneRollup([
      lane("stopped", "e"),
      lane("done", "d"),
      lane("working", "c"),
      lane("awaiting-input", "b"),
      lane("needs-approval", "a"),
    ]);
    expect(roll.counts.map((c) => c.status)).toEqual(["needs-approval", "awaiting-input", "working", "done", "stopped"]);
    expect(roll.summary).toBe("1 need approval, 1 waiting on you, 1 working, 1 done, 1 stopped");
  });

  it("counts lanes per state and names them in snapshot order", () => {
    const roll = laneRollup([lane("working", "api"), lane("done", "docs"), lane("working", "web")]);
    expect(roll.counts).toEqual([
      { status: "working", count: 2, names: ["api", "web"], attention: false },
      { status: "done", count: 1, names: ["docs"], attention: false },
    ]);
    expect(roll.lines).toEqual(["2 working: api, web", "1 done: docs"]);
  });

  it("flags attention for EXACTLY the three states only a human can move, and busy for the three that run", () => {
    for (const status of LANE_STATUS_ORDER) {
      const roll = laneRollup([lane(status, "x")]);
      expect(roll.attention).toBe(status === "needs-approval" || status === "awaiting-input" || status === "likely-stuck");
      expect(roll.busy).toBe(status === "working" || status === "starting" || status === "likely-stuck");
      expect(roll.counts[0]?.attention).toBe(roll.attention);
    }
  });

  it("attention survives a snapshot where most lanes are calm", () => {
    const roll = laneRollup([lane("done", "a"), lane("stopped", "b"), lane("needs-approval", "c")]);
    expect(roll.attention).toBe(true);
    expect(roll.busy).toBe(false);
    expect(roll.counts[0]?.status).toBe("needs-approval"); // and it leads the phrase
  });

  it("COUNTS an unknown status instead of dropping it, sorts it last, and never calls it attention", () => {
    const roll = laneRollup([lane("hibernating", "z"), lane("working", "a")]);
    expect(roll.counts.map((c) => c.status)).toEqual(["working", "hibernating"]);
    expect(roll.counts.find((c) => c.status === "hibernating")).toEqual({ status: "hibernating", count: 1, names: ["z"], attention: false });
    expect(roll.attention).toBe(false); // a state we cannot reason about must not light the alarm
    expect(roll.summary).toBe("1 working, 1 hibernating"); // raw status stands in for missing wording
  });

  it("falls back to the id, then the status, when a lane has no name", () => {
    expect(laneRollup([{ id: "lane-7", status: "working" }]).lines).toEqual(["1 working: lane-7"]);
    expect(laneRollup([{ status: "working" }]).lines).toEqual(["1 working: working"]);
  });

  it("an empty snapshot yields an empty roll-up, with NO summary for the caller to word itself", () => {
    expect(laneRollup([])).toEqual({ counts: [], attention: false, busy: false, summary: "", lines: [] });
  });

  it("every ordered state has wording, so no roll-up can print a raw enum at a user", () => {
    for (const status of LANE_STATUS_ORDER) expect(LANE_STATUS_WORDS[status]).toBeTruthy();
  });
});

// P-STUCK-SHOW.1 (ADR-0556): a working spoke whose open call is marked likely stuck must never read as plain
// "working" on a roll-up, and the alert for it fires once per stall.
const live = (id: string, status: string, state?: string) => ({ id, name: id, status, progress: state ? { liveness: { state } } : undefined });

describe("fleet_status: likely stuck", () => {
  it("a working lane marked stuck shows as likely stuck and sorts ahead of working lanes", () => {
    const lanes = [live("a", "working", "working"), live("b", "working", "stuck")];
    expect(lanes.map(displayStatus)).toEqual(["working", "likely-stuck"]);
    const roll = laneRollup(lanes.map((l) => ({ ...l, status: displayStatus(l) })));
    expect(roll.summary).toBe("1 likely stuck, 1 working");
    expect(roll.attention).toBe(true);
  });

  it("only a WORKING lane can be likely stuck: a stale stuck verdict on a finished or dead lane does not paint it", () => {
    expect(displayStatus(live("a", "awaiting-input", "stuck"))).toBe("awaiting-input");
    expect(displayStatus(live("b", "error", "stuck"))).toBe("error");
    expect(displayStatus(live("c", "working"))).toBe("working");
  });

  it("alerts once per stall: a lane still stuck is not fresh, a lane that recovered and stalls again is", () => {
    const first = newlyStuck(new Set(), [live("a", "working", "stuck"), live("b", "working", "working")]);
    expect(first.fresh.map((l) => l.id)).toEqual(["a"]);
    const still = newlyStuck(first.now, [live("a", "working", "stuck")]);
    expect(still.fresh).toEqual([]);
    const moved = newlyStuck(still.now, [live("a", "working", "working")]);
    expect(moved.now.size).toBe(0);
    expect(newlyStuck(moved.now, [live("a", "working", "stuck")]).fresh.map((l) => l.id)).toEqual(["a"]);
  });
});
