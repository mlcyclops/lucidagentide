// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/kb/store.test.ts — P-KB.1 (ADR-0099): the compiled-KB store. Confirms the 0011 migration
// applies to a fresh kb_graph.duckdb and the page-graph CRUD (documents/pages/links/sources/changelog)
// round-trips, including the doc-status transition the ingest quarantine path uses.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KbGraphStore, sha256Hex } from "./store.ts";

describe("KbGraphStore", () => {
  let dir: string;
  let store: KbGraphStore;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "kb-store-"));
    store = await KbGraphStore.open(join(dir, "kb_graph.duckdb"));
  });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  test("a fresh DB has the schema applied and is empty", async () => {
    expect(await store.pageCount()).toBe(0);
    expect(await store.listPages()).toEqual([]);
    expect(await store.listLinks()).toEqual([]);
  });

  test("document CRUD + the quarantine status transition", async () => {
    const id = await store.addDocument({ sourcePath: "spec.md", title: "Spec", sha256: sha256Hex("body"), classification: "U", trustLabel: "trusted", status: "compiled" });
    const doc = await store.getDocument(id);
    expect(doc?.title).toBe("Spec");
    expect(doc?.status).toBe("compiled");
    await store.setDocumentStatus(id, "quarantined");
    expect((await store.getDocument(id))?.status).toBe("quarantined");
  });

  test("pages, links, and sources round-trip; pages default to their passed trust", async () => {
    const docId = await store.addDocument({ sourcePath: "s.md", title: "S", sha256: "d", classification: "U", trustLabel: "trusted", status: "compiled" });
    const summary = await store.addPage({ kind: "summary", slug: "s-summary", title: "S — summary", bodyMd: "the gist", trustLabel: "untrusted", classification: "U" });
    const concept = await store.addPage({ kind: "concept", slug: "retrieval", title: "Retrieval", bodyMd: "a concept", trustLabel: "untrusted", classification: "U" });
    await store.addLink({ fromPageId: summary, toPageId: concept, relation: "mentions" });
    await store.addPageSource({ pageId: summary, documentId: docId, ordinal: 0, quote: "excerpt" });

    expect(await store.pageCount()).toBe(2);
    expect((await store.listPages("concept")).map((p) => p.slug)).toEqual(["retrieval"]);
    expect((await store.listPages()).every((p) => p.trust_label === "untrusted")).toBe(true); // derived → untrusted
    const links = await store.listLinks();
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ from_page_id: summary, to_page_id: concept, relation: "mentions" });
  });

  test("the changelog is append-only + queryable per document", async () => {
    const docId = await store.addDocument({ sourcePath: "s.md", title: "S", sha256: "d", classification: "U", trustLabel: "trusted", status: "compiled" });
    await store.appendChangelog({ documentId: docId, action: "ingested", detail: "clean source" });
    await store.appendChangelog({ documentId: docId, action: "page_added", detail: "s-summary" });
    await store.appendChangelog({ documentId: null, action: "compiled", detail: "graph-wide note" });
    expect((await store.changelog(docId)).map((c) => c.action)).toEqual(["ingested", "page_added"]);
    expect((await store.changelog()).length).toBe(3);
  });
});
