// harness/memory/db.test.ts

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "./db.ts";

async function withDb<T>(fn: (db: Db, dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "db-test-"));
  const db = await Db.open(join(dir, "t.duckdb"));
  try {
    return await fn(db, dir);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("migration 0001 creates the security tables", async () => {
  await withDb(async (db) => {
    const rows = await db.all(
      "SELECT table_name FROM information_schema.tables WHERE table_schema=$1",
      ["main"],
    );
    const names = rows.map((r) => r.table_name);
    for (const t of [
      "content_artifacts",
      "content_scans",
      "security_findings",
      "sanitized_artifacts",
      "approval_events",
      "export_events",
      "security_alerts",
    ]) {
      expect(names).toContain(t);
    }
  });
});

test("schema_migrations records the applied versions in order", async () => {
  await withDb(async (db) => {
    expect(await db.appliedVersions()).toEqual([1, 2]);
  });
});

test("reopening an existing db does not re-apply migrations", async () => {
  const dir = mkdtempSync(join(tmpdir(), "db-reopen-"));
  const path = join(dir, "t.duckdb");
  try {
    const a = await Db.open(path);
    expect(await a.appliedVersions()).toEqual([1, 2]);
    a.close();
    const b = await Db.open(path);
    expect(await b.appliedVersions()).toEqual([1, 2]); // unchanged, not re-applied
    b.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FK within the security family is enforced", async () => {
  await withDb(async (db) => {
    // a scan referencing a non-existent artifact must fail
    await expect(
      db.run(
        `INSERT INTO content_scans (scan_id, artifact_id, scanner_name, scanner_version, verdict, created_at)
         VALUES ('s1','does-not-exist','unicode-scanner','0.2.0','clean', now())`,
      ),
    ).rejects.toThrow();
  });
});
