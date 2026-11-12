// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, test } from "bun:test";
import {
  AOS_STALL_AFTER_MS, addTask, agentStatus, aosLiveness, chargeLanes, control, newGoal, parseCheckVerdict, planTasks, recoverTasks,
  setTaskCheck, spentUsd, taskTurnEnded, tick, validateGoalInput, validateTaskInput,
  type AosGoal, type AosHeartbeat, type AosLaneInput,
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

// ------------------------------------------------------------------------------ P-AOS.2: tasks

const idle = (id: string): AosLaneInput => lane(id, 0, { busy: false, status: "awaiting-input" });
const TASK = { title: "fix the dock", prompt: "make the timeline dock render rows", outputContract: "a passing branch", checks: ["$ bun test", "rows show within 3 s"], assignee: "a", dependsOn: [] as string[] };
function withTasks(...specs: Partial<typeof TASK>[]): AosGoal {
  let g = goal();
  for (const spec of specs) {
    const v = validateTaskInput({ ...TASK, ...spec }, g, ["a", "b"]);
    if (!v.ok) throw new Error(v.error);
    g = addTask(g, v.input, T0);
  }
  return g;
}

describe("validateTaskInput (section 6: an output contract and at least one acceptance check)", () => {
  test("no deliverable, no checks, an unknown spoke, or a dependency that does not exist is refused", () => {
    const g = goal();
    expect(validateTaskInput({ ...TASK, outputContract: " " }, g, ["a"]).ok).toBe(false);
    expect(validateTaskInput({ ...TASK, checks: ["", " "] }, g, ["a"]).ok).toBe(false);
    expect(validateTaskInput({ ...TASK, assignee: "zz" }, g, ["a"]).ok).toBe(false);
    expect(validateTaskInput({ ...TASK, dependsOn: ["t-9"] }, g, ["a"]).ok).toBe(false);
    expect(validateTaskInput(TASK, null, ["a"]).ok).toBe(false);
  });
  test("a line starting with \"$ \" is a command the spoke runs; any other line is a person's check", () => {
    const v = validateTaskInput(TASK, goal(), ["a"]);
    expect(v.ok && v.input.checks).toEqual([{ kind: "command", text: "bun test" }, { kind: "human", text: "rows show within 3 s" }]);
  });
});

describe("planTasks (Dispatch)", () => {
  test("a task waits for its dependency; a failed dependency cancels it", () => {
    let g = withTasks({}, { dependsOn: ["t-1"], assignee: "b" });
    let r = planTasks(g, [idle("a"), idle("b")], T0);
    expect(r.dispatch.map((d) => d.taskId)).toEqual(["t-1"]);
    expect(r.goal.tasks[1]!.status).toBe("pending");
    g = { ...r.goal, tasks: r.goal.tasks.map((t) => (t.id === "t-1" ? { ...t, status: "failed" as const } : t)) };
    r = planTasks(g, [idle("a"), idle("b")], T0);
    expect(r.goal.tasks[1]).toMatchObject({ status: "cancelled", lastFailure: "dependency t-1 did not complete" });
  });
  test("one running task per spoke, and a busy spoke gets nothing", () => {
    const g = withTasks({}, {});
    const first = planTasks(g, [idle("a")], T0);
    expect(first.dispatch.length).toBe(1);
    expect(planTasks(first.goal, [idle("a")], T0).dispatch).toEqual([]);
    expect(planTasks(g, [lane("a", 0)], T0).dispatch).toEqual([]); // busy
  });
  test("a blocked goal dispatches nothing", () => {
    const g = { ...withTasks({}), spend: { a: { last: 0, total: 0 } } };
    const r = tick(g, HB, [{ ...idle("a"), cost: 50 }], T0 + 1000);
    expect(r.goal?.status).toBe("blocked");
    expect(r.dispatch).toEqual([]);
  });
});

describe("taskTurnEnded (verify before done, fail-closed)", () => {
  const started = (): AosGoal => planTasks(withTasks({}), [idle("a")], T0).goal;
  test("work, then a verification turn; passing commands leave the person's check for review; the tick completes it", () => {
    const w = taskTurnEnded(started(), "t-1", "work", { ok: true, text: "Fixed the scan." }, T0 + 1);
    expect(w.dispatch.map((d) => d.turn)).toEqual(["verify"]);
    const v = taskTurnEnded(w.goal, "t-1", "verify", { ok: true, text: 'Ran it. {"checks":[{"id":"k1","pass":true,"detail":"exit 0"}]}' }, T0 + 2);
    expect(v.goal.tasks[0]).toMatchObject({ status: "needs_review", result: "Fixed the scan." });
    const done = setTaskCheck(v.goal, "t-1", "k2", true, T0 + 3);
    expect(done.ok && done.goal.tasks[0]!.status).toBe("done");
  });
  test("a verification reply without a verdict fails the check; the retry carries the reason; the last attempt fails the task", () => {
    const w = taskTurnEnded(started(), "t-1", "work", { ok: true, text: "done" }, T0 + 1);
    const v = taskTurnEnded(w.goal, "t-1", "verify", { ok: true, text: "All good, trust me." }, T0 + 2);
    expect(v.goal.tasks[0]).toMatchObject({ status: "ready", attempts: 1 });
    expect(v.goal.tasks[0]!.lastFailure).toContain("no verdict");
    const again = planTasks(v.goal, [idle("a")], T0 + 3);
    expect(again.dispatch[0]!.text).toContain("The previous attempt did not pass");
    const err = taskTurnEnded(again.goal, "t-1", "work", { ok: false, error: "lane is stopped" }, T0 + 4);
    expect(err.goal.tasks[0]).toMatchObject({ status: "failed", attempts: 2 });
  });
  test("a person's rejection is a failed attempt, and a command check cannot be ticked by hand", () => {
    const w = taskTurnEnded(started(), "t-1", "work", { ok: true, text: "done" }, T0 + 1);
    const v = taskTurnEnded(w.goal, "t-1", "verify", { ok: true, text: '{"checks":[{"id":"k1","pass":true}]}' }, T0 + 2);
    expect(setTaskCheck(v.goal, "t-1", "k1", true, T0 + 3).ok).toBe(false);
    const rejected = setTaskCheck(v.goal, "t-1", "k2", false, T0 + 3);
    expect(rejected.ok && rejected.goal.tasks[0]).toMatchObject({ status: "ready", lastFailure: "a reviewer rejected: rows show within 3 s" });
  });
  test("an outcome for a task no longer running (cancelled meanwhile) changes nothing", () => {
    const g = started();
    const cancelled = { ...g, tasks: g.tasks.map((t) => ({ ...t, status: "cancelled" as const })) };
    expect(taskTurnEnded(cancelled, "t-1", "work", { ok: true, text: "x" }, T0 + 1).goal).toBe(cancelled);
  });
});

describe("parseCheckVerdict", () => {
  test("finds the JSON inside prose, honors braces inside strings, and fails anything not explicitly passing", () => {
    const v = parseCheckVerdict('Output: {"checks":[{"id":"k1","pass":true,"detail":"printed {ok}"},{"id":"k2","pass":"yes"}]} end', ["k1", "k2", "k3"]);
    expect(v.k1).toEqual({ passed: true, detail: "printed {ok}" });
    expect(v.k2!.passed).toBe(false);
    expect(v.k3!.passed).toBe(false);
  });
});

describe("goal lifecycle reaches tasks", () => {
  test("cancelling the goal cancels its open tasks; an engine restart sends a mid-turn task back to ready", () => {
    const g = planTasks(withTasks({}, { assignee: "b" }), [idle("a"), lane("b", 0)], T0).goal; // b is busy: its task stays ready
    const c = control(g, HB, "cancel", T0 + 1);
    expect(c.ok && c.goal?.tasks.map((t) => t.status)).toEqual(["cancelled", "cancelled"]);
    const r = recoverTasks(g, T0 + 2);
    expect(r.tasks[0]).toMatchObject({ status: "ready", attempts: 1, lastFailure: "the engine restarted during this task's turn" });
  });
});
