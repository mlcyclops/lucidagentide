// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/export/vault_export.test.ts — P9.4: the Obsidian vault + NARA CUI archive.
// Over-tested on the two security-load-bearing guarantees: (1) CUI is never in the
// ordinary vault unless explicitly requested, and (2) every emitted byte is escaped —
// no invisible/control/bidi codepoint can ride into a note. Plus the CUI manifest's
// SHA-256 inventory must actually attest to the bytes written.

import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildCuiArchive, buildVault, isSafeUrl } from "./vault_export.ts";
import { PersonalStore } from "../personal/store.ts";
import type { PersonalGraph } from "../personal/store.ts";

const NOW = "2026-06-19T00:00:00.000Z";

function graph(): PersonalGraph {
  return {
    entities: [
      { id: "e-pers", name: "Terse answers", kind: "user:preference", trust_label: "trusted", confidence: 0.9, created_at: NOW },
      { id: "e-work", name: "Acme repo", kind: "user:decision", trust_label: "trusted", confidence: 0.8, created_at: NOW },
      { id: "e-cui", name: "Program X", kind: "user:behavior", trust_label: "trusted", confidence: 0.7, created_at: NOW },
      { id: "e-link", name: "https://example.com/docs", kind: "user:link", trust_label: "trusted", confidence: 1, created_at: NOW },
    ],
    facts: [
      { id: "f1", entity_id: "e-pers", statement: "prefers terse answers", scope: "personal", trust_label: "trusted", confidence: 0.9, status: "active", promoted_at: NOW },
      { id: "f2", entity_id: "e-work", statement: "chose monorepo at Acme", scope: "work", trust_label: "trusted", confidence: 0.8, status: "active", promoted_at: NOW },
      { id: "f3", entity_id: "e-cui", statement: "works on Program X", scope: "cui", trust_label: "trusted", confidence: 0.7, status: "active", promoted_at: NOW },
      { id: "f4", entity_id: "e-link", statement: "https://example.com/docs", scope: "personal", trust_label: "trusted", confidence: 1, status: "active", promoted_at: NOW },
    ],
    links: [{ id: "l1", from_entity_id: "e-pers", to_entity_id: "e-link", relation: "documented-at", created_at: NOW }],
  };
}

// ── scope-awareness (ADR-0012): CUI is excluded by default ──────────────────────
test("vault EXCLUDES cui by default; the CUI note never appears", () => {
  const { files, summary } = buildVault(graph(), { scopes: ["personal", "work"], now: NOW });
  expect(summary.includedCui).toBe(false);
  const blob = files.map((f) => f.content).join("\n");
  expect(blob).not.toContain("Program X");
  expect(blob).not.toContain("works on Program X");
  // personal + work entities ARE present (plus the link), CUI is not.
  expect(summary.entities).toBe(3);
  expect(files.some((f) => f.path.startsWith("Behaviors/"))).toBe(false);
});

test("vault INCLUDES cui only when explicitly requested", () => {
  const { files, summary } = buildVault(graph(), { scopes: ["personal", "work", "cui"], now: NOW });
  expect(summary.includedCui).toBe(true);
  expect(summary.entities).toBe(4);
  expect(files.map((f) => f.content).join("\n")).toContain("works on Program X");
});

test("_index.md exists, is a MOC, and warns when cui is bundled", () => {
  const idx = buildVault(graph(), { scopes: ["personal", "work", "cui"], now: NOW }).files.find((f) => f.path === "_index.md")!;
  expect(idx.content).toContain("# Personal knowledge graph");
  expect(idx.content).toContain("## Preferences");
  expect(idx.content).toContain("INCLUDES CUI");
});

// ── escaping: no invisible/control codepoint can ride into a note ────────────────
test("statements with a zero-width char are escaped (no raw invisible emitted)", () => {
  const g = graph();
  g.facts[0]!.statement = "prefers​terse"; // ZERO WIDTH SPACE
  const blob = buildVault(g, { scopes: ["personal"], now: NOW }).files.map((f) => f.content).join("\n");
  expect(blob).not.toContain("​");
  expect(blob).toContain("\\u{200b}");
});

// ── links: sanitized but working ────────────────────────────────────────────────
test("a clean http(s) URL renders as a working markdown link", () => {
  const blob = buildVault(graph(), { scopes: ["personal"], now: NOW }).files.find((f) => f.path.startsWith("Links/"))!.content;
  expect(blob).toContain("(https://example.com/docs)"); // clickable href preserved
});

test("isSafeUrl rejects non-http and codepoint-smuggling URLs", () => {
  expect(isSafeUrl("https://example.com/a")).toBe(true);
  expect(isSafeUrl("javascript:alert(1)")).toBe(false);
  expect(isSafeUrl("https://exa​mple.com")).toBe(false); // zero-width inside
  expect(isSafeUrl("https://e.com/a b")).toBe(false); // space
});

// ── CUI archive (NARA records management) ───────────────────────────────────────
test("CUI archive contains ONLY cui, with banner markings + portion marks", () => {
  const { files } = buildCuiArchive(graph(), { now: NOW });
  const note = files.find((f) => f.path.startsWith("Behaviors/"))!;
  expect(note.content.startsWith("CUI")).toBe(true); // top banner
  expect(note.content.trimEnd().endsWith("CUI")).toBe(true); // bottom banner
  expect(note.content).toContain("(CUI) works on Program X"); // portion mark
  // no personal/work data leaked in
  expect(files.map((f) => f.content).join("\n")).not.toContain("prefers terse answers");
});

test("CUI archive ships a cover sheet + manifest whose SHA-256 inventory attests to the bytes", () => {
  const { files, summary } = buildCuiArchive(graph(), { now: NOW, designation: { recordsSchedule: "GRS 4.2", disposition: "TEMPORARY" } });
  expect(files.some((f) => f.path === "_CUI_COVER_SHEET.md")).toBe(true);
  const manifestFile = files.find((f) => f.path === "_CUI_MANIFEST.json")!;
  const manifest = JSON.parse(manifestFile.content);
  expect(manifest.format).toBe("lucid-cui-archive.v1");
  expect(manifest.records_management.records_schedule).toBe("GRS 4.2");
  // every inventory entry's sha256 matches the actual file content
  for (const item of manifest.inventory) {
    const f = files.find((x) => x.path === item.path)!;
    expect(createHash("sha256").update(f.content, "utf8").digest("hex")).toBe(item.sha256);
  }
  // manifest_sha256 attests to the inventory it carries
  expect(createHash("sha256").update(JSON.stringify(manifest.inventory), "utf8").digest("hex")).toBe(summary.manifestSha256);
});

test("uncompleted CUI designation is flagged, not silently blank", () => {
  const manifest = JSON.parse(buildCuiArchive(graph(), { now: NOW }).files.find((f) => f.path === "_CUI_MANIFEST.json")!.content);
  expect(manifest.cui.designating_agency).toContain("REQUIRED");
  expect(manifest.records_management.records_schedule).toContain("REQUIRED");
});

// ── payload hash is stable (audited fingerprint) ────────────────────────────────
test("payloadSha256 is deterministic for the same graph + scopes", () => {
  const a = buildVault(graph(), { scopes: ["personal", "work"], now: NOW }).summary.payloadSha256;
  const b = buildVault(graph(), { scopes: ["personal", "work"], now: NOW }).summary.payloadSha256;
  expect(a).toBe(b);
});

// ── store: the in-store export audit trail round-trips through encryption ────────
let n = 0;
const paths: string[] = [];
const tmp = (): string => { const p = join(tmpdir(), `lucid-vault-${process.pid}-${++n}.enc`); paths.push(p); return p; };
afterAll(() => { for (const p of paths) try { if (existsSync(p)) rmSync(p); } catch { /* ignore */ } });

test("recordExport persists (encrypted) and exportLog returns it most-recent-first", () => {
  const path = tmp();
  const s = PersonalStore.createWithPassphrase(path, "correct horse battery");
  s.recordExport({ kind: "vault", scopes: ["personal"], entity_count: 2, fact_count: 3, file_count: 4, payload_sha256: "aa", included_cui: false });
  s.recordExport({ kind: "cui-archive", scopes: ["cui"], entity_count: 1, fact_count: 1, file_count: 3, payload_sha256: "bb", manifest_sha256: "cc", included_cui: true });
  s.save();
  const re = PersonalStore.openWithPassphrase(path, "correct horse battery");
  const log = re.exportLog();
  expect(log.length).toBe(2);
  expect(log[0]!.kind).toBe("cui-archive"); // most recent first
  expect(log[1]!.kind).toBe("vault");
  expect(log[0]!.manifest_sha256).toBe("cc");
});
