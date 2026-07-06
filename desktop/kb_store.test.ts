// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/kb_store.test.ts — P-KB.2b: the desktop's compiled-KB handle. Confirms the process-wide store
// opens at the configured path (migrated + empty), is a genuine singleton across calls, and reopens fresh
// after teardown. The compile/gate/retrieve logic itself is covered in harness/kb/*.test.ts.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetKbStoreForTest, kbStore, stopKb } from "./kb_store.ts";

describe("kbStore — desktop singleton", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "kb-desktop-")); process.env.LUCID_KB_DB_PATH = join(dir, "kb_graph.duckdb"); _resetKbStoreForTest(); });
  afterEach(async () => { await stopKb(); delete process.env.LUCID_KB_DB_PATH; rmSync(dir, { recursive: true, force: true }); });

  test("opens at the configured path (migrated + empty) and returns the SAME instance", async () => {
    const a = await kbStore();
    const b = await kbStore();
    expect(a).toBe(b); // one process-wide writer
    expect(await a.pageCount()).toBe(0);
  });

  test("reopens a fresh store after teardown", async () => {
    const first = await kbStore();
    await stopKb(); // closes + nulls the singleton
    const second = await kbStore();
    expect(second).not.toBe(first);
    expect(await second.pageCount()).toBe(0);
  });
});
