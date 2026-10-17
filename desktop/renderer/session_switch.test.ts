// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-SWITCH.1 (ADR-0403): opening a session never stops Main's work unless the user chose to, and never puts
// one session in two omp processes.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { currentSwitchPreflight, liveBadge, planSessionSwitch, switchSheetCopy, type SwitchLane } from "./session_switch.ts";

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

// #460 case 5 (the #392 review): "openSession awaits two preflights before any epoch check, so clicking
// A then B quickly can let A's late plan win. Take a generation number before the await." The generation
// lives inside currentSwitchPreflight, taken synchronously at the call, so it can never be taken late.
describe("currentSwitchPreflight (#460 case 5: a superseded open's plan is discarded)", () => {
  test("a single uncontested open gets its preflight result back unchanged", async () => {
    expect(await currentSwitchPreflight(Promise.resolve("preflight"))).toBe("preflight");
  });

  test("THE BUG: click A, then B while A's preflight is in flight - A's late result must not win", async () => {
    let landA!: (v: string) => void;
    const a = currentSwitchPreflight(new Promise<string>((resolve) => { landA = resolve; })); // A's preflight hangs at the engine
    const b = currentSwitchPreflight(Promise.resolve("B")); // B is clicked before A's preflight lands
    expect(await b).toBe("B"); // the newest click proceeds with its own plan
    landA("A"); // A's preflight finally lands, after B already decided
    expect(await a).toBeNull(); // superseded: A's stale result is discarded, its plan never applied
  });

  test("the newest click wins even when its preflight lands second", async () => {
    let landB!: (v: string) => void;
    const a = currentSwitchPreflight(Promise.resolve("A"));
    const b = currentSwitchPreflight(new Promise<string>((resolve) => { landB = resolve; })); // B clicked right after A
    expect(await a).toBeNull(); // A's preflight landed first, but B is the newer intent
    landB("B");
    expect(await b).toBe("B");
  });

  test("openSession wires the guard around its preflights, with no earlier await (pinned at the source)", () => {
    const src = readFileSync(join(import.meta.dir, "app.ts"), "utf8");
    const start = src.indexOf("async function openSession");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\n}", start));
    const code = body.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
    // The first await in openSession is the guarded Promise.all of the two preflights: the generation
    // is taken synchronously inside currentSwitchPreflight, before sessionBusy/fleetStatus can land.
    expect(code.indexOf("await")).toBe(code.indexOf("await currentSwitchPreflight(Promise.all([bridge.sessionBusy"));
    expect(code).toContain("if (!pre) return;");
  });
});
