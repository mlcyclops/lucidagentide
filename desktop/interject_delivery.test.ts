// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/interject_delivery.test.ts - ADR-0414: "Push not delivered" on an attached spoke.
//
// The operator's report: the main composer attached to a spoke ("ON SPOKE fix a brochure"), Push now, and
// the toast "The note was refused - the per-turn note cap may be full". The cap is not per turn: it counts
// notes WAITING for the lane's next tool result, and before ADR-0414 a tool result was the only way out.
// Every attach and every release queues an operator note for the lane (app.ts promoteLane / demoteLane),
// so four attach/release rounds on an idle spoke filled the eight slots, and the next turn refused the
// user's push until the agent happened to call a tool. These tests drive the REAL lane manager against the
// fake ACP agent over stdio, wired to the real interject store exactly as dev.ts wires it.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { FleetLaneManager, type LaneEvent } from "./fleet_lanes.ts";
import { HEALTH_PROBE_NOTE } from "./health_watch.ts";
import { __resetInterjects, addInterject, carryPendingNotes, pendingInterjectCount } from "./interject_store.ts";
import { demoteAgentNote, promoteAgentNote } from "./renderer/composer_target.ts";

const FAKE = join(import.meta.dir, "..", "harness", "mcp", "testing", "fake_acp_agent.ts");
const TIMEOUT = 20_000;

let live: FleetLaneManager | null = null;
beforeEach(() => __resetInterjects());
afterEach(() => { live?.stopAll(); live = null; delete process.env.FAKE_ACP_MODE; });

/** The lane manager as dev.ts builds it, as far as notes go. `onCarry` fires when the prompt's notes
 *  have been drained, which is the moment the prompt goes out (the fake in hang mode sends nothing back). */
function manager(mode: string, onCarry: () => void = () => {}): FleetLaneManager {
  process.env.FAKE_ACP_MODE = mode;
  return new FleetLaneManager({
    argv: () => ({ cmd: "bun", args: [FAKE] }),
    masterModel: () => "m",
    sample: async () => ({ cpuModel: "t", cores: 8, speedMHz: 4000, cpuBusyPct: 10, memTotalMB: 16_000, memFreeMB: 12_000 }),
    interject: (laneId, text) => { addInterject(laneId, text); },
    carriedNotes: (laneId) => { const block = carryPendingNotes(laneId); onCarry(); return block; },
  });
}

async function attachReleaseRounds(id: string, rounds: number): Promise<void> {
  const target = { kind: "lane" as const, laneId: id, name: "fix a brochure", cwd: import.meta.dir, model: "m" };
  for (let i = 0; i < rounds; i++) { addInterject(id, promoteAgentNote(target)); addInterject(id, demoteAgentNote(target)); }
}

test("attach/release notes on an idle spoke no longer fill the cap: the user's push into its next turn lands", async () => {
  const sent = Promise.withResolvers<void>();
  live = manager("hang", () => sent.resolve());
  const id = (await live.spawn({ cwd: import.meta.dir, name: "fix a brochure" })).lane!.id;
  await attachReleaseRounds(id, 4);
  expect(pendingInterjectCount(id)).toBe(8); // the state the operator was in
  const turn = live.prompt(id, "fix a brochure", () => {}); // a long turn with no tool step yet
  await sent.promise;
  expect(pendingInterjectCount(id)).toBe(0); // they rode the prompt
  const push = addInterject(id, "use the blue logo", { running: live.laneRunning(id), live: true });
  expect(push).toEqual({ ok: true });
  live.cancel(id);
  await turn;
}, TIMEOUT);

test("notes queued while the lane had no tool step reach the agent once, with the next prompt; a stale probe does not", async () => {
  live = manager("clean");
  const id = (await live.spawn({ cwd: import.meta.dir })).lane!.id;
  await attachReleaseRounds(id, 1);
  addInterject(id, HEALTH_PROBE_NOTE); // asked about a turn that has since ended
  const first: LaneEvent[] = [];
  await live.prompt(id, "REQ-7731", (e) => first.push(e));
  const said = first.flatMap((e) => (e.type === "token" ? [e.text] : [])).join("");
  expect(said).toContain("your session is now being driven from the MAIN COMPOSER");
  expect(said).toContain("RETURNED to your fleet lane card");
  expect(said).not.toContain("Status?");
  expect(said.indexOf("RETURNED")).toBeLessThan(said.indexOf("REQ-7731")); // before the request, not after
  const second: LaneEvent[] = [];
  await live.prompt(id, "pong", (e) => second.push(e));
  expect(second.flatMap((e) => (e.type === "token" ? [e.text] : [])).join("")).not.toContain("MAIN COMPOSER"); // exactly once
}, TIMEOUT);

test("a live push is refused by name when the lane's turn is not running; no note is parked for a lane that is gone", async () => {
  live = manager("clean");
  const id = (await live.spawn({ cwd: import.meta.dir })).lane!.id;
  expect(addInterject(id, "too late", { running: live.laneRunning(id), live: true })).toMatchObject({ ok: false, code: "idle" });
  expect(addInterject("lane-gone", "anyone?", { running: live.laneRunning("lane-gone"), live: false })).toMatchObject({ ok: false, code: "unknown-target" });
  expect(pendingInterjectCount(id) + pendingInterjectCount("lane-gone")).toBe(0);
  // The harness's own note to an idle lane still queues: it is for whatever the lane does next.
  expect(addInterject(id, "released from the main composer", { running: live.laneRunning(id), live: false })).toEqual({ ok: true });
}, TIMEOUT);
