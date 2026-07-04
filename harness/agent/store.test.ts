// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/agent/store.test.ts — P-AGENT.1 (ADR-0133): DuckDB persistence for Agent Specs, fail-closed.

import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../memory/db.ts";
import { saveSpec, loadSpec, listSpecs, deleteSpec } from "./store.ts";
import { newSpecId, SPEC_VERSION, type AgentSpec } from "./spec.ts";

async function withDb<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "agent-store-"));
  const db = await Db.open(join(dir, "t.duckdb"));
  try {
    return await fn(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
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

describe("agent spec store (P-AGENT.1)", () => {
  test("migration 0010 creates agent_specs", async () => {
    await withDb(async (db) => {
      expect(await db.appliedVersions()).toContain(10);
      const rows = await db.all(
        "SELECT table_name FROM information_schema.tables WHERE table_schema=$1",
        ["main"],
      );
      expect(rows.map((r) => r.table_name)).toContain("agent_specs");
    });
  });

  test("save → load round-trips the spec exactly", async () => {
    await withDb(async (db) => {
      const s = spec("researcher");
      await saveSpec(db, s);
      const loaded = await loadSpec(db, s.spec_id);
      expect(loaded).toEqual(s);
    });
  });

  test("save is an upsert (second save updates, no duplicate row)", async () => {
    await withDb(async (db) => {
      const s = spec("v1");
      await saveSpec(db, s);
      await saveSpec(db, { ...s, name: "v2", updated_at: s.updated_at + 1 });
      const all = await listSpecs(db);
      expect(all.filter((r) => r.spec_id === s.spec_id).length).toBe(1);
      expect((await loadSpec(db, s.spec_id))?.name).toBe("v2");
    });
  });

  test("saving an INVALID spec is refused fail-closed (never persisted)", async () => {
    await withDb(async (db) => {
      const bad = { ...spec("bad"), nodes: [] } as unknown as AgentSpec; // empty nodes → invalid
      await expect(saveSpec(db, bad)).rejects.toThrow(/invalid agent spec/);
      expect(await listSpecs(db)).toEqual([]);
    });
  });

  test("a corrupted stored row is NOT returned as a valid spec", async () => {
    await withDb(async (db) => {
      const s = spec("corruptme");
      await saveSpec(db, s);
      // Corrupt the json column out-of-band (simulating on-disk damage / tampering).
      await db.run("UPDATE agent_specs SET json = $1 WHERE spec_id = $2", ["{not valid json", s.spec_id]);
      expect(await loadSpec(db, s.spec_id)).toBeNull();
    });
  });

  test("loadSpec returns null for an unknown id; deleteSpec reports removal", async () => {
    await withDb(async (db) => {
      expect(await loadSpec(db, "nope")).toBeNull();
      const s = spec("todelete");
      await saveSpec(db, s);
      expect(await deleteSpec(db, s.spec_id)).toBe(true);
      expect(await deleteSpec(db, s.spec_id)).toBe(false);
      expect(await loadSpec(db, s.spec_id)).toBeNull();
    });
  });

  test("listSpecs records the provenance trust label", async () => {
    await withDb(async (db) => {
      await saveSpec(db, spec("trusted-one")); // default trusted
      await saveSpec(db, spec("imported-one"), "untrusted");
      const labels = (await listSpecs(db)).map((r) => r.trust_label).sort();
      expect(labels).toEqual(["trusted", "untrusted"]);
    });
  });
});
