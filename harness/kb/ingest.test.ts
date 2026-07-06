// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/kb/ingest.test.ts — P-KB.1 (ADR-0099): the compile pipeline's fail-closed gates ARE the
// security keystone. Asserts: a clean doc compiles to stored (untrusted) pages + links; a poisoned
// SOURCE is quarantined and NEVER compiled; a dead scanner fails closed; and a poisoned DERIVED PAGE is
// re-scanned + quarantined (never stored), with its links dropped — derived content never auto-promotes.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScannerClient } from "../security/scanner_client.ts";
import { ScanUnavailableError } from "../security/scanner_client.ts";
import { KbGraphStore } from "./store.ts";
import { ingestDocument } from "./ingest.ts";

// Structural fake scanners (the project's test shape): scan() returns findings derived from the text;
// DEFAULT_POLICY blocks at "high".
const fakeScanner = (findings: (t: string) => unknown[]): ScannerClient =>
  ({ scan: async (t: string) => ({ findings: findings(t) }) }) as unknown as ScannerClient;
const cleanScanner = fakeScanner(() => []);
const poisonScanner = fakeScanner((t) => (/POISON/.test(t) ? [{ severity: "high", finding_type: "zero-width" }] : []));
const deadScanner = { scan: async () => { throw new ScanUnavailableError("sidecar dead"); } } as unknown as ScannerClient;

// A fake model returning two clean pages + a link (used with the clean scanner).
const cleanModel = async (): Promise<string> => JSON.stringify({
  pages: [
    { kind: "summary", slug: "doc-summary", title: "Doc — summary", body_md: "The document is about retrieval." },
    { kind: "concept", slug: "retrieval", title: "Retrieval", body_md: "Finding relevant context for a query." },
  ],
  links: [{ from: "doc-summary", to: "retrieval", relation: "mentions" }],
});
// A fake model returning one clean page + one page whose BODY contains POISON, linked to it.
const poisonPageModel = async (): Promise<string> => JSON.stringify({
  pages: [
    { kind: "summary", slug: "clean-summary", title: "Clean", body_md: "A perfectly ordinary summary." },
    { kind: "concept", slug: "evil", title: "Evil", body_md: "This derived page hides POISON in its body." },
  ],
  links: [{ from: "clean-summary", to: "evil", relation: "mentions" }],
});

describe("ingestDocument (compile pipeline)", () => {
  let dir: string;
  let store: KbGraphStore;
  beforeEach(async () => { dir = mkdtempSync(join(tmpdir(), "kb-ingest-")); store = await KbGraphStore.open(join(dir, "kb_graph.duckdb")); });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  // NB: exclude `store` here - it is (re)assigned in beforeEach, so each call references the live one.
  const base = { sourcePath: "doc.md", title: "Doc", text: "A clean document about retrieval and context." };

  test("a clean document compiles to stored (untrusted) pages + links", async () => {
    const r = await ingestDocument({ store, ...base, scanner: cleanScanner, complete: cleanModel });
    expect(r.status).toBe("compiled");
    expect(r.pagesCompiled).toBe(2);
    expect(r.links).toBe(1);
    expect(await store.pageCount()).toBe(2);
    expect((await store.listPages()).every((p) => p.trust_label === "untrusted")).toBe(true); // keystone #2
    expect((await store.getDocument(r.documentId))?.status).toBe("compiled");
    expect((await store.changelog(r.documentId)).map((c) => c.action)).toContain("page_added");
  });

  test("a poisoned SOURCE is quarantined and NEVER compiled", async () => {
    const blocks: unknown[] = [];
    const r = await ingestDocument({ store, ...base, text: "This source hides POISON.", scanner: poisonScanner, complete: cleanModel, onBlock: (b) => blocks.push(b) });
    expect(r.status).toBe("quarantined");
    expect(r.pagesCompiled).toBe(0);
    expect(await store.pageCount()).toBe(0); // the model was never even called to store anything
    expect((await store.getDocument(r.documentId))?.status).toBe("quarantined");
    expect(blocks).toHaveLength(1);
    expect(r.blocked[0]!.stage).toBe("source");
  });

  test("a dead scanner fails closed: source quarantined, nothing compiled", async () => {
    const r = await ingestDocument({ store, ...base, scanner: deadScanner, complete: cleanModel });
    expect(r.status).toBe("quarantined");
    expect(await store.pageCount()).toBe(0);
  });

  test("a poisoned DERIVED PAGE is re-scanned + quarantined (never stored); its links are dropped", async () => {
    // Source is clean (no POISON) so it passes; the model returns a page whose BODY carries POISON.
    const blocks: unknown[] = [];
    const r = await ingestDocument({ store, ...base, scanner: poisonScanner, complete: poisonPageModel, onBlock: (b) => blocks.push(b) });
    expect(r.status).toBe("compiled"); // the source itself was clean
    expect(r.pagesCompiled).toBe(1); // only the clean page stored
    expect(r.pagesQuarantined).toBe(1); // the POISON page blocked
    expect(r.links).toBe(0); // the link pointed at the quarantined page → dropped
    expect(await store.pageCount()).toBe(1);
    expect((await store.listPages()).every((p) => !/POISON/.test(p.body_md))).toBe(true);
    expect(blocks).toHaveLength(1);
    expect(r.blocked[0]).toMatchObject({ stage: "page", slug: "evil" });
    expect((await store.changelog(r.documentId)).map((c) => c.action)).toContain("page_flagged");
  });
});
