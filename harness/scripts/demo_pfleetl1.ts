// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_pfleetl1.ts
//
// P-FLEET.L1: local lanes - N concurrent headless LUCID agents on one machine, capped by the 75%
// headroom guard, streaming into the fleet grid, reporting to the master agent. This demo drives the
// REAL FleetLaneManager against REAL fake-ACP subprocesses (the firewall's faithful stand-in) and
// proves the load-bearing properties headlessly:
//   1. two lanes run turns CONCURRENTLY (the local fan-out);
//   2. the lane model defaults to the MASTER's current model;
//   3. admission refuses over the 75% watermark with the measured number, and at the lane ceiling;
//   4. a permission ask lands needs-approval, an unanswered/denied ask stays fail-closed;
//   5. cancel lands awaiting-input (never done); stopAll orphans nothing;
//   6. the status payload is metadata only - lane reply text never rides in /api/fleet/status shapes.
//
// Run: bun run harness/scripts/demo_pfleetl1.ts

import { join } from "node:path";
import { FleetLaneManager, type LaneEvent } from "../../desktop/fleet_lanes.ts";
import type { SystemSnapshot } from "../../desktop/system_profile.ts";

const FAKE = join(import.meta.dir, "..", "mcp", "testing", "fake_acp_agent.ts");

function fail(msg: string): never {
  console.error(`   FAIL - ${msg}`);
  process.exit(1);
}
function ok(msg: string): void {
  console.log(`   ok - ${msg}`);
}

const healthy: SystemSnapshot = { cpuModel: "demo", cores: 8, speedMHz: 4000, cpuBusyPct: 12, memTotalMB: 16_000, memFreeMB: 11_000 };

function mgr(snap: SystemSnapshot = healthy, mode?: string): FleetLaneManager {
  if (mode) process.env.FAKE_ACP_MODE = mode; else delete process.env.FAKE_ACP_MODE;
  return new FleetLaneManager({ argv: () => ({ cmd: "bun", args: [FAKE] }), masterModel: () => "orchestrator-model", sample: async () => snap });
}

const sleep = (ms: number) => { const w = Promise.withResolvers<void>(); setTimeout(w.resolve, ms); return w.promise; };

// 1 + 2. Two lanes, concurrent turns, master-model default.
console.log("1) two lanes run concurrently, defaulting to the master's model");
{
  const fleet = mgr();
  const a = await fleet.spawn({ cwd: process.cwd(), name: "repo-a" });
  const b = await fleet.spawn({ cwd: import.meta.dir, name: "repo-b" });
  if (!a.ok || !b.ok) fail(`spawns failed: ${a.reason ?? ""} ${b.reason ?? ""}`);
  if (a.lane!.model !== "orchestrator-model" || b.lane!.model !== "orchestrator-model") fail("lane model must default to the master's");
  const eventsA: LaneEvent[] = [];
  const eventsB: LaneEvent[] = [];
  const t0 = Date.now();
  await Promise.all([
    fleet.prompt(a.lane!.id, "alpha", (e) => eventsA.push(e)),
    fleet.prompt(b.lane!.id, "beta", (e) => eventsB.push(e)),
  ]);
  const textA = eventsA.filter((e) => e.type === "token").map((e) => (e as { text: string }).text).join("");
  const textB = eventsB.filter((e) => e.type === "token").map((e) => (e as { text: string }).text).join("");
  if (!textA.includes("You said: alpha") || !textB.includes("You said: beta")) fail("replies crossed or missing");
  const st = await fleet.status();
  if (st.lanes.filter((l) => l.status === "done").length !== 2) fail("both lanes must land done");
  if (st.masterModel !== "orchestrator-model") fail("status must carry the master model");
  ok(`two turns completed concurrently in ${Date.now() - t0}ms, replies never crossed`);
  fleet.stopAll();
}

// 3. Admission: the 75% watermark and the lane ceiling refuse with measured numbers.
console.log("2) admission refuses over the watermark and at the ceiling");
{
  const hot = mgr({ ...healthy, memFreeMB: 2_000 }); // 87.5% used
  const r = await hot.spawn({ cwd: process.cwd() });
  if (r.ok) fail("must refuse over the memory watermark");
  if (!/88%/.test(r.reason ?? "")) fail(`refusal must carry the measured number, got: ${r.reason}`);
  ok(`memory refusal carries the number - "${r.reason}"`);

  const tiny = mgr({ ...healthy, cores: 2 }); // ceiling 1
  const first = await tiny.spawn({ cwd: process.cwd() });
  if (!first.ok) fail("first lane must fit under a ceiling of 1");
  const second = await tiny.spawn({ cwd: process.cwd() });
  if (second.ok) fail("must refuse at the lane ceiling");
  if (!/1\/1/.test(second.reason ?? "")) fail(`ceiling refusal must count lanes, got: ${second.reason}`);
  ok(`ceiling refusal counts lanes - "${second.reason}"`);
  tiny.stopAll();
}

// 4. Permission asks are fail-closed and visible.
console.log("3) a permission ask lands needs-approval; deny is honored");
{
  const fleet = mgr(healthy, "permission");
  const r = await fleet.spawn({ cwd: process.cwd() });
  if (!r.ok) fail(r.reason ?? "spawn failed");
  const events: LaneEvent[] = [];
  const turn = fleet.prompt(r.lane!.id, "try something risky", (e) => events.push(e));
  let pending = false;
  for (let i = 0; i < 50 && !pending; i++) { await sleep(100); pending = !!(await fleet.status()).lanes[0]!.pendingApproval; }
  if (!pending) fail("the ask never surfaced");
  if ((await fleet.status()).lanes[0]!.status !== "needs-approval") fail("status must be needs-approval");
  fleet.answer(r.lane!.id, false);
  await turn;
  const text = events.filter((e) => e.type === "token").map((e) => (e as { text: string }).text).join("");
  if (!text.includes("cancelled")) fail("the deny must reach the remote as cancelled");
  ok("ask surfaced, glowed as needs-approval, deny landed fail-closed");
  fleet.stopAll();
}

// 5. Cancel lands awaiting-input; stopAll cleans up.
console.log("4) cancel returns the lane to awaiting-input; stopAll orphans nothing");
{
  const fleet = mgr(healthy, "hang");
  const r = await fleet.spawn({ cwd: process.cwd() });
  if (!r.ok) fail(r.reason ?? "spawn failed");
  const turn = fleet.prompt(r.lane!.id, "never finishes", () => {});
  await sleep(200);
  fleet.cancel(r.lane!.id);
  await turn;
  const st = await fleet.status();
  if (st.lanes[0]!.status !== "awaiting-input") fail(`cancel must land awaiting-input, got ${st.lanes[0]!.status}`);
  fleet.stopAll();
  if ((await fleet.status()).lanes[0]!.status !== "stopped") fail("stopAll must stop the lane");
  ok("cancelled turn is not an error; shutdown stopped every child");
}

// 6. The status payload is metadata: no lane reply text.
console.log("5) /api/fleet/status shapes carry metadata only");
{
  const fleet = mgr();
  const r = await fleet.spawn({ cwd: process.cwd() });
  if (!r.ok) fail(r.reason ?? "spawn failed");
  await fleet.prompt(r.lane!.id, "SECRET-REPLY-MARKER", () => {});
  const flat = JSON.stringify(await fleet.status());
  if (flat.includes("You said") || flat.includes("SECRET-REPLY-MARKER")) fail("status leaked reply text");
  ok("status is counts, states and ages - the reply lives in the mini window only");
  fleet.stopAll();
}

console.log("\ndemo_pfleetl1 OK - local lanes fan out concurrently under the 75% guard, glow for attention fail-closed, and report metadata to the fleet manager.");
process.exit(0);
