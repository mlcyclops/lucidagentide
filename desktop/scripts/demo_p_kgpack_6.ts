// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_kgpack_6.ts — P-KGPACK.6 (ADR-0205): the background KG-seed job (cap lifted).
//
// Authoring a real role pack means compiling HUNDREDS of conversations; the old route capped at 50. This runs
// a 120-document seed (well past the old cap) as a background job and polls it to completion - proving all
// 120 compile (no cap), the live counts advance, and the final result is reconciled. Model + scanner are
// injected fakes (instant + deterministic); the gate itself is exercised for real in demo-P-KGPACK.3/.4.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScannerClient } from "../../harness/security/scanner_client.ts";
import { KbGraphStore } from "../../harness/kb/store.ts";
import { ingestSourcesIntoKg, type KbSourceDoc } from "../../harness/kb/batch_ingest.ts";
import { startKbIngest, kbIngestJobStatus, __resetKbIngestJob } from "../kb_ingest_job.ts";

function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(`ASSERT FAILED: ${msg}`); }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const cleanScanner = ({ scan: async () => ({ findings: [] }) }) as unknown as ScannerClient;
let n = 0;
const model = async (): Promise<string> => { const k = n++; return JSON.stringify({ pages: [{ kind: "summary", slug: `s-${k}`, title: "S", body_md: `body ${k}` }, { kind: "concept", slug: `c-${k}`, title: "C", body_md: `concept ${k}` }], links: [{ from: `s-${k}`, to: `c-${k}`, relation: "explains" }] }); };
const docs: KbSourceDoc[] = Array.from({ length: 120 }, (_, i) => ({ sourcePath: `chat:openai#${i}`, title: `Conversation ${i}`, text: `A synthetic proposal-ops conversation number ${i}.` }));

const dir = mkdtempSync(join(tmpdir(), "kgpack6-"));

try {
  __resetKbIngestJob();
  const store = await KbGraphStore.open(join(dir, "kg.duckdb"));

  console.log("== start a 120-document background seed (old cap was 50) ==");
  const started = startKbIngest({
    kgId: "demo-kg", kgName: "Senior Proposal Manager",
    run: (onTick, signal) => ingestSourcesIntoKg({ store, scanner: cleanScanner, complete: model, docs, onProgress: onTick, signal })
      .then((r) => ({ ...r, kgId: "demo-kg", kgName: "Senior Proposal Manager", kind: "chat", vendor: "openai" as string | null })),
  });
  assert(started.ok, "job started");
  if (!started.ok) throw new Error("unreachable");

  let last = 0;
  for (;;) {
    const st = kbIngestJobStatus(started.jobId)!;
    if (st.documents !== last) { last = st.documents; if (last % 40 === 0 || last === st.totalDocuments) console.log(`   ${st.documents}/${st.totalDocuments} sources · ${st.pagesCompiled} pages`); }
    if (st.state !== "running") break;
    await sleep(15);
  }

  const done = kbIngestJobStatus(started.jobId)!;
  assert(done.state === "done", `job finished (state=${done.state})`);
  assert(done.result!.documents === 120, `all 120 documents compiled - NO cap (got ${done.result!.documents})`);
  assert(done.result!.skipped === 0, `nothing skipped (cap lifted) (got ${done.result!.skipped})`);
  assert(done.result!.pagesCompiled === 240, `2 pages per doc = 240 (got ${done.result!.pagesCompiled})`);
  assert((await store.pageCount()) === 240, "the store holds all 240 pages");
  store.close();
  console.log(`   DONE: ${done.result!.documents} sources → ${done.result!.pagesCompiled} pages, 0 skipped (the old 50-doc cap is gone)`);

  console.log("== demo-P-KGPACK.6 OK ==");
} finally {
  __resetKbIngestJob();
  rmSync(dir, { recursive: true, force: true });
}
