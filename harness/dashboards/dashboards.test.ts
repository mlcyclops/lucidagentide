// harness/dashboards/dashboards.test.ts

import { test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../memory/db.ts";
import { ingestArtifact } from "../memory/ingest.ts";
import { recordApproval } from "../security/approvals.ts";
import { ScannerClient } from "../security/scanner_client.ts";
import { materializeDashboards, rowsToCsv } from "./materialize.ts";
import { approvalQueue, findingsOverview, quarantineReview } from "./views.ts";

const ZWSP = String.fromCodePoint(0x200b);
const VIEW_NAMES = [
  "findings_overview",
  "unicode_analysis",
  "approval_queue",
  "quarantine_review",
  "memory_promotion_risk",
  "export_audit",
  "active_runs",
];

function hasInvisible(s: string): boolean {
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if ([0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x202e].includes(c)) return true;
    if (c >= 0xe0000 && c <= 0xe007f) return true;
  }
  return false;
}

let scanner: ScannerClient;
let dir: string;
let db: Db;

beforeAll(() => {
  scanner = new ScannerClient();
  scanner.start();
});
afterAll(() => scanner.stop());

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "dash-test-"));
  db = await Db.open(join(dir, "t.duckdb"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("rowsToCsv writes a quoted header + rows; empty -> empty", () => {
  expect(rowsToCsv([])).toBe("");
  expect(rowsToCsv([{ a: 1, b: "x" }])).toBe('"a","b"\n"1","x"');
});

test("materialize writes all seven view files", async () => {
  const out = join(dir, "data");
  const r = await materializeDashboards(db, out);
  expect(r.files.map((f) => f.name).sort()).toEqual([...VIEW_NAMES].sort());
  const written = readdirSync(out).sort();
  expect(written).toEqual(VIEW_NAMES.map((n) => `${n}.csv`).sort());
});

test("KEYSTONE: dashboard feed never carries an invisible char", async () => {
  await ingestArtifact(db, scanner, { runId: "r", sourceType: "comment", rawContent: `boom${ZWSP} now` });
  const out = join(dir, "data");
  const r = await materializeDashboards(db, out);
  for (const f of r.files) expect(hasInvisible(readFileSync(f.path, "utf8"))).toBe(false);
});

test("findings overview counts the scanner's findings", async () => {
  await ingestArtifact(db, scanner, { runId: "r", sourceType: "comment", rawContent: `x${ZWSP}y` });
  const rows = await findingsOverview(db);
  expect(rows.length).toBeGreaterThanOrEqual(1);
  expect(rows.some((x) => x.finding_type === "zero-width")).toBe(true);
});

test("quarantine review lists isolated artifacts; approval clears the approval queue", async () => {
  const ing = await ingestArtifact(db, scanner, { runId: "r", sourceType: "import", rawContent: `bad${ZWSP}` });
  expect((await quarantineReview(db)).length).toBe(1);
  expect((await approvalQueue(db)).length).toBe(1);

  await recordApproval(db, { artifactId: ing.artifactId, action: "quarantine_release", decidedBy: "u" });
  expect((await approvalQueue(db)).length).toBe(0); // reviewed -> no longer queued
});
