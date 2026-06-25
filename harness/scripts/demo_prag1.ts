// harness/scripts/demo_prag1.ts
//
// P-RAG.1 (ADR-0054): the local knowledge spine. Proves the end-to-end security + retrieval property
// against the REAL Unicode scanner sidecar and a real (temp) knowledge.duckdb:
//   1. a CLEAN document is chunked, scanned, embedded, and stored in the vector store;
//   2. a TAMPERED document (Trojan-Source bidi U+202E + zero-width U+200B) is BLOCKED at the gate —
//      its poisoned chunk is never embedded and never stored (fail-closed, invariant #3/#5);
//   3. brute-force cosine retrieval returns the relevant chunk first (DuckDB list_cosine_distance,
//      no vss/HNSW extension — air-gap clean);
//   4. retrieved knowledge is wrapped in UNTRUSTED_CONTENT_START/END for late, delimited injection.
//
// Run with: bun run harness/scripts/demo_prag1.ts

import { mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ScannerClient } from "../security/scanner_client.ts";
import { HashEmbedder } from "../knowledge/embedder.ts";
import { KnowledgeStore } from "../knowledge/store.ts";
import { ingestText, wrapRetrieved } from "../knowledge/ingest.ts";

const dir = mkdtempSync(join(homedir(), ".lucid-demo-prag1-"));
const scanner = new ScannerClient();
let store: KnowledgeStore | null = null;
const cleanup = () => { try { scanner.stop(); } catch { /* ignore */ } try { store?.close(); } catch { /* ignore */ } rmSync(dir, { recursive: true, force: true }); };
const fail = (m: string): never => { cleanup(); console.error(`FAIL: ${m}`); process.exit(1); };

const HANDBOOK = `Retrieval-augmented generation grounds the model in your own documents.
The knowledge store keeps text chunks together with their embedding vectors.

DuckDB ranks chunks by cosine distance with a built-in array function, so retrieval
works fully offline with no vector-database extension to install.

Every chunk is scanned at the security gate before it is stored, and again it is only
ever injected into a prompt as delimited, untrusted data — never as instructions.`;

// A tampered note: a right-to-left override (U+202E) + a zero-width space (U+200B) hidden in the text —
// never-legitimate control characters the scanner flags HIGH (DEFAULT_POLICY blocks at high).
const TAMPERED = `This note looks ordinary but hides a Trojan-Source payload: Miti‮gate​ the rollback.`;

try {
  scanner.start();
  store = await KnowledgeStore.open(join(dir, "knowledge.duckdb"));
  const ds = await store.createDataset({ name: "handbook", classification: "U", source: "local", embeddingModel: "hash-bow-384", dim: 384 });
  const emb = new HashEmbedder(384);

  console.log("== [1/4] a CLEAN document is chunked, scanned, embedded, and stored ==");
  const r1 = await ingestText({ store, scanner, embedder: emb, datasetId: ds.dataset_id, sourcePath: "handbook.txt", text: HANDBOOK, chunkOptions: { maxChars: 240, overlapChars: 40 } });
  if (r1.stored < 2 || r1.blocked !== 0) fail(`clean doc should store multiple chunks, block none; got ${JSON.stringify({ stored: r1.stored, blocked: r1.blocked })}`);
  console.log(`   stored ${r1.stored}/${r1.chunksTotal} chunks  ·  blocked ${r1.blocked}`);

  console.log("\n== [2/4] a TAMPERED note (bidi/zero-width) is BLOCKED — never embedded, never stored ==");
  const before = await store.chunkCount(ds.dataset_id);
  let audited = 0;
  const r2 = await ingestText({ store, scanner, embedder: emb, datasetId: ds.dataset_id, sourcePath: "tampered.txt", text: TAMPERED, onBlock: () => audited++ });
  const after = await store.chunkCount(ds.dataset_id);
  if (r2.stored !== 0 || r2.blocked < 1) fail(`tampered note must be blocked, nothing stored; got ${JSON.stringify({ stored: r2.stored, blocked: r2.blocked })}`);
  if (after !== before) fail(`store count changed on a blocked ingest (${before} → ${after})`);
  if (audited !== r2.blocked) fail("every blocked chunk must be audited via onBlock");
  console.log(`   blocked ${r2.blocked} chunk(s)  ·  audited ${audited}  ·  store count unchanged at ${after}`);

  console.log("\n== [3/4] brute-force cosine retrieval returns the relevant chunk first ==");
  const [q] = await emb.embed(["how does cosine ranking work without a vector database extension"]);
  const hits = await store.retrieve(ds.dataset_id, q!, 3);
  if (hits.length === 0) fail("retrieval returned nothing");
  if (!/cosine distance/.test(hits[0]!.text)) fail(`expected the cosine-distance chunk first; got: ${hits[0]!.text.slice(0, 60)}`);
  console.log(`   top hit (d=${hits[0]!.distance.toFixed(4)}): ${hits[0]!.text.replace(/\n/g, " ").slice(0, 80)}...`);

  console.log("\n== [4/4] retrieved knowledge is wrapped as delimited, untrusted data ==");
  const wrapped = wrapRetrieved(hits);
  if (!wrapped.startsWith("UNTRUSTED_CONTENT_START") || !wrapped.endsWith("UNTRUSTED_CONTENT_END")) fail("injection must be delimited");
  console.log("   " + wrapped.split("\n")[0] + "  ...  " + wrapped.split("\n").slice(-1)[0]);

  cleanup();
  console.log("\nPASS: local knowledge spine — scan-gated ingest, fail-closed block, offline cosine retrieval, delimited injection.");
} catch (e) {
  fail(String((e as Error)?.stack ?? e));
}
process.exit(0);
