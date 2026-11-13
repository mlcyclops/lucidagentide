// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-HOLDER.2 (ADR-0573): the lanes an IDE update meets. What must hold, as the person updating sees it:
//   - stuck and idle lanes are offered for stopping; a working one never is, and the prompt says what happens to it;
//   - a lane that runs from the install folder never gets an install over it: a working one leaves only "Later",
//     an idle or stuck one only the "Stop ... and restart" path;
//   - the stop takes only lanes still idle or stuck when the person clicks.

import { describe, expect, test } from "bun:test";
import type { LaneView } from "./fleet_lanes.ts";
import { parseUpdateCheck, stopForUpdate, updateCheck, updatePrompt } from "./update_lanes.ts";

const lane = (id: string, over: Partial<LaneView> & { stuck?: boolean } = {}): LaneView => ({
  id, name: id, cwd: "C:\\w", model: "m", status: "awaiting-input", createdAt: 1, lastActivityAt: 2, turns: 1, canRetry: false, respawns: 0,
  autoApprove: false, sessionAllow: [], sessionId: null, hubSessionId: null, queued: [], promoted: false, openCalls: 0, heldRuntime: "current", ...over,
}) as LaneView;
const stuckProgress = { liveness: { state: "stuck" } } as unknown as LaneView["progress"];

describe("sorting the lanes", () => {
  test("stuck, idle and working; a stopped lane runs nothing and is left out", () => {
    const c = updateCheck([
      lane("a", { status: "awaiting-input" }), lane("b", { status: "done" }), lane("c", { status: "error" }),
      lane("d", { status: "working" }), lane("e", { status: "needs-approval" }), lane("f", { status: "starting" }),
      lane("g", { status: "working", progress: stuckProgress }), lane("h", { status: "stopped" }),
    ]);
    expect(c.lanes.map((l) => [l.id, l.group])).toEqual([["a", "idle"], ["b", "idle"], ["c", "idle"], ["d", "working"], ["e", "working"], ["f", "working"], ["g", "stuck"]]);
    expect([c.idle, c.working, c.stuck, c.blocking]).toEqual([3, 3, 1, 0]);
  });

  test("a lane from the install folder blocks the install; a child of the engine is not held", () => {
    const c = updateCheck([lane("old", { heldRuntime: "install" }), lane("child", { heldRuntime: undefined }), lane("prev", { heldRuntime: "previous" })]);
    expect(c.lanes.map((l) => [l.id, l.held, l.blocksInstall])).toEqual([["old", true, true], ["child", false, false], ["prev", true, false]]);
    expect(parseUpdateCheck(JSON.parse(JSON.stringify(c)))).toEqual(c);
    expect(parseUpdateCheck({ lanes: "nope" })).toBeNull();
  });
});

describe("the update prompt", () => {
  const prompt = (lanes: LaneView[]) => updatePrompt("2.6.0", updateCheck(lanes));

  test("no lanes: Restart now or Later", () => {
    expect(prompt([]).choices.map((c) => c.label)).toEqual(["Restart now", "Later"]);
    expect(updatePrompt("2.6.0", null).choices.map((c) => c.install)).toEqual([true, false]);
  });

  test("idle and stuck are offered for stopping; working ones are named and keep running", () => {
    const p = prompt([lane("idle1"), lane("stuck1", { status: "working", progress: stuckProgress }), lane("busy", { status: "working" })]);
    expect(p.stop).toEqual(["stuck1", "idle1"]);
    expect(p.choices).toEqual([
      { label: "Stop 2 idle or stuck lanes and restart", stop: true, install: true },
      { label: "Restart and keep every lane", stop: false, install: true },
      { label: "Later", stop: false, install: false },
    ]);
    expect(p.detail).toContain('Working (1): "busy". They keep running on the previous version; restart them later to pick up 2.6.0.');
    expect(p.detail).toContain('Look stuck (1): "stuck1".');
  });

  test("only working lanes: no stop button, and a lane that ends with the IDE is called out", () => {
    const p = prompt([lane("held", { status: "working" }), lane("child", { status: "working", heldRuntime: undefined })]);
    expect(p.choices.map((c) => c.label)).toEqual(["Restart now", "Later"]);
    expect(p.detail).toContain('Working, ends when the IDE restarts (1): "child".');
  });

  test("from the install folder: a working one leaves only Later; an idle one only the stop-and-restart path", () => {
    expect(prompt([lane("old", { status: "working", heldRuntime: "install" }), lane("idle1")]).choices.map((c) => c.label)).toEqual(["Later"]);
    expect(prompt([lane("old", { heldRuntime: "install" })]).choices.map((c) => c.label)).toEqual(["Stop 1 idle or stuck lane and restart", "Later"]);
  });
});

describe("stopping for the update", () => {
  test("only lanes still idle or stuck are stopped; one that started working or is gone is kept", () => {
    const stopped: string[] = [];
    const r = stopForUpdate(["a", "b", "c", "gone"], [lane("a"), lane("b", { status: "working" }), lane("c", { status: "working", progress: stuckProgress })], (id) => { stopped.push(id); return { ok: true }; });
    expect(r).toEqual({ stopped: ["a", "c"], kept: [{ id: "b", why: "it started working" }, { id: "gone", why: "not running" }] });
    expect(stopped).toEqual(["a", "c"]);
  });
});
