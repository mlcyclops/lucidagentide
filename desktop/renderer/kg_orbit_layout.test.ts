// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Tests for the orbit engine's pure core (P-KG-ORBIT.1, ADR-0470): dependency layers on the SCC
// condensation, deterministic placement, and upstream / downstream lineage.

import { describe, expect, test } from "bun:test";
import { layersOf, lineage, orbitLayout, sccs, type OrbitInEdge, type OrbitInNode } from "./kg_orbit_layout.ts";

const node = (id: string, kind = "desktop", count = 1): OrbitInNode => ({ id, kind, count });
const edge = (from: string, to: string): OrbitInEdge => ({ from, to });

// e -> a -> b <-> c -> d   ("x -> y" = x depends on y); b and c form a cycle.
const FIX_NODES = ["a", "b", "c", "d", "e"].map((id) => node(id));
const FIX_EDGES = [edge("e", "a"), edge("a", "b"), edge("b", "c"), edge("c", "b"), edge("c", "d")];

const layerById = (nodes: OrbitInNode[], edges: OrbitInEdge[]): Record<string, number> =>
  Object.fromEntries(orbitLayout(nodes, edges).points.map((p) => [p.id, p.layer]));

describe("ADR-0470 dependency layers on the SCC condensation", () => {
  test("an acyclic chain climbs one layer per dependency hop", () => {
    const nodes = ["app", "ui", "core", "util"].map((id) => node(id));
    const edges = [edge("app", "ui"), edge("ui", "core"), edge("core", "util")];
    expect(layerById(nodes, edges)).toEqual({ util: 0, core: 1, ui: 2, app: 3 });
  });

  test("every node of a cycle shares one layer, and the condensation orders around it", () => {
    expect(layerById(FIX_NODES, FIX_EDGES)).toEqual({ d: 0, b: 1, c: 1, a: 2, e: 3 });
  });

  test("a layer is the LONGEST path down, not the shortest", () => {
    // top depends on base directly AND through mid, so it sits above mid
    const nodes = ["top", "mid", "base"].map((id) => node(id));
    expect(layerById(nodes, [edge("top", "base"), edge("top", "mid"), edge("mid", "base")])).toEqual({ base: 0, mid: 1, top: 2 });
  });

  test("a three-node cycle is one component; isolated nodes are layer 0", () => {
    const out = [[1], [2], [0], []]; // 0 -> 1 -> 2 -> 0, 3 alone
    const { comp, count } = sccs(4, out);
    expect(count).toBe(2);
    expect(comp[0]).toBe(comp[1]);
    expect(comp[1]).toBe(comp[2]);
    expect(comp[3]).not.toBe(comp[0]);
    expect([...layersOf(4, out).layer]).toEqual([0, 0, 0, 0]);
  });

  test("a deep chain does not overflow the stack (iterative walk)", () => {
    const n = 50_000;
    const out = Array.from({ length: n }, (_, i) => (i + 1 < n ? [i + 1] : []));
    out[n - 1] = [0]; // close it into one giant cycle as well
    const { count } = sccs(n, out);
    expect(count).toBe(1);
    const chain = Array.from({ length: n }, (_, i) => (i + 1 < n ? [i + 1] : []));
    expect(layersOf(n, chain).layer[0]).toBe(n - 1);
  });

  test("self loops and edges to unknown ids are ignored", () => {
    const nodes = [node("a"), node("b")];
    expect(layerById(nodes, [edge("a", "a"), edge("a", "ghost"), edge("a", "b")])).toEqual({ a: 1, b: 0 });
  });
});

describe("ADR-0470 deterministic placement", () => {
  const nodes = [
    node("desktop/renderer/app.ts", "desktop", 40), node("desktop/renderer/graph.ts", "desktop", 6),
    node("desktop/dev.ts", "desktop", 30), node("harness/contracts.ts", "harness", 25),
    node("harness/gate.ts", "harness", 8), node("tools/license_headers.ts", "tools", 1),
  ];
  const edges = [
    edge("desktop/renderer/app.ts", "desktop/renderer/graph.ts"), edge("desktop/dev.ts", "harness/gate.ts"),
    edge("harness/gate.ts", "harness/contracts.ts"), edge("desktop/renderer/app.ts", "harness/contracts.ts"),
  ];
  const coords = (ns: OrbitInNode[], es: OrbitInEdge[]) =>
    Object.fromEntries(orbitLayout(ns, es).points.map((p) => [p.id, [p.x, p.y, p.z, p.layer]]));

  test("repeat calls give identical coordinates", () => {
    expect(coords(nodes, edges)).toEqual(coords(nodes, edges));
  });

  test("input order does not move any node", () => {
    expect(coords([...nodes].reverse(), [...edges].reverse())).toEqual(coords(nodes, edges));
  });

  test("coordinates stay in range: x,z in [-1,1], y in [0,1], centrality in [0,1]", () => {
    for (const p of orbitLayout(nodes, edges).points) {
      expect(Math.abs(p.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(p.z)).toBeLessThanOrEqual(1);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(1);
      expect(p.c).toBeGreaterThanOrEqual(0);
      expect(p.c).toBeLessThanOrEqual(1);
    }
  });

  test("height follows the layer and the funnel widens upward", () => {
    const L = orbitLayout(FIX_NODES, FIX_EDGES);
    const at = (id: string) => L.points[L.index.get(id)!]!;
    expect(at("d").y).toBe(0);
    expect(at("e").y).toBe(1);
    expect(at("b").y).toBe(at("c").y);
    expect(Math.hypot(at("e").x, at("e").z)).toBeGreaterThan(Math.hypot(at("d").x, at("d").z));
  });

  test("kinds get sectors ordered by size, largest first", () => {
    expect(orbitLayout(nodes, edges).kinds).toEqual([{ kind: "desktop", count: 3 }, { kind: "harness", count: 2 }, { kind: "tools", count: 1 }]);
  });
});

describe("ADR-0470 lineage (upstream = depends on, downstream = blast radius)", () => {
  const L = orbitLayout(FIX_NODES, FIX_EDGES);
  const ids = (xs: number[]) => xs.map((i) => L.points[i]!.id).sort();
  const ix = (id: string) => L.index.get(id)!;

  test("upstream of a is everything it transitively depends on", () => {
    expect(ids(lineage(ix("a"), L.out))).toEqual(["b", "c", "d"]);
  });

  test("downstream of d is everything that transitively depends on it", () => {
    expect(ids(lineage(ix("d"), L.inn))).toEqual(["a", "b", "c", "e"]);
  });

  test("inside a cycle each member is both upstream and downstream of the other", () => {
    expect(ids(lineage(ix("c"), L.out))).toEqual(["b", "d"]);
    expect(ids(lineage(ix("c"), L.inn))).toEqual(["a", "b", "e"]);
  });

  test("a root has no downstream and a leaf has no upstream", () => {
    expect(lineage(ix("e"), L.inn)).toEqual([]);
    expect(lineage(ix("d"), L.out)).toEqual([]);
  });

  test("BFS order lists direct dependencies before deeper ones", () => {
    expect(lineage(ix("e"), L.out).map((i) => L.points[i]!.id)).toEqual(["a", "b", "c", "d"]);
  });
});
