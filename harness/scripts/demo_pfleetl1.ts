// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_pfleetl1.ts
//
// P-FLEET.L1 (guard evolved by P-FLEET.L2): local lanes - N concurrent headless LUCID agents on one
// machine under the SUSTAINED-pressure guard, streaming into the fleet grid, reporting to the master
// agent. This demo drives the REAL FleetLaneManager against REAL fake-ACP subprocesses (the firewall's
// faithful stand-in) and proves the load-bearing properties headlessly:
//   1. two lanes run turns CONCURRENTLY (the local fan-out);
//   2. the lane model defaults to the MASTER's current model;
//   3. admission ignores a BURST and refuses only a HELD line, with the measured percent + duration;
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

function mgr(snap: SystemSnapshot = healthy, mode?: string, now?: () => number): FleetLaneManager {
  if (mode) process.env.FAKE_ACP_MODE = mode; else delete process.env.FAKE_ACP_MODE;
  return new FleetLaneManager({
    argv: () => ({ cmd: "bun", args: [FAKE] }),
    masterModel: () => "orchestrator-model",
    sample: async () => snap,
    ...(now ? { now } : {}),
  });
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

// 3. Admission: a burst is free, a HELD line refuses with measured numbers, and there is no ceiling.
console.log("2) admission ignores a burst and refuses only a held line");
{
  const pegged: SystemSnapshot = { ...healthy, cpuBusyPct: 99, memFreeMB: 900 }; // 100% cpu, ~94% memory
  const burst = mgr(pegged);
  const spike = await burst.spawn({ cwd: process.cwd() });
  if (!spike.ok) fail(`a single pegged reading is a BURST and must still admit, got: ${spike.reason}`);
  ok("a pegged instant never refuses - that was the old 75% watermark's mistake");
  burst.stopAll();

  // Drive the pressure window with a fake clock: eight readings, 5s apart, all over the line.
  let t = 5_000_000;
  const held = mgr(pegged, undefined, () => t);
  for (let i = 0; i < 8; i++) { await held.status(); t += 5_000; }
  const r = await held.spawn({ cwd: process.cwd() });
  if (r.ok) fail("30 unbroken seconds over the line must refuse");
  if (!/9\d%/.test(r.reason ?? "")) fail(`refusal must carry the measured percent, got: ${r.reason}`);
  if (!/at 9\d% for \d+s/.test(r.reason ?? "")) fail(`refusal must carry the measured DURATION beside the measured percent, got: ${r.reason}`);
  ok(`held-line refusal carries percent and duration - "${r.reason}"`);
  held.stopAll();

  // No ceiling: a 2-core box was capped at ONE lane under P-FLEET.L1.
  const tiny = mgr({ ...healthy, cores: 2 });
  const lanes = [await tiny.spawn({ cwd: process.cwd() }), await tiny.spawn({ cwd: process.cwd() }), await tiny.spawn({ cwd: process.cwd() })];
  if (lanes.some((l) => !l.ok)) fail(`lanes are unlimited; a core-derived ceiling must not exist: ${lanes.map((l) => l.reason ?? "").join(" ")}`);
  if (tiny.liveLanes() !== 3) fail("three lanes must be live on a 2-core box");
  ok("three lanes on two cores - the min(6, cores/2) ceiling is gone");
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

console.log("\ndemo_pfleetl1 OK - unlimited local lanes fan out concurrently under the sustained-pressure guard (a burst is free, a held line is not), glow for attention fail-closed, and report metadata to the fleet manager.");
process.exit(0);
