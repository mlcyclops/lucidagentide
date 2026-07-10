// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/kb/batch_ingest.test.ts — P-KGPACK.3 (ADR-0205): seeding one KG from many documents. The batch is
// a thin loop over ingestDocument, so its security is inherited; these tests pin the BATCH concerns: clean
// docs compile into the target store, a poisoned doc quarantines WITHOUT stopping the batch, a dead scanner
// fails closed for every doc, the cap reports the remainder as `skipped` (never silent), and cancellation
// stops at a document boundary keeping what already compiled.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScannerClient } from "../security/scanner_client.ts";
import { ScanUnavailableError } from "../security/scanner_client.ts";
import { KbGraphStore } from "./store.ts";
import { ingestSourcesIntoKg, type KbSourceDoc } from "./batch_ingest.ts";

const fakeScanner = (findings: (t: string) => unknown[]): ScannerClient =>
  ({ scan: async (t: string) => ({ findings: findings(t) }) }) as unknown as ScannerClient;
const cleanScanner = fakeScanner(() => []);
const poisonScanner = fakeScanner((t) => (/POISON/.test(t) ? [{ severity: "high", finding_type: "zero-width" }] : []));
const deadScanner = { scan: async () => { throw new ScanUnavailableError("sidecar dead"); } } as unknown as ScannerClient;

// Each doc compiles to two clean pages + one link (slugs keyed by the doc so a batch makes distinct pages).
const modelFor = (): ((system: string, user: string) => Promise<string>) => {
  let n = 0;
  return async () => {
    const k = n++;
    return JSON.stringify({
      pages: [
        { kind: "summary", slug: `sum-${k}`, title: `Summary ${k}`, body_md: `Summary body ${k}.` },
        { kind: "concept", slug: `concept-${k}`, title: `Concept ${k}`, body_md: `Concept body ${k}.` },
      ],
      links: [{ from: `sum-${k}`, to: `concept-${k}`, relation: "mentions" }],
    });
  };
};

const docs = (n: number, poisonAt?: number): KbSourceDoc[] =>
  Array.from({ length: n }, (_, i) => ({ sourcePath: `doc-${i}`, title: `Doc ${i}`, text: i === poisonAt ? "This source hides POISON." : `Clean document ${i} about retrieval.` }));

describe("ingestSourcesIntoKg (batch seed)", () => {
  let dir: string;
  let store: KbGraphStore;
  beforeEach(async () => { dir = mkdtempSync(join(tmpdir(), "kb-batch-")); store = await KbGraphStore.open(join(dir, "kb_graph.duckdb")); });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  test("clean documents all compile into the target store", async () => {
    const r = await ingestSourcesIntoKg({ store, scanner: cleanScanner, complete: modelFor(), docs: docs(3) });
    expect(r.documents).toBe(3);
    expect(r.documentsQuarantined).toBe(0);
    expect(r.pagesCompiled).toBe(6); // 2 pages per doc
    expect(r.links).toBe(3);
    expect(r.skipped).toBe(0);
    expect(await store.pageCount()).toBe(6);
    expect((await store.listPages()).every((p) => p.trust_label === "untrusted")).toBe(true); // keystone #2
  });

  test("a poisoned document quarantines WITHOUT stopping the batch", async () => {
    const blocks: unknown[] = [];
    const r = await ingestSourcesIntoKg({ store, scanner: poisonScanner, complete: modelFor(), docs: docs(3, 1), onBlock: (b) => blocks.push(b) });
    expect(r.documents).toBe(3);
    expect(r.documentsQuarantined).toBe(1);   // only the poisoned one
    expect(r.pagesCompiled).toBe(4);          // the other two docs still compiled
    expect(blocks).toHaveLength(1);
    expect(await store.pageCount()).toBe(4);
  });

  test("a dead scanner fails closed for EVERY document", async () => {
    const r = await ingestSourcesIntoKg({ store, scanner: deadScanner, complete: modelFor(), docs: docs(3) });
    expect(r.documentsQuarantined).toBe(3);
    expect(r.pagesCompiled).toBe(0);
    expect(await store.pageCount()).toBe(0);
  });

  test("the cap bounds processing; the remainder is reported skipped (never silent)", async () => {
    const r = await ingestSourcesIntoKg({ store, scanner: cleanScanner, complete: modelFor(), docs: docs(5), maxDocuments: 2 });
    expect(r.documents).toBe(2);
    expect(r.totalDocuments).toBe(2);
    expect(r.available).toBe(5);
    expect(r.skipped).toBe(3);
    expect(await store.pageCount()).toBe(4);
  });

  test("cancellation stops at a document boundary, keeping what already compiled", async () => {
    const ac = new AbortController();
    let seen = 0;
    const r = await ingestSourcesIntoKg({
      store, scanner: cleanScanner, complete: modelFor(), docs: docs(5),
      onProgress: () => { if (++seen === 3) ac.abort(); }, // abort after a couple of docs
      signal: ac.signal,
    });
    expect(r.cancelled).toBe(true);
    expect(r.documents).toBeLessThan(5);
    expect(r.skipped).toBe(r.available - r.documents);
    expect(await store.pageCount()).toBe(r.pagesCompiled); // partial progress persisted (fail-safe)
  });

  test("a document whose compile THROWS is counted (errored) and never aborts the batch", async () => {
    let n = 0;
    const flakyModel = async (): Promise<string> => {
      if (n++ === 1) throw new Error("backend outage"); // the 2nd doc's compile blows up
      return JSON.stringify({ pages: [{ kind: "summary", slug: `s-${n}`, title: "S", body_md: "ok" }], links: [] });
    };
    const r = await ingestSourcesIntoKg({ store, scanner: cleanScanner, complete: flakyModel, docs: docs(3) });
    expect(r.documents).toBe(3);          // all three attempted
    expect(r.errored).toBe(1);            // the flaky one counted, not fatal
    expect(r.documentsQuarantined).toBe(0); // an outage is NOT a security quarantine
    expect(r.pagesCompiled).toBe(2);      // the other two still compiled
  });

  test("progress ticks count up to the total", async () => {
    const ticks: number[] = [];
    await ingestSourcesIntoKg({ store, scanner: cleanScanner, complete: modelFor(), docs: docs(3), onProgress: (p) => ticks.push(p.documents) });
    expect(ticks[0]).toBe(0);                 // an initial 0/total tick
    expect(ticks[ticks.length - 1]).toBe(3);  // finishes at the total
  });
});
