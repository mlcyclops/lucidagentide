// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_paos1.ts
//
// P-AOS.1 (ADR-0452): one standing fleet goal and an AOS-1 heartbeat. Proves, against the REAL engine
// store (desktop/fleet_goal.ts over a temp file) and the real pure rules (desktop/aos.ts):
//   1. A GOAL NEEDS A BUDGET: no spend cap, no time cap, or no criteria is refused in words.
//   2. THE HEARTBEAT IS READABLE: each beat stamps seq + ts, and any observer derives alive / late / dead
//      from its age (1.5x and 3x the interval), so a frozen engine shows as late, then dead.
//   3. REAP: a spoke mid-turn that went silent past the stall line is reported stalled.
//   4. BUDGET CHECK: spend charged since the goal started crosses the cap and blocks the goal, naming why;
//      spend from before the goal is never charged.
//   5. VERIFY: the human ticks the last criterion and the goal is achieved, the heartbeat stopped.
//   6. DURABLE: the goal survives an engine restart; dismissing a finished goal removes it.
//
// Run: bun run harness/scripts/demo_paos1.ts

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AOS_STALL_AFTER_MS, aosLiveness, type AosLaneInput } from "../../desktop/aos.ts";
import { FleetGoal } from "../../desktop/fleet_goal.ts";

function fail(msg: string): never {
  console.error(`   FAIL - ${msg}`);
  process.exit(1);
}
function ok(msg: string): void {
  console.log(`   ok - ${msg}`);
}

const dir = mkdtempSync(join(tmpdir(), "lucid-paos1-"));
const path = join(dir, "lucid-fleet-goal.json");
let now = 1_760_000_000_000;
const lanes: AosLaneInput[] = [
  { id: "lane-api", name: "api", status: "working", busy: true, lastActivityAt: now, cost: 4 },
  { id: "lane-docs", name: "docs", status: "awaiting-input", busy: false, lastActivityAt: now, cost: 0 },
];
const make = (): FleetGoal => new FleetGoal({ lanes: () => lanes, now: () => now, path });

try {
  console.log("1) a goal without a budget or criteria is refused");
  const engine = make();
  const noBudget = engine.set({ title: "ship the beta", criteria: ["tests green"], maxUsd: 0, maxHours: 4 });
  if (noBudget.ok) fail("a goal with no spend cap was accepted");
  ok(`no spend cap: "${noBudget.error}"`);
  const noCriteria = engine.set({ title: "ship the beta", criteria: [], maxUsd: 5, maxHours: 4 });
  if (noCriteria.ok) fail("a goal with no criteria was accepted");
  ok(`no criteria: "${noCriteria.error}"`);

  console.log("2) the heartbeat is readable: alive, late, dead from its age alone");
  const set = engine.set({ title: "ship the beta", criteria: ["tests green", "release notes written"], maxUsd: 5, maxHours: 4 });
  if (!set.ok) fail(set.error);
  const hb = engine.snapshot().heartbeat;
  const at = (ms: number) => aosLiveness(ms - hb.ts, hb.intervalS);
  const seen = [at(now + 5_000), at(now + 20_000), at(now + 45_000)];
  if (seen.join() !== "alive,late,dead") fail(`liveness by age: ${seen.join()}`);
  ok(`beat #${hb.seq} every ${hb.intervalS} s reads alive at 5 s, late at 20 s, dead at 45 s`);

  console.log("3) a spoke silent mid-turn past the stall line is reaped as stalled");
  now += AOS_STALL_AFTER_MS;
  lanes[1] = { ...lanes[1]!, lastActivityAt: now };
  engine.beat();
  const agents = engine.snapshot().agents.map((a) => `${a.name}:${a.status}`).join(", ");
  if (agents !== "api:stalled, docs:idle") fail(`agents: ${agents}`);
  ok(`roster reads ${agents}`);

  console.log("4) spend since the goal started crosses the cap and blocks the goal");
  lanes[0] = { ...lanes[0]!, cost: 9.5, lastActivityAt: now }; // $4 was spent before the goal: never charged
  engine.beat();
  const blocked = engine.snapshot();
  if (blocked.goal?.status !== "blocked" || Math.abs(blocked.spentUsd - 5.5) > 1e-9) fail(`status ${blocked.goal?.status}, spent ${blocked.spentUsd}`);
  ok(`blocked: ${blocked.goal.blockedReason}`);

  console.log("5) the human ticks the last criterion: achieved, heartbeat stopped");
  engine.criterion("c1", true);
  const done = engine.criterion("c2", true);
  if (!done.ok || done.data.goal?.status !== "achieved" || done.data.heartbeat.status !== "stopped") fail(`after the last tick: ${JSON.stringify(done)}`);
  ok("verification outranks the budget: a blocked goal whose criteria are all met is achieved");

  console.log("6) durable across a restart; dismiss clears a finished goal");
  const restarted = make();
  if (restarted.snapshot().goal?.status !== "achieved") fail("the achieved goal did not survive a restart");
  ok("a fresh engine reads the achieved goal back");
  if (!restarted.control("dismiss").ok || make().snapshot().goal !== null) fail("dismiss did not clear the goal");
  ok("dismissed: the next engine starts with no goal and offers the set form");

  console.log("\ndemo_paos1 OK - one standing fleet goal with a mandatory budget, a heartbeat any observer reads as alive / late / dead, stalled spokes reaped, spend charged since the start and blocking at the cap, human-verified criteria achieving the goal, and the goal durable across restarts.");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
