// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/kb/registry.test.ts — P-KGPACK.1 (ADR-0205): the named-KG registry.
//
// Proves: create mints unique stable ids + persists atomically; list/get return copies; the first KG becomes
// active; rename changes only the label (id + db_path frozen, invariant #9); setActive/rename reject unknown
// ids and blank names; ensureDefault is idempotent by db_path (the zero-data-loss adoption of the legacy
// file); a MISSING registry opens empty while a CORRUPT one throws (never wipes); state round-trips reopen.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KgRegistry } from "./registry.ts";

describe("KgRegistry — named-KG index", () => {
  let dir: string;
  let path: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "kg-reg-")); path = join(dir, "kg_registry.json"); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("a missing registry opens empty with no active KG", () => {
    const r = KgRegistry.open(path);
    expect(r.list()).toEqual([]);
    expect(r.activeId()).toBeNull();
    expect(r.active()).toBeUndefined();
  });

  test("create mints a stable id, becomes active as the first KG, and persists", () => {
    const r = KgRegistry.open(path);
    const a = r.create({ name: "Backend Engineer", dbPathFor: (id) => join(dir, `kg_${id}.duckdb`) });
    expect(a.kg_id).toBeTruthy();
    expect(a.db_path).toContain(a.kg_id);
    expect(a.read_only).toBe(false);
    expect(r.activeId()).toBe(a.kg_id); // first KG is auto-active

    const b = r.create({ name: "Data Scientist", dbPathFor: (id) => join(dir, `kg_${id}.duckdb`) });
    expect(b.kg_id).not.toBe(a.kg_id);        // unique ids
    expect(r.activeId()).toBe(a.kg_id);        // active does NOT move on later creates
    expect(r.list().map((e) => e.name)).toEqual(["Backend Engineer", "Data Scientist"]);

    // survives a reopen from the same file
    const reopened = KgRegistry.open(path);
    expect(reopened.list().map((e) => e.kg_id)).toEqual([a.kg_id, b.kg_id]);
    expect(reopened.activeId()).toBe(a.kg_id);
  });

  test("rename changes only the label; id and db_path are frozen", () => {
    const r = KgRegistry.open(path);
    const a = r.create({ name: "Backend Engineer", dbPathFor: (id) => join(dir, `kg_${id}.duckdb`) });
    const renamed = r.rename(a.kg_id, "  Senior Backend Engineer  ");
    expect(renamed.name).toBe("Senior Backend Engineer"); // trimmed
    expect(renamed.kg_id).toBe(a.kg_id);
    expect(renamed.db_path).toBe(a.db_path);
    expect(r.get(a.kg_id)!.name).toBe("Senior Backend Engineer");
  });

  test("blank names and unknown ids are rejected", () => {
    const r = KgRegistry.open(path);
    const a = r.create({ name: "KG", dbPathFor: (id) => join(dir, `kg_${id}.duckdb`) });
    expect(() => r.create({ name: "   ", dbPathFor: () => join(dir, "x.duckdb") })).toThrow(/name must not be empty/);
    expect(() => r.rename(a.kg_id, "  ")).toThrow(/name must not be empty/);
    expect(() => r.rename("nope", "X")).toThrow(/unknown KG/);
    expect(() => r.setActive("nope")).toThrow(/unknown KG/);
  });

  test("create requires a resolvable db path", () => {
    const r = KgRegistry.open(path);
    expect(() => r.create({ name: "KG" })).toThrow(/dbPath or dbPathFor/);
  });

  test("ensureDefault is idempotent by db_path (adopts the legacy file with zero data loss)", () => {
    const legacy = join(dir, "kb_graph.duckdb");
    const r = KgRegistry.open(path);
    const first = r.ensureDefault({ name: "My Knowledge", dbPath: legacy });
    const again = r.ensureDefault({ name: "Renamed Ignored", dbPath: legacy });
    expect(again.kg_id).toBe(first.kg_id);           // same entry, not a duplicate
    expect(again.name).toBe("My Knowledge");          // second call does not overwrite
    expect(r.list()).toHaveLength(1);
    expect(r.activeId()).toBe(first.kg_id);
  });

  test("setActive moves the active pointer and persists", () => {
    const r = KgRegistry.open(path);
    const a = r.create({ name: "A", dbPathFor: (id) => join(dir, `kg_${id}.duckdb`) });
    const b = r.create({ name: "B", dbPathFor: (id) => join(dir, `kg_${id}.duckdb`) });
    r.setActive(b.kg_id);
    expect(r.activeId()).toBe(b.kg_id);
    expect(KgRegistry.open(path).activeId()).toBe(b.kg_id);
    // sanity: `a` is still there
    expect(r.get(a.kg_id)).toBeDefined();
  });

  test("list/get return copies — external mutation cannot corrupt registry state", () => {
    const r = KgRegistry.open(path);
    const a = r.create({ name: "A", dbPathFor: (id) => join(dir, `kg_${id}.duckdb`) });
    const copy = r.get(a.kg_id)!;
    copy.name = "hacked";
    expect(r.get(a.kg_id)!.name).toBe("A");
    const listed = r.list();
    listed[0]!.name = "hacked";
    expect(r.list()[0]!.name).toBe("A");
  });

  test("a corrupt registry file throws rather than silently wiping the KG list", () => {
    writeFileSync(path, "{ this is not json", "utf8");
    expect(() => KgRegistry.open(path)).toThrow(/unreadable\/corrupt/);
    // the bad file is left intact for recovery
    expect(readFileSync(path, "utf8")).toContain("not json");
  });

  test("an active pointer to a deleted entry falls back to the first KG on open", () => {
    // hand-craft a registry whose active_kg_id references a missing entry
    writeFileSync(path, JSON.stringify({
      version: 1,
      active_kg_id: "ghost",
      entries: [{ kg_id: "real", name: "Real", db_path: join(dir, "real.duckdb"), source_kind: "manual", read_only: false, provenance: "", created_at: "x", updated_at: "x" }],
    }), "utf8");
    const r = KgRegistry.open(path);
    expect(r.activeId()).toBe("real"); // normalized to a valid entry
  });
});
