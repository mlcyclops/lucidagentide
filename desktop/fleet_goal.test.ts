// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AosLaneInput } from "./aos.ts";
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
