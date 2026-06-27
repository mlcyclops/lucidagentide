// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/memory/resume.test.ts

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "./db.ts";
import { upsertWorkingState } from "./memory.ts";
import { resumeRun } from "./resume.ts";

let dir: string;
let db: Db;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "resume-test-"));
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
async function approve(artifactId: string) {
  await db.run(
    `INSERT INTO approval_events (approval_id, artifact_id, action, decided_by, created_at)
     VALUES ($1,$2,'quarantine_release','tester', now())`,
    [`ap-${artifactId}`, artifactId],
  );
}

test("resume returns the working state", async () => {
  await upsertWorkingState(db, "run-1", { goal: "ship P4.3", nextStep: "resume" });
  const r = await resumeRun(db, "run-1");
  expect(r.workingState?.goal).toBe("ship P4.3");
});

test("resume is UNSAFE while a quarantined artifact is unreviewed, SAFE after approval", async () => {
  await addArtifact("q", "quarantined");
  const before = await resumeRun(db, "run-1");
  expect(before.safe).toBe(false);
  expect(before.blocking).toHaveLength(1);

  await approve("q");
  const after = await resumeRun(db, "run-1");
  expect(after.safe).toBe(true);
  expect(after.blocking).toHaveLength(0);
});

test("a run with only clean artifacts resumes safely", async () => {
  await addArtifact("u", "untrusted");
  expect((await resumeRun(db, "run-1")).safe).toBe(true);
});
