// harness/memory/memory.test.ts

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "./db.ts";
import { archiveChunk, getArchiveChunk, getFacts, getWorkingState, promoteFact, upsertWorkingState } from "./memory.ts";

let dir: string;
let db: Db;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "memory-test-"));
  db = await Db.open(join(dir, "t.duckdb"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("working state upserts (one row per run, updated in place)", async () => {
  await upsertWorkingState(db, "r1", { goal: "g1", nextStep: "s1" });
  await upsertWorkingState(db, "r1", { goal: "g1", nextStep: "s2", blockers: "b" });
  const ws = await getWorkingState(db, "r1");
  expect(ws?.next_step).toBe("s2");
  expect(ws?.blockers).toBe("b");
  const n = await db.get("SELECT count(*)::INT AS n FROM working_state WHERE run_id='r1'");
  expect(n?.n).toBe(1);
});

test("working state defaults trust to trusted", async () => {
  await upsertWorkingState(db, "r2", { goal: "g" });
  expect((await getWorkingState(db, "r2"))?.trust_label).toBe("trusted");
});

test("archive preserves the raw content and its hash", async () => {
  const id = await archiveChunk(db, { runId: "r1", content: "raw original" });
  const row = await getArchiveChunk(db, id);
  expect(row?.content).toBe("raw original");
  expect(typeof row?.content_sha256).toBe("string");
});

test("promoteFact records provenance + trust and creates the entity", async () => {
  const chunk = await archiveChunk(db, { content: "src" });
  const { factId, entityId } = await promoteFact(db, {
    entityName: "build-system",
    statement: "builds with Bun",
    trustLabel: "trusted",
    sourceArchiveChunkId: chunk,
  });
  expect(factId).toBeTruthy();
  const facts = await getFacts(db, "build-system");
  expect(facts).toHaveLength(1);
  expect(facts[0]!.entity_id).toBe(entityId);
  expect(facts[0]!.source_archive_chunk_id).toBe(chunk);
  expect(facts[0]!.trust_label).toBe("trusted");
});

test("a second fact for the same entity reuses that entity", async () => {
  const a = await promoteFact(db, { entityName: "e", statement: "f1", trustLabel: "trusted" });
  const b = await promoteFact(db, { entityName: "e", statement: "f2", trustLabel: "untrusted" });
  expect(a.entityId).toBe(b.entityId);
  expect(await getFacts(db, "e")).toHaveLength(2);
  const entities = await db.get("SELECT count(*)::INT AS n FROM semantic_entities WHERE name='e'");
  expect(entities?.n).toBe(1);
});
