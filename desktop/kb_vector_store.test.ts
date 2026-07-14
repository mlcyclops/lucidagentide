// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/kb_vector_store.test.ts — ADR-0221: the desktop's per-KG VECTOR store glue (knowledgeVectorStore +
// vectorDatasetFor). Verified against REAL DuckDB with the offline HashEmbedder (no network): a KG's vector
// store is a sibling file, a dataset is find-or-created to match the current embedder, and a DIFFERENT embedding
// model gets its OWN dataset so vector spaces never mix at retrieval.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HashEmbedder } from "../harness/knowledge/embedder.ts";
import { knowledgeVectorStore, vectorDatasetFor, createKg, stopKb, _resetKbStoreForTest } from "./kb_store.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kb-vec-"));
  process.env.LUCID_KB_DB_PATH = join(dir, "kb_graph.duckdb");
  process.env.LUCID_KG_REGISTRY_PATH = join(dir, "kg_registry.json");
  _resetKbStoreForTest();
});
afterEach(async () => {
  await stopKb();
  delete process.env.LUCID_KB_DB_PATH; delete process.env.LUCID_KG_REGISTRY_PATH;
  rmSync(dir, { recursive: true, force: true });
});

describe("knowledgeVectorStore + vectorDatasetFor (ADR-0221)", () => {
  test("per-KG vector store; find-or-create a dataset matching the embedder (reuse on the second call)", async () => {
    const kg = createKg({ name: "Notes" });
    const store = await knowledgeVectorStore(kg.kg_id);
    const emb = new HashEmbedder(64);
    const ds1 = await vectorDatasetFor(store, "Notes", emb);
    const ds2 = await vectorDatasetFor(store, "Notes", emb); // same model → REUSE, not a duplicate
    expect(ds2).toBe(ds1);
    const list = await store.listDatasets();
    expect(list.length).toBe(1);
    expect(list[0]!.embedding_model).toBe(emb.id);
    expect(list[0]!.dim).toBe(64);
  });

  test("a different embedding model → a NEW dataset (vector spaces never mix)", async () => {
    const kg = createKg({ name: "Notes" });
    const store = await knowledgeVectorStore(kg.kg_id);
    const ds1 = await vectorDatasetFor(store, "Notes", new HashEmbedder(64));
    const ds2 = await vectorDatasetFor(store, "Notes", new HashEmbedder(128)); // different id + dim
    expect(ds2).not.toBe(ds1);
    expect((await store.listDatasets()).length).toBe(2);
  });

  test("a stored chunk is retrievable by cosine within the KG's dataset", async () => {
    const kg = createKg({ name: "Notes" });
    const store = await knowledgeVectorStore(kg.kg_id);
    const emb = new HashEmbedder(64);
    const datasetId = await vectorDatasetFor(store, "Notes", emb);
    const [vec] = await emb.embed(["the mission planning cadence is weekly"]);
    await store.addChunk({ datasetId, sourcePath: "notes/ops.md", ordinal: 0, text: "the mission planning cadence is weekly", trustLabel: "trusted", embedding: vec! });
    const [q] = await emb.embed(["how often is mission planning"]);
    const hits = await store.retrieve(datasetId, q!, 3);
    expect(hits.length).toBe(1);
    expect(hits[0]!.source_path).toBe("notes/ops.md");
  });
});
