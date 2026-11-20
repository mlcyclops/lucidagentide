// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_model.test.ts - P-VIZ.1 (ADR-0622): the Visualize view's rules. The rate is an
// estimate and must say so; a surge is a jump against the node's own trailing mean; every power-down names
// its real cause; a lane watched by two streams counts once; the layout and the perf budgets are fixed.

import { describe, expect, test } from "bun:test";
import { orbitSlots } from "./orbit_layout.ts";
import type { VizBusEvent } from "./viz_bus.ts";
import { createDemo, DEMO_CYCLE_MS } from "./viz_demo.ts";
import {
  applyEvent, applyFleet, applyLaneStatus, applyRuns, census, createOutput, createVizState, cubeHalf, describeNode, drainEvents, edgesOf, fmtRate, foldOutput, frameInterval,
  GONE_MS, HUB_ID, idleSeconds, OUT_CHARS, OUT_TURNS, layoutPositions, LOG_MAX, markAsked, personaFor, shortLabel, superviseText, teamOf, tick, vizTierOpts,
  type PowerKind, type VizEvent, type VizState,
} from "./viz_model.ts";

const T0 = 1_000_000;
const tok = (source: string, chars: number, origin: VizBusEvent["origin"] = "lane"): VizBusEvent => ({ source, origin, e: { type: "token", text: "x".repeat(chars) } });
const ev = (source: string, e: { type: string; [k: string]: unknown }, origin: VizBusEvent["origin"] = "lane"): VizBusEvent => ({ source, origin, e });
const lane = (id: string, status: string, name = id) => ({ id, name, model: "m", status });
const powers = (events: readonly VizEvent[]): { node: string; power: PowerKind }[] =>
  events.flatMap((e) => (e.kind === "power" ? [{ node: e.node, power: e.power }] : []));

/** Stream `charsPer100ms` to `source` for `ms`, ticking every 100 ms; returns the time reached. */
function stream(s: VizState, source: string, charsPer100ms: number, from: number, ms: number): number {
  let t = from;
  for (let i = 0; i < ms / 100; i++) {
    t += 100;
    if (charsPer100ms > 0) applyEvent(s, tok(source, charsPer100ms), t);
    tick(s, t);
  }
  return t;
}

describe("personaFor", () => {
  test("the hub leads; a known agent type wins over keywords", () => {
    expect(personaFor({ kind: "hub", text: "write tests" })).toBe("lead");
    expect(personaFor({ kind: "subagent", agentType: "explore", text: "write tests" })).toBe("scout");
    expect(personaFor({ kind: "subagent", agentType: "security-reviewer" })).toBe("guard");
  });
  test("keywords in priority order, word-bounded", () => {
    expect(personaFor({ kind: "agent", text: "security review of auth" })).toBe("guard");
    expect(personaFor({ kind: "subagent", agentType: "task", text: "Write tests for the parser" })).toBe("tester");
    expect(personaFor({ kind: "agent", text: "research_caching_options" })).toBe("researcher");
    expect(personaFor({ kind: "agent", text: "Draft an explanation" })).toBe("writer");
    expect(personaFor({ kind: "agent", text: "pull the latest changes" })).toBe("coder");
    expect(personaFor({ kind: "agent", text: "api-refactor" })).toBe("coder");
  });
  test("labels stay one short line", () => {
    expect(shortLabel("  a   b  ")).toBe("a b");
    expect(shortLabel("a-very-long-agent-name-indeed", 10)).toBe("a-very-lo\u2026");
  });
});

describe("estimated rate", () => {
  test("chars / 4 folded into a ~1 s EMA: 10 tokens per 100 ms reads about 100 est. tok/s", () => {
    const s = createVizState(T0);
    applyFleet(s, [lane("L1", "working")], T0);
    stream(s, "L1", 40, T0, 3000);
    const r = s.nodes.get("L1")!.rate;
    expect(r).toBeGreaterThan(90);
    expect(r).toBeLessThan(101);
    expect(fmtRate(r)).toMatch(/est\. tok\/s$/);
  });
  test("the rate decays to zero when the stream stops, and the totals keep the count", () => {
    const s = createVizState(T0);
    applyFleet(s, [lane("L1", "working")], T0);
    let t = stream(s, "L1", 40, T0, 2000);
    t = stream(s, "L1", 0, t, 10_000);
    const n = s.nodes.get("L1")!;
    expect(n.rate).toBe(0);
    expect(n.totalTok).toBe(200);
  });
  test("a lane carried by two streams at once counts once", () => {
    const s = createVizState(T0);
    applyFleet(s, [lane("L1", "working")], T0);
    applyEvent(s, tok("L1", 40, "lane"), T0 + 10);
    applyEvent(s, tok("L1", 40, "chat"), T0 + 20); // the composer attached to the same lane
    applyEvent(s, tok("L1", 40, "lane"), T0 + 30);
    expect(s.nodes.get("L1")!.totalTok).toBe(20);
  });
  test("events for a source the fleet has not listed are dropped", () => {
    const s = createVizState(T0);
    applyEvent(s, tok("ghost", 400), T0 + 10);
    expect(s.nodes.has("ghost")).toBe(false);
  });
});

describe("surges", () => {
  test("a jump against the trailing mean emits one surge; a steady rate does not", () => {
    const s = createVizState(T0);
    applyFleet(s, [lane("L1", "working")], T0);
    let t = stream(s, "L1", 8, T0, 10_000); // 20 est. tok/s
    drainEvents(s);
    t = stream(s, "L1", 8, t, 5000);
    expect(drainEvents(s).filter((e) => e.kind === "surge")).toHaveLength(0);
    stream(s, "L1", 80, t, 1000); // 200 est. tok/s
    const surges = drainEvents(s).filter((e) => e.kind === "surge");
    expect(surges).toHaveLength(1);
    expect(surges[0]).toMatchObject({ node: "L1" });
  });
});

describe("power-downs name their cause", () => {
  test("a failed tool call (tool-meta ok=false on Main, a failed lane tool) is tool-failed and recovers", () => {
    const s = createVizState(T0);
    applyFleet(s, [lane("L1", "working")], T0);
    applyEvent(s, ev(HUB_ID, { type: "tool-meta", id: "c1", name: "bash", ok: false }, "chat"), T0 + 1);
    applyEvent(s, ev("L1", { type: "tool", id: "c2", name: "edit", detail: "", status: "failed" }), T0 + 2);
    expect(powers(drainEvents(s))).toEqual([{ node: HUB_ID, power: "tool-failed" }, { node: "L1", power: "tool-failed" }]);
    expect(s.nodes.get("L1")!.status).toBe("active");
    expect(s.nodes.get("L1")!.toolFails).toBe(1);
  });
  test("Stop turn then the lane going idle reads as paused; a natural turn end as ended", () => {
    const s = createVizState(T0);
    applyFleet(s, [lane("L1", "working"), lane("L2", "working")], T0);
    drainEvents(s);
    markAsked(s, "L1", "cancel");
    applyFleet(s, [lane("L1", "done"), lane("L2", "done")], T0 + 100);
    expect(powers(drainEvents(s))).toEqual([{ node: "L1", power: "paused" }, { node: "L2", power: "ended" }]);
    expect(s.nodes.get("L1")!.status).toBe("paused");
    expect(s.nodes.get("L2")!.status).toBe("idle");
    expect(edgesOf(s, T0 + 100).find((e) => e.from === "L1")!.frozen).toBe(true);
  });
  test("a stopped agent ends; an error or a forced removal kills, and a removed node leaves after its effect", () => {
    const s = createVizState(T0);
    applyFleet(s, [lane("L1", "working"), lane("L2", "working"), lane("L3", "idle")], T0);
    drainEvents(s);
    applyLaneStatus(s, s.nodes.get("L1")!, "stopped", T0 + 10);
    applyEvent(s, ev("L2", { type: "status", status: "error" }), T0 + 20);
    markAsked(s, "L3", "kill");
    applyFleet(s, [lane("L1", "stopped"), lane("L2", "error")], T0 + 30);
    expect(powers(drainEvents(s))).toEqual([{ node: "L1", power: "ended" }, { node: "L2", power: "killed" }, { node: "L3", power: "killed" }]);
    tick(s, T0 + 30 + GONE_MS);
    expect(s.nodes.has("L3")).toBe(false);
    expect(s.nodes.get("L1")!.status).toBe("ended");
  });
  test("a respawn after a kill wakes the node clean", () => {
    const s = createVizState(T0);
    applyFleet(s, [lane("L1", "error")], T0);
    expect(s.nodes.get("L1")!.status).toBe("killed");
    applyFleet(s, [lane("L1", "starting")], T0 + 10);
    expect(s.nodes.get("L1")!.status).toBe("active");
  });
});

describe("subagents", () => {
  test("a delegation adds one node per assignment; the run poll drives it and its hover never claims a rate", () => {
    const s = createVizState(T0);
    applyEvent(s, ev(HUB_ID, { type: "subagent", id: "b1", agent: "task", title: "t", assignments: ["Write tests for x", "Review y"], names: ["tests-x", "review-y"] }, "chat"), T0);
    const kids = [...s.nodes.values()].filter((n) => n.kind === "subagent");
    expect(kids.map((k) => [k.name, k.persona])).toEqual([["tests-x", "tester"], ["review-y", "reviewer"]]);
    applyRuns(s, [{ name: "tests-x", done: false, lastAt: T0 + 900, assignment: "Write tests for x", model: null, tools: 3, steps: [] }], T0 + 1000);
    const n = kids[0]!;
    expect(n.tools).toBe(3);
    const d = describeNode(n, T0 + 1000);
    expect(d.lines).toContain("live, 3 tools");
    expect(d.lines.join(" ")).not.toContain("tok/s");
    expect(edgesOf(s, T0 + 1000).find((e) => e.from === n.id)!.rate).toBeNull();
    drainEvents(s);
    applyRuns(s, [{ name: "tests-x", done: true, lastAt: T0 + 1500, endedAt: T0 + 1500, assignment: "Write tests for x", model: null, tools: 4, steps: [] }], T0 + 2000);
    expect(powers(drainEvents(s))).toEqual([{ node: n.id, power: "ended" }]);
  });
  test("a run nobody announced joins when live, but an old finished one does not", () => {
    const s = createVizState(T0);
    applyRuns(s, [
      { name: "live-one", done: false, lastAt: T0, assignment: "a", model: null, tools: 0, steps: [] },
      { name: "old-one", done: true, lastAt: T0 - 600_000, endedAt: T0 - 600_000, assignment: "b", model: null, tools: 0, steps: [] },
    ], T0);
    expect(s.nodes.has("run:live-one")).toBe(true);
    expect(s.nodes.has("run:old-one")).toBe(false);
  });
  test("a lane's delegation ends with the lane's turn", () => {
    const s = createVizState(T0);
    applyFleet(s, [lane("L1", "working")], T0);
    applyEvent(s, ev("L1", { type: "subagent", id: "b", agent: "plan", title: "p", assignments: ["Plan it"] }), T0 + 1);
    applyEvent(s, ev("L1", { type: "done" }), T0 + 2);
    const kid = [...s.nodes.values()].find((n) => n.kind === "subagent")!;
    expect(kid.persona).toBe("planner");
    expect(kid.status).toBe("ended");
  });
  test("P-VIZ.4: a lane's background delegation hangs off the lane and outlives the task call and the turn; its run poll ends it", () => {
    const s = createVizState(T0);
    applyFleet(s, [lane("L1", "working")], T0);
    applyEvent(s, ev("L1", { type: "tool", id: "tc1", name: "other", detail: "task", status: "open" }), T0 + 1);
    applyEvent(s, ev("L1", { type: "subagent", id: "tc1", agent: "task", title: "task", assignments: ["Fix app.py", "Write smoke tests"], names: ["FixApp", "SmokeScript"] }), T0 + 1);
    const kids = () => [...s.nodes.values()].filter((n) => n.kind === "subagent");
    expect(kids().map((k) => [k.name, k.parent])).toEqual([["FixApp", "L1"], ["SmokeScript", "L1"]]);
    // omp returns "Spawned 2 background agents" at once: the call settles, the subagents keep running.
    applyEvent(s, ev("L1", { type: "tool", id: "tc1", name: "other", detail: "task", status: "done", elapsedMs: 40 }), T0 + 50);
    expect(kids().every((k) => k.status === "active")).toBe(true);
    const run = (name: string, done: boolean, at: number) => ({ name, done, lastAt: at, ...(done ? { endedAt: at } : {}), assignment: "", model: null, tools: 1, steps: [] });
    applyRuns(s, [run("FixApp", false, T0 + 900), run("SmokeScript", false, T0 + 900)], T0 + 1000, "L1");
    applyEvent(s, ev("L1", { type: "done" }), T0 + 1100);
    expect(kids().every((k) => k.status === "active")).toBe(true);
    drainEvents(s);
    applyRuns(s, [run("FixApp", true, T0 + 2000), run("SmokeScript", false, T0 + 2000)], T0 + 2100, "L1");
    expect(powers(drainEvents(s))).toEqual([{ node: kids()[0]!.id, power: "ended" }]);
    expect(kids()[1]!.status).toBe("active");
  });
  test("P-VIZ.4: lane runs stay under their own lane, even with the same run name as another lane's", () => {
    const s = createVizState(T0);
    applyFleet(s, [lane("L1", "working"), lane("L2", "working")], T0);
    const run = { name: "Reviewer", done: false, lastAt: T0, assignment: "Audit", model: null, tools: 0, steps: [] };
    applyRuns(s, [run], T0, "L1");
    applyRuns(s, [run], T0, "L2");
    applyRuns(s, [run], T0, "gone-lane");
    expect([...s.nodes.values()].filter((n) => n.kind === "subagent").map((n) => [n.id, n.parent])).toEqual([["run:L1:Reviewer", "L1"], ["run:L2:Reviewer", "L2"]]);
  });
  test("P-VIZ.4: a failed task call kills the batch it announced", () => {
    const s = createVizState(T0);
    applyFleet(s, [lane("L1", "working")], T0);
    applyEvent(s, ev("L1", { type: "subagent", id: "tc9", agent: "reviewer", title: "task", assignments: ["Review tests"], names: ["TestReviewer"] }), T0 + 1);
    drainEvents(s);
    applyEvent(s, ev("L1", { type: "tool", id: "tc9", name: "other", detail: "task", status: "failed" }), T0 + 2);
    const kid = [...s.nodes.values()].find((n) => n.kind === "subagent")!;
    expect(kid.status).toBe("killed");
    expect(powers(drainEvents(s))).toEqual([{ node: "L1", power: "tool-failed" }, { node: kid.id, power: "killed" }]);
  });
});

describe("P-VIZ.4 node panel output", () => {
  test("a watch seed, the live stream, a sent prompt and a turn end read like the card's transcript", () => {
    const o = createOutput();
    foldOutput(o, { type: "watch-seed", turns: [{ role: "user", text: "Fix app.py" }, { role: "assistant", text: "Done." }, { role: "system", text: "x" }] });
    expect(o.seeded).toBe(true);
    expect(o.turns).toEqual([{ role: "user", text: "Fix app.py" }, { role: "assistant", text: "Done." }]);
    foldOutput(o, { type: "user", text: "Now add tests" });
    foldOutput(o, { type: "token", text: "Reading" });
    foldOutput(o, { type: "tool", id: "c1", name: "read", detail: "app.py", status: "open" });
    foldOutput(o, { type: "tool", id: "c1", name: "read", detail: "app.py", status: "done" });
    foldOutput(o, { type: "token", text: "Wrote them." });
    expect(o.live).toBe("Reading\n> app.py\nWrote them.");
    foldOutput(o, { type: "done" });
    expect(o.live).toBe("");
    expect(o.turns.slice(-2)).toEqual([{ role: "user", text: "Now add tests" }, { role: "assistant", text: "Reading\n> app.py\nWrote them." }]);
    foldOutput(o, { type: "error", message: "boom" });
    expect(o.turns.at(-1)).toEqual({ role: "assistant", text: "Error: boom" });
  });
  test("bounded: the newest turns and the newest text are kept", () => {
    const o = createOutput();
    for (let i = 0; i < OUT_TURNS + 3; i++) foldOutput(o, { type: "user", text: `p${i}` });
    expect(o.turns).toHaveLength(OUT_TURNS);
    expect(o.turns.at(-1)!.text).toBe(`p${OUT_TURNS + 2}`);
    foldOutput(o, { type: "token", text: "a".repeat(OUT_CHARS) + "END" });
    expect(o.live).toHaveLength(OUT_CHARS);
    expect(o.live.endsWith("END")).toBe(true);
  });
});

describe("P-VIZ.4 boss and idle clock", () => {
  test("Main not streaming while an agent works is supervising them; with nobody working it is just idle", () => {
    const s = createVizState(T0);
    applyFleet(s, [lane("L1", "working"), lane("L2", "working"), lane("L3", "done")], T0);
    const hub = s.nodes.get(HUB_ID)!;
    expect(teamOf(s, HUB_ID)).toEqual({ agents: 2, subagents: 0 });
    expect(describeNode(hub, T0, teamOf(s, HUB_ID)).lines).toContain("supervising 2 agents");
    expect(superviseText({ agents: 1, subagents: 2 })).toBe("supervising 1 agent and 2 subagents");
    applyFleet(s, [lane("L1", "done"), lane("L2", "done"), lane("L3", "done")], T0 + 1000);
    expect(teamOf(s, HUB_ID)).toEqual({ agents: 0, subagents: 0 });
    expect(describeNode(hub, T0 + 1000, teamOf(s, HUB_ID)).lines).toContain("idle");
    // Main streaming is Main working, never supervising.
    applyEvent(s, tok(HUB_ID, 40, "chat"), T0 + 1100);
    applyFleet(s, [lane("L1", "working")], T0 + 1200);
    expect(describeNode(hub, T0 + 1200, teamOf(s, HUB_ID)).lines.join(" ")).not.toContain("supervising");
  });
  test("an agent's team is its own subagents only", () => {
    const s = createVizState(T0);
    applyFleet(s, [lane("L1", "done"), lane("L2", "working")], T0);
    applyRuns(s, [{ name: "a", done: false, lastAt: T0, assignment: "x", model: null, tools: 0, steps: [] }], T0, "L1");
    expect(teamOf(s, "L1")).toEqual({ agents: 0, subagents: 1 });
    expect(teamOf(s, "L2")).toEqual({ agents: 0, subagents: 0 });
  });
  test("idleSince starts when work stops and clears while working", () => {
    const s = createVizState(T0);
    applyFleet(s, [lane("L1", "working")], T0);
    const n = s.nodes.get("L1")!;
    tick(s, T0 + 100);
    expect(n.idleSince).toBeNull();
    expect(idleSeconds(n, T0 + 100)).toBe(0);
    applyEvent(s, ev("L1", { type: "done" }), T0 + 200);
    tick(s, T0 + 300);
    expect(n.idleSince).toBe(T0 + 300);
    expect(idleSeconds(n, T0 + 61_300)).toBe(61);
    applyEvent(s, tok("L1", 40), T0 + 62_000);
    tick(s, T0 + 62_100);
    expect(idleSeconds(n, T0 + 62_100)).toBe(0);
  });
});

describe("census and log", () => {
  test("counts agents, live subagents and the tapped est. rate total", () => {
    const s = createVizState(T0);
    applyFleet(s, [lane("L1", "working"), lane("L2", "done")], T0);
    stream(s, "L1", 40, T0, 2000);
    const c = census(s, T0 + 2000);
    expect(c.agents).toBe(2);
    expect(c.subagents).toBe(0);
    expect(c.tapped).toBe(1);
    expect(c.tokps).toBeGreaterThan(80);
  });
  test("the event log is bounded", () => {
    const s = createVizState(T0);
    applyFleet(s, [lane("L1", "working")], T0);
    for (let i = 0; i < LOG_MAX + 50; i++) applyEvent(s, ev("L1", { type: "tool-meta", id: `c${i}`, name: "x", ok: false }), T0 + i);
    expect(s.log).toHaveLength(LOG_MAX);
  });
});

describe("layout", () => {
  const nodes = [
    { id: HUB_ID, kind: "hub" as const, parent: null },
    { id: "a", kind: "agent" as const, parent: HUB_ID },
    { id: "b", kind: "agent" as const, parent: HUB_ID },
    { id: "s1", kind: "subagent" as const, parent: "a" },
    { id: "s2", kind: "subagent" as const, parent: HUB_ID },
  ];
  test("orbit: the hub at the center, agents on the orbit's own ellipse in the XZ plane, helpers near their parent", () => {
    const p = layoutPositions(nodes, "orbit");
    expect(p.get(HUB_ID)).toEqual([0, 0, 0]);
    const slots = orbitSlots(2, 1600, 1000);
    // Each agent sits where the orbit puts its card, in the XZ plane: same direction from the hub, uniform scale.
    for (const [i, id] of ["a", "b"].entries()) {
      const q = p.get(id)!, s = slots[i]!;
      expect(q[1]).toBe(0);
      expect(Math.atan2(q[2], q[0])).toBeCloseTo(Math.atan2(s.y, s.x), 5);
    }
    // Helpers ring their parent outside its glass frame (about 1.5 units), Main's on a wider ring than a lane's.
    const a = p.get("a")!, s1 = p.get("s1")!;
    const laneRing = Math.hypot(s1[0] - a[0], s1[2] - a[2]);
    const hubRing = Math.hypot(p.get("s2")![0], p.get("s2")![2]);
    expect(laneRing).toBeGreaterThan(1.5);
    expect(hubRing).toBeGreaterThan(laneRing);
    // No two bots overlap.
    const all = [...p.values()];
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
      expect(Math.hypot(all[i]![0] - all[j]![0], all[i]![1] - all[j]![1], all[i]![2] - all[j]![2])).toBeGreaterThan(1.5);
    }
    expect(layoutPositions(nodes, "orbit")).toEqual(p);
  });
  test("constellation: agents spread around the hub in 3D", () => {
    const p = layoutPositions(nodes, "constellation");
    for (const id of ["a", "b"]) {
      const d = Math.hypot(...p.get(id)!);
      expect(d).toBeGreaterThan(5.6 * 0.79);
      expect(d).toBeLessThan(5.6 * 1.01);
    }
    expect(p.get("a")).not.toEqual(p.get("b"));
  });
  test("P-VIZ.5: subagent cubes keep clear of each other and of their parent, however many helpers", () => {
    type K = "hub" | "agent" | "subagent";
    for (const layout of ["orbit", "constellation"] as const) {
      for (const parent of [HUB_ID, "a"]) {
        for (let n = 1; n <= 12; n++) {
          const ns: { id: string; kind: K; parent: string | null }[] = [
            { id: HUB_ID, kind: "hub", parent: null },
            { id: "a", kind: "agent", parent: HUB_ID },
            { id: "b", kind: "agent", parent: HUB_ID },
          ];
          for (let i = 0; i < n; i++) ns.push({ id: `s${i}`, kind: "subagent", parent });
          const p = layoutPositions(ns, layout);
          const group = ns.filter((x) => x.id === parent || x.parent === parent && x.kind === "subagent");
          for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
            const u = p.get(group[i]!.id)!, v = p.get(group[j]!.id)!;
            const d = Math.hypot(u[0] - v[0], u[1] - v[1], u[2] - v[2]);
            expect(d).toBeGreaterThanOrEqual(1.3 * (cubeHalf(group[i]!.kind) + cubeHalf(group[j]!.kind)));
          }
        }
      }
    }
  });
});

describe("perf budgets", () => {
  test("per tier: particles, frame cap, DPR cap, bloom and glass only on full", () => {
    expect(vizTierOpts("full", false)).toMatchObject({ particles: 6000, fps: 60, dprCap: 1.5, bloom: true, antialias: true });
    expect(vizTierOpts("reduced", false)).toMatchObject({ particles: 2500, fps: 30, dprCap: 1.25, bloom: false });
    expect(vizTierOpts("minimal", false)).toMatchObject({ particles: 600, fps: 20, dprCap: 1, lightning: 0 });
    // P-VIZ.2: the mini Lucid figures are built at the tier's detail, reduced motion included.
    expect((["full", "reduced", "minimal"] as const).map((t) => vizTierOpts(t, true).detail)).toEqual(["full", "reduced", "minimal"]);
  });
  test("reduced motion: no automatic motion, effects become color changes, frames only on change", () => {
    const o = vizTierOpts("full", true);
    expect(o).toMatchObject({ motion: false, particles: 0, fx: 0, lightning: 0 });
    expect(frameInterval(o, true, false)).toBeNull();
  });
  test("busy runs at the tier cap, idle drops to the idle cadence, a recording holds at least 30 fps", () => {
    expect(frameInterval(vizTierOpts("full", false), true, false)).toBeCloseTo(1000 / 60);
    expect(frameInterval(vizTierOpts("full", false), false, false)).toBeCloseTo(1000 / 15);
    expect(frameInterval(vizTierOpts("minimal", false), true, true)).toBeCloseTo(1000 / 30);
    expect(frameInterval(vizTierOpts("full", true), false, true)).toBeCloseTo(1000 / 60);
  });
});

describe("demo feed (?vizDemo=1)", () => {
  /** Drive one full demo cycle through the real model, the way viz_view does. */
  function runDemo(): { kinds: Set<string>; s: VizState; log: VizEvent[] } {
    const s = createVizState(T0);
    const demo = createDemo(T0);
    const log: VizEvent[] = [];
    let prev = T0;
    for (let t = T0 + 250; t <= T0 + DEMO_CYCLE_MS + 1000; t += 250) {
      const st = demo.step(prev, t);
      for (const a of st.asks) markAsked(s, a.id, a.ask);
      if ((t - T0) % 500 === 0) applyFleet(s, demo.lanes(t), t);
      for (const e of st.events) applyEvent(s, e, t);
      if ((t - T0) % 1000 === 0) applyRuns(s, demo.runs(t), t);
      tick(s, t);
      log.push(...drainEvents(s));
      prev = t;
    }
    return { kinds: new Set(log.map((e) => (e.kind === "power" ? e.power : e.kind))), s, log };
  }
  test("one cycle shows every power-down kind, surges and spawns", () => {
    const { kinds } = runDemo();
    for (const k of ["tool-failed", "paused", "ended", "killed", "surge", "spawn"]) expect(kinds.has(k)).toBe(true);
  });
  test("deterministic: the same start time yields the same events", () => {
    expect(runDemo().log).toEqual(runDemo().log);
  });
});
