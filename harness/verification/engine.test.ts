// harness/verification/engine.test.ts

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../memory/db.ts";
import { runChecks, securityPrecondition, verifyTask } from "./engine.ts";

const PASS = { name: "pass", command: ["node", "-e", "process.exit(0)"] };
const FAILC = { name: "fail", command: ["node", "-e", "process.exit(3)"] };

let dir: string;
let db: Db;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "verify-test-"));
  db = await Db.open(join(dir, "t.duckdb"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function addArtifact(runId: string, artifactId: string, trust: string, opts: { failClosed?: boolean } = {}) {
  await db.run(
    `INSERT INTO content_artifacts (artifact_id, run_id, source_type, trust_label, raw_sha256, created_at)
     VALUES ($1,$2,'import',$3,'x', now())`,
    [artifactId, runId, trust],
  );
  await db.run(
    `INSERT INTO content_scans (scan_id, artifact_id, scanner_name, scanner_version, verdict, finding_count, fail_closed, created_at)
     VALUES ($1,$2,'unicode-scanner','0.2.0',$3,0,$4, now())`,
    [`scan-${artifactId}`, artifactId, trust === "untrusted" ? "clean" : trust, opts.failClosed ?? false],
  );
}

async function approve(artifactId: string, action: string) {
  await db.run(
    `INSERT INTO approval_events (approval_id, artifact_id, action, decided_by, created_at)
     VALUES ($1,$2,$3,'tester', now())`,
    [`appr-${artifactId}`, artifactId, action],
  );
}

// ── runChecks ───────────────────────────────────────────────────────────────
test("runChecks reports per-check pass/fail and aggregate", async () => {
  const r = await runChecks([PASS, FAILC]);
  expect(r.checks[0]!.passed).toBe(true);
  expect(r.checks[1]!.passed).toBe(false);
  expect(r.checks[1]!.exitCode).toBe(3);
  expect(r.allPassed).toBe(false);
});

test("runChecks allPassed true when every check exits 0", async () => {
  expect((await runChecks([PASS, PASS])).allPassed).toBe(true);
});

// ── securityPrecondition ──────────────────────────────────────────────────────
test("a quarantined artifact blocks; an approval clears it", async () => {
  await addArtifact("run-1", "a1", "quarantined");
  expect((await securityPrecondition(db, "run-1")).ok).toBe(false);
  await approve("a1", "quarantine_release");
  expect((await securityPrecondition(db, "run-1")).ok).toBe(true);
});

test("suspicious also blocks until reviewed", async () => {
  await addArtifact("run-2", "a2", "suspicious");
  const s = await securityPrecondition(db, "run-2");
  expect(s.ok).toBe(false);
  expect(s.blocking[0]!.trustLabel).toBe("suspicious");
});

test("untrusted (clean external) and trusted do not block", async () => {
  await addArtifact("run-3", "a3", "untrusted");
  expect((await securityPrecondition(db, "run-3")).ok).toBe(true);
});

test("fail-closed flag is surfaced on the blocking artifact", async () => {
  await addArtifact("run-4", "a4", "quarantined", { failClosed: true });
  const s = await securityPrecondition(db, "run-4");
  expect(s.blocking[0]!.failClosed).toBe(true);
});

// ── verifyTask ────────────────────────────────────────────────────────────────
test("security blocks completion even with all checks green", async () => {
  await addArtifact("run-5", "a5", "quarantined");
  const v = await verifyTask(db, "run-5", [PASS]);
  expect(v.completionAllowed).toBe(false);
  expect(v.report.allPassed).toBe(true); // checks were fine; security blocked
});

test("acceptPartial does NOT waive the security precondition", async () => {
  await addArtifact("run-6", "a6", "quarantined");
  const v = await verifyTask(db, "run-6", [PASS], { acceptPartial: true });
  expect(v.completionAllowed).toBe(false);
});

test("acceptPartial waives failed checks when security is clear", async () => {
  await addArtifact("run-7", "a7", "untrusted");
  expect((await verifyTask(db, "run-7", [PASS, FAILC])).completionAllowed).toBe(false);
  expect((await verifyTask(db, "run-7", [PASS, FAILC], { acceptPartial: true })).completionAllowed).toBe(true);
});

test("all checks pass + security clear => completion allowed", async () => {
  const v = await verifyTask(db, "run-empty", [PASS]); // no artifacts at all
  expect(v.completionAllowed).toBe(true);
});
