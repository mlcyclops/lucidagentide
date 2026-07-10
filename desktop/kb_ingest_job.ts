// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/kb_ingest_job.ts — P-KGPACK.6 (ADR-0205): run a KG batch-seed as a tracked BACKGROUND job.
//
// Authoring a real role pack means compiling HUNDREDS of conversations (one model call each) - too long to
// hold an HTTP request open, and the old /api/kb/ingest-batch capped at 50 to avoid exactly that. This lifts
// the cap: the seed runs in the background (no cap - author the whole dataset), the request returns a jobId
// at once, and the UI polls a live count + can cancel. A single active job at a time (a seed is heavy and
// serialises through one KG store); a second start is refused rather than racing two writers. Fail-safe: a
// cancelled/failed run keeps the pages already compiled (ingestSourcesIntoKg persists per document).
//
// This mirrors desktop/import_job.ts (the personal-graph import job) with a KB-shaped progress/result.

import { Snowflake } from "@oh-my-pi/pi-utils";
import type { KbBatchProgress, KbBatchResult } from "../harness/kb/batch_ingest.ts";

export type KbIngestJobState = "running" | "done" | "failed" | "cancelled";

/** The batch result plus which KG it seeded + where the sources came from. */
export interface KbIngestJobResult extends KbBatchResult { kgId: string; kgName: string; kind: string; vendor: string | null }

export interface KbIngestJobView {
  jobId: string;
  state: KbIngestJobState;
  kgId: string;
  kgName: string;
  documents: number; totalDocuments: number;
  pagesCompiled: number; pagesQuarantined: number; documentsQuarantined: number; errored: number;
  startedAt: number; updatedAt: number;
  result?: KbIngestJobResult; // present on done/cancelled (cancelled still carries its partial counts)
  error?: string;             // present on failed
}
interface KbIngestJob extends KbIngestJobView { abort: AbortController }

let active: KbIngestJob | null = null;

/** The current job's status (jobId-scoped). Null if there is no job, or the id doesn't match. */
export function kbIngestJobStatus(jobId?: string): KbIngestJobView | null {
  if (!active) return null;
  if (jobId && jobId !== active.jobId) return null;
  const { abort: _abort, ...view } = active;
  return { ...view };
}

/** Start a KG seed in the background. Returns a jobId immediately; the run is NOT awaited, so the HTTP
 *  handler returns at once and the app stays responsive. Refuses if one is already running. */
export function startKbIngest(opts: {
  kgId: string; kgName: string;
  run: (onTick: (t: KbBatchProgress) => void, signal: AbortSignal) => Promise<KbIngestJobResult>;
}): { ok: true; jobId: string } | { ok: false; error: string } {
  if (active && active.state === "running") return { ok: false, error: "A knowledge-graph import is already running." };
  const abort = new AbortController();
  const now = Date.now();
  const job: KbIngestJob = {
    jobId: String(Snowflake.next()), state: "running", kgId: opts.kgId, kgName: opts.kgName,
    documents: 0, totalDocuments: 0, pagesCompiled: 0, pagesQuarantined: 0, documentsQuarantined: 0, errored: 0,
    startedAt: now, updatedAt: now, abort,
  };
  active = job;
  const onTick = (t: KbBatchProgress) => {
    job.documents = t.documents; job.totalDocuments = t.totalDocuments;
    job.pagesCompiled = t.pagesCompiled; job.pagesQuarantined = t.pagesQuarantined;
    job.documentsQuarantined = t.documentsQuarantined; job.errored = t.errored;
    job.updatedAt = Date.now();
  };
  void opts.run(onTick, abort.signal).then(
    (result) => {
      job.result = result;
      job.state = (abort.signal.aborted || result.cancelled) ? "cancelled" : "done";
      // reconcile the final counts from the authoritative result
      job.documents = result.documents; job.totalDocuments = result.totalDocuments;
      job.pagesCompiled = result.pagesCompiled; job.pagesQuarantined = result.pagesQuarantined;
      job.documentsQuarantined = result.documentsQuarantined; job.errored = result.errored;
      job.updatedAt = Date.now();
    },
    (e) => { job.state = "failed"; if (!job.error) job.error = String((e as Error)?.message ?? e); job.updatedAt = Date.now(); },
  );
  return { ok: true, jobId: job.jobId };
}

/** Request cancellation of the running job (cancels at the next document boundary). */
export function cancelKbIngest(jobId?: string): { ok: boolean } {
  if (!active || active.state !== "running") return { ok: false };
  if (jobId && jobId !== active.jobId) return { ok: false };
  active.abort.abort();
  return { ok: true };
}

// Test-only: reset the singleton between cases.
export function __resetKbIngestJob(): void { active = null; }
