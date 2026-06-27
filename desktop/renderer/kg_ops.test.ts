// Tests for the Knowledge-graph interaction-polish helpers (increment B-KG.1, issues #112/#113/#114).
// These are the pure cores of: fit-on-open, idle-CPU frame budgeting, and optimistic forget.

import { describe, expect, test } from "bun:test";
import type { PersonalGraphData } from "./bridge.ts";
import { applyForget, fitTransform, frameWork } from "./kg_ops.ts";

describe("#112 fitTransform — large graphs actually fit", () => {
  const W = 800, H = 600;

  test("a big imported graph fits below the OLD 0.4 floor and centers", () => {
    // bbox 4000×3000 — needs ~0.19 to fit; the old Math.max(0.4, …) floor would have overflowed.
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

describe("#114 frameWork — idle frames stop burning CPU", () => {
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

describe("#113 applyForget — instant, snapshot-safe removal", () => {
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
