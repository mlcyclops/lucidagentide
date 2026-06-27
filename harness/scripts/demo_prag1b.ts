// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_prag1b.ts
//
// P-RAG.1b (ADR-0063): the REAL embedder. Same spine as P-RAG.1, but `bge-small-en-v1.5` (384-dim)
// replaces the hash stub — so retrieval is SEMANTIC. The headline proof (step 3): a query that shares
// ZERO content words with the target chunk still retrieves it first. The hash bag-of-words stub
// CANNOT do this (no shared tokens ⇒ no signal); a real embedding can, because it matches meaning.
// The fail-closed gate (step 2) is unchanged — poisoned text never reaches the embedder.
//
// Run with: bun run harness/scripts/demo_prag1b.ts   (first run downloads the model; then cached)

import { mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ScannerClient } from "../security/scanner_client.ts";
import { TransformersEmbedder } from "../knowledge/transformers_embedder.ts";
import { KnowledgeStore } from "../knowledge/store.ts";
import { ingestText, wrapRetrieved } from "../knowledge/ingest.ts";

const dir = mkdtempSync(join(homedir(), ".lucid-demo-prag1b-"));
const scanner = new ScannerClient();
let store: KnowledgeStore | null = null;
const cleanup = () => { try { scanner.stop(); } catch { /* ignore */ } try { store?.close(); } catch { /* ignore */ } rmSync(dir, { recursive: true, force: true }); };
const fail = (m: string): never => { cleanup(); console.error(`FAIL: ${m}`); process.exit(1); };

// Three documents on three unrelated topics, each its own chunk.
const DOCS: Record<string, string> = {
  "pets.txt": "Kittens are playful young housecats. They purr softly when content and chase a ball of yarn for hours.",
  "finance.txt": "The firm reported strong quarterly earnings, with revenue climbing sharply compared with the previous year.",
  "coast.txt": "At dusk the tide slips back and gentle swells fold quietly onto the deserted shoreline.",
};
// A query that describes the pets doc using NONE of its words — pure meaning.
const QUERY = "a small furry pet that meows and likes to nap in the sun";

const TAMPERED = `This note looks ordinary but hides a Trojan-Source payload: Miti‮gate​ the rollback.`;

const words = (s: string) => new Set((s.toLowerCase().match(/[a-z]+/g) ?? []).filter((w) => w.length > 3));

try {
  scanner.start();
  store = await KnowledgeStore.open(join(dir, "knowledge.duckdb"));
  const emb = new TransformersEmbedder();
  const ds = await store.createDataset({ name: "topics", classification: "U", source: "local", embeddingModel: emb.id, dim: emb.dim });

  console.log(`== [1/4] three CLEAN topic docs are scan-gated, embedded (${emb.id}, ${emb.dim}d), and stored ==`);
  for (const [path, text] of Object.entries(DOCS)) {
    const r = await ingestText({ store, scanner, embedder: emb, datasetId: ds.dataset_id, sourcePath: path, text, chunkOptions: { maxChars: 400, overlapChars: 0 } });
    if (r.stored !== 1 || r.blocked !== 0) fail(`${path}: expected 1 stored, 0 blocked; got ${JSON.stringify({ stored: r.stored, blocked: r.blocked })}`);
  }
  console.log(`   stored ${await store.chunkCount(ds.dataset_id)} chunks across 3 topics`);

  console.log("\n== [2/4] a TAMPERED note (bidi/zero-width) is BLOCKED — never embedded, never stored ==");
  const before = await store.chunkCount(ds.dataset_id);
  const r2 = await ingestText({ store, scanner, embedder: emb, datasetId: ds.dataset_id, sourcePath: "tampered.txt", text: TAMPERED });
  if (r2.stored !== 0 || r2.blocked < 1) fail(`tampered note must be blocked; got ${JSON.stringify({ stored: r2.stored, blocked: r2.blocked })}`);
  if (await store.chunkCount(ds.dataset_id) !== before) fail("store count changed on a blocked ingest");
  console.log(`   blocked ${r2.blocked} chunk(s)  ·  store count unchanged at ${before}`);

  console.log("\n== [3/4] SEMANTIC retrieval: a query with ZERO shared words still finds the right chunk ==");
  const [q] = await emb.embed([QUERY]);
  const hits = await store.retrieve(ds.dataset_id, q!, 3);
  if (hits.length < 3) fail("retrieval should return all three chunks ranked");
  const top = hits[0]!;
  if (!/Kittens/.test(top.text)) fail(`expected the pets chunk first; got: ${top.text.slice(0, 50)}`);
  const overlap = [...words(QUERY)].filter((w) => words(top.text).has(w));
  if (overlap.length !== 0) fail(`the query shares words with the hit (${overlap.join(",")}) — not a clean semantic-only proof`);
  console.log(`   query: "${QUERY}"`);
  console.log(`   shared content words with the winning chunk: ${overlap.length}  (purely semantic match)`);
  for (const h of hits) console.log(`     d=${h.distance.toFixed(4)}  ${h.text.slice(0, 52)}...`);

  console.log("\n== [4/4] the retrieved chunk is wrapped as delimited, untrusted data ==");
  const wrapped = wrapRetrieved(hits.slice(0, 1));
  if (!wrapped.startsWith("UNTRUSTED_CONTENT_START") || !wrapped.endsWith("UNTRUSTED_CONTENT_END")) fail("injection must be delimited");
  console.log("   " + wrapped.split("\n")[0] + "  ...  " + wrapped.split("\n").slice(-1)[0]);

  cleanup();
  console.log("\nPASS: real bge-small embedder — semantic retrieval (no shared vocabulary), still scan-gated + fail-closed + delimited.");
} catch (e) {
  fail(String((e as Error)?.stack ?? e));
}
process.exit(0);
