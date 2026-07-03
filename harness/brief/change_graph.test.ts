// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/brief/change_graph.test.ts - P-REPORT.8: the change-annotated dependency graph + schema map.
// Pure: git numstat/name-status in → grouped modules + edges + Mermaid + SVG + annex markdown.

import { test, expect, describe } from "bun:test";
import {
  parseGitChanges, buildChangeGraph, changeGraphMermaid, changeGraphSvg,
  buildSchemaChanges, schemaMermaid, schemaSvg, renderAnnexes,
} from "./change_graph.ts";

const NUMSTAT = [
  "120\t10\tdesktop/renderer/app.ts",
  "40\t5\tdesktop/dev.ts",
  "8\t2\tharness/brief/compliance.ts",
  "0\t60\tharness/old_thing.ts",
  "30\t0\tdesktop/settings_store.ts",
  "-\t-\tbuild/icon.png",            // binary → skipped
].join("\n");
const NAMESTATUS = [
  "M\tdesktop/renderer/app.ts",
  "M\tdesktop/dev.ts",
  "M\tharness/brief/compliance.ts",
  "D\tharness/old_thing.ts",
  "A\tdesktop/settings_store.ts",
].join("\n");

describe("change graph (P-REPORT.8)", () => {
  test("parses numstat + name-status, skipping binaries", () => {
    const files = parseGitChanges(NUMSTAT, NAMESTATUS);
    expect(files.get("desktop/renderer/app.ts")).toEqual({ added: 120, removed: 10, status: "M" });
    expect(files.get("harness/old_thing.ts")!.status).toBe("D");
    expect(files.has("build/icon.png")).toBe(false); // "-\t-" is not matched as a numeric change
  });

  test("groups files into architecture layers with line totals + net status", () => {
    const g = buildChangeGraph(NUMSTAT, NAMESTATUS, "the last 5 commits");
    const renderer = g.modules.find((m) => m.id === "renderer")!;
    expect(renderer.added).toBe(120); // app.ts is renderer, NOT desktop
    const desktop = g.modules.find((m) => m.id === "desktop")!;
    expect(desktop.files).toBe(2); // dev.ts + settings_store.ts
    const harness = g.modules.find((m) => m.id === "harness")!;
    expect(harness.status).toBe("removed"); // old_thing deleted, net negative
    expect(g.totalAdded).toBe(198);
    expect(g.totalRemoved).toBe(77);
  });

  test("Mermaid is marked, classed green/red/blue, and edge-linked", () => {
    const g = buildChangeGraph(NUMSTAT, NAMESTATUS, "range");
    const mm = changeGraphMermaid(g);
    expect(mm.startsWith("%% lucid:changegraph")).toBe(true);
    expect(mm).toContain("flowchart TD");
    expect(mm).toMatch(/classDef added fill/);
    expect(mm).toMatch(/:::(added|removed|changed)/);
    expect(mm).toMatch(/desktop --> harness|renderer --> desktop/); // a real dependency edge among present modules
  });

  test("SVG renders nodes with counts + is valid-ish svg", () => {
    const svg = changeGraphSvg(buildChangeGraph(NUMSTAT, NAMESTATUS, "r"));
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("</svg>");
    expect(svg).toContain("+120");   // renderer added count in a node
    expect(svg).toContain("Renderer (UI)");
  });

  test("schema map picks up store-backing files + colors by net direction", () => {
    const schema = buildSchemaChanges(NUMSTAT, NAMESTATUS);
    const settings = schema.find((s) => /Settings store/.test(s.store));
    expect(settings).toBeTruthy();               // settings_store.ts matched
    expect(settings!.added).toBe(30);
    expect(schemaMermaid(schema).startsWith("%% lucid:schema")).toBe(true);
    expect(schemaSvg(schema).startsWith("<svg")).toBe(true);
  });

  test("annex markdown: two annexes, tables, marked Mermaid blocks", () => {
    const g = buildChangeGraph(NUMSTAT, NAMESTATUS, "the last 5 commits");
    const md = renderAnnexes(g, buildSchemaChanges(NUMSTAT, NAMESTATUS));
    expect(md).toContain("## Annex A - Application dependency graph");
    expect(md).toContain("## Annex B - Data schema changes");
    expect(md).toContain("```mermaid");
    expect(md).toContain("%% lucid:changegraph");
    expect(md).toContain("+198 / -77"); // total line
  });

  test("empty git output degrades to an honest 'no changes' annex", () => {
    const md = renderAnnexes(buildChangeGraph("", "", "r"), buildSchemaChanges("", ""));
    expect(md).toContain("No code changes detected");
    expect(md).toContain("No data-schema");
  });
});
