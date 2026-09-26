// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_p_progress_1.ts
//
// P-PROGRESS.1 (ADR-0404): workers say what they are doing, how far along they probably are, and whether
// they are alive; same-folder turns take turns visibly. Proven headless against the real seams:
//   [1] the estimate is history or nothing, and never finishes a running turn;
//   [2] liveness follows the evidence (dead > watchdog action > streaming > open call > quiet);
//   [3] the folder gate serializes overlapping folders in order and tells the waiter what it waits on;
//   [4] the doing line for a tool call, and the settle of a lane row by call id;
//   [5] two REAL lanes (the fake ACP agent over stdio) on one folder run in serial, with the wait on the wire.
//
// Run: bun run harness/scripts/demo_p_progress_1.ts

import { join } from "node:path";
import { DurationHistory, estimateTurn, livenessVerdict, progressLine, progressView } from "../../desktop/turn_progress.ts";
import { WorkspaceGate } from "../../desktop/workspace_gate.ts";
import { describeTool } from "../../desktop/renderer/tool_describe.ts";
import { settleToolRow, type LaneToolRow } from "../../desktop/renderer/lane_transcript.ts";
import { FleetLaneManager, type LaneEvent } from "../../desktop/fleet_lanes.ts";

const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
const ok = (cond: boolean, m: string) => { if (!cond) fail(m); console.log(`  ok  ${m}`); };

console.log("== #ADR-0404 P-PROGRESS.1: progress, liveness, and same-folder turns ==\n");

console.log("[1] the estimate");
const h = new DurationHistory();
ok(estimateTurn({ elapsedMs: 10_000, model: "m", history: h }).basis === "none", "no history: no number");
for (const ms of [20_000, 40_000, 60_000, 80_000, 100_000]) h.addTurn("m", ms);
const e = estimateTurn({ elapsedMs: 40_000, model: "m", history: h });
ok(e.typicalMs === 80_000 && e.percent === 50 && e.etaMs === 40_000, "p75 of the model's turns is the typical length; 40 s of 80 s is 50%");
ok(estimateTurn({ elapsedMs: 500_000, model: "m", history: h }).percent === 95, "past the typical length the bar stops at 95% and says longer than usual");

console.log("\n[2] liveness");
const now = 1_000_000;
const base = { busy: true, dead: false, lastSignalMs: 0, stepsOpen: [], lastHealth: null, now };
ok(livenessVerdict({ ...base, dead: true }).state === "dead", "a dead child outranks a fresh signal");
ok(livenessVerdict({ ...base, lastSignalMs: 2_000 }).state === "streaming", "a signal within 5 s is streaming");
ok(livenessVerdict({ ...base, lastSignalMs: 600_000, stepsOpen: [{ label: "bash: bun test", elapsedMs: 600_000 }] }).state === "working", "ten silent minutes with a tool call out is working, not stalled");
ok(livenessVerdict({ ...base, lastSignalMs: 60_000 }).state === "quiet", "a minute of silence with nothing out is quiet");
ok(livenessVerdict({ ...base, lastHealth: { action: "recover", at: now - 5_000 } }).state === "recovering", "a recovery five seconds ago is what the user sees");
const p = progressView({ busy: true, dead: false, startedAt: now - 30_000, lastActivityAt: now - 1_000, stepsDone: 2, stepsOpen: [], model: "m", history: h, now });
ok(progressLine(p) === "30 s \u00b7 step 2 \u00b7 about 50 s left (est.)", `the progress line reads: ${progressLine(p)}`);

console.log("\n[3] the folder gate");
let clock = now;
const gate = new WorkspaceGate({ now: () => clock, platform: "linux" });
const releaseA = await gate.acquire({ id: "master", name: "Main", cwd: "/w/repo", etaMs: () => 50_000 });
let told = "";
const bp = gate.acquire({ id: "lane-1", name: "docs", cwd: "/w/repo/docs", etaMs: () => 20_000 }, { onWait: (w) => { told = `${w.on.name}/${w.position}/${w.etaMs}`; } });
ok(told === "Main/1/50000", "a lane in a folder INSIDE the master's waits behind Main, next in line, with the estimated wait");
const cp = gate.acquire({ id: "lane-2", name: "api", cwd: "/w/repo" });
const seq = gate.sequenceFor("/w/repo");
ok(seq.map((s) => `${s.name}:${s.state}`).join(",") === "Main:running,docs:waiting,api:waiting", "the sequence is Main, then docs, then api");
ok(seq[2]!.expectedStartAt === now + 70_000, "api is expected to start after both estimates ahead of it");
const other = await gate.acquire({ id: "lane-3", name: "elsewhere", cwd: "/other" });
ok(gate.queues().length === 1, "a disjoint folder ran at once and is in no queue");
other();
clock += 50_000; releaseA();
const releaseB = await bp;
ok(gate.waitView("lane-2")?.on.name === "docs", "after Main ends, docs runs and api now waits on docs");
releaseB(); (await cp)();
ok(gate.queues().length === 0, "everyone ran, nothing is queued");

console.log("\n[4] the doing line and the settle");
ok(describeTool({ name: "bash", intent: "Running the lane tests", input: "bun test" }).doing === "Running the lane tests", "the agent's intent is the doing line");
ok(describeTool({ name: "execute", title: "execute", input: "bun test desktop" }).doing === "Running bun test desktop", "without one, the sentence names the command");
const rows: LaneToolRow[] = [{ id: "c1", name: "run", detail: "bun test", callId: "call-1", status: "open", open: false }];
ok(settleToolRow(rows, "call-1", "done", 4_200) && rows[0]!.status === "done" && rows[0]!.elapsedMs === 4_200, "a settle closes the row its call opened");
ok(!settleToolRow(rows, "call-9", "failed") && rows.length === 1, "a settle for an unknown call adds nothing");

console.log("\n[5] two real lanes on one folder");
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
  ok(waited.wait.on.name === "alpha", "beta (a folder inside alpha's) is told it waits for alpha");
  const st = await fleet.status();
  ok(st.queues.length === 1 && st.queues[0]!.entries.map((x) => x.name).join(",") === "alpha,beta", "the fleet status lists the shared folder's order");
  ok(st.lanes.find((l) => l.id === a.lane!.id)!.progress?.liveness.state !== undefined, "the running lane carries its progress view");
  fleet.cancel(a.lane!.id); await aTurn;
  await Bun.sleep(200); // the real child must receive beta's prompt before session/cancel reaches it
  fleet.cancel(b.lane!.id); await bTurn;
  ok(bEvents.some((ev) => ev.type === "done"), "beta ran after alpha and settled");
} finally { fleet.stopAll(); delete process.env.FAKE_ACP_MODE; }

console.log("\nP-PROGRESS.1 demo: all checks passed.");
