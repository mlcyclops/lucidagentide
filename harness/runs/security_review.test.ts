// harness/runs/security_review.test.ts

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../memory/db.ts";
import { startRun, getRunTree } from "./lineage.ts";
import { spawnSecurityReview } from "./security_review.ts";

let dir: string;
let db: Db;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "secrev-test-"));
  db = await Db.open(join(dir, "t.duckdb"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("spawnSecurityReview creates a read-only-audit child linked to its parent", async () => {
  const root = await startRun(db, { kind: "root", sessionId: "s1" });
  const review = await spawnSecurityReview(db, root);
  const row = await db.get("SELECT parent_run_id, kind, mode, sandbox_profile, session_id FROM runs WHERE run_id=$1", [review]);
  expect(row?.parent_run_id).toBe(root);
  expect(row?.kind).toBe("security-review");
  expect(row?.mode).toBe("security-review");
  expect(row?.sandbox_profile).toBe("read-only-audit");
  expect(row?.session_id).toBe("s1"); // inherits parent session
});

test("quarantine is an allowed (read-only) security-review profile", async () => {
  const root = await startRun(db, { kind: "root" });
  const review = await spawnSecurityReview(db, root, { profile: "quarantine" });
  const row = await db.get("SELECT sandbox_profile FROM runs WHERE run_id=$1", [review]);
  expect(row?.sandbox_profile).toBe("quarantine");
});

test("a write-capable profile is rejected", async () => {
  const root = await startRun(db, { kind: "root" });
  // @ts-expect-error — deliberately passing a non-read-only profile
  await expect(spawnSecurityReview(db, root, { profile: "trusted-local" })).rejects.toThrow(/read-only/);
});

test("run tree surfaces finding + approval counts (injection/approval lineage)", async () => {
  const root = await startRun(db, { kind: "root" });
  // artifact + scan + finding + approval under the root run
  await db.run(
    `INSERT INTO content_artifacts (artifact_id, run_id, source_type, trust_label, raw_sha256, created_at)
     VALUES ('a',$1,'import','quarantined','h', now())`,
    [root],
  );
  await db.run(
    `INSERT INTO content_scans (scan_id, artifact_id, scanner_name, scanner_version, verdict, finding_count, created_at)
     VALUES ('sc','a','unicode-scanner','0.2.0','quarantined',1, now())`,
  );
  await db.run(
    `INSERT INTO security_findings (finding_id, scan_id, finding_type, severity, created_at)
     VALUES ('f','sc','zero-width','high', now())`,
  );
  await db.run(
    `INSERT INTO approval_events (approval_id, artifact_id, action, decided_by, created_at)
     VALUES ('ap','a','deny','tester', now())`,
  );
  const tree = await getRunTree(db, root);
  expect(tree?.findingCount).toBe(1);
  expect(tree?.approvalCount).toBe(1);
});
