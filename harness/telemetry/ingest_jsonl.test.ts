// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/telemetry/ingest_jsonl.test.ts

import { test, expect, beforeEach, afterEach } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../memory/db.ts";
import { Telemetry, fileSink } from "./events.ts";
import { ingestTelemetryJsonl } from "./ingest_jsonl.ts";
import { eventCountsByType, findingsByType, runTimeline } from "./queries.ts";

let dir: string;
let db: Db;
let jsonl: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "jsonl-test-"));
  db = await Db.open(join(dir, "t.duckdb"));
  jsonl = join(dir, "events.jsonl");
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function emitSome() {
  const tel = new Telemetry({ runId: "run-1", sessionId: "sess-1", sink: fileSink(jsonl) });
  tel.emit("content_ingested", { artifact_id: "art-1", source_type: "import" });
  tel.emit("finding_detected", { artifact_id: "art-1", finding_type: "zero-width", severity: "high" });
  tel.emit("finding_detected", { artifact_id: "art-1", finding_type: "bidi-control", severity: "high" });
  tel.emit("artifact_quarantined", { artifact_id: "art-1" });
}

test("ingests events and promotes the envelope columns", async () => {
  emitSome();
  const stats = await ingestTelemetryJsonl(db, jsonl);
  expect(stats.inserted).toBe(4);
  expect(stats.skipped).toBe(0);

  const row = await db.get("SELECT event, run_id, artifact_id FROM telemetry_events WHERE event='content_ingested'");
  expect(row?.run_id).toBe("run-1");
  expect(row?.artifact_id).toBe("art-1");
});

test("ingestion is idempotent (event_id is the dedup key)", async () => {
  emitSome();
  expect((await ingestTelemetryJsonl(db, jsonl)).inserted).toBe(4);
  const again = await ingestTelemetryJsonl(db, jsonl);
  expect(again.inserted).toBe(0);
  expect(again.duplicates).toBe(4);
});

test("new events appended later are picked up, old ones not duplicated", async () => {
  emitSome();
  await ingestTelemetryJsonl(db, jsonl);
  const tel = new Telemetry({ runId: "run-1", sessionId: "sess-1", sink: fileSink(jsonl) });
  tel.emit("approval_denied", { artifact_id: "art-1", action: "deny" });
  const stats = await ingestTelemetryJsonl(db, jsonl);
  expect(stats.inserted).toBe(1); // only the new one
});

test("malformed and incomplete lines are skipped, not dropped silently", async () => {
  writeFileSync(
    jsonl,
    [
      "{ not json",
      JSON.stringify({ event_id: "e1", ts: "2026-06-18T00:00:00Z", event: "run_started", run_id: "r", session_id: "s" }),
      JSON.stringify({ ts: "2026-06-18T00:00:00Z", event: "run_started", run_id: "r", session_id: "s" }), // no event_id
      JSON.stringify({ event_id: "e2", ts: "not-a-date", event: "run_started", run_id: "r", session_id: "s" }), // bad ts -> insert fails
      "",
    ].join("\n"),
  );
  const stats = await ingestTelemetryJsonl(db, jsonl);
  expect(stats.inserted).toBe(1);
  expect(stats.skipped).toBe(3);
});

test("fields json + queries: findings by type and run timeline", async () => {
  emitSome();
  await ingestTelemetryJsonl(db, jsonl);

  const byType = await findingsByType(db);
  const types = byType.map((r) => r.finding_type).sort();
  expect(types).toEqual(["bidi-control", "zero-width"]);

  const counts = await eventCountsByType(db, "run-1");
  expect(counts.find((c) => c.event === "finding_detected")?.n).toBe(2);

  const timeline = await runTimeline(db, "run-1");
  expect(timeline.length).toBe(4);
});
