// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/memory/obs_mirror.test.ts
//
// The lock-free harness-memory mirror (ADR-0211 pattern applied to the Memory panel). THE POINT:
// while omp's gate child holds agent_obs.duckdb read-write, no other process can open it at all -
// so the dashboard summary must be readable WITHOUT touching DuckDB. These tests prove the
// writer-side snapshot matches the DB, and that the read side works with the DB handle closed or
// the file gone, and degrades to null (never throws) on a torn or foreign file.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "./db.ts";
import { promoteFact } from "./memory.ts";
import { mirrorPathFor, readHarnessMirror, snapshotHarnessMemory, writeHarnessMirror } from "./obs_mirror.ts";

let dir: string;
let dbPath: string;
let db: Db;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "obs-mirror-"));
  dbPath = join(dir, "agent_obs.duckdb");
  db = await Db.open(dbPath);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("snapshot reflects promoted facts and blocked-promotion telemetry", async () => {
  await promoteFact(db, { entityName: "service", statement: "listens on 8080", trustLabel: "trusted" });
  await promoteFact(db, { entityName: "api", statement: "uses bearer auth", trustLabel: "untrusted" });
  await db.run(
    `INSERT INTO telemetry_events (event_id, ts, event, run_id, session_id, ingested_at)
     VALUES ('t1', now(), 'memory_promotion_blocked','r','s', now())`,
  );
  const snap = await snapshotHarnessMemory(db);
  expect(snap.counts.facts).toBe(2);
  expect(snap.gate).toEqual({ promoted: 2, blocked: 1 });
  expect(snap.facts.map((f) => f.entity).sort()).toEqual(["api", "service"]);
  expect(snap.layers.map((l) => l.layer)).toEqual(["working", "archive", "semantic"]);
});

test("the snapshot lists the 8 NEWEST facts, newest first, with counts from the same statement", async () => {
  for (let i = 1; i <= 10; i++) await promoteFact(db, { entityName: `e${i}`, statement: `fact ${i}`, trustLabel: "trusted" });
  const snap = await snapshotHarnessMemory(db);
  expect(snap.counts.facts).toBe(10);
  expect(snap.facts.map((f) => f.statement)).toEqual(["fact 10", "fact 9", "fact 8", "fact 7", "fact 6", "fact 5", "fact 4", "fact 3"]);
});

test("THE POINT: the mirror is readable after the DB handle is gone (no DuckDB open needed)", async () => {
  await promoteFact(db, { entityName: "service", statement: "listens on 8080", trustLabel: "trusted" });
  await writeHarnessMirror(db, dbPath);
  db.close(); // simulate: the reader process cannot open the DB at all
  const got = readHarnessMirror(dbPath);
  expect(got).not.toBeNull();
  expect(got!.counts.facts).toBe(1);
  expect(got!.facts[0]).toEqual({ entity: "service", statement: "listens on 8080", trust_label: "trusted" });
  db = { close() {} } as unknown as Db; // afterEach double-close guard
});

test("a missing mirror reads as null (honest empty state)", () => {
  expect(readHarnessMirror(join(dir, "nope.duckdb"))).toBeNull();
});

test("a torn or foreign mirror file degrades to null, never throws", () => {
  writeFileSync(mirrorPathFor(dbPath), "{ torn");
  expect(readHarnessMirror(dbPath)).toBeNull();
  writeFileSync(mirrorPathFor(dbPath), JSON.stringify({ memory: { counts: 3 } }));
  expect(readHarnessMirror(dbPath)).toBeNull();
});

test("refreshing the mirror replaces the previous snapshot atomically", async () => {
  await writeHarnessMirror(db, dbPath);
  expect(readHarnessMirror(dbPath)!.counts.facts).toBe(0);
  await promoteFact(db, { entityName: "e", statement: "s", trustLabel: "trusted" });
  await writeHarnessMirror(db, dbPath);
  expect(readHarnessMirror(dbPath)!.counts.facts).toBe(1);
});
