// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, test } from "bun:test";
import {
  AOS_STALL_AFTER_MS, agentStatus, aosLiveness, chargeLanes, control, newGoal, spentUsd, tick, validateGoalInput,
  type AosHeartbeat, type AosLaneInput,
} from "./aos.ts";

const T0 = 1_000_000_000;
const HB: AosHeartbeat = { seq: 0, ts: 0, intervalS: 10, status: "running", lastTickMs: 0, consecutiveErrors: 0 };
const lane = (id: string, cost: number, over: Partial<AosLaneInput> = {}): AosLaneInput => ({ id, name: id, status: "working", busy: true, lastActivityAt: T0, cost, ...over });
const goal = (lanes: AosLaneInput[] = [], budget = { maxUsd: 10, maxWallClockS: 3600 }) =>
  newGoal({ title: "ship it", criteria: ["tests pass", "notes written"], budget }, "goal-1", lanes, T0);

describe("aosLiveness (AOS-1 section 8)", () => {
  test("alive under 1.5x the interval, late under 3x, dead at 3x and beyond", () => {
    expect(aosLiveness(14_999, 10)).toBe("alive");
    expect(aosLiveness(15_000, 10)).toBe("late");
    expect(aosLiveness(29_999, 10)).toBe("late");
    expect(aosLiveness(30_000, 10)).toBe("dead");
  });
  test("a beat from the future or a missing interval is not evidence of life", () => {
    expect(aosLiveness(-1, 10)).toBe("dead");
    expect(aosLiveness(Number.NaN, 10)).toBe("dead");
    expect(aosLiveness(1, 0)).toBe("dead");
  });
});

describe("agentStatus (Reap)", () => {
  test("a lane mid-turn goes stalled exactly at the stall line; idle and errored lanes never do", () => {
    expect(agentStatus(lane("a", 0), T0 + AOS_STALL_AFTER_MS - 1)).toBe("running");
    expect(agentStatus(lane("a", 0), T0 + AOS_STALL_AFTER_MS)).toBe("stalled");
    expect(agentStatus(lane("a", 0, { busy: false }), T0 + 10 * AOS_STALL_AFTER_MS)).toBe("idle");
    expect(agentStatus(lane("a", 0, { status: "error", busy: false }), T0)).toBe("errored");
  });
});

describe("validateGoalInput (section 7: a goal without a budget is invalid)", () => {
  test("a missing cap, no criteria, or no title is refused", () => {
    const ok = { title: "t", criteria: ["c"], maxUsd: 5, maxHours: 1 };
    expect(validateGoalInput(ok).ok).toBe(true);
    expect(validateGoalInput({ ...ok, maxUsd: 0 }).ok).toBe(false);
    expect(validateGoalInput({ ...ok, maxHours: undefined }).ok).toBe(false);
    expect(validateGoalInput({ ...ok, criteria: ["  ", ""] }).ok).toBe(false);
    expect(validateGoalInput({ ...ok, title: " " }).ok).toBe(false);
  });
});

describe("spend ledger", () => {
  test("only spend after the goal starts is charged; a respawned lane's new session counts in full; a new lane counts in full", () => {
    let g = goal([lane("a", 3)]); // $3 spent before the goal: baseline
    g = chargeLanes(g, [lane("a", 4)]);
    expect(spentUsd(g)).toBeCloseTo(1);
    g = chargeLanes(g, [lane("a", 0.5)]); // respawn: session cost restarted
    expect(spentUsd(g)).toBeCloseTo(1.5);
    g = chargeLanes(g, [lane("a", 0.5), lane("b", 2)]);
    expect(spentUsd(g)).toBeCloseTo(3.5);
  });
  test("an unchanged poll returns the same goal, so the store skips the write", () => {
    const g = goal([lane("a", 3)]);
    expect(chargeLanes(g, [lane("a", 3)])).toBe(g);
  });
});

describe("tick (Beat, Reap, Verify, Budget check)", () => {
  test("every tick beats; the last criterion met achieves the goal and stops the heartbeat", () => {
    const g = goal();
    const r1 = tick(g, HB, [], T0 + 1000);
    expect(r1.heartbeat).toMatchObject({ seq: 1, ts: T0 + 1000, status: "running" });
    const met = { ...g, criteria: g.criteria.map((c) => ({ ...c, met: true })) };
    const r2 = tick(met, r1.heartbeat, [], T0 + 2000);
    expect(r2.goal?.status).toBe("achieved");
    expect(r2.heartbeat.status).toBe("stopped");
    // Terminal: later ticks change nothing and evaluate nothing, but still beat (the engine's pulse), so
    // a finished goal never reads as a dead engine.
    const r3 = tick(r2.goal, r2.heartbeat, [], T0 + 3000);
    expect(r3.goal).toBe(r2.goal);
    expect(r3.heartbeat).toMatchObject({ seq: r2.heartbeat.seq + 1, ts: T0 + 3000, status: "stopped" });
  });
  test("over the spend cap blocks with the reason; over the time cap too", () => {
    const g = goal([lane("a", 0)]);
    const spent = tick(g, HB, [lane("a", 12)], T0 + 1000);
    expect(spent.goal?.status).toBe("blocked");
    expect(spent.goal?.blockedReason).toBe("spend cap reached: $12.00 of $10.00");
    const late = tick(goal(), HB, [], T0 + 3600 * 1000);
    expect(late.goal?.status).toBe("blocked");
    expect(late.goal?.blockedReason).toBe("time cap reached: 1 h of 1 h");
  });
  test("a blocked goal whose criteria are all met is achieved: verification outranks the budget", () => {
    const blocked = tick(goal([lane("a", 0)]), HB, [lane("a", 12)], T0 + 1000).goal!;
    const met = { ...blocked, criteria: blocked.criteria.map((c) => ({ ...c, met: true })) };
    expect(tick(met, HB, [lane("a", 12)], T0 + 2000).goal?.status).toBe("achieved");
  });
  test("a paused heartbeat still beats but evaluates nothing, even over budget", () => {
    const g = goal([lane("a", 0)]);
    const r = tick(g, { ...HB, status: "paused" }, [lane("a", 50)], T0 + 1000);
    expect(r.heartbeat).toMatchObject({ seq: 1, status: "paused" });
    expect(r.goal).toBe(g);
    expect(r.changed).toBe(false);
  });
  test("stalled lanes are reported as agents", () => {
    const r = tick(goal(), HB, [lane("quiet", 0), lane("fresh", 0, { lastActivityAt: T0 + AOS_STALL_AFTER_MS })], T0 + AOS_STALL_AFTER_MS);
    expect(r.agents.map((a) => [a.laneId, a.status])).toEqual([["quiet", "stalled"], ["fresh", "running"]]);
  });
});

describe("control (pause / resume / cancel at any time; dismiss a finished goal)", () => {
  test("cancel is terminal and stops the heartbeat; a terminal goal refuses pause, resume and cancel", () => {
    const c = control(goal(), HB, "cancel", T0);
    expect(c.ok && c.goal?.status).toBe("cancelled");
    expect(c.ok && c.heartbeat.status).toBe("stopped");
    const done = c.ok ? c.goal : null;
    for (const a of ["pause", "resume", "cancel"] as const) expect(control(done, HB, a, T0).ok).toBe(false);
    const d = control(done, HB, "dismiss", T0);
    expect(d.ok && d.goal).toBeNull();
  });
  test("an open goal cannot be dismissed, only cancelled", () => {
    expect(control(goal(), HB, "dismiss", T0).ok).toBe(false);
  });
});
