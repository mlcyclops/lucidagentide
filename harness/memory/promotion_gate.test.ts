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

// ── P-CAP.1b (ADR-0590): a fact derived from several artifacts ───────────────────────────────────────
// The fact carries the most severe label among its sources, every source must be found, and every source
// that needs review needs its own approval. A derived fact can never launder a source.

test("derived from clean sources: promoted, with the most severe of their labels", async () => {
  await addArtifact("t1", "trusted");
  await addArtifact("u1", "untrusted");
  const out = await promoteFactGated(db, { ...base, derivedFrom: ["t1", "u1"] });
  expect(out.promoted).toBe(true);
  expect(out.sourceTrust).toBe("untrusted");
  expect((await db.get("SELECT trust_label, source_artifact_id FROM semantic_facts"))).toEqual({ trust_label: "untrusted", source_artifact_id: "t1" });
});

test("derived from one suspicious source among clean ones: blocked, nothing written", async () => {
  await addArtifact("t1", "trusted");
  await addArtifact("s1", "suspicious");
  const out = await promoteFactGated(db, { ...base, derivedFrom: ["t1", "s1"] });
  expect(out).toMatchObject({ promoted: false, blocked: true, sourceTrust: "suspicious" });
  expect(out.reason).toBe("blocked: a source this fact derives from is suspicious (human review required before promotion)");
  expect(await factCount()).toBe(0);
});

test("derived from a quarantined source: blocked, whatever else it derives from", async () => {
  await addArtifact("t1", "trusted");
  await addArtifact("q1", "quarantined");
  for (const derivedFrom of [["q1"], ["t1", "q1"], ["q1", "t1"]]) {
    const out = await promoteFactGated(db, { ...base, derivedFrom });
    expect(out.blocked).toBe(true);
    expect(out.sourceTrust).toBe("quarantined");
  }
  expect(await factCount()).toBe(0);
});

test("the caller's own label never softens a derived fact", async () => {
  await addArtifact("s1", "suspicious");
  expect((await promoteFactGated(db, { ...base, trustLabel: "trusted", derivedFrom: ["s1"] })).blocked).toBe(true);
  expect((await promoteFactGated(db, { ...base, trustLabel: "trusted", sourceArtifactId: "s1", derivedFrom: [] })).blocked).toBe(true);
  expect(await factCount()).toBe(0);
});

test("a clean primary source does not cover for a suspicious derived one", async () => {
  await addArtifact("t1", "trusted");
  await addArtifact("s1", "suspicious");
  expect((await promoteFactGated(db, { ...base, sourceArtifactId: "t1", derivedFrom: ["s1"] })).blocked).toBe(true);
  expect((await promoteFactGated(db, { ...base, sourceArtifactId: "s1", derivedFrom: ["t1"] })).blocked).toBe(true);
  expect(await factCount()).toBe(0);
});

test("FAIL-CLOSED: one derived source that cannot be found blocks the fact", async () => {
  await addArtifact("t1", "trusted");
  const out = await promoteFactGated(db, { ...base, derivedFrom: ["t1", "no-such-artifact"] });
  expect(out).toMatchObject({ promoted: false, blocked: true });
  expect(out.reason).toContain("provenance unverifiable");
  expect(await factCount()).toBe(0);
});

test("FAIL-CLOSED: a stored label outside the closed set counts as quarantined", async () => {
  await addArtifact("odd", "verified-by-agent");
  const out = await promoteFactGated(db, { ...base, derivedFrom: ["odd"] });
  expect(out.blocked).toBe(true);
  expect(out.sourceTrust).toBe("quarantined");
  expect((await promoteFactGated(db, { ...base, sourceArtifactId: "odd" })).blocked).toBe(true);
  expect(await factCount()).toBe(0);
});

test("each source that needs review needs its own approval: one approval does not clear the other", async () => {
  await addArtifact("s1", "suspicious");
  await addArtifact("s2", "suspicious");
  await approve("s1", "approve");
  const half = await promoteFactGated(db, { ...base, derivedFrom: ["s1", "s2"] });
  expect(half.blocked).toBe(true);
  expect(await factCount()).toBe(0);
  await approve("s2", "promotion_approve");
  const both = await promoteFactGated(db, { ...base, derivedFrom: ["s1", "s2"] });
  expect(both.promoted).toBe(true);
  expect(both.sourceTrust).toBe("suspicious"); // reviewed, and still labeled for what it is
  expect((await db.get("SELECT trust_label FROM semantic_facts"))?.trust_label).toBe("suspicious");
});

test("an approved suspicious source does not clear an unapproved quarantined one, and the block names the worse", async () => {
  await addArtifact("s1", "suspicious");
  await addArtifact("q1", "quarantined");
  await approve("s1", "approve");
  const events: TelemetryEvent[] = [];
  const tel = new Telemetry({ runId: "r", sessionId: "s", sink: (e) => events.push(e) });
  const out = await promoteFactGated(db, { ...base, derivedFrom: ["s1", "q1"] }, { telemetry: tel });
  expect(out.blocked).toBe(true);
  expect(out.reason).toContain("is quarantined");
  const ev = events.find((e) => e.event === "memory_promotion_blocked");
  expect(ev).toBeDefined();
  expect(await factCount()).toBe(0);
});

test("the same source named twice is one source, and no derived sources changes nothing", async () => {
  await addArtifact("u1", "untrusted");
  expect((await promoteFactGated(db, { ...base, sourceArtifactId: "u1", derivedFrom: ["u1", "u1"] })).promoted).toBe(true);
  expect((await promoteFactGated(db, { entityName: "plain", statement: "s", trustLabel: "trusted", derivedFrom: [] })).sourceTrust).toBe("trusted");
  expect(await factCount()).toBe(2);
});

test("with no source at all, a blocked label from the caller cannot be approved by anything", async () => {
  for (const trustLabel of ["suspicious", "quarantined"] as const) expect((await promoteFactGated(db, { entityName: "x", statement: "y", trustLabel })).blocked).toBe(true);
  expect(await factCount()).toBe(0);
});

