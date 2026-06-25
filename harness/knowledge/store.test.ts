// harness/knowledge/store.test.ts — the vector store against a real (temp) knowledge.duckdb: separate
// migration set applies, dataset/chunk CRUD, brute-force cosine ranking, dim-mismatch fails loudly.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HashEmbedder } from "./embedder.ts";
import { KnowledgeStore } from "./store.ts";

describe("KnowledgeStore", () => {
  let dir: string;
  let store: KnowledgeStore;
  // 384-dim (the real bge dimensionality): enough buckets that the stub embedder's hash collisions
  // don't flip rankings of close sentences. The dim is also what addChunk validates against.
  const emb = new HashEmbedder(384);

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "kb-"));
    store = await KnowledgeStore.open(join(dir, "knowledge.duckdb"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function dataset() {
    return store.createDataset({ name: "docs", classification: "U", source: "local", embeddingModel: emb.id, dim: emb.dim });
  }

  test("the knowledge migration set creates kb tables (separate DB)", async () => {
    const ds = await dataset();
    expect(ds.dataset_id).toBeTruthy();
    expect(await store.listDatasets()).toHaveLength(1);
    expect(await store.chunkCount(ds.dataset_id)).toBe(0);
  });

  test("addChunk + retrieve ranks the nearest chunk first", async () => {
    const ds = await dataset();
    const texts = [
      "duckdb brute force cosine retrieval over float arrays",
      "the cat sat quietly on the warm windowsill",
      "vector embeddings power semantic search and retrieval",
    ];
    const vecs = await emb.embed(texts);
    for (let i = 0; i < texts.length; i++) {
      await store.addChunk({ datasetId: ds.dataset_id, sourcePath: "doc.txt", ordinal: i, text: texts[i]!, trustLabel: "trusted", embedding: vecs[i]! });
    }
    expect(await store.chunkCount(ds.dataset_id)).toBe(3);

    const [q] = await emb.embed(["cosine retrieval in duckdb"]);
    const hits = await store.retrieve(ds.dataset_id, q!, 3);
    expect(hits).toHaveLength(3);
    expect(hits[0]!.text).toBe(texts[0]!);                 // nearest first
    expect(hits[0]!.distance).toBeLessThanOrEqual(hits[1]!.distance);
    expect(hits[1]!.distance).toBeLessThanOrEqual(hits[2]!.distance);
    expect(hits[0]!.trust_label).toBe("trusted");
  });

  test("retrieve honors k and is scoped to the dataset", async () => {
    const a = await dataset();
    const b = await dataset();
    const [va] = await emb.embed(["alpha only content"]);
    const [vb] = await emb.embed(["beta only content"]);
    await store.addChunk({ datasetId: a.dataset_id, sourcePath: "a", ordinal: 0, text: "alpha only content", trustLabel: "trusted", embedding: va! });
    await store.addChunk({ datasetId: b.dataset_id, sourcePath: "b", ordinal: 0, text: "beta only content", trustLabel: "trusted", embedding: vb! });
    const hits = await store.retrieve(a.dataset_id, va!, 5);
    expect(hits).toHaveLength(1);          // only dataset a's chunk
    expect(hits[0]!.text).toBe("alpha only content");
  });

  test("dim mismatch throws at write (never silently stored)", async () => {
    const ds = await dataset();
    await expect(
      store.addChunk({ datasetId: ds.dataset_id, sourcePath: "x", ordinal: 0, text: "bad", trustLabel: "trusted", embedding: [0.1, 0.2] }),
    ).rejects.toThrow(/dim/);
  });

  test("unknown dataset throws", async () => {
    await expect(
      store.addChunk({ datasetId: "nope", sourcePath: "x", ordinal: 0, text: "y", trustLabel: "trusted", embedding: new Array(64).fill(0) }),
    ).rejects.toThrow(/unknown dataset/);
  });
});
