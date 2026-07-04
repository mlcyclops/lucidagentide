// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/agent/file_store.test.ts — P-AGENT.2b (ADR-0133): workspace-local Agent Spec file persistence.

import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveSpecFile, loadSpecFile, listSpecFiles, deleteSpecFile, saveSpecTrust, loadSpecTrust, listSpecHistory, loadSpecRevision, SPEC_HISTORY_KEEP } from "./file_store.ts";
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

describe("spec revision history (P-AGENT.17)", () => {
  test("every save snapshots a revision; restore-style load round-trips the exact old spec", () => {
    const r = root();
    try {
      const s1 = spec("v-one", 1000);
      saveSpecFile(r, s1);
      const s2 = { ...s1, name: "v-two", updated_at: 2000 };
      saveSpecFile(r, s2);
      const hist = listSpecHistory(r, s1.spec_id);
      expect(hist.map((h) => h.name)).toEqual(["v-two", "v-one"]); // newest first
      expect(hist[1]).toMatchObject({ updated_at: 1000, nodes: 2, edges: 1 });
      expect(loadSpecRevision(r, s1.spec_id, 1000)).toEqual(s1); // the old revision restores byte-equal
      expect(loadSpecRevision(r, s1.spec_id, 9999)).toBeNull(); // unknown ts → null, never a guess
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  test(`history prunes to the newest ${SPEC_HISTORY_KEEP}; re-saving the same revision doesn't multiply`, () => {
    const r = root();
    try {
      const s = spec("pruner", 1);
      for (let i = 1; i <= SPEC_HISTORY_KEEP + 5; i++) saveSpecFile(r, { ...s, updated_at: i * 100 });
      const hist = listSpecHistory(r, s.spec_id);
      expect(hist).toHaveLength(SPEC_HISTORY_KEEP);
      expect(hist[0]!.updated_at).toBe((SPEC_HISTORY_KEEP + 5) * 100); // newest kept
      expect(hist.at(-1)!.updated_at).toBe(600); // oldest five pruned
      saveSpecFile(r, { ...s, updated_at: (SPEC_HISTORY_KEEP + 5) * 100 }); // identical re-save
      expect(listSpecHistory(r, s.spec_id)).toHaveLength(SPEC_HISTORY_KEEP);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });
});

describe("spec trust sidecar (P-AGENT.9)", () => {
  test("save → load round-trips a trust record; missing sidecar defaults to trusted (local author)", () => {
    const r = root();
    try {
      const s = spec("imported");
      saveSpecFile(r, s);
      expect(loadSpecTrust(r, s.spec_id).trustLabel).toBe("trusted"); // no sidecar yet
      saveSpecTrust(r, s.spec_id, { trustLabel: "untrusted", reason: "imported from an external source" });
      const t = loadSpecTrust(r, s.spec_id);
      expect(t.trustLabel).toBe("untrusted");
      expect(t.reason).toContain("imported");
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  test("trust labels are the closed set; a corrupted sidecar quarantines (fail-closed)", () => {
    const r = root();
    try {
      const s = spec("weird");
      saveSpecFile(r, s);
      expect(() => saveSpecTrust(r, s.spec_id, { trustLabel: "friendly" as never, reason: "x" })).toThrow(/invalid trust label/);
      writeFileSync(join(r, ".omp", "agents", `${s.spec_id}.trust.json`), '{"trustLabel":"nonsense"}');
      expect(loadSpecTrust(r, s.spec_id).trustLabel).toBe("quarantined");
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  test("trust sidecars don't pollute the spec list and die with their spec", () => {
    const r = root();
    try {
      const s = spec("withtrust");
      saveSpecFile(r, s);
      saveSpecTrust(r, s.spec_id, { trustLabel: "suspicious", reason: "findings" });
      const list = listSpecFiles(r);
      expect(list.length).toBe(1); // the .trust.json sidecar is not listed as a spec
      expect(list[0]!.trust_label).toBe("suspicious"); // but its label rides on the summary
      deleteSpecFile(r, s.spec_id);
      expect(loadSpecTrust(r, s.spec_id).trustLabel).toBe("trusted"); // sidecar removed with the spec
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });
});
