// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Tests for the Knowledge-graph interaction-polish helpers (increment B-KG.1, issues #112/#113/#114).
// These are the pure cores of: fit-on-open, idle-CPU frame budgeting, and optimistic forget.

import { describe, expect, test } from "bun:test";
import type { PersonalGraphData } from "./bridge.ts";
import { KE_REST, addEdgeOptimistic, applyForget, chainPairs, fitTransform, frameWork, matchNodes, nodeAtPoint, removeEdgeOptimistic, resolveRelationLabel, settleDone, settleStart, togglePick } from "./kg_ops.ts";

describe("ADR-0130 settleStart (P-PERF.3 layout continuity)", () => {
  test("fully seeded mount = static paint: full budget consumed up front + a one-time fit", () => {
    expect(settleStart(40, 40, 480)).toEqual({ frames: 480, needsFit: true });
  });
  test("mostly seeded (≥80%) = short nestle for the newcomers, no static fit", () => {
    expect(settleStart(36, 40, 480)).toEqual({ frames: 360, needsFit: false });
    expect(settleStart(32, 40, 480)).toEqual({ frames: 360, needsFit: false }); // exactly 80%
  });
  test("cold or barely-seeded mount = the full settle", () => {
    expect(settleStart(0, 40, 480)).toEqual({ frames: 0, needsFit: false });
    expect(settleStart(10, 40, 480)).toEqual({ frames: 0, needsFit: false });
  });
  test("a tiny tier budget never goes negative on the nestle path", () => {
    expect(settleStart(9, 10, 100).frames).toBe(0);
  });
  test("empty graph = nothing to do (no static fit on zero nodes)", () => {
    expect(settleStart(0, 0, 480)).toEqual({ frames: 0, needsFit: false });
  });
});

describe("ADR-0130 settleDone (P-PERF.3 energy-based early exit)", () => {
  test("motion below the rest threshold after the grace period stops the sim", () => {
    expect(settleDone(40 * KE_REST * 0.5, 40, 100)).toBe(true);
  });
  test("still-moving layouts keep simulating", () => {
    expect(settleDone(40 * KE_REST * 10, 40, 100)).toBe(false);
  });
  test("never exits during the grace period (young layouts start near-still)", () => {
    expect(settleDone(0, 40, 10)).toBe(false);
    expect(settleDone(0, 40, 30)).toBe(false); // boundary: grace is exclusive
    expect(settleDone(0, 40, 31)).toBe(true);
  });
  test("an empty graph never reports done (nothing to settle)", () => {
    expect(settleDone(0, 0, 100)).toBe(false);
  });
});

describe("#131 matchNodes (P-KG-SEARCH.1)", () => {
  const nodes = [
    { id: "1", name: "Rust" }, { id: "2", name: "Kubernetes" }, { id: "3", name: "rusty pipelines" },
  ];
  test("case-insensitive substring match; empty query → no matches", () => {
    expect([...matchNodes(nodes, "rust")].sort()).toEqual(["1", "3"]); // "Rust" + "rusty…"
    expect([...matchNodes(nodes, "KUBER")]).toEqual(["2"]);
    expect(matchNodes(nodes, "").size).toBe(0);
    expect(matchNodes(nodes, "   ").size).toBe(0);
    expect(matchNodes(nodes, "nope").size).toBe(0);
  });
});

describe("#130 removeEdgeOptimistic (P-KG-REL.3)", () => {
  const data = (): PersonalGraphData => ({
    nodes: [],
    edges: [{ from: "a", to: "b", relation: "related" }, { from: "a", to: "b", relation: "deploys with" }],
    facts: [],
  });
  test("removes the exact from+to+relation triple, never mutating the input", () => {
    const d = data();
    const out = removeEdgeOptimistic(d, "a", "b", "related");
    expect(out.edges).toEqual([{ from: "a", to: "b", relation: "deploys with" }]); // only the matching one
    expect(d.edges).toHaveLength(2); // input untouched → caller can roll back
  });
  test("a non-matching removal is a no-op (same ref back)", () => {
    const d = data();
    expect(removeEdgeOptimistic(d, "a", "b", "nope")).toBe(d);
    expect(removeEdgeOptimistic(d, "x", "y", "related")).toBe(d);
  });
});

describe("#122 resolveRelationLabel (P-KG-REL.2)", () => {
  test("uses a typed label, defaults to 'related' when blank", () => {
    expect(resolveRelationLabel("deploys with")).toBe("deploys with");
    expect(resolveRelationLabel("  used for  ")).toBe("used for"); // trimmed
    expect(resolveRelationLabel("")).toBe("related");
    expect(resolveRelationLabel("   ")).toBe("related");
    expect(resolveRelationLabel(null)).toBe("related");
    expect(resolveRelationLabel(undefined)).toBe("related");
  });
});

describe("#112 fitTransform - large graphs actually fit", () => {
  const W = 800, H = 600;

  test("a big imported graph fits below the OLD 0.4 floor and centers", () => {
    // bbox 4000×3000 - needs ~0.19 to fit; the old Math.max(0.4, …) floor would have overflowed.
    const box = { minX: -2000, minY: -1500, maxX: 2000, maxY: 1500 };
    const t = fitTransform(box, W, H)!;
    expect(t).not.toBeNull();
    expect(t.sc).toBeLessThan(0.4); // the bug fix: it can zoom out far enough now
    expect(t.sc).toBeGreaterThan(0.05);
    // the bbox center (0,0) must land at the viewport center
    expect(t.tx).toBeCloseTo(W / 2, 5);
    expect(t.ty).toBeCloseTo(H / 2, 5);
    // and the whole box must fit inside the viewport at that scale
    expect((box.maxX - box.minX) * t.sc).toBeLessThanOrEqual(W);
    expect((box.maxY - box.minY) * t.sc).toBeLessThanOrEqual(H);
  });

  test("a tiny graph clamps to the max zoom (doesn't blow up)", () => {
    const t = fitTransform({ minX: -10, minY: -10, maxX: 10, maxY: 10 }, W, H)!;
    expect(t.sc).toBe(1.5);
  });

  test("no viewport size yet → null (never center onto a 0×0 canvas)", () => {
    expect(fitTransform({ minX: 0, minY: 0, maxX: 100, maxY: 100 }, 0, 0)).toBeNull();
  });
});

describe("#114 frameWork - idle frames stop burning CPU", () => {
  test("while the sim is stepping, do the full layout repaint", () => {
    const w = frameWork({ simActive: true, easing: false, calm: false, parity: 1 });
    expect(w.layout).toBe(true);
    expect(w.stop).toBe(false);
  });

  test("reduced-motion + nothing moving → halt the loop entirely", () => {
    const w = frameWork({ simActive: false, easing: false, calm: true, parity: 0 });
    expect(w.stop).toBe(true);
    expect(w.layout).toBe(false);
    expect(w.particles).toBe(false);
  });

  test("idle with particles → no layout work, particles throttled to every other frame", () => {
    const even = frameWork({ simActive: false, easing: false, calm: false, parity: 0 });
    const odd = frameWork({ simActive: false, easing: false, calm: false, parity: 1 });
    expect(even.layout).toBe(false);
    expect(odd.layout).toBe(false);
    expect(even.particles).toBe(true);  // ~30fps, not 60
    expect(odd.particles).toBe(false);
    expect(even.stop).toBe(false);       // keep looking alive
  });
});

describe("#113 applyForget - instant, snapshot-safe removal", () => {
  const graph = (): PersonalGraphData => ({
    nodes: [
      { id: "n1", name: "Rust", kind: "preference", trust: "trusted", count: 2 },
      { id: "n2", name: "Vim", kind: "behavior", trust: "trusted", count: 1 },
    ],
    edges: [{ from: "n1", to: "n2", relation: "related" }],
    facts: [
      { id: "f1", entity_id: "n1", statement: "likes Rust", scope: "personal", trust: "trusted", confidence: 0.9, at: "t" },
      { id: "f2", entity_id: "n1", statement: "prefers Rust over Go", scope: "personal", trust: "trusted", confidence: 0.8, at: "t" },
      { id: "f3", entity_id: "n2", statement: "uses Vim", scope: "personal", trust: "trusted", confidence: 0.95, at: "t" },
    ],
  });

  test("removing one of several facts keeps the node, decrements its count", () => {
    const g = graph();
    const { data, nodeRemoved } = applyForget(g, "f1");
    expect(nodeRemoved).toBeNull();
    expect(data.facts.map((f) => f.id)).toEqual(["f2", "f3"]);
    expect(data.nodes.find((n) => n.id === "n1")!.count).toBe(1);
    expect(data.edges).toHaveLength(1); // node still present → edge stays
  });

  test("removing a node's LAST fact drops the node and its dangling edges", () => {
    const g = graph();
    const { data, nodeRemoved } = applyForget(g, "f3"); // n2's only fact
    expect(nodeRemoved).toBe("n2");
    expect(data.nodes.map((n) => n.id)).toEqual(["n1"]);
    expect(data.edges).toHaveLength(0); // n1→n2 edge removed with n2
  });

  test("does NOT mutate the input (so the caller can roll back on server failure)", () => {
    const g = graph();
    applyForget(g, "f3");
    expect(g.nodes).toHaveLength(2);     // original untouched
    expect(g.edges).toHaveLength(1);
    expect(g.facts).toHaveLength(3);
    expect(g.nodes.find((n) => n.id === "n1")!.count).toBe(2);
  });

  test("forgetting an unknown id is a harmless no-op", () => {
    const g = graph();
    const { data, nodeRemoved } = applyForget(g, "nope");
    expect(nodeRemoved).toBeNull();
    expect(data.facts).toHaveLength(3);
    expect(data.nodes).toHaveLength(2);
  });
});

describe("#109 manual relate helpers (P-KG-REL.1)", () => {
  const hit = [
    { id: "a", x: 0, y: 0, r: 10 },
    { id: "b", x: 100, y: 0, r: 8 },
  ];

  test("nodeAtPoint finds the node under a point (with grab padding) and respects exclude", () => {
    expect(nodeAtPoint(hit, 3, 4)).toBe("a");        // within a's radius
    expect(nodeAtPoint(hit, 100, 0)).toBe("b");
    expect(nodeAtPoint(hit, 50, 0)).toBeNull();       // empty space between
    expect(nodeAtPoint(hit, 3, 4, "a")).toBeNull();   // excluded → can't relate a node to itself
  });

  test("togglePick adds then removes, preserving order", () => {
    let picks: string[] = [];
    picks = togglePick(picks, "a"); expect(picks).toEqual(["a"]);
    picks = togglePick(picks, "b"); expect(picks).toEqual(["a", "b"]);
    picks = togglePick(picks, "a"); expect(picks).toEqual(["b"]); // toggle off, order preserved
  });

  test("chainPairs links consecutive picks (A,B,C → A→B, B→C)", () => {
    expect(chainPairs(["a", "b", "c"])).toEqual([["a", "b"], ["b", "c"]]);
    expect(chainPairs(["a"])).toEqual([]); // need at least two to relate
    expect(chainPairs([])).toEqual([]);
  });

  test("addEdgeOptimistic appends a new edge, dedups identical, never mutates input", () => {
    const data: PersonalGraphData = { nodes: [], edges: [{ from: "a", to: "b", relation: "related" }], facts: [] };
    const added = addEdgeOptimistic(data, "b", "c", "related");
    expect(added.edges).toHaveLength(2);
    expect(added.edges.at(-1)).toEqual({ from: "b", to: "c", relation: "related" });
    expect(data.edges).toHaveLength(1); // input untouched → caller can roll back

    const dup = addEdgeOptimistic(data, "a", "b", "related"); // identical → no-op (same ref back)
    expect(dup).toBe(data);
  });
});

// ───────────── P-KGVIZ.1 (ADR-0183): form in place ─────────────

import { presettle, stepForces, type SimBody } from "./kg_ops.ts";

const body = (x: number, y: number, r = 8): SimBody => ({ x, y, vx: 0, vy: 0, r });
/** Deterministic scattered cloud (no Math.random - tests must be reproducible). */
const cloud = (n: number): SimBody[] =>
  Array.from({ length: n }, (_, i) => body(300 + Math.cos(i * 2.4) * (40 + (i % 9) * 6), 300 + Math.sin(i * 2.4) * (40 + (i % 7) * 6)));

describe("ADR-0183 stepForces (the extracted physics frame)", () => {
  test("overlapping nodes repel; velocities and positions stay finite", () => {
    const bodies = [body(300, 300), body(302, 300)];
    stepForces(bodies, [], 300, 300, 0);
    expect(bodies[0]!.x).toBeLessThan(bodies[1]!.x);
    expect(bodies[1]!.x - bodies[0]!.x).toBeGreaterThan(2);
    for (const b of bodies) { expect(Number.isFinite(b.x)).toBe(true); expect(Number.isFinite(b.vx)).toBe(true); }
  });
  test("a spring pulls distant linked nodes together", () => {
    const bodies = [body(0, 300), body(600, 300)];
    const gap0 = bodies[1]!.x - bodies[0]!.x;
    stepForces(bodies, [[0, 1]], 300, 300, 200);
    expect(bodies[1]!.x - bodies[0]!.x).toBeLessThan(gap0);
  });
  test("a held node does not move and carries no velocity (the drag contract)", () => {
    const bodies = [body(300, 300), body(304, 300)];
    stepForces(bodies, [], 300, 300, 0, 0);
    expect(bodies[0]!.x).toBe(300);
    expect(bodies[0]!.vx).toBe(0);
    expect(bodies[1]!.x).not.toBe(304); // its neighbor still reacts
  });
  test("returns Σv² - zero only when nothing moved", () => {
    expect(stepForces([], [], 300, 300, 0)).toBe(0);
    expect(stepForces(cloud(12), [], 300, 300, 0)).toBeGreaterThan(0);
  });
});

describe("ADR-0183 presettle (the off-screen settle)", () => {
  test("a cold 150-node cloud reaches energy rest before the frame budget (no on-screen shake left)", () => {
    const bodies = cloud(150);
    const frames = presettle(bodies, [], 300, 300, { settle: 480, frames: 0, deadlineMs: 60_000 });
    expect(frames).toBeLessThan(480); // settleDone fired, not the budget
    const residual = stepForces(bodies, [], 300, 300, 480);
    expect(residual).toBeLessThan(150 * KE_REST * 2); // parked = parked: one more frame barely moves
    for (const b of bodies) expect(Number.isFinite(b.x) && Number.isFinite(b.y)).toBe(true);
  });
  test("deterministic: the same input settles to the same layout", () => {
    const a = cloud(40), b = cloud(40);
    presettle(a, [[0, 1], [1, 2]], 300, 300, { settle: 480, frames: 0, deadlineMs: 60_000 });
    presettle(b, [[0, 1], [1, 2]], 300, 300, { settle: 480, frames: 0, deadlineMs: 60_000 });
    expect(a.map((n) => [n.x, n.y])).toEqual(b.map((n) => [n.x, n.y]));
  });
  test("the wall-clock deadline wins over the frame budget (a huge graph can never hang the mount)", () => {
    let t = 0;
    const frames = presettle(cloud(30), [], 300, 300, { settle: 480, frames: 0, deadlineMs: 250, now: () => (t += 100) });
    expect(frames).toBeLessThanOrEqual(4); // ~3 iterations at 100ms per tick
  });
  test("a late-start restart (live merge) still moves newborn nodes - grace is measured in iterations run", () => {
    const bodies = [...cloud(10), body(300, 300), body(301, 300)]; // two newcomers stacked at center
    const before = bodies.slice(-2).map((n) => n.x);
    presettle(bodies, [], 300, 300, { settle: 480, frames: 320, deadlineMs: 60_000 }); // starts at SETTLE-160
    const after = bodies.slice(-2).map((n) => n.x);
    expect(after).not.toEqual(before); // settleDone's grace didn't instantly bail at frames > 30
  });
});
