// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/kb_store.test.ts — P-KB.2b + P-KGPACK.1 (ADR-0205): the desktop's compiled-KB handle. Confirms
// the default KG opens at the configured legacy path (singleton, reopen-fresh) AND the multi-KG behaviour:
// the default adopts the pre-existing kb_graph.duckdb with zero data loss, created KGs are isolated files,
// rename touches only the label, and switching the active KG re-points a no-arg store lookup.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KbGraphStore } from "../harness/kb/store.ts";
import {
  _resetKbStoreForTest, kbStore, stopKb,
  listKgs, activeKgId, createKg, renameKg, setActiveKg,
} from "./kb_store.ts";

describe("kbStore — desktop singleton", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "kb-desktop-")); process.env.LUCID_KB_DB_PATH = join(dir, "kb_graph.duckdb"); _resetKbStoreForTest(); });
  afterEach(async () => { await stopKb(); delete process.env.LUCID_KB_DB_PATH; rmSync(dir, { recursive: true, force: true }); });

  test("opens at the configured path (migrated + empty) and returns the SAME instance", async () => {
    const a = await kbStore();
    const b = await kbStore();
    expect(a).toBe(b); // one writer for the active KG
    expect(await a.pageCount()).toBe(0);
  });

  test("reopens a fresh store after teardown", async () => {
    const first = await kbStore();
    await stopKb(); // closes + nulls the caches
    const second = await kbStore();
    expect(second).not.toBe(first);
    expect(await second.pageCount()).toBe(0);
  });
});

describe("kbStore — named KGs (P-KGPACK.1)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "kg-multi-")); process.env.LUCID_KB_DB_PATH = join(dir, "kb_graph.duckdb"); _resetKbStoreForTest(); });
  afterEach(async () => { await stopKb(); delete process.env.LUCID_KB_DB_PATH; rmSync(dir, { recursive: true, force: true }); });

  test("a default 'My Knowledge' KG is auto-registered and active", async () => {
    await kbStore(); // triggers registry seed
    const kgs = listKgs();
    expect(kgs).toHaveLength(1);
    expect(kgs[0]!.name).toBe("My Knowledge");
    expect(kgs[0]!.db_path).toBe(join(dir, "kb_graph.duckdb"));
    expect(activeKgId()).toBe(kgs[0]!.kg_id);
  });

  test("the default KG ADOPTS a pre-existing kb_graph.duckdb (zero data loss)", async () => {
    // simulate today's combined KB: write a page into the legacy file BEFORE the registry ever sees it
    const legacy = await KbGraphStore.open(join(dir, "kb_graph.duckdb"));
    await legacy.addPage({ kind: "summary", slug: "legacy", title: "Legacy", bodyMd: "carried forward", trustLabel: "untrusted", classification: "U" });
    legacy.close();

    _resetKbStoreForTest();
    const store = await kbStore(); // active default should point at that same file
    expect(await store.pageCount()).toBe(1); // the pre-existing page survived
  });

  test("created KGs are isolated files; the active pointer moves on switch", async () => {
    await kbStore(); // seed default
    const be = createKg({ name: "Backend Engineer" });
    const ds = createKg({ name: "Data Scientist" });
    expect(listKgs()).toHaveLength(3);
    expect(be.db_path).not.toBe(ds.db_path);

    await (await kbStore(be.kg_id)).addPage({ kind: "concept", slug: "api", title: "API", bodyMd: "x", trustLabel: "untrusted", classification: "U" });
    const dsStore = await kbStore(ds.kg_id);
    await dsStore.addPage({ kind: "concept", slug: "ml", title: "ML", bodyMd: "y", trustLabel: "untrusted", classification: "U" });
    await dsStore.addPage({ kind: "entity", slug: "pandas", title: "pandas", bodyMd: "z", trustLabel: "untrusted", classification: "U" });

    expect(await (await kbStore(be.kg_id)).pageCount()).toBe(1);   // isolation: BE has just its page
    expect(await (await kbStore(ds.kg_id)).pageCount()).toBe(2);   // DS has just its two
    expect(await (await kbStore()).pageCount()).toBe(0);           // default (still active) is untouched

    setActiveKg(ds.kg_id);
    expect(activeKgId()).toBe(ds.kg_id);
    expect(await (await kbStore()).pageCount()).toBe(2);           // no-arg now resolves to DS
  });

  test("rename changes the label without touching the id or file", async () => {
    await kbStore();
    const be = createKg({ name: "Backend Engineer" });
    const renamed = renameKg(be.kg_id, "Senior Backend Engineer");
    expect(renamed.kg_id).toBe(be.kg_id);
    expect(renamed.db_path).toBe(be.db_path);
    expect(listKgs().find((k) => k.kg_id === be.kg_id)!.name).toBe("Senior Backend Engineer");
  });
});
