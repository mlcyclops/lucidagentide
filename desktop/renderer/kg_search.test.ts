// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Tests for the Knowledge view's ranked "Find a node" results (P-KG-ORBIT.1, ADR-0470).

import { describe, expect, test } from "bun:test";
import { rankNodes, scoreNode } from "./kg_search.ts";

const n = (id: string, name: string, count = 1, kind = "desktop") => ({ id, name, kind, count });

const NODES = [
  n("desktop/renderer/graph_orbit.ts", "graph_orbit.ts", 3),
  n("desktop/renderer/app.ts#mountGraph", "mountGraph", 9, "function"),
  n("desktop/renderer/graph.ts", "graph.ts", 12),
  n("desktop/renderer/kg_ops.ts", "kg_ops.ts", 7),
  n("desktop/renderer/paragraphs.ts", "paragraphs.ts", 1),
  n("harness/graph/index.ts", "index.ts", 2, "harness"),
  n("desktop/renderer/graph", "graph", 1),
];

describe("ADR-0470 rankNodes", () => {
  test("an exact name match ranks first, ahead of busier prefix matches", () => {
    expect(rankNodes(NODES, "graph")[0]!.id).toBe("desktop/renderer/graph");
  });

  test("tiers: exact > prefix > word start (camelCase) > substring > id path > subsequence", () => {
    const order = rankNodes(NODES, "graph", 20).map((r) => r.id);
    expect(order).toEqual([
      "desktop/renderer/graph", // exact
      "desktop/renderer/graph.ts", // prefix, shorter name
      "desktop/renderer/graph_orbit.ts", // prefix
      "desktop/renderer/app.ts#mountGraph", // camelCase word start
      "desktop/renderer/paragraphs.ts", // plain substring
      "harness/graph/index.ts", // id path segment only
    ]);
  });

  test("case-insensitive, trims, and an empty query returns nothing", () => {
    expect(rankNodes(NODES, "  KG_OPS ")[0]!.id).toBe("desktop/renderer/kg_ops.ts");
    expect(rankNodes(NODES, "   ")).toEqual([]);
  });

  test("a subsequence still finds the node, below every substring hit", () => {
    const r = rankNodes(NODES, "gorb");
    expect(r.map((x) => x.id)).toEqual(["desktop/renderer/graph_orbit.ts"]);
    expect(r[0]!.score).toBeLessThan(200);
  });

  test("non-matches are dropped and the limit holds", () => {
    expect(rankNodes(NODES, "zzz")).toEqual([]);
    expect(rankNodes(NODES, "s", 2)).toHaveLength(2);
  });

  test("scoreNode tiers are strictly ordered", () => {
    expect(scoreNode("graph", "x", "graph")!).toBeGreaterThan(scoreNode("graphs", "x", "graph")!);
    expect(scoreNode("graphs", "x", "graph")!).toBeGreaterThan(scoreNode("mountGraph", "x", "graph")!);
    expect(scoreNode("mountGraph", "x", "graph")!).toBeGreaterThan(scoreNode("paragraph", "x", "graph")!);
    expect(scoreNode("paragraph", "x", "graph")!).toBeGreaterThan(scoreNode("index", "a/graph/index", "graph")!);
    expect(scoreNode("index", "a/graph/index", "graph")!).toBeGreaterThan(scoreNode("index", "agraph", "graph")!);
    expect(scoreNode("index", "agraph", "graph")!).toBeGreaterThan(scoreNode("g-r-a-p-h", "x", "graph")!);
    expect(scoreNode("index", "x", "graph")).toBeNull();
  });
});
