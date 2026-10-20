// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AosLaneInput, AosTurnOutcome } from "./aos.ts";
import { FleetGoal } from "./fleet_goal.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function store(lanes: AosLaneInput[] = [], now = () => 1_000_000): { path: string; make: () => FleetGoal } {
  const dir = mkdtempSync(join(tmpdir(), "lucid-goal-"));
  dirs.push(dir);
  const path = join(dir, "goal.json");
  return { path, make: () => new FleetGoal({ lanes: () => lanes, now, path }) };
}
const INPUT = { title: "ship the beta", criteria: ["tests green", "notes written"], maxUsd: 20, maxHours: 8 };

test("a goal survives an engine restart; only one open goal at a time", () => {
  const s = store();
  const a = s.make();
  expect(a.set(INPUT).ok).toBe(true);
  const second = a.set(INPUT);
  expect(second.ok).toBe(false);
  const b = s.make(); // a fresh engine reads the same file
  expect(b.snapshot().goal?.title).toBe("ship the beta");
  expect(b.snapshot().goal?.criteria.map((c) => c.text)).toEqual(["tests green", "notes written"]);
});

test("ticking the last criterion achieves the goal at once, and dismissing it removes the file", () => {
  const s = store();
  const g = s.make();
  g.set(INPUT);
  g.criterion("c1", true);
  const r = g.criterion("c2", true);
  expect(r.ok && r.data.goal?.status).toBe("achieved");
  expect(r.ok && r.data.heartbeat.status).toBe("stopped");
  expect(g.control("dismiss").ok).toBe(true);
  expect(existsSync(s.path)).toBe(false);
  expect(s.make().snapshot().goal).toBeNull();
});

test("a torn goal file is no goal, never a crash", () => {
  const s = store();
  writeFileSync(s.path, "{\"id\":\"goal-1\",\"title\":");
  expect(s.make().snapshot().goal).toBeNull();
});

test("the heartbeat beats from the first tick, and a pause holds the goal while the beat continues", () => {
  let now = 1_000_000;
  const s = store([{ id: "a", name: "a", status: "working", busy: true, lastActivityAt: now, cost: 0 }], () => now);
  const g = s.make();
  g.beat();
  expect(g.snapshot().heartbeat).toMatchObject({ seq: 1, ts: now });
  g.set(INPUT);
  g.control("pause");
  now += 10_000;
  g.beat();
  expect(g.snapshot().heartbeat.status).toBe("paused");
  expect(g.snapshot().goal?.status).toBe("active");
  expect(g.control("resume").ok && g.snapshot().heartbeat.status).toBe("running");
});

test("a task runs end to end through the dispatch seam: work turn, verification turn, review, done", async () => {
  const sent: { laneId: string; text: string }[] = [];
  const replies: AosTurnOutcome[] = [{ ok: true, text: "Fixed it." }, { ok: true, text: '{"checks":[{"id":"k1","pass":true,"detail":"exit 0"}]}' }];
  const lanes: AosLaneInput[] = [{ id: "a", name: "api", status: "awaiting-input", busy: false, lastActivityAt: 1_000_000, cost: 0 }];
  const dir = mkdtempSync(join(tmpdir(), "lucid-goal-"));
  dirs.push(dir);
  const g = new FleetGoal({ lanes: () => lanes, path: join(dir, "goal.json"), now: () => 1_000_000, dispatch: async (laneId, text) => { sent.push({ laneId, text }); return replies.shift()!; } });
  g.set(INPUT);
  const add = g.addTask({ title: "fix", prompt: "fix the dock", outputContract: "a green test", checks: ["$ bun test", "rows render"], assignee: "a", dependsOn: [] });
  expect(add.ok).toBe(true);
  await Bun.sleep(10); // both turns resolve on microtasks
  expect(sent.map((s) => s.text.split("\n")[0])).toEqual(['[Fleet goal "ship the beta", task t-1: fix]', "[Task t-1 verification] You are verifying, not working. Run each command below EXACTLY as written in this folder. Do not modify any file and do not try to fix anything. Then reply with ONLY one line of strict JSON: {\"checks\":[{\"id\":\"k1\",\"pass\":true,\"detail\":\"exit code and a short reason\"}]} with one entry per command; \"pass\" is true only when the command exited 0."]);
  expect(g.snapshot().goal?.tasks[0]?.status).toBe("needs_review");
  const done = g.taskCheck("t-1", "k2", true);
  expect(done.ok && done.data.goal?.tasks[0]?.status).toBe("done");
});

test("an outcome that lands after its goal was replaced is dropped, never applied by task id", async () => {
  const releases: ((o: AosTurnOutcome) => void)[] = [];
  const lanes: AosLaneInput[] = [{ id: "a", name: "api", status: "awaiting-input", busy: false, lastActivityAt: 1_000_000, cost: 0 }];
  const dir = mkdtempSync(join(tmpdir(), "lucid-goal-"));
  dirs.push(dir);
  const g = new FleetGoal({ lanes: () => lanes, path: join(dir, "goal.json"), now: () => 1_000_000, dispatch: () => { const turn = Promise.withResolvers<AosTurnOutcome>(); releases.push(turn.resolve); return turn.promise; } });
  g.set(INPUT);
  g.addTask({ title: "fix", prompt: "p", outputContract: "c", checks: ["looks right"], assignee: "a", dependsOn: [] });
  g.control("cancel");
  g.control("dismiss");
  g.set(INPUT);
  g.addTask({ title: "other", prompt: "p", outputContract: "c", checks: ["looks right"], assignee: "a", dependsOn: [] });
  const before = g.snapshot().goal?.tasks[0];
  releases[0]!({ ok: true, text: "late result from the old goal" }); // the OLD goal's t-1 turn
  await Bun.sleep(10);
  expect(g.snapshot().goal?.tasks[0]).toEqual(before!);
});
