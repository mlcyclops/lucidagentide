// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-SWITCH.1 (ADR-0403): opening a session never stops Main's work unless the user chose to, and never puts
// one session in two omp processes.

import { describe, expect, test } from "bun:test";
import { liveBadge, planSessionSwitch, switchSheetCopy, type SwitchLane } from "./session_switch.ts";

const lane = (id: string, sessionId: string | null, status: string): SwitchLane => ({ id, sessionId, status });

describe("planSessionSwitch", () => {
  test("idle Main opens the session in Main, as before", () => {
    expect(planSessionSwitch({ busy: null, mainSessionId: "A", targetId: "B", lanes: [] })).toEqual({ kind: "load" });
  });

  test("busy Main asks instead of loading, carrying the engine's reason", () => {
    expect(planSessionSwitch({ busy: "a turn is running", mainSessionId: "A", targetId: "B", lanes: [] }))
      .toEqual({ kind: "ask", reason: "a turn is running" });
  });

  test("Main's own session never asks: its running turn is adopted, not stopped", () => {
    expect(planSessionSwitch({ busy: "a turn is running", mainSessionId: "A", targetId: "A", lanes: [] })).toEqual({ kind: "load" });
  });

  test("a session held by a live spoke attaches to that spoke, busy or not", () => {
    const lanes = [lane("L1", "X", "done"), lane("L2", "B", "working")];
    expect(planSessionSwitch({ busy: null, mainSessionId: "A", targetId: "B", lanes })).toEqual({ kind: "promote", laneId: "L2" });
    expect(planSessionSwitch({ busy: "a turn is running", mainSessionId: "A", targetId: "B", lanes })).toEqual({ kind: "promote", laneId: "L2" });
  });

  test("a spoke that cannot attach yet refuses rather than loading a second copy", () => {
    const plan = planSessionSwitch({ busy: null, mainSessionId: "A", targetId: "B", lanes: [lane("L2", "B", "needs-approval")] });
    expect(plan.kind).toBe("refuse");
  });

  test("a stopped or crashed spoke no longer owns its session", () => {
    for (const status of ["stopped", "error"]) {
      expect(planSessionSwitch({ busy: null, mainSessionId: "A", targetId: "B", lanes: [lane("L2", "B", status)] })).toEqual({ kind: "load" });
      expect(planSessionSwitch({ busy: "a turn is running", mainSessionId: "A", targetId: "B", lanes: [lane("L2", "B", status)] }).kind).toBe("ask");
    }
  });
});

describe("liveBadge", () => {
  test("names the spoke and its state; an approval wait reads as the ask tone", () => {
    expect(liveBadge({ where: "spoke", laneId: "L", name: "Refactor tests", status: "needs-approval" }))
      .toEqual({ text: `spoke "Refactor tests" \u00b7 needs your approval`, tone: "ask" });
    expect(liveBadge({ where: "spoke", laneId: "L", name: "x", status: "working" })?.tone).toBe("work");
  });

  test("Main shows only while it works; on disk shows nothing", () => {
    expect(liveBadge({ where: "main", busy: true })).toEqual({ text: "working in Main", tone: "work" });
    expect(liveBadge({ where: "main", busy: false })).toBeNull();
    expect(liveBadge(undefined)).toBeNull();
  });
});

describe("switchSheetCopy", () => {
  test("names both sessions and the reason, and bounds a long title", () => {
    const long = "x".repeat(200);
    const c = switchSheetCopy("Fix login flow", long, "a turn is running");
    expect(c.title).toBe(`"Fix login flow" is still working`);
    expect(c.body).toContain("(a turn is running)");
    expect(c.body).toContain(`"${"x".repeat(47)}\u2026"`);
    expect(c.body).not.toContain("x".repeat(48));
    expect(c.stop).toBe("Stop it and switch");
  });

  test("New session wording when there is no target", () => {
    const c = switchSheetCopy(null, null, "a goal loop is running");
    expect(c.title).toBe("The main session is still working");
    expect(c.spoke).toBe("Start it as a spoke");
    expect(c.stop).toBe("Stop it and start new");
    expect(c.spokeHint).toContain("A new session opens in its own spoke");
  });
});
