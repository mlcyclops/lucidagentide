// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_pkb2.ts
//
// P-KB.2 (ADR-0100): the hybrid retrieval router + the "kept in sync" generator, over BOTH sibling stores
// (compiled kb_pages + vector kb_chunks), against the REAL Unicode scanner (the compile MODEL is injected):
//   [1] compiled-only retrieval returns structural page hits (page:slug citations);
//   [2] vector-only retrieval returns cosine chunk hits (source#ordinal citations);
//   [3] hybrid merges BOTH, normalized + deduped, wrapped as delimited untrusted DATA;
//   [4] re-syncing unchanged bytes is idempotent; a changed source re-compiles, appends a changelog entry,
//       and flags a contradiction (prior page retained, never silently overwritten).
//
// Run with: bun run harness/scripts/demo_pkb2.ts

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScannerClient } from "../security/scanner_client.ts";
import { HashEmbedder } from "../knowledge/embedder.ts";
import { ingestText } from "../knowledge/ingest.ts";
import { KnowledgeStore } from "../knowledge/store.ts";
import { ingestDocument } from "../kb/ingest.ts";
import { retrieveKnowledge } from "../kb/retrieve.ts";
import { KbGraphStore } from "../kb/store.ts";
import { syncDocument } from "../kb/sync.ts";

const dir = mkdtempSync(join(tmpdir(), "lucid-demo-pkb2-"));
const scanner = new ScannerClient();
let kb: KbGraphStore | null = null;
let vec: KnowledgeStore | null = null;
function fail(m: string): never { try { scanner.stop(); } catch { /* ignore */ } kb?.close(); vec?.close(); rmSync(dir, { recursive: true, force: true }); console.error(`FAIL: ${m}`); process.exit(1); }

const DOC = "Retrieval-augmented generation fetches relevant context for a query. A compiled knowledge base instead accumulates cross-linked summary, concept, and entity pages.";
const modelV1 = async (): Promise<string> => JSON.stringify({
  pages: [
    { kind: "summary", slug: "kb-overview", title: "KB overview", body_md: "RAG retrieves context; a compiled KB accumulates pages about retrieval." },
    { kind: "concept", slug: "retrieval", title: "Retrieval", body_md: "Finding the most relevant context for a query." },
  ],
  links: [{ from: "kb-overview", to: "retrieval", relation: "mentions" }],
});
const modelV2 = async (): Promise<string> => JSON.stringify({
  pages: [{ kind: "concept", slug: "retrieval", title: "Retrieval", body_md: "REVISED: retrieval now also re-ranks with a compiled page graph." }],
  links: [],
});

try {
  scanner.start();
  kb = await KbGraphStore.open(join(dir, "kb_graph.duckdb"));
  vec = await KnowledgeStore.open(join(dir, "knowledge.duckdb"));
  const emb = new HashEmbedder(64);
  const datasetId = (await vec.createDataset({ name: "docs", classification: "U", source: "local", embeddingModel: emb.id, dim: emb.dim })).dataset_id;

  // Seed both stores from the same clean source (real scanner gates both paths).
  await ingestDocument({ store: kb, scanner, complete: modelV1, sourcePath: "kb.md", title: "KB", text: DOC });
  await ingestText({ store: vec, scanner, embedder: emb, datasetId, sourcePath: "kb.md", text: DOC, chunkOptions: { maxChars: 90, overlapChars: 10 } });

  console.log("== [1/4] compiled-only retrieval -> structural page hits ==");
  const c = await retrieveKnowledge({ query: "retrieval context", mode: "compiled", compiled: { store: kb } });
  if (!c.items.length || !c.items.every((i) => i.store === "compiled" && i.citation.startsWith("page:"))) fail(`compiled retrieval should return page hits; got ${JSON.stringify(c.items)}`);
  console.log(`   ${c.items.length} page hit(s): ${c.items.map((i) => i.citation).join(", ")}`);

  console.log("\n== [2/4] vector-only retrieval -> cosine chunk hits ==");
  const v = await retrieveKnowledge({ query: "retrieval context", mode: "vector", vector: { store: vec, datasetId, embedder: emb } });
  if (!v.items.length || !v.items.every((i) => i.store === "vector")) fail(`vector retrieval should return chunk hits; got ${JSON.stringify(v.items)}`);
  console.log(`   ${v.items.length} chunk hit(s): ${v.items.map((i) => i.citation).join(", ")}`);

  console.log("\n== [3/4] hybrid -> BOTH stores, normalized + deduped, wrapped as untrusted DATA ==");
  const h = await retrieveKnowledge({ query: "retrieval context", mode: "hybrid", vector: { store: vec, datasetId, embedder: emb }, compiled: { store: kb } });
  const stores = new Set(h.items.map((i) => i.store));
  if (!stores.has("vector") || !stores.has("compiled")) fail(`hybrid should merge both stores; got ${[...stores].join(",")}`);
  if (!h.wrapped.startsWith("UNTRUSTED_CONTENT_START") || !h.wrapped.trimEnd().endsWith("UNTRUSTED_CONTENT_END")) fail("hybrid output must be delimited untrusted data");
  console.log(`   merged ${h.items.length} hit(s) from [${[...stores].sort().join(", ")}]; delimited + cited`);

  console.log("\n== [4/4] sync: idempotent on unchanged bytes; a change re-compiles + flags a contradiction ==");
  const noop = await syncDocument({ store: kb, scanner, complete: modelV1, sourcePath: "kb.md", title: "KB", text: DOC });
  if (noop.changed) fail(`re-syncing identical bytes must be a no-op; got ${JSON.stringify(noop)}`);
  const changed = await syncDocument({ store: kb, scanner, complete: modelV2, sourcePath: "kb.md", title: "KB", text: DOC + " Updated with a page-graph re-rank." });
  if (!changed.changed || changed.contradictions.length < 1) fail(`a changed source should re-compile + flag a contradiction; got ${JSON.stringify(changed)}`);
  const actions = (await kb.changelog(changed.documentId!)).map((x) => x.action);
  if (!actions.includes("resynced") || !actions.includes("contradiction")) fail(`changelog should record resynced + contradiction; got ${actions.join(",")}`);
  console.log(`   unchanged -> no-op; changed -> re-compiled, contradiction on [${changed.contradictions.map((x) => x.slug).join(", ")}] (prior page retained, changelog updated)`);

  scanner.stop(); kb.close(); vec.close(); kb = null; vec = null;
  console.log("\nPASS: hybrid router (vector | compiled | both, delimited + cited) + sync (idempotent, re-compile, contradiction-flagged).");
} catch (e) {
  fail(`unexpected error: ${String((e as Error)?.stack ?? e)}`);
} finally {
  try { scanner.stop(); } catch { /* ignore */ }
  kb?.close(); vec?.close();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
