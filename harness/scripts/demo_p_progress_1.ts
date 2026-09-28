// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_p_progress_1.ts
//
// P-PROGRESS.1 (ADR-0409, amended 2026-09-27): workers say what they are doing, a dead agent process is
// reported with the action that fixes it, and same-folder turns take turns visibly. No estimates, no ETAs,
// no signal ages: the operator cut them as noise. Proven headless against the real seams:
//   [1] the only liveness a worker reports is a dead agent process (it outranks a running turn);
//   [2] the folder gate serializes overlapping folders in order and tells the waiter whom it waits for and
//       its place in line, and nothing about when it will start;
//   [3] the doing line for a tool call, and the settle of a lane row by call id;
//   [4] two REAL lanes (the fake ACP agent over stdio) on one folder run in serial, with the wait on the wire;
//   [5] a REAL lane whose agent process dies mid-turn reports liveness dead in the fleet status.
//
// Run: bun run harness/scripts/demo_p_progress_1.ts

import { join } from "node:path";
import { progressView } from "../../desktop/turn_progress.ts";
import { WorkspaceGate } from "../../desktop/workspace_gate.ts";
import { describeTool } from "../../desktop/renderer/tool_describe.ts";
import { settleToolRow, type LaneToolRow } from "../../desktop/renderer/lane_transcript.ts";
import { FleetLaneManager, type LaneEvent } from "../../desktop/fleet_lanes.ts";

const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
const ok = (cond: boolean, m: string) => { if (!cond) fail(m); console.log(`  ok  ${m}`); };

console.log("== #ADR-0409 P-PROGRESS.1: the dead-process line, the doing line, and same-folder turns ==\n");

console.log("[1] liveness is only reported when it is actionable");
ok(progressView({ busy: true, dead: true }).liveness === "dead", "a dead child outranks a running turn: the restart line shows");
ok(progressView({ busy: true, dead: false }).liveness === "running", "a live running worker is just running: nothing extra shows");
ok(progressView({ busy: false, dead: false }).liveness === "idle", "an idle worker is idle");
ok(Object.keys(progressView({ busy: true, dead: false })).join(",") === "liveness", "the progress view carries no estimate, ETA, or signal age");

console.log("\n[2] the folder gate");
const gate = new WorkspaceGate({ platform: "linux" });
const releaseA = await gate.acquire({ id: "master", name: "Main", cwd: "/w/repo" });
let told = "";
let toldKeys = "";
const bp = gate.acquire({ id: "lane-1", name: "docs", cwd: "/w/repo/docs" }, { onWait: (w) => { told = `${w.on.name}/${w.position}`; toldKeys = Object.keys(w).sort().join(","); } });
ok(told === "Main/1", "a lane in a folder INSIDE the master's waits behind Main, next in line");
ok(toldKeys === "folder,on,position,sequence", "the wait says whom and where in line, with no estimated start");
const cp = gate.acquire({ id: "lane-2", name: "api", cwd: "/w/repo" });
const seq = gate.sequenceFor("/w/repo");
ok(seq.map((s) => `${s.name}:${s.state}:${s.position}`).join(",") === "Main:running:0,docs:waiting:1,api:waiting:2", "the sequence is Main, then docs, then api");
const other = await gate.acquire({ id: "lane-3", name: "elsewhere", cwd: "/other" });
ok(gate.queues().length === 1, "a disjoint folder ran at once and is in no queue");
other();
releaseA();
const releaseB = await bp;
ok(gate.waitView("lane-2")?.on.name === "docs", "after Main ends, docs runs and api now waits on docs");
releaseB(); (await cp)();
ok(gate.queues().length === 0, "everyone ran, nothing is queued");

console.log("\n[3] the doing line and the settle");
ok(describeTool({ name: "bash", intent: "Running the lane tests", input: "bun test" }).doing === "Running the lane tests", "the agent's intent is the doing line");
ok(describeTool({ name: "execute", title: "execute", input: "bun test desktop" }).doing === "Running bun test desktop", "without one, the sentence names the command");
const rows: LaneToolRow[] = [{ id: "c1", name: "run", detail: "bun test", callId: "call-1", status: "open", open: false }];
ok(settleToolRow(rows, "call-1", "done", 4_200) && rows[0]!.status === "done" && rows[0]!.elapsedMs === 4_200, "a settle closes the row its call opened, with how long it took");
ok(!settleToolRow(rows, "call-9", "failed") && rows.length === 1, "a settle for an unknown call adds nothing");

console.log("\n[4] two real lanes on one folder");
const FAKE = join(import.meta.dir, "..", "mcp", "testing", "fake_acp_agent.ts");
process.env.FAKE_ACP_MODE = "hang";
const fleet = new FleetLaneManager({ argv: () => ({ cmd: "bun", args: [FAKE] }), masterModel: () => "demo-model", sample: async () => ({ cpuModel: "t", cores: 8, speedMHz: 4000, cpuBusyPct: 10, memTotalMB: 16_000, memFreeMB: 12_000 }) });
try {
  const a = await fleet.spawn({ cwd: join(import.meta.dir, ".."), name: "alpha" });
  const b = await fleet.spawn({ cwd: import.meta.dir, name: "beta" });
  if (!a.ok || !b.ok) fail(`lanes did not spawn: ${a.reason ?? b.reason}`);
  const bEvents: LaneEvent[] = [];
  const aTurn = fleet.prompt(a.lane!.id, "first", () => {});
  const bTurn = fleet.prompt(b.lane!.id, "second", (ev) => bEvents.push(ev));
  const waited = await new Promise<Extract<LaneEvent, { type: "waiting" }>>((res) => {
    const tick = () => { const w = bEvents.find((ev): ev is Extract<LaneEvent, { type: "waiting" }> => ev.type === "waiting"); if (w) res(w); else setTimeout(tick, 10); };
    tick();
  });
  ok(waited.wait.on.name === "alpha" && waited.wait.position === 1, "beta (a folder inside alpha's) is told it waits for alpha, next in line");
  const st = await fleet.status();
  ok(st.queues.length === 1 && st.queues[0]!.entries.map((x) => x.name).join(",") === "alpha,beta", "the fleet status lists the shared folder's order");
  ok(st.lanes.find((l) => l.id === a.lane!.id)!.progress?.liveness === "running", "the running lane with a live child reports running, so no restart line shows");
  fleet.cancel(a.lane!.id); await aTurn;
  await Bun.sleep(200); // the real child must receive beta's prompt before session/cancel reaches it
  fleet.cancel(b.lane!.id); await bTurn;
  ok(bEvents.some((ev) => ev.type === "done"), "beta ran after alpha and settled");
} finally { fleet.stopAll(); delete process.env.FAKE_ACP_MODE; }

console.log("\n[5] a lane whose agent process dies reports it, so its card shows Restart this lane");
process.env.FAKE_ACP_MODE = "crash";
const crashFleet = new FleetLaneManager({ argv: () => ({ cmd: "bun", args: [FAKE] }), masterModel: () => "demo-model", sample: async () => ({ cpuModel: "t", cores: 8, speedMHz: 4000, cpuBusyPct: 10, memTotalMB: 16_000, memFreeMB: 12_000 }) });
try {
  const c = await crashFleet.spawn({ cwd: import.meta.dir, name: "gamma" });
  if (!c.ok) fail(`lane did not spawn: ${c.reason}`);
  await crashFleet.prompt(c.lane!.id, "do the work", () => {});
  const lane = (await crashFleet.status()).lanes.find((l) => l.id === c.lane!.id)!;
  ok(lane.progress?.liveness === "dead", "the crashed lane's status carries liveness dead, the one state the card acts on");
} finally { crashFleet.stopAll(); delete process.env.FAKE_ACP_MODE; }

console.log("\nP-PROGRESS.1 demo: all checks passed.");
