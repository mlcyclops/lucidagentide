// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-WSSETUP: workspace profiling + .agents scaffold behavior (real temp dirs, no mocks).

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { profileWorkspace, scaffoldAgentsFramework } from "./workspace_setup.ts";

const ALL_FILES = [
  "AGENTS.md",
  ".agents/README.md",
  ".agents/CONTEXT.md",
  ".agents/PROGRESS.md",
  ".agents/DECISIONS.md",
  ".agents/skills/SOURCES.md",
];

let dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "lucid-wssetup-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("profileWorkspace", () => {
  test("empty dir: isEmpty, no code, junk names ignored", () => {
    const d = tmp();
    writeFileSync(join(d, "Thumbs.db"), "junk");
    const p = profileWorkspace(d);
    expect(p.isEmpty).toBe(true);
    expect(p.hasCode).toBe(false);
    expect(p.fileCount).toBe(0);
    expect(p.stack).toEqual([]);
  });

  test("package.json with react dep + scripts: hasCode, stack has node and react", () => {
    const d = tmp();
    writeFileSync(join(d, "package.json"), JSON.stringify({ dependencies: { react: "^18.0.0" }, scripts: { dev: "vite", build: "vite build" } }));
    const p = profileWorkspace(d);
    expect(p.isEmpty).toBe(false);
    expect(p.hasCode).toBe(true);
    expect(p.stack).toContain("node");
    expect(p.stack).toContain("react");
  });

  test("root AGENTS.md marks hasAgentsFramework", () => {
    const d = tmp();
    writeFileSync(join(d, "AGENTS.md"), "# AGENTS.md\n");
    const p = profileWorkspace(d);
    expect(p.hasAgentsFramework).toBe(true);
  });

  test("no manifest but src/ with a code file: hasCode without stack", () => {
    const d = tmp();
    mkdirSync(join(d, "src"));
    writeFileSync(join(d, "src", "main.py"), "print('hi')\n");
    const p = profileWorkspace(d);
    expect(p.hasCode).toBe(true);
    expect(p.stack).toEqual([]);
  });
});

describe("scaffoldAgentsFramework", () => {
  test("creates all 6 files; a second run skips all 6 and creates 0", () => {
    const d = tmp();
    const first = scaffoldAgentsFramework(d, { purpose: "app", scan: false });
    expect(first.ok).toBe(true);
    expect(first.created.sort()).toEqual([...ALL_FILES].sort());
    expect(first.skipped).toEqual([]);
    const second = scaffoldAgentsFramework(d, { purpose: "app", scan: false });
    expect(second.ok).toBe(true);
    expect(second.created).toEqual([]);
    expect(second.skipped.sort()).toEqual([...ALL_FILES].sort());
  });

  test("scan=true embeds the detected stack and an npm run command in AGENTS.md", () => {
    const d = tmp();
    writeFileSync(join(d, "package.json"), JSON.stringify({ dependencies: { react: "1.0.0" }, scripts: { build: "tsc" } }));
    const r = scaffoldAgentsFramework(d, { purpose: "app", scan: true });
    expect(r.ok).toBe(true);
    const md = readFileSync(join(d, "AGENTS.md"), "utf8");
    expect(md).toContain("## Detected stack");
    expect(md).toContain("- node");
    expect(md).toContain("- react");
    expect(md).toContain("npm run build");
  });

  test("no generated file contains an em dash (U+2014)", () => {
    const d = tmp();
    scaffoldAgentsFramework(d, { purpose: "analysis", scan: false });
    for (const rel of ALL_FILES) {
      const content = readFileSync(join(d, ...rel.split("/")), "utf8");
      expect(content.includes("\u2014")).toBe(false);
    }
  });

  test("purpose docs changes the AGENTS.md intro", () => {
    const a = tmp();
    const b = tmp();
    scaffoldAgentsFramework(a, { purpose: "app", scan: false });
    scaffoldAgentsFramework(b, { purpose: "docs", scan: false });
    const appMd = readFileSync(join(a, "AGENTS.md"), "utf8");
    const docsMd = readFileSync(join(b, "AGENTS.md"), "utf8");
    expect(docsMd).toContain("analyzes and organizes documents");
    expect(docsMd).not.toBe(appMd);
    expect(appMd).toContain("builds an application");
  });
});
