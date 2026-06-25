// harness/knowledge/ingest.test.ts — the scan-gate is the security keystone here. Asserts: clean text
// is chunked/embedded/stored with trust labels; a poisoned chunk is NEVER stored and IS audited; a
// dead scanner fails closed (nothing stored); and retrieval wrapping is delimited (invariant #5).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScannerClient } from "../security/scanner_client.ts";
import { ScanUnavailableError } from "../security/scanner_client.ts";
import { HashEmbedder } from "./embedder.ts";
import { KnowledgeStore } from "./store.ts";
import { ingestText, wrapRetrieved } from "./ingest.ts";

// Reuse the project's fake-scanner shape (see personal/*.test.ts): a structural ScannerClient whose
// scan() returns findings derived from the text. DEFAULT_POLICY blocks at "high".
const fakeScanner = (findings: (t: string) => unknown[]): ScannerClient =>
  ({ scan: async (t: string) => ({ findings: findings(t) }) }) as unknown as ScannerClient;
const cleanScanner = fakeScanner(() => []);
const poisonScanner = fakeScanner((t) => (/POISON/.test(t) ? [{ severity: "high", finding_type: "zero-width" }] : []));
const deadScanner = { scan: async () => { throw new ScanUnavailableError("sidecar dead"); } } as unknown as ScannerClient;

describe("ingestText (scan-gated)", () => {
  let dir: string;
  let store: KnowledgeStore;
  const emb = new HashEmbedder(64);

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "kb-ingest-"));
    store = await KnowledgeStore.open(join(dir, "knowledge.duckdb"));
  });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  async function ds() {
    return (await store.createDataset({ name: "d", classification: "U", source: "local", embeddingModel: emb.id, dim: emb.dim })).dataset_id;
  }

  test("clean text is chunked, embedded, and stored as trusted", async () => {
    const id = await ds();
    const text = Array.from({ length: 30 }, (_, i) => `Clean fact number ${i} about retrieval.`).join(" ");
    const r = await ingestText({ store, scanner: cleanScanner, embedder: emb, datasetId: id, sourcePath: "clean.txt", text, chunkOptions: { maxChars: 120, overlapChars: 20 } });
    expect(r.chunksTotal).toBeGreaterThan(1);
    expect(r.stored).toBe(r.chunksTotal);
    expect(r.blocked).toBe(0);
    expect(await store.chunkCount(id)).toBe(r.stored);
  });

  test("a poisoned chunk is BLOCKED — never stored — and audited via onBlock", async () => {
    const id = await ds();
    const blocks: unknown[] = [];
    // Two paragraphs: one clean, one containing POISON. With a small window each is its own chunk.
    const text = "This paragraph is perfectly clean and ordinary.\n\nThis paragraph contains POISON and must be quarantined.";
    const r = await ingestText({
      store, scanner: poisonScanner, embedder: emb, datasetId: id, sourcePath: "mixed.txt", text,
      chunkOptions: { maxChars: 60, overlapChars: 0 }, onBlock: (b) => blocks.push(b),
    });
    expect(r.blocked).toBeGreaterThanOrEqual(1);
    expect(blocks.length).toBe(r.blocked);
    // nothing stored contains POISON
    const stored = await store.retrieve(id, (await emb.embed(["poison"]))[0]!, 50);
    expect(stored.every((c) => !/POISON/.test(c.text))).toBe(true);
    expect(await store.chunkCount(id)).toBe(r.stored);
  });

  test("a dead scanner fails closed: every chunk blocked, nothing stored", async () => {
    const id = await ds();
    const r = await ingestText({ store, scanner: deadScanner, embedder: emb, datasetId: id, sourcePath: "x.txt", text: "anything at all goes here, more than one chunk maybe" });
    expect(r.stored).toBe(0);
    expect(r.blocked).toBe(r.chunksTotal);
    expect(await store.chunkCount(id)).toBe(0);
  });

  test("wrapRetrieved delimits injected knowledge as untrusted data", async () => {
    const id = await ds();
    const [v] = await emb.embed(["delimited knowledge chunk"]);
    await store.addChunk({ datasetId: id, sourcePath: "d.txt", ordinal: 2, text: "delimited knowledge chunk", trustLabel: "trusted", embedding: v! });
    const hits = await store.retrieve(id, v!, 3);
    const wrapped = wrapRetrieved(hits);
    expect(wrapped.startsWith("UNTRUSTED_CONTENT_START")).toBe(true);
    expect(wrapped.endsWith("UNTRUSTED_CONTENT_END")).toBe(true);
    expect(wrapped).toContain("(d.txt#2)");
    expect(wrapRetrieved([])).toBe("");
  });
});
