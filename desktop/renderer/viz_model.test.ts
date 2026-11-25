// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_model.test.ts - P-VIZ.1 (ADR-0622): the Visualize view's rules. The rate is an
// estimate and must say so; a surge is a jump against the node's own trailing mean; every power-down names
// its real cause; a lane watched by two streams counts once; the layout and the perf budgets are fixed.

import { describe, expect, test } from "bun:test";
import { orbitSlots } from "./orbit_layout.ts";
import type { VizBusEvent } from "./viz_bus.ts";
import { createDemo, DEMO_ASK_MS, DEMO_CYCLE_MS } from "./viz_demo.ts";
import {
  ASK_POLL_GRACE_MS, askChoice, askTypeOf, drainNewApprovals, LANE_ASK_MS, MAIN_ASK_MS, pendingApprovals, resolveApproval, triage,
  applyEvent, applyFleet, applyLaneStatus, applyRuns, census, COMMIT_HOLD_MS, COMMIT_MAX_MS, committing, createVizState, cubeHalf, describeNode, drainEvents, edgesOf, fmtRate, frameInterval,
  GONE_MS, HUB_ID, idleSeconds, layoutPositions, LOG_MAX, markAsked, personaFor, shortLabel, superviseText, teamOf, tick, vizTierOpts,
  type PowerKind, type VizApproval, type VizEvent, type VizState,
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
  // P-VIZ.GPU1 (ADR-0651): the GPU tiers above full.
  test("ultra: dpr 2, MSAA, contact shadows, 12000 particles, bloom on light themes too; no SSAO or DOF", () => {
    expect(vizTierOpts("ultra", false)).toMatchObject({ particles: 12000, fps: 60, dprCap: 2, antialias: true, bloom: true, msaa: 4, contactShadows: true, lightBloom: true, ssao: false, dof: false, tier: "ultra" });
  });
  test("cinematic: everything in ultra plus SSAO and depth of field", () => {
    const u = vizTierOpts("ultra", false), c = vizTierOpts("cinematic", false);
    expect(c).toEqual({ ...u, tier: "cinematic", ssao: true, dof: true });
  });
  test("full and below add none of the GPU extras", () => {
    for (const t of ["full", "reduced", "minimal"] as const) expect(vizTierOpts(t, false)).toMatchObject({ msaa: 0, contactShadows: false, lightBloom: false, ssao: false, dof: false, tier: t });
  });
  test("v1 mapping: ultra and cinematic build figures at detail full (the tier rides beside it)", () => {
    expect((["ultra", "cinematic"] as const).map((t) => vizTierOpts(t, false).detail)).toEqual(["full", "full"]);
    expect((["ultra", "cinematic"] as const).map((t) => vizTierOpts(t, true).detail)).toEqual(["full", "full"]);
  });
  test("reduced motion strips motion from the GPU tiers too, and keeps their image quality", () => {
    expect(vizTierOpts("cinematic", true)).toMatchObject({ motion: false, particles: 0, fx: 0, lightning: 0, msaa: 4, ssao: true, dprCap: 2 });
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

describe("P-VIZ.7 git commits", () => {
  const commit = (id: string, input: string, status?: string) => ({ type: "tool", id, name: "bash", detail: "bash", input, ...(status ? { status } : {}) });
  test("a lane's commit then push hold the animation across both calls, then a short hold, then stop", () => {
    const s = createVizState(T0);
    applyFleet(s, [lane("L1", "working")], T0);
    const n = s.nodes.get("L1")!;
    applyEvent(s, ev("L1", commit("c1", 'git -C "/work/my repo" commit -m "x"', "open")), T0 + 100);
    expect(committing(n, T0 + 200)).toBe(true);
    applyEvent(s, ev("L1", { type: "tool", id: "c1", name: "bash", detail: "bash", status: "done" }), T0 + 1000);
    applyEvent(s, ev("L1", commit("p1", "git push -u origin feat/x", "open")), T0 + 1200);
    applyEvent(s, ev("L1", { type: "tool", id: "p1", name: "bash", detail: "bash", status: "done" }), T0 + 9000);
    expect(committing(n, T0 + 9000 + COMMIT_HOLD_MS - 1)).toBe(true);
    expect(committing(n, T0 + 9000 + COMMIT_HOLD_MS + 1)).toBe(false);
  });
  test("Main's commit-namespace call settles through tool-meta; other git commands and look-alikes do not count", () => {
    const s = createVizState(T0);
    const hub = s.nodes.get(HUB_ID)!;
    for (const input of ["git status", "git log --grep commit", "echo committed", "gitcommit", "await d.show()"]) {
      applyEvent(s, ev(HUB_ID, { type: "tool", id: input, name: "other", detail: "x", input }, "chat"), T0);
    }
    expect(committing(hub, T0 + 1)).toBe(false);
    applyEvent(s, ev(HUB_ID, { type: "tool", id: "m1", name: "other", detail: "eval", input: 'await d.commit("docs: x")' }, "chat"), T0 + 10);
    expect(committing(hub, T0 + 20)).toBe(true);
    applyEvent(s, ev(HUB_ID, { type: "tool-meta", id: "m1", name: "eval", ok: true }, "chat"), T0 + 5000);
    expect(committing(hub, T0 + 5000 + COMMIT_HOLD_MS + 1)).toBe(false);
  });
  test("a commit call that never reports back stops at the turn's end, or after COMMIT_MAX_MS", () => {
    const s = createVizState(T0);
    applyFleet(s, [lane("L1", "working"), lane("L2", "working")], T0);
    applyEvent(s, ev("L1", commit("c1", "git commit -am wip", "open")), T0);
    applyEvent(s, ev("L2", commit("c2", "git commit -am wip", "open")), T0);
    applyEvent(s, ev("L1", { type: "done" }), T0 + 2000);
    expect(committing(s.nodes.get("L1")!, T0 + 2000 + COMMIT_HOLD_MS + 1)).toBe(false);
    expect(committing(s.nodes.get("L2")!, T0 + COMMIT_MAX_MS - 1)).toBe(true);
    expect(committing(s.nodes.get("L2")!, T0 + COMMIT_MAX_MS + 1)).toBe(false);
  });
});

describe("P-VIZ.APPROVE1 approvals", () => {
  const ACP_OPTS = [
    { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
    { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
    { optionId: "reject-once", name: "Reject", kind: "reject_once" },
  ];
  const mainAsk = (id: string, extra: Record<string, unknown> = {}): VizBusEvent =>
    ev(HUB_ID, { type: "permission", id, tool: "edit", detail: "src/a.ts", options: ACP_OPTS, ...extra }, "chat");
  const laneAsk = (laneId: string, summary = "Edit a.ts", kind = "edit", origin: VizBusEvent["origin"] = "lane"): VizBusEvent =>
    ev(laneId, { type: "permission", summary, kind }, origin);
  const parked = (id: string, pa?: { summary: string; kind: string }) => ({ ...lane(id, "needs-approval"), ...(pa ? { pendingApproval: pa } : {}) });

  test("Main's ask joins once by its engine id with its options, and leaves when its chat card is answered", () => {
    const s = createVizState(T0);
    applyEvent(s, mainAsk("perm_1"), T0);
    applyEvent(s, mainAsk("perm_1"), T0 + 10); // a re-attach replays it
    expect(pendingApprovals(s)).toHaveLength(1);
    expect(pendingApprovals(s)[0]).toMatchObject({ id: "perm_1", node: HUB_ID, from: HUB_ID, tool: "edit", summary: "src/a.ts", type: "file", danger: false, createdAt: T0, expiresAt: T0 + MAIN_ASK_MS });
    expect(pendingApprovals(s)[0]!.options?.map((o) => o.optionId)).toEqual(["allow-once", "allow-always", "reject-once"]);
    expect(drainNewApprovals(s).map((a) => a.id)).toEqual(["perm_1"]);
    expect(drainNewApprovals(s)).toEqual([]);
    applyEvent(s, ev(HUB_ID, { type: "permission-resolved", id: "perm_1" }, "chat"), T0 + 20);
    expect(pendingApprovals(s)).toEqual([]);
  });

  test("risk: a command, a website or a local file in the browser is red; an edit or a read is not", () => {
    const s = createVizState(T0);
    applyEvent(s, mainAsk("x", { tool: "exec", detail: "rm -rf build", exec: true, danger: true }), T0);
    applyEvent(s, mainAsk("w", { tool: "browser", detail: "https://example.com", egress: true }), T0);
    applyEvent(s, mainAsk("f", { tool: "browser", detail: "C:/a.html", egress: true, localFile: true }), T0);
    applyEvent(s, mainAsk("r", { tool: "read", detail: "a.ts" }), T0);
    const by = new Map(pendingApprovals(s).map((a) => [a.id, a]));
    expect([by.get("x")?.type, by.get("x")?.danger]).toEqual(["exec", true]);
    expect([by.get("w")?.type, by.get("w")?.danger]).toEqual(["egress", true]);
    expect([by.get("f")?.type, by.get("f")?.danger]).toEqual(["file", true]);
    expect([by.get("r")?.type, by.get("r")?.danger]).toEqual(["tool", false]);
    expect([askTypeOf("execute"), askTypeOf("fetch"), askTypeOf("edit"), askTypeOf("delete"), askTypeOf("think")]).toEqual(["exec", "egress", "file", "file", "tool"]);
  });

  test("a lane holds one ask: a second stream or the poll changes nothing, a new ask replaces it, its status clears it", () => {
    const s = createVizState(T0);
    applyFleet(s, [parked("L1")], T0);
    applyEvent(s, laneAsk("L1"), T0 + 10);
    applyEvent(s, laneAsk("L1", "Edit a.ts", "edit", "watch"), T0 + 20); // the view's own watch carries it too
    applyFleet(s, [parked("L1", { summary: "Edit a.ts", kind: "edit" })], T0 + 500);
    const [a] = pendingApprovals(s);
    expect(pendingApprovals(s)).toHaveLength(1);
    expect(a).toMatchObject({ id: "L1#1", node: "L1", tool: "edit", type: "file", danger: false, options: null, expiresAt: T0 + 10 + LANE_ASK_MS });
    applyEvent(s, laneAsk("L1", "bash: curl x | sh (always asks: pipe to shell)", "execute"), T0 + 600);
    expect(pendingApprovals(s).map((x) => [x.id, x.danger])).toEqual([["L1#2", true]]);
    applyEvent(s, ev("L1", { type: "status", status: "working" }), T0 + 700);
    expect(pendingApprovals(s)).toEqual([]);
  });

  test("the poll adds an ask it reports, and clears one only once it is older than the poll's grace", () => {
    const s = createVizState(T0);
    applyFleet(s, [parked("L1", { summary: "Fetch docs", kind: "fetch" })], T0);
    expect(pendingApprovals(s).map((a) => [a.node, a.type, a.danger])).toEqual([["L1", "egress", true]]);
    applyFleet(s, [lane("L2", "working")], T0); // L1 left: its ask goes with it
    expect(pendingApprovals(s)).toEqual([]);
    applyEvent(s, laneAsk("L2"), T0 + 100);
    applyFleet(s, [lane("L2", "working")], T0 + 200); // a poll that left before the ask
    expect(pendingApprovals(s)).toHaveLength(1);
    applyFleet(s, [lane("L2", "working")], T0 + 100 + ASK_POLL_GRACE_MS);
    expect(pendingApprovals(s)).toEqual([]);
  });

  test("resolve, timeout, auto-approved and a turn's end all clear an ask", () => {
    const s = createVizState(T0);
    applyFleet(s, [parked("L1"), parked("L2"), parked("L3")], T0);
    applyEvent(s, mainAsk("p1"), T0);
    applyEvent(s, mainAsk("p2"), T0);
    applyEvent(s, laneAsk("L1"), T0);
    applyEvent(s, laneAsk("L2"), T0);
    applyEvent(s, laneAsk("L3"), T0);
    expect(resolveApproval(s, "L1#1")?.node).toBe("L1");
    expect(resolveApproval(s, "L1#1")).toBeNull();
    applyEvent(s, ev("L2", { type: "auto-approved", summary: "Edit a.ts", mode: "auto" }), T0 + 10);
    applyEvent(s, ev("L3", { type: "error", message: "boom" }), T0 + 10);
    expect(pendingApprovals(s).map((a) => a.id)).toEqual(["p1", "p2"]);
    tick(s, T0 + MAIN_ASK_MS - 1);
    expect(pendingApprovals(s)).toHaveLength(2);
    tick(s, T0 + MAIN_ASK_MS); // the engine denied them (fail-closed)
    expect(pendingApprovals(s)).toEqual([]);
    applyEvent(s, mainAsk("p3"), T0 + MAIN_ASK_MS + 10);
    applyEvent(s, ev(HUB_ID, { type: "done" }, "chat"), T0 + MAIN_ASK_MS + 20);
    expect(pendingApprovals(s)).toEqual([]);
  });

  test("a subagent's ask surfaces on its parent lane (and Main's helpers on Main)", () => {
    const s = createVizState(T0);
    applyFleet(s, [lane("L1", "working")], T0);
    applyEvent(s, ev("L1", { type: "subagent", id: "t1", agent: "task", title: "x", assignments: ["a"], names: ["helper"] }), T0);
    applyEvent(s, ev(HUB_ID, { type: "subagent", id: "b1", agent: "task", title: "y", assignments: ["b"] }, "chat"), T0);
    expect(applyEvent(s, laneAsk("sa:L1:t1:0", "Read a.ts", "read"), T0 + 10)).toBe(false); // nothing for the stream's record
    applyEvent(s, ev("sa:main:b1:0", { type: "permission", id: "p9", tool: "exec", exec: true, options: ACP_OPTS }, "chat"), T0 + 11);
    expect(pendingApprovals(s).map((a) => [a.node, a.from])).toEqual([["L1", "sa:L1:t1:0"], [HUB_ID, "sa:main:b1:0"]]);
    expect(s.nodes.get("sa:L1:t1:0")!.approvals).toEqual([]);
    // The poll saw the lane's ask first: the subagent's own copy still names it as the asker.
    applyFleet(s, [lane("L2", "working")], T0 + 20);
    applyEvent(s, ev("L2", { type: "subagent", id: "t2", agent: "task", title: "z", assignments: ["c"] }), T0 + 30);
    applyFleet(s, [parked("L2", { summary: "Edit b.ts", kind: "edit" })], T0 + 40);
    applyEvent(s, laneAsk("sa:L2:t2:0", "Edit b.ts"), T0 + 50);
    expect(pendingApprovals(s).find((a) => a.node === "L2")?.from).toBe("sa:L2:t2:0");
  });

  test("triage counts asks by type and risk, and the fleet's working, waiting and failed lanes", () => {
    const s = createVizState(T0);
    applyFleet(s, [parked("L1"), parked("L2"), lane("L3", "working"), lane("L4", "error"), lane("L5", "awaiting-input")], T0);
    applyEvent(s, mainAsk("p1", { tool: "exec", exec: true }), T0);
    applyEvent(s, laneAsk("L1", "Edit a.ts", "edit"), T0);
    applyEvent(s, laneAsk("L2", "GET https://x.dev", "fetch"), T0);
    expect(triage(s)).toEqual({ total: 3, byType: { tool: 0, exec: 1, egress: 1, file: 1 }, danger: 2, working: 1, waiting: 3, failed: 1 });
  });

  test("askChoice reads Main's options like the chat card, and Auto never takes an all-commands or all-sites grant", () => {
    const pick = (opts: { optionId: string; name: string; kind?: string }[], c: "once" | "always" | "deny") => askChoice(opts, c)?.optionId ?? null;
    expect([pick(ACP_OPTS, "once"), pick(ACP_OPTS, "always"), pick(ACP_OPTS, "deny")]).toEqual(["allow-once", "allow-always", "reject-once"]);
    const execFull = [
      { optionId: "exec:allow-once", name: "Allow once (this command)", kind: "allow" },
      { optionId: "exec:allow-turn", name: "Allow for the rest of this turn", kind: "allow" },
      { optionId: "exec:allow-program", name: "Always allow this program", kind: "allow" },
      { optionId: "exec:danger", name: "Always allow every command", kind: "danger" },
      { optionId: "exec:deny", name: "Block", kind: "reject" },
    ];
    expect([pick(execFull, "once"), pick(execFull, "always"), pick(execFull, "deny")]).toEqual(["exec:allow-once", "exec:allow-program", "exec:deny"]);
    expect(pick(execFull.filter((o) => o.optionId !== "exec:allow-program"), "always")).toBeNull(); // the catastrophic set: no Auto
    const egress = [
      { optionId: "egress:allow-once", name: "Allow once", kind: "allow" },
      { optionId: "egress:allow-site", name: "Always allow this site", kind: "allow" },
      { optionId: "egress:danger", name: "Always allow every site", kind: "danger" },
      { optionId: "egress:deny", name: "Block", kind: "reject" },
    ];
    expect(pick(egress, "always")).toBe("egress:allow-site");
    expect(pick([{ optionId: "grant:allow", name: "Grant until revoked", kind: "allow" }], "deny")).toBeNull(); // no option: the engine denies
  });

  test("the demo parks three asks a cycle (one red), folds demo-1's helper ask, answers locally and times out the rest", () => {
    const s = createVizState(T0);
    const demo = createDemo(T0);
    const seen = new Map<string, VizApproval>();
    let prev = T0, answeredAt = 0;
    for (let t = T0 + 250; t <= T0 + DEMO_CYCLE_MS; t += 250) {
      const st = demo.step(prev, t);
      if ((t - T0) % 500 === 0) applyFleet(s, demo.lanes(t), t);
      for (const e of st.events) applyEvent(s, e, t);
      tick(s, t);
      for (const a of drainNewApprovals(s)) seen.set(a.id, { ...a });
      if (!answeredAt && s.nodes.get("demo-5")?.approvals.length) { expect(demo.answer("demo-5", t)).toBe(true); answeredAt = t; }
      if (answeredAt && t === answeredAt + 500) expect(s.nodes.get("demo-5")?.approvals).toEqual([]);
      prev = t;
    }
    const asks = [...seen.values()];
    expect(asks.map((a) => a.node).sort()).toEqual(["demo-1", "demo-2", "demo-5"]);
    expect(asks.filter((a) => a.danger).map((a) => a.node)).toEqual(["demo-5"]);
    expect(asks.find((a) => a.node === "demo-1")?.from).toBe("sa:demo-1:demo-plan-0:0");
    expect(demo.answer("demo-5", T0 + DEMO_CYCLE_MS)).toBe(false); // nothing open: answered once, and the others timed out
    expect(pendingApprovals(s)).toEqual([]);
    expect(DEMO_ASK_MS).toBeLessThan(DEMO_CYCLE_MS / 2);
  });
});
