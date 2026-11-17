// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-HOLDER.2 (ADR-0574): the lanes an IDE update meets. What must hold, as the person updating sees it:
//   - stuck and idle lanes are offered for stopping; a working one never is, and the prompt says what happens to it;
//   - a lane that runs from the install folder never gets an install over it: a working one leaves only "Later",
//     an idle or stuck one only the "Stop ... and restart" path;
//   - the stop takes only lanes still idle or stuck when the person clicks.

import { describe, expect, test } from "bun:test";
import type { LaneView } from "./fleet_lanes.ts";
import { decideInstall, parseUpdateCheck, stopForUpdate, updateCheck, updatePrompt } from "./update_lanes.ts";

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
    expect(updatePrompt("2.6.0", null).choices.map((c) => c.install)).toEqual([true, false]); // no fleet to ask
  });

  test("lanes that could not be read: only Later (fail-closed; a held lane may still run from the install folder)", () => {
    const p = updatePrompt("2.6.0", "unavailable");
    expect(p.choices.map((c) => c.label)).toEqual(["Later"]);
    expect(p.choices.some((c) => c.install)).toBe(false);
    expect(p.stop).toEqual([]);
    expect(p.detail).toContain("could not check");
  });

  test("idle and stuck are offered for stopping; working ones are named and keep running", () => {
    const p = prompt([lane("idle1"), lane("stuck1", { status: "working", progress: stuckProgress }), lane("busy", { status: "working" })]);
    expect(p.stop).toEqual(["stuck1", "idle1"]);
    expect(p.choices).toEqual([
      { label: "Stop 2 idle or stuck agents and restart", stop: true, install: true },
      { label: "Restart and keep every agent", stop: false, install: true },
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
    expect(prompt([lane("old", { heldRuntime: "install" })]).choices.map((c) => c.label)).toEqual(["Stop 1 idle or stuck agent and restart", "Later"]);
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

describe("reading the engine's answer: all or nothing", () => {
  const good = () => JSON.parse(JSON.stringify(updateCheck([lane("a"), lane("b", { status: "working", heldRuntime: "previous" })])));

  test("one malformed row among valid ones makes the whole answer unreadable (Later only)", () => {
    for (const bad of [null, "row", 7, [], { id: "x", name: "x", status: "working", group: "working", held: true }, { name: "x", status: "working", group: "working", held: true, blocksInstall: true, lastActivityAt: 1 }, { id: "x", name: "x", status: "working", group: "busy", held: true, blocksInstall: true, lastActivityAt: 1 }]) {
      const v = good();
      v.lanes.splice(1, 0, bad);
      expect({ bad, parsed: parseUpdateCheck(v) }).toEqual({ bad, parsed: null });
    }
    expect(updatePrompt("2.6.0", parseUpdateCheck({ lanes: [...good().lanes, null] }) ?? "unavailable").choices.map((c) => c.label)).toEqual(["Later"]);
  });

  test("held and blocksInstall must be real booleans; a missing or string one is not read as false", () => {
    for (const [field, value] of [["blocksInstall", "true"], ["blocksInstall", undefined], ["blocksInstall", 1], ["held", "false"], ["held", null], ["lastActivityAt", "2"]] as const) {
      const v = good();
      v.lanes[0][field] = value;
      if (value === undefined) delete v.lanes[0][field];
      expect({ field, value, parsed: parseUpdateCheck(v) }).toEqual({ field, value, parsed: null });
    }
    expect(parseUpdateCheck(good())).toEqual(updateCheck([lane("a"), lane("b", { status: "working", heldRuntime: "previous" })]));
  });
});

describe("every install choice reads the lanes one final time", () => {
  const view = (lanes: LaneView[]) => JSON.parse(JSON.stringify(updateCheck(lanes)));
  /** The engine as the updater sees it: `answers` are its successive update-check answers. */
  const engine = (answers: unknown[], pending = 0, commitOk = true) => {
    const calls: string[] = [];
    let i = 0;
    return {
      calls,
      deps: {
        check: async () => { calls.push("check"); return parseUpdateCheck(answers[Math.min(i++, answers.length - 1)]); },
        stop: async (ids: string[]) => { calls.push(`stop ${ids.join(",")}`); return { stopped: ids }; },
        commit: async (on: boolean) => { calls.push(`commit ${on}`); return commitOk ? { pending: on ? pending : 0 } : null; },
      },
    };
  };
  const installChoices = (lanes: LaneView[]) => { const p = updatePrompt("2.6.0", updateCheck(lanes)); return { p, choices: p.choices.filter((c) => c.install) }; };

  test("Restart now, Restart and keep every lane, and Stop and restart each commit, then check, then install", async () => {
    for (const lanes of [[], [lane("a"), lane("w", { status: "working", heldRuntime: "previous" })]]) {
      const { p, choices } = installChoices(lanes);
      expect(choices.length).toBeGreaterThan(0);
      for (const choice of choices) {
        const e = engine([view(lanes)]);
        expect({ label: choice.label, d: await decideInstall(choice, p.stop, e.deps) }).toEqual({ label: choice.label, d: { install: true } });
        expect({ label: choice.label, calls: e.calls }).toEqual({ label: choice.label, calls: [...(choice.stop ? ["stop a"] : []), "commit true", "check"] });
      }
    }
  });

  test("a lane that started from the install folder while the prompt was open stops every install choice", async () => {
    const before = [lane("a"), lane("w", { status: "working", heldRuntime: "previous" })];
    const after = [...before, lane("late", { status: "working", heldRuntime: "install" })];
    const { p, choices } = installChoices(before);
    expect(choices.map((c) => c.label)).toEqual(["Stop 1 idle or stuck agent and restart", "Restart and keep every agent"]);
    for (const choice of choices) {
      const e = engine([view(after)]);
      expect(await decideInstall(choice, p.stop, e.deps)).toEqual({ install: false, waits: "\"late\" still runs from the install folder. It is offered again at the next launch." });
      expect(e.calls.slice(-3)).toEqual(["commit true", "check", "commit false"]);
    }
  });

  test("Restart now with no lanes waits when the final check fails, the commit fails, or a lane is starting", async () => {
    const [restart] = installChoices([]).choices;
    expect(restart!.label).toBe("Restart now");
    const unreadable = engine([{ lanes: [{ id: "x", name: "x", status: "working", group: "working", held: true, blocksInstall: "true", lastActivityAt: 1 }] }]);
    expect(await decideInstall(restart, [], unreadable.deps)).toEqual({ install: false, waits: "LUCID could not check the agents right before installing. It is offered again at the next launch." });
    expect(unreadable.calls).toEqual(["commit true", "check", "commit false"]);
    const noCommit = engine([view([])], 0, false);
    expect(await decideInstall(restart, [], noCommit.deps)).toEqual({ install: false, waits: "LUCID could not keep new agents from starting from the install folder. It is offered again at the next launch." });
    expect(noCommit.calls).toEqual(["commit true", "commit false"]);
    const starting = engine([view([])], 1);
    expect(await decideInstall(restart, [], starting.deps)).toEqual({ install: false, waits: "An agent is starting from the install folder. It is offered again at the next launch." });
    expect(starting.calls).toEqual(["commit true", "commit false"]);
  });

  test("Later neither checks nor installs", async () => {
    const e = engine([view([])]);
    expect(await decideInstall({ label: "Later", stop: false, install: false }, [], e.deps)).toEqual({ install: false, waits: null });
    expect(e.calls).toEqual([]);
  });
});
