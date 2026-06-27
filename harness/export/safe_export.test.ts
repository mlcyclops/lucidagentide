// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/export/safe_export.test.ts

import { test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../memory/db.ts";
import { ingestArtifact } from "../memory/ingest.ts";
import { recordApproval } from "../security/approvals.ts";
import { ScannerClient } from "../security/scanner_client.ts";
import { csvField, escapeMarkdown, exportCsv, exportJsonBundle, exportMarkdownReport } from "./safe_export.ts";

const ZWSP = String.fromCodePoint(0x200b);
const TAG = String.fromCodePoint(0xe0041);
const POISON = `deploy${ZWSP}${TAG} now`;

function hasInvisible(s: string): boolean {
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if ([0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x202e, 0x202d].includes(c)) return true;
    if (c >= 0xe0000 && c <= 0xe007f) return true;
  }
  return false;
}

let scanner: ScannerClient;
let dir: string;
let db: Db;
let artifactId: string;

beforeAll(() => {
  scanner = new ScannerClient();
  scanner.start();
});
afterAll(() => scanner.stop());

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "export-test-"));
  db = await Db.open(join(dir, "t.duckdb"));
  const ing = await ingestArtifact(db, scanner, { runId: "r", sourceType: "import", rawContent: POISON });
  artifactId = ing.artifactId;
  await recordApproval(db, { artifactId, action: "deny", decidedBy: "u", rationale: "injection" });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("escapeMarkdown escapes metacharacters and renders control chars as notation", () => {
  expect(escapeMarkdown("a|b*c`d")).toBe("a\\|b\\*c\\`d");
  expect(escapeMarkdown(`x${ZWSP}y`).includes(ZWSP)).toBe(false);
});

test("csvField quotes and flattens newlines", () => {
  expect(csvField('a"b\nc')).toBe('"a""b c"');
});

test("KEYSTONE: md report renders no invisibles and never the raw payload", async () => {
  const r = await exportMarkdownReport(db, { artifactIds: [artifactId], reviewer: "u" });
  expect(hasInvisible(r.content)).toBe(false);
  expect(r.content.includes(POISON)).toBe(false);
  expect(r.content).toContain("unicode-tag-block");
  expect(r.includedRaw).toBe(false);
});

test("csv is sanitized-only with no invisibles", async () => {
  const r = await exportCsv(db, { artifactIds: [artifactId] });
  expect(hasInvisible(r.content)).toBe(false);
  expect(r.content.includes(POISON)).toBe(false);
  expect(r.content.split("\n")[0]).toContain("artifact_id");
});

test("json bundle omits raw by default", async () => {
  const r = await exportJsonBundle(db, { artifactIds: [artifactId] });
  expect(r.includedRaw).toBe(false);
  expect(hasInvisible(r.content)).toBe(false);
  expect(r.content.includes("raw_evidence")).toBe(false);
  const parsed = JSON.parse(r.content);
  expect(parsed.includes_raw).toBe(false);
  expect(parsed.artifacts[0].raw_sha256).toBeTruthy();
});

test("json bundle WITH raw isolates and flags it", async () => {
  const r = await exportJsonBundle(db, { artifactIds: [artifactId], includeRaw: true });
  expect(r.includedRaw).toBe(true);
  expect(r.content).toContain("DANGEROUS_RAW_DO_NOT_RENDER");
  const parsed = JSON.parse(r.content);
  expect(parsed.artifacts[0].raw_evidence.content).toBe(POISON); // raw kept, but isolated
});

test("every export is audited in export_events with a payload hash", async () => {
  await exportMarkdownReport(db, { artifactIds: [artifactId] });
  await exportJsonBundle(db, { artifactIds: [artifactId], includeRaw: true });
  const rows = await db.all("SELECT export_type, sanitization_status, included_raw, payload_sha256 FROM export_events ORDER BY created_at");
  expect(rows).toHaveLength(2);
  expect(rows[0]?.sanitization_status).toBe("sanitized-only");
  expect(rows[1]?.sanitization_status).toBe("raw-flagged");
  expect(rows[1]?.included_raw).toBe(true);
  expect(String(rows[0]?.payload_sha256).length).toBe(64);
});
