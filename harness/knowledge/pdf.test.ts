// harness/knowledge/pdf.test.ts — the PDF path must add NO new trust path. Asserts: text round-trips out
// of a PDF; a non-PDF buffer fails closed (throws, never empty text); a PDF carrying POISON is BLOCKED by
// the SAME gate as .txt and never stored; a dead scanner fails closed on PDF input too.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScannerClient } from "../security/scanner_client.ts";
import { ScanUnavailableError } from "../security/scanner_client.ts";
import { HashEmbedder } from "./embedder.ts";
import { KnowledgeStore } from "./store.ts";
import { extractPdfText, ingestPdf } from "./pdf.ts";
import { makeTextPdf } from "./pdf_fixture.ts";

const fakeScanner = (findings: (t: string) => unknown[]): ScannerClient =>
  ({ scan: async (t: string) => ({ findings: findings(t) }) }) as unknown as ScannerClient;
const cleanScanner = fakeScanner(() => []);
const poisonScanner = fakeScanner((t) => (/POISON/.test(t) ? [{ severity: "high", finding_type: "zero-width" }] : []));
const deadScanner = { scan: async () => { throw new ScanUnavailableError("sidecar dead"); } } as unknown as ScannerClient;

describe("extractPdfText", () => {
  test("round-trips per-page text out of a built PDF", async () => {
    const pdf = makeTextPdf(["Kittens are playful young housecats.", "The firm reported strong quarterly earnings."]);
    const out = await extractPdfText(pdf);
    expect(out.totalPages).toBe(2);
    expect(out.pages[0]).toContain("Kittens are playful young housecats.");
    expect(out.pages[1]).toContain("quarterly earnings");
  });

  test("fails closed on a non-PDF buffer — throws, never empty text", async () => {
    const notPdf = new TextEncoder().encode("just some plain text, definitely not a PDF");
    await expect(extractPdfText(notPdf)).rejects.toThrow(/not a PDF/);
  });
});

describe("ingestPdf (same scan gate as text)", () => {
  let dir: string;
  let store: KnowledgeStore;
  const emb = new HashEmbedder(64);

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "kb-pdf-"));
    store = await KnowledgeStore.open(join(dir, "knowledge.duckdb"));
  });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  async function ds() {
    return (await store.createDataset({ name: "d", classification: "U", source: "local", embeddingModel: emb.id, dim: emb.dim })).dataset_id;
  }

  test("a clean PDF is extracted, chunked, embedded, and stored", async () => {
    const id = await ds();
    const pdf = makeTextPdf(["Retrieval augmented generation grounds answers in retrieved context.", "Embeddings place similar meanings near each other in vector space."]);
    const r = await ingestPdf({ store, scanner: cleanScanner, embedder: emb, datasetId: id, sourcePath: "doc.pdf", data: pdf, chunkOptions: { maxChars: 200, overlapChars: 20 } });
    expect(r.stored).toBe(r.chunksTotal);
    expect(r.stored).toBeGreaterThanOrEqual(1);
    expect(r.blocked).toBe(0);
    expect(await store.chunkCount(id)).toBe(r.stored);
  });

  test("a PDF carrying POISON is BLOCKED by the same gate — never stored — and audited", async () => {
    const id = await ds();
    const blocks: unknown[] = [];
    const pdf = makeTextPdf(["This page is perfectly ordinary and clean.", "This page hides POISON and must be quarantined."]);
    const r = await ingestPdf({
      store, scanner: poisonScanner, embedder: emb, datasetId: id, sourcePath: "mixed.pdf", data: pdf,
      chunkOptions: { maxChars: 60, overlapChars: 0 }, onBlock: (b) => blocks.push(b),
    });
    expect(r.blocked).toBeGreaterThanOrEqual(1);
    expect(blocks.length).toBe(r.blocked);
    const stored = await store.retrieve(id, (await emb.embed(["poison"]))[0]!, 50);
    expect(stored.every((c) => !/POISON/.test(c.text))).toBe(true);
    expect(await store.chunkCount(id)).toBe(r.stored);
  });

  test("a dead scanner fails closed on PDF input: nothing stored", async () => {
    const id = await ds();
    const pdf = makeTextPdf(["anything at all", "more than one page of content here"]);
    const r = await ingestPdf({ store, scanner: deadScanner, embedder: emb, datasetId: id, sourcePath: "x.pdf", data: pdf });
    expect(r.stored).toBe(0);
    expect(r.blocked).toBe(r.chunksTotal);
    expect(await store.chunkCount(id)).toBe(0);
  });
});
