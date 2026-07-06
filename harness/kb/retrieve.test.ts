// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/kb/retrieve.test.ts — P-KB.2 (ADR-0100): the hybrid router. Pure tests for the vectorless
// compiled scoring (keyword + link expansion), score normalization, and delimited wrapping; integration
// tests for the three modes over REAL temp stores, asserting hybrid merges both + wraps as untrusted data.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HashEmbedder } from "../knowledge/embedder.ts";
import { KnowledgeStore } from "../knowledge/store.ts";
import { KbGraphStore } from "./store.ts";
import { normalizeScores, retrieveKnowledge, type RetrievedItem, scoreCompiledPages, wrapKnowledge } from "./retrieve.ts";

const page = (over: Partial<import("./store.ts").KbPage> & { page_id: string; slug: string }): import("./store.ts").KbPage => ({
  kind: "concept", title: over.slug, body_md: "", trust_label: "untrusted", classification: "U", created_at: "t", updated_at: "t", ...over,
});
const item = (over: Partial<RetrievedItem>): RetrievedItem => ({ store: "compiled", citation: "page:x", title: "x", text: "t", score: 1, trustLabel: "untrusted", ...over });

describe("scoreCompiledPages — keyword + link expansion (vectorless)", () => {
  test("keyword relevance ranks a matching page first; a no-match page is excluded", () => {
    const pages = [
      page({ page_id: "1", slug: "retrieval", title: "Retrieval", body_md: "retrieval finds relevant context for a query" }),
      page({ page_id: "2", slug: "unrelated", title: "Cooking", body_md: "how to bake bread" }),
    ];
    const out = scoreCompiledPages(pages, [], "retrieval context", 5);
    expect(out[0]!.citation).toBe("page:retrieval");
    expect(out.some((o) => o.citation === "page:unrelated")).toBe(false);
  });
  test("link expansion surfaces a neighbor that has no query words of its own", () => {
    const pages = [
      page({ page_id: "s", slug: "summary", title: "Retrieval overview", body_md: "retrieval" }),
      page({ page_id: "c", slug: "pageindex", title: "PageIndex", body_md: "a hierarchical tree" }), // no query words
    ];
    const links = [{ link_id: "l", from_page_id: "s", to_page_id: "c", relation: "related", created_at: "t" }];
    const out = scoreCompiledPages(pages, links, "retrieval", 5);
    expect(out.map((o) => o.citation)).toContain("page:pageindex"); // pulled in via the link from the hit
  });
  test("an empty query or no pages yields nothing", () => {
    expect(scoreCompiledPages([], [], "x")).toEqual([]);
    expect(scoreCompiledPages([page({ page_id: "1", slug: "a", body_md: "b" })], [], "")).toEqual([]);
  });
});

describe("normalizeScores + wrapKnowledge", () => {
  test("normalize maps into [0,1]; a single item maps to 1", () => {
    const n = normalizeScores([item({ score: 2 }), item({ citation: "page:y", score: 10 })]);
    expect(Math.min(...n.map((i) => i.score))).toBe(0);
    expect(Math.max(...n.map((i) => i.score))).toBe(1);
    expect(normalizeScores([item({ score: 7 })])[0]!.score).toBe(1);
  });
  test("wrapKnowledge delimits + cites each hit; empty → ''", () => {
    const w = wrapKnowledge([item({ store: "vector", citation: "doc.md#3", title: "doc.md", text: "hello" })]);
    expect(w.startsWith("UNTRUSTED_CONTENT_START")).toBe(true);
    expect(w.endsWith("UNTRUSTED_CONTENT_END")).toBe(true);
    expect(w).toContain("(vector:doc.md#3)");
    expect(wrapKnowledge([])).toBe("");
  });
});

describe("retrieveKnowledge — modes over real stores", () => {
  let dir: string;
  let kb: KbGraphStore;
  let vec: KnowledgeStore;
  let datasetId: string;
  const emb = new HashEmbedder(64);

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "kb-retrieve-"));
    kb = await KbGraphStore.open(join(dir, "kb_graph.duckdb"));
    vec = await KnowledgeStore.open(join(dir, "knowledge.duckdb"));
    datasetId = (await vec.createDataset({ name: "d", classification: "U", source: "local", embeddingModel: emb.id, dim: emb.dim })).dataset_id;
    const s = await kb.addPage({ kind: "summary", slug: "doc-summary", title: "Doc summary", bodyMd: "about retrieval systems and context", trustLabel: "untrusted", classification: "U" });
    const c = await kb.addPage({ kind: "concept", slug: "retrieval", title: "Retrieval", bodyMd: "finding relevant context", trustLabel: "untrusted", classification: "U" });
    await kb.addLink({ fromPageId: s, toPageId: c, relation: "mentions" });
    const [v] = await emb.embed(["a vector chunk about retrieval and context"]);
    await vec.addChunk({ datasetId, sourcePath: "notes.txt", ordinal: 0, text: "a vector chunk about retrieval and context", trustLabel: "trusted", embedding: v! });
  });
  afterEach(() => { kb.close(); vec.close(); rmSync(dir, { recursive: true, force: true }); });

  test("compiled mode returns only page hits", async () => {
    const r = await retrieveKnowledge({ query: "retrieval context", mode: "compiled", compiled: { store: kb } });
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items.every((i) => i.store === "compiled")).toBe(true);
    expect(r.items.every((i) => i.citation.startsWith("page:"))).toBe(true);
  });

  test("vector mode returns only chunk hits", async () => {
    const r = await retrieveKnowledge({ query: "retrieval context", mode: "vector", vector: { store: vec, datasetId, embedder: emb } });
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items.every((i) => i.store === "vector")).toBe(true);
    expect(r.items[0]!.citation).toBe("notes.txt#0");
  });

  test("hybrid merges BOTH stores and wraps the result as untrusted data", async () => {
    const r = await retrieveKnowledge({ query: "retrieval context", mode: "hybrid", vector: { store: vec, datasetId, embedder: emb }, compiled: { store: kb } });
    const stores = new Set(r.items.map((i) => i.store));
    expect(stores.has("vector")).toBe(true);
    expect(stores.has("compiled")).toBe(true);
    expect(r.wrapped.startsWith("UNTRUSTED_CONTENT_START")).toBe(true);
    expect(r.items.every((i) => i.score >= 0 && i.score <= 1)).toBe(true); // hybrid normalizes
  });
});
