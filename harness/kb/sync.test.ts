// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/kb/sync.test.ts — P-KB.2 (ADR-0100): the "kept in sync" generator. Asserts idempotency on an
// unchanged sha256, a changelog entry + re-compile on a changed source, a CONTRADICTION flag when a slug's
// body changes (prior page retained, not overwritten), and that a changed-but-poisoned source still
// quarantines (sync writes only through the gated ingest path).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScannerClient } from "../security/scanner_client.ts";
import { KbGraphStore } from "./store.ts";
import { syncDocument } from "./sync.ts";

const fakeScanner = (findings: (t: string) => unknown[]): ScannerClient =>
  ({ scan: async (t: string) => ({ findings: findings(t) }) }) as unknown as ScannerClient;
const cleanScanner = fakeScanner(() => []);
const poisonScanner = fakeScanner((t) => (/POISON/.test(t) ? [{ severity: "high", finding_type: "zero-width" }] : []));

const modelV1 = async (): Promise<string> => JSON.stringify({ pages: [{ kind: "summary", slug: "doc", title: "Doc", body_md: "version one of the document" }], links: [] });
const modelV2 = async (): Promise<string> => JSON.stringify({ pages: [{ kind: "summary", slug: "doc", title: "Doc", body_md: "version TWO — the fact changed" }], links: [] });

describe("syncDocument", () => {
  let dir: string;
  let store: KbGraphStore;
  beforeEach(async () => { dir = mkdtempSync(join(tmpdir(), "kb-sync-")); store = await KbGraphStore.open(join(dir, "kb_graph.duckdb")); });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  test("a new source compiles and records a resynced changelog entry", async () => {
    const r = await syncDocument({ store, scanner: cleanScanner, complete: modelV1, sourcePath: "d.md", title: "D", text: "the original text" });
    expect(r.changed).toBe(true);
    expect(r.ingest?.status).toBe("compiled");
    expect(await store.pageCount()).toBe(1);
    expect((await store.changelog(r.documentId!)).map((c) => c.action)).toContain("resynced");
  });

  test("re-syncing UNCHANGED bytes is idempotent — no-op, no duplicate pages", async () => {
    await syncDocument({ store, scanner: cleanScanner, complete: modelV1, sourcePath: "d.md", title: "D", text: "the original text" });
    const again = await syncDocument({ store, scanner: cleanScanner, complete: modelV1, sourcePath: "d.md", title: "D", text: "the original text" });
    expect(again.changed).toBe(false);
    expect(again.reason).toContain("unchanged");
    expect(await store.pageCount()).toBe(1); // no second compile
  });

  test("a CHANGED source re-compiles + flags a contradiction; the prior page is retained", async () => {
    await syncDocument({ store, scanner: cleanScanner, complete: modelV1, sourcePath: "d.md", title: "D", text: "the original text" });
    const r = await syncDocument({ store, scanner: cleanScanner, complete: modelV2, sourcePath: "d.md", title: "D", text: "the CHANGED text" });
    expect(r.changed).toBe(true);
    expect(r.contradictions).toEqual([{ slug: "doc" }]);
    expect(await store.pageCount()).toBe(2); // both versions retained
    expect((await store.changelog(r.documentId!)).map((c) => c.action)).toContain("contradiction");
  });

  test("a changed-but-POISONED source still quarantines (sync writes only via the gated path)", async () => {
    await syncDocument({ store, scanner: cleanScanner, complete: modelV1, sourcePath: "d.md", title: "D", text: "the original text" });
    const r = await syncDocument({ store, scanner: poisonScanner, complete: modelV2, sourcePath: "d.md", title: "D", text: "now the source hides POISON" });
    expect(r.changed).toBe(true);
    expect(r.ingest?.status).toBe("quarantined");
    expect(r.contradictions).toEqual([]);
    expect(await store.pageCount()).toBe(1); // only the original clean page; nothing new compiled
  });
});
