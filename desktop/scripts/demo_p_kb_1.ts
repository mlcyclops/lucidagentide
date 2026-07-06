// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_kb_1.ts
//
// P-KB.2b (ADR-0099/0100 desktop plumbing): the desktop compiled-KB surface. Proves the desktop store
// singleton + the ingest/retrieve/graph flow the dev-server routes wrap, against the REAL Unicode scanner
// (the compile MODEL is injected — the real one is backend.complete in the route):
//   [1] /api/kb/ingest  — a clean doc compiles into pages+links through the desktop store (fail-closed);
//   [2] /api/kb/retrieve — the router returns cited, delimited hits from the compiled store;
//   [3] /api/kb/graph    — pages + links for the force-graph view;
//   [4] a poisoned source is quarantined (never compiled) — the gate holds through the desktop wiring.
//
// Run with: bun run desktop/scripts/demo_p_kb_1.ts

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestDocument } from "../../harness/kb/ingest.ts";
import { retrieveKnowledge } from "../../harness/kb/retrieve.ts";
import { kbScanner, kbStore, stopKb } from "../kb_store.ts";

const dir = mkdtempSync(join(tmpdir(), "lucid-demo-pkb2b-"));
process.env.LUCID_KB_DB_PATH = join(dir, "kb_graph.duckdb");
process.env.LUCID_SKILL_SCAN_PATH = join(dir, "scans.jsonl");
async function fail(m: string): Promise<never> { await stopKb(); rmSync(dir, { recursive: true, force: true }); console.error(`FAIL: ${m}`); process.exit(1); }

const DOC = "A compiled knowledge base turns documents into cross-linked summary, concept, and entity pages. Retrieval walks the page graph instead of re-embedding per query.";
const model = async (): Promise<string> => JSON.stringify({
  pages: [
    { kind: "summary", slug: "compiled-kb", title: "Compiled KB", body_md: "Documents become a graph of pages about retrieval." },
    { kind: "concept", slug: "page-graph", title: "Page graph", body_md: "Summary/concept/entity pages joined by links." },
  ],
  links: [{ from: "compiled-kb", to: "page-graph", relation: "explains" }],
});
const POISON = "This source hides a Trojan-Source override Miti\u202egate\u200b in its text.";

try {
  const store = await kbStore(); // the desktop process-wide store (opens + migrates kb_graph.duckdb)

  console.log("== [1/4] /api/kb/ingest: a clean doc compiles into the desktop store (real scanner) ==");
  const ing = await ingestDocument({ store, scanner: kbScanner(), complete: model, sourcePath: "kb.md", title: "KB", text: DOC });
  if (ing.status !== "compiled" || ing.pagesCompiled < 1 || ing.links < 1) await fail(`clean doc should compile; got ${JSON.stringify(ing)}`);
  console.log(`   compiled ${ing.pagesCompiled} page(s) + ${ing.links} link(s)`);

  console.log("\n== [2/4] /api/kb/retrieve: the router returns cited, delimited hits ==");
  const ret = await retrieveKnowledge({ query: "retrieval page graph", mode: "compiled", compiled: { store } });
  if (!ret.items.length || !ret.wrapped.startsWith("UNTRUSTED_CONTENT_START")) await fail(`retrieve should return delimited cited hits; got ${JSON.stringify(ret.items)}`);
  console.log(`   ${ret.items.length} hit(s): ${ret.items.map((i) => i.citation).join(", ")}; wrapped as untrusted DATA`);

  console.log("\n== [3/4] /api/kb/graph: pages + links for the force-graph view ==");
  const pages = await store.listPages();
  const links = await store.listLinks();
  if (pages.length < 1 || links.length < 1) await fail(`graph should expose pages + links; got ${pages.length}/${links.length}`);
  console.log(`   graph: ${pages.length} node(s) [${pages.map((p) => p.kind).sort().join(", ")}] + ${links.length} edge(s)`);

  console.log("\n== [4/4] a POISONED source is quarantined through the desktop wiring (never compiled) ==");
  const before = await store.pageCount();
  const bad = await ingestDocument({ store, scanner: kbScanner(), complete: model, sourcePath: "evil.md", title: "Evil", text: POISON });
  if (bad.status !== "quarantined" || (await store.pageCount()) !== before) await fail(`poisoned source must quarantine; got ${JSON.stringify(bad)}`);
  console.log(`   source quarantined: ${bad.blocked[0]?.reason}; page count unchanged (${before})`);

  await stopKb();
  console.log("\nPASS: desktop compiled-KB surface - ingest compiles, retrieve returns cited delimited hits, graph exposes pages+links, poisoned source quarantined.");
} catch (e) {
  await fail(`unexpected error: ${String((e as Error)?.stack ?? e)}`);
} finally {
  await stopKb();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
