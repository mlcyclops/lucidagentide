// harness/memory/recall.test.ts
//
// KEYSTONE #2 coverage for the READ side: suspicious/quarantined facts must never
// be recallable into a later session, statements are markdown-escaped, and a
// recall is logged + emits memory_recalled.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "./db.ts";
import { promoteFact } from "./memory.ts";
import { buildRecall } from "./recall.ts";
import { Telemetry, type TelemetryEvent } from "../telemetry/events.ts";
import type { TrustLabel } from "../contracts.ts";

let dir: string;
let db: Db;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "recall-"));
  db = await Db.open(join(dir, "agent_obs.duckdb"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const seed = (entityName: string, statement: string, trustLabel: TrustLabel) =>
  promoteFact(db, { entityName, statement, trustLabel });

test("keystone #2: only trusted/untrusted facts are recallable; suspicious/quarantined never", async () => {
  await seed("a", "trusted fact", "trusted");
  await seed("b", "untrusted fact", "untrusted");
  await seed("c", "SUSPICIOUS injection", "suspicious");
  await seed("d", "QUARANTINED payload", "quarantined");

  const out = await buildRecall(db, { limit: 50 });
  expect(out.count).toBe(2);
  expect(out.factIds.length).toBe(2);
  expect(out.block).toContain("trusted fact");
  expect(out.block).toContain("untrusted fact");
  expect(out.block).not.toContain("SUSPICIOUS injection");
  expect(out.block).not.toContain("QUARANTINED payload");
});

test("every statement + entity is markdown/codepoint escaped (defense in depth)", async () => {
  // zero-width space (invisible) + markdown metachars in the statement.
  await seed("ent*x", "danger\u200Bzone *bold* [link](x)", "untrusted");
  const out = await buildRecall(db, { limit: 10 });
  expect(out.block).not.toBeNull();
  const block = out.block!;
  // no raw invisible char survives
  expect(block.includes("\u200B")).toBe(false);
  // dangerous codepoint rendered as U+XXXX notation; metachars backslash-escaped
  expect(block).toContain("\\u{200b}");
  expect(block).toContain("\\*bold\\*");
  expect(block).toContain("ent\\*x");
});

test("with a sessionId: logs fact_sessions + emits memory_recalled; without: neither", async () => {
  await seed("a", "fact one", "trusted");
  await seed("b", "fact two", "trusted");

  // no sessionId -> read-only, no side effects
  const events: TelemetryEvent[] = [];
  const silent = await buildRecall(db, {});
  expect(silent.count).toBe(2);
  expect((await db.all("SELECT * FROM fact_sessions")).length).toBe(0);

  // with sessionId -> one sidecar row per fact + a single memory_recalled event
  const tel = new Telemetry({ runId: "run-B", sessionId: "sess-B", sink: (e) => events.push(e) });
  const out = await buildRecall(db, { sessionId: "sess-B", runId: "run-B", limit: 10, telemetry: tel });
  const rows = await db.all("SELECT * FROM fact_sessions ORDER BY fact_id");
  expect(rows.length).toBe(2);
  expect(rows.every((r) => r.session_id === "sess-B" && r.run_id === "run-B")).toBe(true);
  expect(new Set(rows.map((r) => String(r.fact_id)))).toEqual(new Set(out.factIds));

  const recalled = events.filter((e) => e.event === "memory_recalled");
  expect(recalled.length).toBe(1);
  expect(recalled[0]!.count).toBe(2);
  expect(recalled[0]!.run_id).toBe("run-B");
  expect(recalled[0]!.session_id).toBe("sess-B");
});

test("limit caps the block; 0 and empty are null", async () => {
  expect((await buildRecall(db, { limit: 10 })).block).toBeNull(); // empty db
  await seed("a", "f1", "trusted");
  await seed("b", "f2", "trusted");
  await seed("c", "f3", "trusted");
  expect((await buildRecall(db, { limit: 2 })).count).toBe(2);
  expect((await buildRecall(db, { limit: 0 })).block).toBeNull();
});

test("buildRecall reads over a read-only connection (Db.openReadOnly) — the live dev-server path", async () => {
  const path = join(dir, "agent_obs.duckdb");
  await seed("a", "ro fact", "trusted");
  await seed("b", "blocked payload", "quarantined");
  db.close(); // drop the writable handle; the reader must not need it

  const ro = await Db.openReadOnly(path);
  const out = await buildRecall(ro, { limit: 10 }); // no sessionId -> pure read, no fact_sessions write
  ro.close();
  db = await Db.open(path); // restore so afterEach's close() is valid

  expect(out.count).toBe(1);
  expect(out.block).toContain("ro fact");
  expect(out.block).not.toContain("blocked payload");
});
