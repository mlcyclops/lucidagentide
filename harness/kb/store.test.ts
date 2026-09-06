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

  test("an empty graph snapshot has zero totals and missing pages stay absent", async () => {
    expect(await store.graphSnapshot()).toEqual({ pages: [], links: [], totalPages: 0, totalLinks: 0 });
    expect(await store.getPage("missing-page")).toBeUndefined();
  });

  test("a small snapshot preserves metadata and isolated nodes without transporting bodies", async () => {
    const isolated = await store.addPage({ kind: "source", slug: "isolated", title: "Isolated", bodyMd: "private body", trustLabel: "untrusted", classification: "CUI" });
    const source = await store.addPage({ kind: "summary", slug: "source", title: "Source", bodyMd: "source body", trustLabel: "untrusted", classification: "U" });
    const target = await store.addPage({ kind: "concept", slug: "target", title: "Target", bodyMd: "target body", trustLabel: "untrusted", classification: "U" });
    const linkId = await store.addLink({ fromPageId: source, toPageId: target, relation: "mentions" });

    const snapshot = await store.graphSnapshot();
    expect(snapshot.totalPages).toBe(3);
    expect(snapshot.totalLinks).toBe(1);
    expect(snapshot.pages.map((p) => p.page_id)).toEqual([...[source, target].sort(), isolated]);
    // listLinks/getPage return raw TIMESTAMP values; the snapshot carries strings. Normalize before
    // structural comparison so this asserts CONTENT equality, not the binding's value class.
    const asStrings = <T extends { created_at: unknown }>(row: T): T => ({ ...row, created_at: String(row.created_at) });
    expect(snapshot.links).toEqual((await store.listLinks()).map(asStrings));
    expect(snapshot.links[0]?.link_id).toBe(linkId);
    for (const page of snapshot.pages) {
      const full = await store.getPage(page.page_id);
      expect(full).toBeDefined();
      const { body_md, ...metadata } = full!;
      expect(body_md).toBeTruthy();
      expect(page).toEqual({ ...asStrings(metadata), updated_at: String(metadata.updated_at) });
      expect(() => JSON.stringify(page)).not.toThrow(); // the wire contract: serializable without a bigint replacer
      expect(Object.hasOwn(page, "body_md")).toBe(false);
    }
    expect((await store.getPage(isolated))?.body_md).toBe("private body");
    expect(await store.getPage("missing-page")).toBeUndefined();
  });

  test("dense snapshots cap both dimensions deterministically while retaining the complete queryable graph", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 105; i++) {
      ids.push(await store.addPage({ kind: "concept", slug: `page-${i}`, title: `Page ${i}`, bodyMd: `Full body ${i}`, trustLabel: "untrusted", classification: "U" }));
    }
    // Insert the most connected page last so insertion order cannot masquerade as degree ranking.
    const hub = ids[104]!;
    for (const id of ids.slice(0, 104)) await store.addLink({ fromPageId: hub, toPageId: id, relation: "mentions" });
    // The clique alone exceeds the edge cap, and all its nodes outrank the star's ordinary leaves.
    for (let i = 0; i < 21; i++) {
      for (let j = i + 1; j < 21; j++) {
        await store.addLink({ fromPageId: ids[i]!, toPageId: ids[j]!, relation: "related" });
      }
    }

    const snapshot = await store.graphSnapshot();
    expect(snapshot.pages).toHaveLength(100);
    expect(snapshot.links).toHaveLength(200);
    expect(snapshot.totalPages).toBe(ids.length);
    expect(snapshot.totalLinks).toBe(104 + (21 * 20 / 2));
    const rankedIds = [hub, ...ids.slice(0, 21).sort(), ...ids.slice(21, 104).sort()];
    expect(snapshot.pages.map((p) => p.page_id)).toEqual(rankedIds.slice(0, 100));
    expect(snapshot.pages.every((p) => !Object.hasOwn(p, "body_md"))).toBe(true);
    const selected = new Set(snapshot.pages.map((p) => p.page_id));
    const allLinks = await store.listLinks();
    const internalLinks = allLinks.filter((l) => selected.has(l.from_page_id) && selected.has(l.to_page_id));
    internalLinks.sort((a, b) => {
      for (const key of ["from_page_id", "to_page_id", "relation", "link_id"] as const) {
        if (a[key] < b[key]) return -1;
        if (a[key] > b[key]) return 1;
      }
      return 0;
    });
    expect(internalLinks.length).toBeGreaterThan(snapshot.links.length);
    expect(snapshot.links).toEqual(internalLinks.slice(0, 200).map((l) => ({ ...l, created_at: String(l.created_at) })));
    expect(await store.graphSnapshot()).toEqual(snapshot);

    const omitted = rankedIds[100]!;
    expect(selected.has(omitted)).toBe(false);
    expect(await store.getPage(omitted)).toMatchObject({ page_id: omitted, body_md: `Full body ${ids.indexOf(omitted)}` });
    const fullPages = await store.listPages();
    expect(fullPages).toHaveLength(snapshot.totalPages);
    expect(fullPages.every((p) => p.body_md === `Full body ${ids.indexOf(p.page_id)}`)).toBe(true);
    expect(await store.listPages("concept")).toEqual(fullPages);
    expect(allLinks).toHaveLength(snapshot.totalLinks);
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
