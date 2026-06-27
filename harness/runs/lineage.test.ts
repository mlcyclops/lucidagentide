// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/runs/lineage.test.ts

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../memory/db.ts";
import { endRun, getLineage, getRunTree, spawnSubagent, startRun } from "./lineage.ts";

let dir: string;
let db: Db;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "lineage-test-"));
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

test("startRun + endRun records status and end time", async () => {
  const id = await startRun(db, { kind: "root", mode: "build", sandboxProfile: "trusted-local" });
  let row = await db.get("SELECT status, ended_at, kind FROM runs WHERE run_id=$1", [id]);
  expect(row?.status).toBe("running");
  expect(row?.ended_at).toBeNull();
  await endRun(db, id, "completed");
  row = await db.get("SELECT status, ended_at FROM runs WHERE run_id=$1", [id]);
  expect(row?.status).toBe("completed");
  expect(row?.ended_at).not.toBeNull();
});

test("spawnSubagent links parent and inherits the session", async () => {
  const root = await startRun(db, { kind: "root", sessionId: "sess-9" });
  const child = await spawnSubagent(db, root, { mode: "general" });
  const row = await db.get("SELECT parent_run_id, session_id, kind, mode FROM runs WHERE run_id=$1", [child]);
  expect(row?.parent_run_id).toBe(root);
  expect(row?.session_id).toBe("sess-9");
  expect(row?.kind).toBe("subagent");
  expect(row?.mode).toBe("general");
});

test("getRunTree reconstructs the hierarchy", async () => {
  const root = await startRun(db, { kind: "root" });
  const a = await spawnSubagent(db, root);
  const b = await spawnSubagent(db, root);
  const gc = await spawnSubagent(db, a);

  const tree = await getRunTree(db, root);
  expect(tree?.runId).toBe(root);
  expect(tree?.children.map((c) => c.runId).sort()).toEqual([a, b].sort());
  const aNode = tree?.children.find((c) => c.runId === a);
  expect(aNode?.children[0]?.runId).toBe(gc);
});

test("getRunTree surfaces per-run suspicious artifact counts (scan lineage)", async () => {
  const root = await startRun(db, { kind: "root" });
  const child = await spawnSubagent(db, root);
  await addArtifact(child, "art-q", "quarantined");
  await addArtifact(child, "art-s", "suspicious");
  await addArtifact(child, "art-u", "untrusted"); // not counted
  await addArtifact(root, "art-clean", "trusted"); // not counted

  const tree = await getRunTree(db, root);
  expect(tree?.suspiciousArtifacts).toBe(0);
  expect(tree?.children[0]?.suspiciousArtifacts).toBe(2);
});

test("getLineage returns the root-to-node chain", async () => {
  const root = await startRun(db, { kind: "root" });
  const a = await spawnSubagent(db, root);
  const gc = await spawnSubagent(db, a);
  expect(await getLineage(db, gc)).toEqual([root, a, gc]);
  expect(await getLineage(db, root)).toEqual([root]);
});

test("getRunTree returns undefined for an unknown root", async () => {
  expect(await getRunTree(db, "nope")).toBeUndefined();
});
