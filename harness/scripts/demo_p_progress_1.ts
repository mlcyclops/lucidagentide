// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_p_progress_1.ts
//
// P-PROGRESS.1 (ADR-0409): workers say what they are doing, how far along they probably are, and whether
// they are alive; (P-WAIT.1) workers wait for each other only on the SAME file. Proven headless against
// the real seams:
//   [1] the estimate is history or nothing, and never finishes a running turn;
//   [2] liveness follows the evidence (dead > watchdog action > streaming > open call > quiet);
//   [3] write claims: different files in one folder never wait; a write to a file another running turn
//       holds waits, is told whom and which file, and goes through when that turn ends;
//   [4] the doing line for a tool call, and the settle of a lane row by call id;
//   [5] two REAL lanes (the fake ACP agent over stdio) on one folder both reach their agent at once.
//
// Run: bun run harness/scripts/demo_p_progress_1.ts

import { join } from "node:path";
import { DurationHistory, estimateTurn, livenessVerdict, progressLine, progressView } from "../../desktop/turn_progress.ts";
import { WriteClaims, type WaitView } from "../../desktop/write_claims.ts";
import { describeTool } from "../../desktop/renderer/tool_describe.ts";
import { settleToolRow, type LaneToolRow } from "../../desktop/renderer/lane_transcript.ts";
import { FleetLaneManager, type LaneEvent } from "../../desktop/fleet_lanes.ts";

const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
const ok = (cond: boolean, m: string) => { if (!cond) fail(m); console.log(`  ok  ${m}`); };

console.log("== #ADR-0409 P-PROGRESS.1 / P-WAIT.1: progress, liveness, and same-file waits ==\n");

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
ok(progressLine(p, true) === "30 s \u00b7 step 2 \u00b7 about 50 s left (est.)", `with the estimate opted in (P-PROGRESS.3) the progress line reads: ${progressLine(p, true)}`);
ok(progressLine(p, false) === "30 s \u00b7 step 2", "by default (estimate off) it carries no number");

console.log("\n[3] write claims: only the same file waits");
const claims = new WriteClaims({ platform: "linux" });
const MAIN = { id: "master", name: "Main" };
ok(!(await claims.acquire(MAIN, ["src/app.ts"], "/w/repo", { waitMs: 0 })).held, "Main's turn claims src/app.ts");
const told: (WaitView | null)[] = [];
ok(!(await claims.acquire({ id: "lane-1", name: "docs" }, ["docs/guide.md"], "/w/repo", { waitMs: 5_000, onWait: (w) => told.push(w) })).held && told.length === 0, "a spoke in the SAME folder writing another file never waits");
const apiWrite = claims.acquire({ id: "lane-2", name: "api" }, ["/w/repo/src/app.ts"], "/elsewhere", { waitMs: 5_000, onWait: (w) => told.push(w) });
ok(JSON.stringify(told[0]) === JSON.stringify({ on: MAIN, file: "app.ts" }), "a spoke writing Main's file waits, told whom and which file (a basename)");
claims.endTurn("master");
ok(!(await apiWrite).held && told[1] === null, "Main's turn ends: the spoke's write goes through and the wait line clears");

console.log("\n[4] the doing line and the settle");
ok(describeTool({ name: "bash", intent: "Running the lane tests", input: "bun test" }).doing === "Running the lane tests", "the agent's intent is the doing line");
ok(describeTool({ name: "execute", title: "execute", input: "bun test desktop" }).doing === "Running bun test desktop", "without one, the sentence names the command");
const rows: LaneToolRow[] = [{ id: "c1", name: "run", detail: "bun test", callId: "call-1", status: "open", open: false }];
ok(settleToolRow(rows, "call-1", "done", 4_200) && rows[0]!.status === "done" && rows[0]!.elapsedMs === 4_200, "a settle closes the row its call opened");
ok(!settleToolRow(rows, "call-9", "failed") && rows.length === 1, "a settle for an unknown call adds nothing");

console.log("\n[5] two real lanes on one folder run at the same time");
const FAKE = join(import.meta.dir, "..", "mcp", "testing", "fake_acp_agent.ts");
process.env.FAKE_ACP_MODE = "midturn"; // each child streams output on receiving its prompt, then keeps the turn open
const fleet = new FleetLaneManager({ argv: () => ({ cmd: "bun", args: [FAKE] }), masterModel: () => "demo-model", sample: async () => ({ cpuModel: "t", cores: 8, speedMHz: 4000, cpuBusyPct: 10, memTotalMB: 16_000, memFreeMB: 12_000 }) });
try {
  const a = await fleet.spawn({ cwd: join(import.meta.dir, ".."), name: "alpha" });
  const b = await fleet.spawn({ cwd: import.meta.dir, name: "beta" }); // a folder INSIDE alpha's
  if (!a.ok || !b.ok) fail(`lanes did not spawn: ${a.reason ?? b.reason}`);
  const aEvents: LaneEvent[] = [];
  const bEvents: LaneEvent[] = [];
  const aTurn = fleet.prompt(a.lane!.id, "first", (ev) => aEvents.push(ev));
  const bTurn = fleet.prompt(b.lane!.id, "second", (ev) => bEvents.push(ev));
  const streamed = (events: LaneEvent[]): Promise<void> => {
    const { promise, resolve } = Promise.withResolvers<void>();
    const tick = () => { if (events.some((ev) => ev.type === "token")) resolve(); else setTimeout(tick, 10); };
    tick();
    return promise;
  };
  await Promise.all([streamed(aEvents), streamed(bEvents)]);
  ok(![...aEvents, ...bEvents].some((ev) => ev.type === "waiting"), "beta's prompt reached its agent while alpha's turn was still open: nobody waited");
  const st = await fleet.status();
  ok(st.lanes.find((l) => l.id === a.lane!.id)!.progress?.liveness.state !== undefined, "the running lane carries its progress view");
  fleet.cancel(a.lane!.id); fleet.cancel(b.lane!.id);
  await Promise.all([aTurn, bTurn]);
  ok(aEvents.some((ev) => ev.type === "done") && bEvents.some((ev) => ev.type === "done"), "both turns settled");
} finally { fleet.stopAll(); delete process.env.FAKE_ACP_MODE; }

console.log("\nP-PROGRESS.1 demo: all checks passed.");
