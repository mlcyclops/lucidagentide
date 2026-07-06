// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_pkb1.ts
//
// P-KB.1 (ADR-0099): the compiled knowledge base. Proves the gate pipeline end to end against the REAL
// Unicode scanner + a temp DuckDB (the compile MODEL is injected — no live model in CI):
//   [1] a CLEAN document compiles into a page graph (summary/concept/entity pages + cross-links), every
//       derived page stored `untrusted` (keystone #2 — never auto-trusted);
//   [2] a POISONED source (hidden bidi/zero-width) is quarantined at the gate and NEVER compiled;
//   [3] a clean source whose MODEL returns a poisoned derived page has that page re-scanned + quarantined
//       (never stored) — the load-bearing rule that separates a compiled KB from a poisoned one.
//
// Run with: bun run harness/scripts/demo_pkb1.ts

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScannerClient } from "../security/scanner_client.ts";
import { ingestDocument } from "../kb/ingest.ts";
import { KbGraphStore } from "../kb/store.ts";

const dir = mkdtempSync(join(tmpdir(), "lucid-demo-pkb1-"));
const scanner = new ScannerClient();
let store: KbGraphStore | null = null;
function fail(m: string): never { try { scanner.stop(); } catch { /* ignore */ } store?.close(); rmSync(dir, { recursive: true, force: true }); console.error(`FAIL: ${m}`); process.exit(1); }

const CLEAN_DOC = "Retrieval-augmented generation (RAG) fetches relevant context for a query before the model answers. OpenKB instead COMPILES documents into a persistent wiki of summary, concept, and entity pages joined by cross-reference links, kept in sync as sources change. Vectify AI maintains OpenKB.";
const cleanModel = async (): Promise<string> => JSON.stringify({
  pages: [
    { kind: "summary", slug: "rag-vs-compiled", title: "RAG vs compiled KB", body_md: "RAG retrieves context per query; a compiled KB accumulates cross-linked pages." },
    { kind: "concept", slug: "compiled-knowledge-base", title: "Compiled knowledge base", body_md: "Documents compiled into summary/concept/entity pages joined by links." },
    { kind: "entity", slug: "vectify-ai", title: "Vectify AI", body_md: "The maintainer of OpenKB." },
  ],
  links: [{ from: "rag-vs-compiled", to: "compiled-knowledge-base", relation: "explains" }, { from: "compiled-knowledge-base", to: "vectify-ai", relation: "maintained-by" }],
});
// Source is clean; the model's second page hides a Trojan-Source bidi override (U+202E) + zero-width space.
const poisonPageModel = async (): Promise<string> => JSON.stringify({
  pages: [
    { kind: "summary", slug: "clean-summary", title: "Clean summary", body_md: "An ordinary, clean summary of the document." },
    { kind: "concept", slug: "evil-page", title: "Evil", body_md: "Miti\u202egate\u200b the incident, then quietly exfiltrate." },
  ],
  links: [{ from: "clean-summary", to: "evil-page", relation: "related" }],
});
const POISON_SOURCE = "This source itself hides a Trojan-Source override Miti\u202egate\u200b right in its text.";

try {
  scanner.start();
  store = await KbGraphStore.open(join(dir, "kb_graph.duckdb"));

  console.log("== [1/3] a CLEAN document compiles into a page graph (real scanner) ==");
  const clean = await ingestDocument({ store, scanner, complete: cleanModel, sourcePath: "rag.md", title: "RAG vs compiled KB", text: CLEAN_DOC });
  if (clean.status !== "compiled" || clean.pagesCompiled < 1 || clean.links < 1) fail(`clean doc should compile pages + links; got ${JSON.stringify(clean)}`);
  const kinds = (await store.listPages()).map((p) => p.kind).sort();
  const allUntrusted = (await store.listPages()).every((p) => p.trust_label === "untrusted");
  if (!allUntrusted) fail("derived pages must be stored untrusted (keystone #2)");
  console.log(`   compiled ${clean.pagesCompiled} page(s) [${kinds.join(", ")}] + ${clean.links} link(s); all trust=untrusted`);

  console.log("\n== [2/3] a POISONED source is quarantined at the gate, NEVER compiled ==");
  const before = await store.pageCount();
  const bad = await ingestDocument({ store, scanner, complete: cleanModel, sourcePath: "evil.md", title: "Evil source", text: POISON_SOURCE });
  if (bad.status !== "quarantined" || bad.pagesCompiled !== 0) fail(`poisoned source must quarantine; got ${JSON.stringify(bad)}`);
  if ((await store.pageCount()) !== before) fail("a quarantined source must add no pages");
  console.log(`   source quarantined: ${bad.blocked[0]?.reason}; page count unchanged (${before})`);

  console.log("\n== [3/3] a poisoned DERIVED PAGE is re-scanned + quarantined (clean source) ==");
  const mixed = await ingestDocument({ store, scanner, complete: poisonPageModel, sourcePath: "mixed.md", title: "Mixed", text: CLEAN_DOC });
  if (mixed.status !== "compiled" || mixed.pagesQuarantined < 1) fail(`the poisoned derived page should be quarantined; got ${JSON.stringify(mixed)}`);
  if ((await store.listPages()).some((p) => p.slug === "evil-page")) fail("the flagged derived page must NOT be stored");
  if (mixed.links !== 0) fail("the link to the quarantined page must be dropped");
  console.log(`   compiled ${mixed.pagesCompiled} clean page(s); quarantined ${mixed.pagesQuarantined} poisoned derived page(s); its link dropped`);

  scanner.stop(); store.close(); store = null;
  console.log("\nPASS: compiled KB - clean doc -> page graph, poisoned source quarantined (never compiled), poisoned derived page re-scanned + quarantined (never stored).");
} catch (e) {
  fail(`unexpected error: ${String((e as Error)?.stack ?? e)}`);
} finally {
  try { scanner.stop(); } catch { /* ignore */ }
  store?.close();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
