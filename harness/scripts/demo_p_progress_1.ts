// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_p_progress_1.ts
//
// P-PROGRESS.1 (ADR-0409, amended 2026-09-27): workers say what they are doing, a dead agent process is
// reported with the action that fixes it, and (P-WAIT.1) workers wait for each other only on the SAME
// file. No estimates, no ETAs, no signal ages: the operator cut them as noise. Proven headless against the
// real seams:
//   [1] the only liveness a worker reports is a dead agent process (it outranks a running turn);
//   [2] write claims: different files in one folder never wait; a write to a file another running turn
//       holds waits, is told whom and which file, and goes through when that turn ends;
//   [3] the doing line for a tool call, and the settle of a lane row by call id;
//   [4] two REAL lanes (the fake ACP agent over stdio) on one folder both reach their agent at once;
//   [5] a REAL lane whose agent process dies mid-turn reports liveness dead in the fleet status.
//
// Run: bun run harness/scripts/demo_p_progress_1.ts

import { join } from "node:path";
import { progressView } from "../../desktop/turn_progress.ts";
import { WriteClaims, type WaitView } from "../../desktop/write_claims.ts";
import { describeTool } from "../../desktop/renderer/tool_describe.ts";
import { settleToolRow, type LaneToolRow } from "../../desktop/renderer/lane_transcript.ts";
import { FleetLaneManager, type LaneEvent } from "../../desktop/fleet_lanes.ts";

const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
const ok = (cond: boolean, m: string) => { if (!cond) fail(m); console.log(`  ok  ${m}`); };

console.log("== #ADR-0409 P-PROGRESS.1 / P-WAIT.1: the dead-process line, the doing line, and same-file waits ==\n");

console.log("[1] liveness is only reported when it is actionable");
ok(progressView({ busy: true, dead: true }).liveness === "dead", "a dead child outranks a running turn: the restart line shows");
ok(progressView({ busy: true, dead: false }).liveness === "running", "a live running worker is just running: nothing extra shows");
ok(progressView({ busy: false, dead: false }).liveness === "idle", "an idle worker is idle");
ok(Object.keys(progressView({ busy: true, dead: false })).join(",") === "liveness", "the progress view carries no estimate, ETA, or signal age");

console.log("\n[2] write claims: only the same file waits");
const claims = new WriteClaims({ platform: "linux" });
const MAIN = { id: "master", name: "Main" };
ok(!(await claims.acquire(MAIN, ["src/app.ts"], "/w/repo", { waitMs: 0 })).held, "Main's turn claims src/app.ts");
const told: (WaitView | null)[] = [];
ok(!(await claims.acquire({ id: "lane-1", name: "docs" }, ["docs/guide.md"], "/w/repo", { waitMs: 5_000, onWait: (w) => told.push(w) })).held && told.length === 0, "a spoke in the SAME folder writing another file never waits");
const apiWrite = claims.acquire({ id: "lane-2", name: "api" }, ["/w/repo/src/app.ts"], "/elsewhere", { waitMs: 5_000, onWait: (w) => told.push(w) });
ok(JSON.stringify(told[0]) === JSON.stringify({ on: MAIN, file: "app.ts" }), "a spoke writing Main's file waits, told whom and which file (a basename)");
claims.endTurn("master");
ok(!(await apiWrite).held && told[1] === null, "Main's turn ends: the spoke's write goes through and the wait line clears");

console.log("\n[3] the doing line and the settle");
ok(describeTool({ name: "bash", intent: "Running the lane tests", input: "bun test" }).doing === "Running the lane tests", "the agent's intent is the doing line");
ok(describeTool({ name: "execute", title: "execute", input: "bun test desktop" }).doing === "Running bun test desktop", "without one, the sentence names the command");
const rows: LaneToolRow[] = [{ id: "c1", name: "run", detail: "bun test", callId: "call-1", status: "open", open: false }];
ok(settleToolRow(rows, "call-1", "done", 4_200) && rows[0]!.status === "done" && rows[0]!.elapsedMs === 4_200, "a settle closes the row its call opened, with how long it took");
ok(!settleToolRow(rows, "call-9", "failed") && rows.length === 1, "a settle for an unknown call adds nothing");

console.log("\n[4] two real lanes on one folder run at the same time");
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
  ok(st.lanes.find((l) => l.id === a.lane!.id)!.progress?.liveness === "running", "the running lane with a live child reports running, so no restart line shows");
  fleet.cancel(a.lane!.id); fleet.cancel(b.lane!.id);
  await Promise.all([aTurn, bTurn]);
  ok(aEvents.some((ev) => ev.type === "done") && bEvents.some((ev) => ev.type === "done"), "both turns settled");
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
