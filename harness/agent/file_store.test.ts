// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/agent/file_store.test.ts — P-AGENT.2b (ADR-0129): workspace-local Agent Spec file persistence.

import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveSpecFile, loadSpecFile, listSpecFiles, deleteSpecFile } from "./file_store.ts";
import { newSpecId, SPEC_VERSION, type AgentSpec } from "./spec.ts";

function root(): string {
  return mkdtempSync(join(tmpdir(), "agent-files-"));
}

function spec(name: string, now = 1_700_000_000_000): AgentSpec {
  return {
    spec_id: newSpecId(),
    spec_version: SPEC_VERSION,
    name,
    mode: "built-agent",
    tools: ["web_search"],
    egress: [],
    selfEdit: "individual",
    nodes: [
      { id: "a", kind: "prompt", label: "Plan", prompt: "" },
      { id: "b", kind: "tool", label: "Search", tool: "web_search" },
    ],
    edges: [{ id: "e1", from: "a", to: "b" }],
    created_at: now,
    updated_at: now,
  };
}

describe("agent spec file store (P-AGENT.2b)", () => {
  test("save → load round-trips through .omp/agents/<id>.json", () => {
    const r = root();
    try {
      const s = spec("researcher");
      saveSpecFile(r, s);
      expect(loadSpecFile(r, s.spec_id)).toEqual(s);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  test("saving an invalid spec is refused fail-closed (nothing written)", () => {
    const r = root();
    try {
      const bad = { ...spec("bad"), nodes: [] } as unknown as AgentSpec;
      expect(() => saveSpecFile(r, bad)).toThrow(/invalid agent spec/);
      expect(listSpecFiles(r)).toEqual([]);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  test("listSpecFiles returns valid specs newest-first and skips corrupted files", () => {
    const r = root();
    try {
      saveSpecFile(r, spec("older", 1000));
      saveSpecFile(r, spec("newer", 2000));
      // drop a corrupted json file in the dir — it must be skipped, not fatal
      mkdirSync(join(r, ".omp", "agents"), { recursive: true });
      writeFileSync(join(r, ".omp", "agents", "junk.json"), "{not json");
      const names = listSpecFiles(r).map((s) => s.name);
      expect(names).toEqual(["newer", "older"]);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  test("a corrupted target file loads as null (never a bogus spec)", () => {
    const r = root();
    try {
      const s = spec("corrupt");
      saveSpecFile(r, s);
      writeFileSync(join(r, ".omp", "agents", `${s.spec_id}.json`), "{broken");
      expect(loadSpecFile(r, s.spec_id)).toBeNull();
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  test("path-traversal ids are refused on save and rejected on load/delete", () => {
    const r = root();
    try {
      expect(() => saveSpecFile(r, { ...spec("evil"), spec_id: "../../etc/passwd" })).toThrow(/invalid spec_id/);
      expect(loadSpecFile(r, "../../secret")).toBeNull();
      expect(deleteSpecFile(r, "../../secret")).toBe(false);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  test("deleteSpecFile removes the file and reports it", () => {
    const r = root();
    try {
      const s = spec("todelete");
      saveSpecFile(r, s);
      expect(deleteSpecFile(r, s.spec_id)).toBe(true);
      expect(deleteSpecFile(r, s.spec_id)).toBe(false);
      expect(loadSpecFile(r, s.spec_id)).toBeNull();
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });
});
