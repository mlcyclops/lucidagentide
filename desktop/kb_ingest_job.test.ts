// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/kb_ingest_job.test.ts — P-KGPACK.6 (ADR-0205): the background KG-seed job. Pins the state machine:
// a start returns a jobId and goes `running`, ticks advance the live counts, a SECOND start is refused while
// one runs, cancel drives the run to `cancelled` (keeping partial counts), a thrown run goes `failed` with
// its message, the final counts are reconciled from the authoritative result, and status is jobId-scoped.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { KbBatchProgress } from "../harness/kb/batch_ingest.ts";
import { startKbIngest, kbIngestJobStatus, cancelKbIngest, __resetKbIngestJob, type KbIngestJobResult } from "./kb_ingest_job.ts";

const flush = () => new Promise((r) => setTimeout(r, 10));
const tick = (over: Partial<KbBatchProgress> = {}): KbBatchProgress => ({ documents: 0, totalDocuments: 0, pagesCompiled: 0, pagesQuarantined: 0, documentsQuarantined: 0, errored: 0, ...over });
const result = (over: Partial<KbIngestJobResult> = {}): KbIngestJobResult => ({
  documents: 2, totalDocuments: 2, available: 2, skipped: 0, pagesCompiled: 4, pagesQuarantined: 0, documentsQuarantined: 0, errored: 0, links: 2, cancelled: false,
  kgId: "kg1", kgName: "Proposal Manager", kind: "chat", vendor: "openai", ...over,
});

describe("kb_ingest_job", () => {
  beforeEach(() => __resetKbIngestJob());
  afterEach(() => __resetKbIngestJob());

  test("start returns a jobId and reports running with live ticks; a second start is refused", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const s = startKbIngest({ kgId: "kg1", kgName: "Proposal Manager", run: async (onTick) => { onTick(tick({ documents: 1, totalDocuments: 3, pagesCompiled: 2 })); await gate; return result({ documents: 3, totalDocuments: 3, pagesCompiled: 6 }); } });
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    await flush();
    const v = kbIngestJobStatus(s.jobId)!;
    expect(v.state).toBe("running");
    expect(v.documents).toBe(1);
    expect(v.totalDocuments).toBe(3);

    const second = startKbIngest({ kgId: "kg2", kgName: "Other", run: async () => result() });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toMatch(/already running/);

    release();
    await flush();
    const done = kbIngestJobStatus(s.jobId)!;
    expect(done.state).toBe("done");
    expect(done.pagesCompiled).toBe(6);           // reconciled from the result
    expect(done.result?.kgName).toBe("Proposal Manager");
  });

  test("cancel drives the run to cancelled, keeping partial counts", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const s = startKbIngest({ kgId: "kg1", kgName: "KG", run: async (onTick, signal) => { onTick(tick({ documents: 1, totalDocuments: 5, pagesCompiled: 2 })); await gate; return result({ documents: 1, pagesCompiled: 2, cancelled: signal.aborted }); } });
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    await flush();
    expect(cancelKbIngest(s.jobId).ok).toBe(true);
    release();
    await flush();
    const v = kbIngestJobStatus(s.jobId)!;
    expect(v.state).toBe("cancelled");
    expect(v.pagesCompiled).toBe(2); // partial progress preserved
  });

  test("a thrown run goes failed with its message", async () => {
    const s = startKbIngest({ kgId: "kg1", kgName: "KG", run: async () => { throw new Error("backend outage"); } });
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    await flush();
    const v = kbIngestJobStatus(s.jobId)!;
    expect(v.state).toBe("failed");
    expect(v.error).toContain("backend outage");
  });

  test("status is jobId-scoped; cancel with no job is a no-op", () => {
    expect(kbIngestJobStatus()).toBeNull();
    expect(cancelKbIngest("nope").ok).toBe(false);
    const s = startKbIngest({ kgId: "kg1", kgName: "KG", run: async () => result() });
    if (!s.ok) return;
    expect(kbIngestJobStatus("wrong-id")).toBeNull();
    expect(kbIngestJobStatus(s.jobId)?.jobId).toBe(s.jobId);
    expect(kbIngestJobStatus()?.jobId).toBe(s.jobId);
  });
});
