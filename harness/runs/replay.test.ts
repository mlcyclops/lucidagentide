// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/runs/replay.test.ts

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../memory/db.ts";
import { startRun, spawnSubagent } from "./lineage.ts";
import { buildReplay, renderReplay } from "./replay.ts";

let dir: string;
let db: Db;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "replay-test-"));
  db = await Db.open(join(dir, "t.duckdb"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function addArtifact(runId: string, id: string, trust: string) {
  await db.run(
    `INSERT INTO content_artifacts (artifact_id, run_id, source_type, trust_label, raw_sha256, created_at)
     VALUES ($1,$2,'import',$3,'h', now())`,
    [id, runId, trust],
  );
}
async function addEvent(runId: string, id: string, event: string) {
  await db.run(
    `INSERT INTO telemetry_events (event_id, ts, event, run_id, session_id, ingested_at)
     VALUES ($1, now(), $2, $3, 's', now())`,
    [id, event, runId],
  );
}

test("buildReplay returns the tree, totals, and timeline for the subtree", async () => {
  const root = await startRun(db, { kind: "root" });
  const child = await spawnSubagent(db, root);
  await addArtifact(child, "a-q", "quarantined");
  await addEvent(root, "e1", "run_started");
  await addEvent(child, "e2", "artifact_quarantined");

  const r = await buildReplay(db, root);
  expect(r?.totals.runs).toBe(2);
  expect(r?.totals.suspicious).toBe(1);
  expect(r?.timeline.length).toBe(2); // both runs' events
  expect(r?.tree.children[0]?.runId).toBe(child);
});

test("renderReplay produces inspectable text with totals", async () => {
  const root = await startRun(db, { kind: "root", mode: "build" });
  const r = await buildReplay(db, root);
  const text = renderReplay(r!);
  expect(text).toContain(`replay of run ${root}`);
  expect(text).toContain("totals: runs=1");
});

test("buildReplay returns undefined for an unknown root", async () => {
  expect(await buildReplay(db, "nope")).toBeUndefined();
});
