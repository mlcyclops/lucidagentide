// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/memory/promotion_gate.test.ts
//
// CORRECTNESS KEYSTONE #2 — over-tested. Suspicious-source content must never
// auto-promote into semantic memory.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "./db.ts";
import { promoteFactGated } from "./promotion_gate.ts";
import { Telemetry, type TelemetryEvent } from "../telemetry/events.ts";

let dir: string;
let db: Db;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "promote-test-"));
  db = await Db.open(join(dir, "t.duckdb"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function addArtifact(id: string, trust: string) {
  await db.run(
    `INSERT INTO content_artifacts (artifact_id, run_id, source_type, trust_label, raw_sha256, created_at)
     VALUES ($1,'run-1','import',$2,'h', now())`,
    [id, trust],
  );
}
async function approve(artifactId: string, action: string) {
  await db.run(
    `INSERT INTO approval_events (approval_id, artifact_id, action, decided_by, created_at)
     VALUES ($1,$2,$3,'tester', now())`,
    [`ap-${artifactId}-${action}`, artifactId, action],
  );
}
async function factCount(): Promise<number> {
  return Number((await db.get("SELECT count(*)::INT AS n FROM semantic_facts"))?.n ?? 0);
}
const base = { entityName: "e", statement: "s", trustLabel: "trusted" as const };

test("quarantined source is blocked and writes no fact", async () => {
  await addArtifact("q", "quarantined");
  const out = await promoteFactGated(db, { ...base, sourceArtifactId: "q" });
  expect(out.blocked).toBe(true);
  expect(out.promoted).toBe(false);
  expect(await factCount()).toBe(0);
});

test("suspicious source is blocked", async () => {
  await addArtifact("s", "suspicious");
  expect((await promoteFactGated(db, { ...base, sourceArtifactId: "s" })).blocked).toBe(true);
});

test("trusted and untrusted sources are promoted", async () => {
  await addArtifact("t", "trusted");
  await addArtifact("u", "untrusted");
  expect((await promoteFactGated(db, { ...base, entityName: "et", sourceArtifactId: "t" })).promoted).toBe(true);
  expect((await promoteFactGated(db, { ...base, entityName: "eu", sourceArtifactId: "u" })).promoted).toBe(true);
  expect(await factCount()).toBe(2);
});

test("KEYSTONE: a caller cannot lie about trust — source provenance wins", async () => {
  await addArtifact("q", "quarantined");
  // caller claims trustLabel: 'trusted', but the SOURCE is quarantined
  const out = await promoteFactGated(db, { ...base, trustLabel: "trusted", sourceArtifactId: "q" });
  expect(out.blocked).toBe(true);
  expect(out.sourceTrust).toBe("quarantined");
  expect(await factCount()).toBe(0);
});

test("fail-closed: unknown source artifact is blocked", async () => {
  const out = await promoteFactGated(db, { ...base, sourceArtifactId: "nope" });
  expect(out.blocked).toBe(true);
  expect(out.reason).toContain("fail-closed");
});

test("approval (promotion_approve or quarantine_release) unblocks", async () => {
  await addArtifact("q1", "quarantined");
  await approve("q1", "promotion_approve");
  expect((await promoteFactGated(db, { ...base, entityName: "e1", sourceArtifactId: "q1" })).promoted).toBe(true);

  await addArtifact("q2", "quarantined");
  await approve("q2", "quarantine_release");
  expect((await promoteFactGated(db, { ...base, entityName: "e2", sourceArtifactId: "q2" })).promoted).toBe(true);
});

test("no source: a suspicious trustLabel is blocked, trusted is allowed", async () => {
  expect((await promoteFactGated(db, { entityName: "a", statement: "s", trustLabel: "suspicious" })).blocked).toBe(true);
  expect((await promoteFactGated(db, { entityName: "b", statement: "s", trustLabel: "trusted" })).promoted).toBe(true);
});

test("a block emits memory_promotion_blocked telemetry", async () => {
  await addArtifact("q", "quarantined");
  const events: TelemetryEvent[] = [];
  const tel = new Telemetry({ runId: "r", sessionId: "s", sink: (e) => events.push(e) });
  await promoteFactGated(db, { ...base, sourceArtifactId: "q" }, { telemetry: tel });
  expect(events.map((e) => e.event)).toContain("memory_promotion_blocked");
});
