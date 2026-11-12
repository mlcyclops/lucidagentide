// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_paos2.ts
//
// P-AOS.2 (ADR-0453): tasks under the fleet goal. Proves, against the REAL engine store
// (desktop/fleet_goal.ts over a temp file) with a scripted dispatch seam standing in for fleet.prompt:
//   1. A TASK NEEDS A CONTRACT: no deliverable or no acceptance check is refused (AOS-1 section 6).
//   2. DISPATCH ORDER: the heartbeat starts ready tasks on idle spokes, one task per spoke, and holds a
//      dependent task until its dependency is done.
//   3. VERIFY BEFORE DONE: command checks run in a separate verification turn; a reply with no verdict
//      FAILS (fail-closed) and the retry prompt carries the reason.
//   4. HUMAN REVIEW: passing commands leave a person's check for review; the tick completes the task, and
//      the dependent task starts on the freed spoke.
//   5. THE LIMIT: a task that keeps failing stops at maxAttempts instead of retrying forever.
//   6. RESTART: a task mid-turn when the engine dies goes back to ready, its attempt counted.
//
// Run: bun run harness/scripts/demo_paos2.ts

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AosLaneInput, AosTurnOutcome } from "../../desktop/aos.ts";
import { FleetGoal } from "../../desktop/fleet_goal.ts";

function fail(msg: string): never {
  console.error(`   FAIL - ${msg}`);
  process.exit(1);
}
function ok(msg: string): void {
  console.log(`   ok - ${msg}`);
}
function settle(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 20);
  return promise;
}

const dir = mkdtempSync(join(tmpdir(), "lucid-paos2-"));
const path = join(dir, "lucid-fleet-goal.json");
const lanes: AosLaneInput[] = [
  { id: "lane-api", name: "api", status: "awaiting-input", busy: false, lastActivityAt: 0, cost: 0 },
  { id: "lane-docs", name: "docs", status: "awaiting-input", busy: false, lastActivityAt: 0, cost: 0 },
];
/** The scripted spokes: each dispatched prompt is recorded and answered from this queue, per lane. */
const sent: { laneId: string; text: string }[] = [];
const script: Record<string, AosTurnOutcome[]> = { "lane-api": [], "lane-docs": [] };
const dispatch = async (laneId: string, text: string): Promise<AosTurnOutcome> => {
  sent.push({ laneId, text });
  return script[laneId]!.shift() ?? { ok: false, error: "no scripted reply" };
};
const make = (): FleetGoal => new FleetGoal({ lanes: () => lanes, dispatch, path });
const PASS = '{"checks":[{"id":"k1","pass":true,"detail":"exit 0"}]}';

try {
  const engine = make();
  const set = engine.set({ title: "ship the timeline fix", criteria: ["the dock renders rows"], maxUsd: 20, maxHours: 4 });
  if (!set.ok) fail(set.error);

  console.log("1) a task needs a deliverable and an acceptance check");
  const noContract = engine.addTask({ title: "fix", prompt: "fix the scan", outputContract: "", checks: ["$ bun test"], assignee: "lane-api", dependsOn: [] });
  if (noContract.ok) fail("a task without a deliverable was accepted");
  ok(`no deliverable: "${noContract.error}"`);
  const noCheck = engine.addTask({ title: "fix", prompt: "fix the scan", outputContract: "a green test", checks: [], assignee: "lane-api", dependsOn: [] });
  if (noCheck.ok) fail("a task without a check was accepted");
  ok(`no check: "${noCheck.error}"`);

  console.log("2) dispatch: one task per spoke, a dependent task waits");
  // api answers attempt 1's work, then a verification reply with NO verdict; then attempt 2 and a passing verdict.
  script["lane-api"]!.push({ ok: true, text: "Made the scan async." }, { ok: true, text: "All commands ran fine." }, { ok: true, text: "Fixed the remaining failure." }, { ok: true, text: PASS });
  engine.addTask({ title: "async scan", prompt: "make listAllSessions async", outputContract: "a green test run", checks: ["$ bun test desktop/timeline.test.ts", "the dock renders within 3 s"], assignee: "lane-api", dependsOn: [] });
  engine.addTask({ title: "release notes", prompt: "write the notes for the fix", outputContract: "a PROGRESS.md entry", checks: ["names the root cause"], assignee: "lane-docs", dependsOn: ["t-1"] });
  await settle();
  if (sent.some((s) => s.laneId === "lane-docs")) fail("t-2 started before its dependency was done");
  ok("t-1 runs on api; t-2 (after t-1) has not been sent to docs");

  console.log("3) verify before done: a reply with no verdict fails the check, and the retry says why");
  const kinds = sent.map((s) => (s.text.startsWith("[Task t-1 verification]") ? "verify" : "work"));
  if (kinds.join() !== "work,verify,work,verify") fail(`turns sent to api: ${kinds.join()}`);
  const retry = sent[2]!;
  if (!retry.text.includes("The previous attempt did not pass") || !retry.text.includes("no verdict")) fail("the retry prompt did not carry the failure");
  const t1 = engine.snapshot().goal!.tasks[0]!;
  if (t1.attempts !== 2 || t1.acceptance[0]!.passed !== true) fail(`after attempt 2: ${JSON.stringify(t1)}`);
  ok("work, verify (no verdict: failed closed), work again with the reason, verify (exit 0): the command check passed");

  console.log("4) human review completes the task; the dependent task starts");
  if (engine.snapshot().goal!.tasks[0]!.status !== "needs_review") fail(`t-1 is ${engine.snapshot().goal!.tasks[0]!.status}`);
  script["lane-docs"]!.push({ ok: true, text: "Wrote the entry." });
  const tick = engine.taskCheck("t-1", "k2", true);
  if (!tick.ok || tick.data.goal!.tasks[0]!.status !== "done") fail("the human tick did not complete t-1");
  await settle();
  const t2 = engine.snapshot().goal!.tasks[1]!;
  if (t2.status !== "needs_review" || !sent.some((s) => s.laneId === "lane-docs")) fail(`t-2 after t-1 done: ${t2.status}`);
  ok("t-1 done after the person's tick; t-2 ran on docs and waits for its own review");

  console.log("5) the attempt limit: a task that keeps failing stops");
  script["lane-api"]!.push({ ok: false, error: "lane is stopped" }, { ok: false, error: "lane is stopped" });
  engine.addTask({ title: "flaky", prompt: "do it", outputContract: "it done", checks: ["looks right"], assignee: "lane-api", dependsOn: [] });
  await settle();
  engine.beat();
  await settle();
  const t3 = engine.snapshot().goal!.tasks[2]!;
  if (t3.status !== "failed" || t3.attempts !== 2) fail(`t-3: ${t3.status} after ${t3.attempts} attempts`);
  ok(`t-3 failed after ${t3.attempts} of ${t3.maxAttempts} attempts: ${t3.lastFailure}`);

  console.log("6) restart: a task mid-turn goes back to ready, its attempt counted");
  const hung = new FleetGoal({ lanes: () => lanes, path, dispatch: () => Promise.withResolvers<AosTurnOutcome>().promise }); // a turn that never ends
  hung.addTask({ title: "long job", prompt: "run the long job", outputContract: "a log", checks: ["looks right"], assignee: "lane-api", dependsOn: [] });
  if (hung.snapshot().goal!.tasks[3]!.status !== "running") fail("t-4 did not start");
  const reborn = make(); // the old engine "died" with t-4 mid-turn
  const t4 = reborn.snapshot().goal!.tasks[3]!;
  if (t4.status !== "ready" || t4.attempts !== 1 || t4.lastFailure !== "the engine restarted during this task's turn") fail(`t-4 after restart: ${JSON.stringify(t4)}`);
  ok(`t-4 is back to ready with attempt ${t4.attempts} of ${t4.maxAttempts} counted; the next beat redispatches it`);

  console.log("\ndemo_paos2 OK - tasks need a deliverable and a check, the heartbeat dispatches one task per spoke in dependency order, command checks are verified in a separate fail-closed turn, failures retry with their reason up to the limit, a person's review completes a task, and a restart never strands one mid-turn.");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
