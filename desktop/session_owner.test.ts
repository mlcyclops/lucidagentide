// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-SWITCH.2 (ADR-0404): one omp session, one owner. A plausible bug here puts one session in two omp
// processes (history interleaves), or hides that a session is running so a click loads it twice.

import { describe, expect, test } from "bun:test";
import { sessionLive, withLiveState, type OwnerLane } from "./session_owner.ts";

const lane = (id: string, sessionId: string | null, status: string): OwnerLane => ({ id, name: `n-${id}`, sessionId, status });
const idle = { sessionId: "M", busy: false };

describe("sessionLive", () => {
  test("a live spoke outranks Main for the same id", () => {
    expect(sessionLive("M", idle, [lane("L1", "M", "working")])).toEqual({ where: "spoke", laneId: "L1", name: "n-L1", status: "working" });
  });

  test("a stopped or crashed spoke no longer holds its session; Main or nobody does", () => {
    for (const status of ["stopped", "error"]) {
      expect(sessionLive("X", idle, [lane("L1", "X", status)])).toBeNull();
      expect(sessionLive("M", { sessionId: "M", busy: true }, [lane("L1", "M", status)])).toEqual({ where: "main", busy: true });
    }
  });

  test("a lane with no session yet holds nothing", () => {
    expect(sessionLive("X", idle, [lane("L1", null, "starting")])).toBeNull();
  });
});

describe("withLiveState", () => {
  test("stamps only live rows and keeps the rest byte-identical", () => {
    const rows = [{ id: "M", title: "a" }, { id: "S", title: "b" }, { id: "Z", title: "c" }];
    const out = withLiveState(rows, { sessionId: "M", busy: true }, [lane("L1", "S", "needs-approval")]);
    expect(out[0]).toEqual({ id: "M", title: "a", live: { where: "main", busy: true } });
    expect(out[1]?.live).toEqual({ where: "spoke", laneId: "L1", name: "n-L1", status: "needs-approval" });
    expect(out[2]).toBe(rows[2]!);
  });
});
