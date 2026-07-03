// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/symbol_graph.test.ts - P-KG-SYM.1: the AST symbol graph. Builds a tiny repo in a temp dir and
// asserts the extracted symbols (with kinds) + the resolved cross-file / intra-file reference edges.

import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSymbolGraph, ingestSymbolGraph, loadSymbolGraph } from "./symbol_graph.ts";

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "sg-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "util.ts"), `export function helper() { return 1; }\nexport const PI = 3.14;\nexport class Box { open() { return helper(); } }`);
  writeFileSync(join(root, "src", "app.ts"),
    `import { helper, PI } from "./util.ts";\n` +
    `export function run() { return helper() + PI; }\n` +
    `function local() { return run(); }\n` +
    `export interface Opts { x: number }`);
  return root;
}

describe("symbol graph (P-KG-SYM.1)", () => {
  test("extracts symbols with kinds (function / const / class / method / type)", () => {
    const root = fixture();
    try {
      const g = buildSymbolGraph(root);
      const kind = (id: string) => g.nodes.find((n) => n.id === id)?.kind;
      expect(kind("src/util.ts#helper")).toBe("function");
      expect(kind("src/util.ts#PI")).toBe("const");
      expect(kind("src/util.ts#Box")).toBe("class");
      expect(kind("src/util.ts#Box.open")).toBe("method");
      expect(kind("src/app.ts#run")).toBe("function");
      expect(kind("src/app.ts#Opts")).toBe("type");
      expect(g.level).toBe("symbol");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("resolves cross-file symbol references through named imports", () => {
    const root = fixture();
    try {
      const g = buildSymbolGraph(root);
      const has = (from: string, to: string) => g.edges.some((e) => e.from === from && e.to === to);
      // run() uses imported helper + PI from util.ts
      expect(has("src/app.ts#run", "src/util.ts#helper")).toBe(true);
      expect(has("src/app.ts#run", "src/util.ts#PI")).toBe(true);
      // Box.open uses local helper (intra-file)
      expect(has("src/util.ts#Box.open", "src/util.ts#helper")).toBe(true);
      // local() calls run() in the same file (intra-file)
      expect(has("src/app.ts#local", "src/app.ts#run")).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("degree counts references; ingest persists + loads", () => {
    const root = fixture();
    try {
      const g = ingestSymbolGraph(root);
      expect(g.nodes.find((n) => n.id === "src/util.ts#helper")!.count).toBeGreaterThanOrEqual(2); // used by run + Box.open
      const loaded = loadSymbolGraph(root);
      expect(loaded?.symbolCount).toBe(g.symbolCount);
      expect(loaded?.edgeCount).toBe(g.edgeCount);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
