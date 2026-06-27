// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_prag1c.ts
//
// P-RAG.1c slice 1 (ADR-0064): ingest a real PDF. A PDF is just another text SOURCE — extractPdfText()
// pulls the text layer out and ingestPdf() runs it through the UNCHANGED scan-gated ingestText pipeline,
// then the real bge-small embedder (P-RAG.1b) makes retrieval semantic. The two proofs:
//   [2/3] fail-closed at the PDF boundary — a corrupt buffer is REJECTED (throws), never read as empty;
//   [3/3] semantic retrieval FROM A PDF — a query sharing ZERO content words with the page still finds it.
// The live scanner (step 1) gates every extracted page exactly as it gates .txt (unit tests cover a
// poisoned page + a dead scanner).
//
// Run with: bun run harness/scripts/demo_prag1c.ts   (first run loads the bge-small model; then cached)

import { mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ScannerClient } from "../security/scanner_client.ts";
import { TransformersEmbedder } from "../knowledge/transformers_embedder.ts";
import { KnowledgeStore } from "../knowledge/store.ts";
import { extractPdfText, ingestPdf } from "../knowledge/pdf.ts";
import { makeTextPdf } from "../knowledge/pdf_fixture.ts";
import { wrapRetrieved } from "../knowledge/ingest.ts";

const dir = mkdtempSync(join(homedir(), ".lucid-demo-prag1c-"));
const scanner = new ScannerClient();
let store: KnowledgeStore | null = null;
const cleanup = () => { try { scanner.stop(); } catch { /* ignore */ } try { store?.close(); } catch { /* ignore */ } rmSync(dir, { recursive: true, force: true }); };
const fail = (m: string): never => { cleanup(); console.error(`FAIL: ${m}`); process.exit(1); };

// One PDF, three pages on three unrelated topics.
const PAGES = [
  "Kittens are playful young housecats. They purr softly when content and chase a ball of yarn for hours.",
  "The firm reported strong quarterly earnings, with revenue climbing sharply compared with the previous year.",
  "At dusk the tide slips back and gentle swells fold quietly onto the deserted shoreline.",
];
// A query that describes page 1 using NONE of its words — pure meaning.
const QUERY = "a small furry pet that meows and likes to nap in the sun";

const words = (s: string) => new Set((s.toLowerCase().match(/[a-z]+/g) ?? []).filter((w) => w.length > 3));

try {
  scanner.start();
  store = await KnowledgeStore.open(join(dir, "knowledge.duckdb"));
  const emb = new TransformersEmbedder();
  const ds = await store.createDataset({ name: "pdf-topics", classification: "U", source: "local", embeddingModel: emb.id, dim: emb.dim });

  console.log(`== [1/3] a real 3-page PDF is parsed, scan-gated, embedded (${emb.id}, ${emb.dim}d), and stored ==`);
  const pdf = makeTextPdf(PAGES);
  const extracted = await extractPdfText(pdf);
  console.log(`   pdf.js extracted ${extracted.totalPages} pages of text`);
  const r = await ingestPdf({ store, scanner, embedder: emb, datasetId: ds.dataset_id, sourcePath: "topics.pdf", data: pdf, chunkOptions: { maxChars: 120, overlapChars: 0 } });
  if (r.blocked !== 0 || r.stored < 3) fail(`clean PDF should store its pages, none blocked; got ${JSON.stringify({ stored: r.stored, blocked: r.blocked })}`);
  console.log(`   stored ${await store.chunkCount(ds.dataset_id)} chunk(s) from the PDF`);

  console.log("\n== [2/3] fail-closed at the PDF boundary: a CORRUPT buffer is rejected — never read as empty ==");
  const before = await store.chunkCount(ds.dataset_id);
  const corrupt = new TextEncoder().encode("%PDF-1.4 then total garbage, no xref, not a real document at all");
  let threw = false;
  try { await ingestPdf({ store, scanner, embedder: emb, datasetId: ds.dataset_id, sourcePath: "corrupt.pdf", data: corrupt }); }
  catch { threw = true; }
  if (!threw) fail("a corrupt PDF must throw (fail-closed), not silently store nothing-as-success");
  if (await store.chunkCount(ds.dataset_id) !== before) fail("store count changed on a rejected PDF");
  console.log(`   corrupt PDF threw  ·  store count unchanged at ${before}`);

  console.log("\n== [3/3] SEMANTIC retrieval FROM the PDF: a query with ZERO shared words still finds the page ==");
  const [q] = await emb.embed([QUERY]);
  const hits = await store.retrieve(ds.dataset_id, q!, 3);
  const top = hits[0]!;
  if (!/Kittens/.test(top.text)) fail(`expected the pets page first; got: ${top.text.slice(0, 50)}`);
  const overlap = [...words(QUERY)].filter((w) => words(top.text).has(w));
  if (overlap.length !== 0) fail(`query shares words with the hit (${overlap.join(",")}) — not a clean semantic-only proof`);
  console.log(`   query: "${QUERY}"`);
  console.log(`   shared content words with the winning page: ${overlap.length}  (purely semantic match)`);
  for (const h of hits) console.log(`     d=${h.distance.toFixed(4)}  ${h.text.slice(0, 52)}...`);

  const wrapped = wrapRetrieved(hits.slice(0, 1));
  if (!wrapped.startsWith("UNTRUSTED_CONTENT_START") || !wrapped.endsWith("UNTRUSTED_CONTENT_END")) fail("injection must be delimited");
  console.log(`   retrieved chunk wrapped: ${wrapped.split("\n")[0]} ... ${wrapped.split("\n").slice(-1)[0]}`);

  cleanup();
  console.log("\nPASS: PDF -> text -> SAME scan gate -> real bge-small embeddings. Semantic retrieval from a PDF; corrupt PDF fails closed; hit delimited.");
} catch (e) {
  fail(String((e as Error)?.stack ?? e));
}
process.exit(0);
