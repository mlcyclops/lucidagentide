// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/import_job.ts — P-KG-INGEST.1 (ADR-0076): run a chat-history import as a tracked BACKGROUND
// job so the HTTP request returns immediately, the app stays usable, and the UI can show a live countdown
// + cancel. A single active job at a time (an import is heavy and serialises through one encrypted store);
// a second start is refused rather than racing two writers. Fail-safe: a cancelled/failed run keeps the
// facts already learned (importer saves partial progress) and never leaves a torn write.

import { Snowflake } from "@oh-my-pi/pi-utils";
import type { ImportResult } from "./personal.ts";
import type { ImportProgressTick } from "../harness/personal/importer.ts";

export type ImportJobState = "running" | "done" | "failed" | "cancelled";

export interface ImportJobView {
  jobId: string;
  state: ImportJobState;
  vendor?: string;
  messages: number; totalMessages: number;
  conversations: number; totalConversations: number;
  learned: number; blocked: number;
  startedAt: number; updatedAt: number;
  cancelRequestedAt?: number; // Stop was pressed; the run is unwinding (UI shows "Stopping...")
  result?: ImportResult; // present on done/cancelled (cancelled still carries its partial counts)
  error?: string;        // present on failed
}
interface ImportJob extends ImportJobView { abort: AbortController; cancelTimer?: ReturnType<typeof setTimeout> }

// P-KG-INGEST.5 (ADR-0264): how long Stop waits for the run to unwind before the job is declared
// cancelled anyway. Without this the job stayed "running" forever whenever the run was wedged, and
// single-flight then refused every retry until the app was restarted.
export const CANCEL_GRACE_MS = 15_000;

let active: ImportJob | null = null;

/** The current job's status (jobId-scoped). Null if there is no job, or the id doesn't match. */
export function importJobStatus(jobId?: string): ImportJobView | null {
  if (!active) return null;
  if (jobId && jobId !== active.jobId) return null;
  const { abort: _abort, cancelTimer: _timer, ...view } = active;
  return { ...view };
}

/** Start an import in the background. Returns a jobId immediately; the run is NOT awaited, so the caller
 *  (the HTTP handler) returns at once and the app stays responsive. Refuses if one is already running. */
export function startImport(opts: {
  vendor?: string;
  run: (onTick: (t: ImportProgressTick) => void, signal: AbortSignal) => Promise<ImportResult>;
}): { ok: true; jobId: string } | { ok: false; error: string } {
  if (active && active.state === "running") return { ok: false, error: "An import is already running." };
  const abort = new AbortController();
  const now = Date.now();
  const job: ImportJob = {
    jobId: String(Snowflake.next()), state: "running", vendor: opts.vendor,
    messages: 0, totalMessages: 0, conversations: 0, totalConversations: 0, learned: 0, blocked: 0,
    startedAt: now, updatedAt: now, abort,
  };
  active = job;
  const onTick = (t: ImportProgressTick) => {
    job.messages = t.messages; job.totalMessages = t.totalMessages;
    job.conversations = t.conversations; job.totalConversations = t.totalConversations;
    job.learned = t.learned; job.blocked = t.blocked; job.updatedAt = Date.now();
  };
  void opts.run(onTick, abort.signal).then(
    (result) => {
      clearTimeout(job.cancelTimer);
      job.result = result;
      // A job already declared cancelled (grace elapsed) stays cancelled: it keeps its partial counts
      // and must not flip back to done/failed after the UI moved on.
      if (job.state === "running") job.state = (abort.signal.aborted || result.cancelled) ? "cancelled" : (result.ok ? "done" : "failed");
      if (!result.ok && !job.error) job.error = result.error;
      job.updatedAt = Date.now();
    },
    (e) => {
      clearTimeout(job.cancelTimer);
      if (job.state === "running") job.state = "failed";
      job.error = String((e as Error)?.message ?? e);
      job.updatedAt = Date.now();
    },
  );
  return { ok: true, jobId: job.jobId };
}

/** Request cancellation of the running job. The abort reaches the importer at the next MESSAGE (and
 *  interrupts the in-flight model call), so a healthy run stops in seconds. A wedged run cannot be
 *  awaited forever, so the job is force-cancelled after CANCEL_GRACE_MS regardless, and pressing
 *  Stop while it is already stopping force-cancels immediately. Either way the UI settles and a new
 *  import can start. */
export function cancelImport(jobId?: string): { ok: boolean } {
  if (!active || active.state !== "running") return { ok: false };
  if (jobId && jobId !== active.jobId) return { ok: false };
  const job = active;
  if (job.cancelRequestedAt) { forceCancel(job); return { ok: true }; } // pressed twice: give up on the unwind
  job.cancelRequestedAt = Date.now();
  job.updatedAt = Date.now();
  job.abort.abort();
  const timer = setTimeout(() => forceCancel(job), CANCEL_GRACE_MS);
  timer.unref?.();
  job.cancelTimer = timer;
  return { ok: true };
}

/** Declare the job cancelled even though its run has not settled. The orphaned run stops at its next
 *  abort check and its own save() is a no-op or a partial-fact write, both safe. */
function forceCancel(job: ImportJob): void {
  clearTimeout(job.cancelTimer);
  job.cancelTimer = undefined;
  if (job.state !== "running") return;
  job.state = "cancelled";
  job.updatedAt = Date.now();
}

// Test-only: reset the singleton between cases.
export function __resetImportJob(): void { clearTimeout(active?.cancelTimer); active = null; }
