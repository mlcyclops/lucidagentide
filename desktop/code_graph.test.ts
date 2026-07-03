// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/code_graph.test.ts - P-KG-CODE.1: the workspace code graph (files → import edges).
// Builds a tiny repo in a temp dir and asserts the resolved import edges, node kinds, and degree counts.

import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCodeGraph, ingestCodeGraph, codeGraphStatus, loadCodeGraph } from "./code_graph.ts";

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "cg-"));
  mkdirSync(join(root, "desktop"), { recursive: true });
  mkdirSync(join(root, "harness"), { recursive: true });
  mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(root, "desktop", "app.ts"), `import { helper } from "../harness/util.ts";\nimport bridge from "./bridge.ts";\nimport { readFileSync } from "node:fs";`);
  writeFileSync(join(root, "desktop", "bridge.ts"), `import { helper } from "../harness/util.ts";`);
  writeFileSync(join(root, "harness", "util.ts"), `export const helper = 1;`);
  writeFileSync(join(root, "node_modules", "pkg", "index.ts"), `import "./skip.ts";`); // must be skipped
  return root;
}

describe("code graph (P-KG-CODE.1)", () => {
  test("resolves relative imports into file→file edges, skips node_modules + external packages", () => {
    const root = fixture();
    try {
      const g = buildCodeGraph(root);
      const ids = g.nodes.map((n) => n.id).sort();
      expect(ids).toEqual(["desktop/app.ts", "desktop/bridge.ts", "harness/util.ts"]); // node_modules excluded
      const has = (from: string, to: string) => g.edges.some((e) => e.from === from && e.to === to);
      expect(has("desktop/app.ts", "harness/util.ts")).toBe(true);
      expect(has("desktop/app.ts", "desktop/bridge.ts")).toBe(true);
      expect(has("desktop/bridge.ts", "harness/util.ts")).toBe(true);
      // "node:fs" (external) produced no edge
      expect(g.edges.some((e) => /node:fs/.test(e.to))).toBe(false);
      expect(g.edgeCount).toBe(3);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("node kind = top-level dir; degree counts imports + imported-by", () => {
    const root = fixture();
    try {
      const g = buildCodeGraph(root);
      expect(g.nodes.find((n) => n.id === "harness/util.ts")!.kind).toBe("harness");
      expect(g.nodes.find((n) => n.id === "desktop/app.ts")!.kind).toBe("desktop");
      // util.ts is imported by app.ts + bridge.ts → degree 2; every node is trusted
      expect(g.nodes.find((n) => n.id === "harness/util.ts")!.count).toBe(2);
      expect(g.nodes.every((n) => n.trust === "trusted")).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("ingest persists; status reports ingested with counts; load round-trips", () => {
    const root = fixture();
    try {
      expect(codeGraphStatus(root).ingested).toBe(false); // nothing written yet
      const g = ingestCodeGraph(root);
      const st = codeGraphStatus(root);
      expect(st.ingested).toBe(true);
      expect(st.fileCount).toBe(g.fileCount);
      expect(st.edgeCount).toBe(3);
      expect(loadCodeGraph(root)!.edges.length).toBe(3);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
