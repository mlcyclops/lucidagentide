// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Tests for the background-import job registry (P-KG-INGEST.1, ADR-0076).

import { beforeEach, expect, test } from "bun:test";
import { __resetImportJob, cancelImport, importJobStatus, startImport } from "./import_job.ts";
import type { ImportResult } from "./personal.ts";
import type { ImportProgressTick } from "../harness/personal/importer.ts";

const settle = () => new Promise((r) => setTimeout(r, 5));

type Started = { ok: true; jobId: string } | { ok: false; error: string };
/** Narrow the start result instead of casting, so a refused start fails the test loudly. */
function jobIdOf(started: Started): string {
  if (!started.ok) throw new Error(`expected the import to start, got: ${started.error}`);
  return started.jobId;
}
/** Flush microtasks so the job's settle handler has run. Deterministic: no wall-clock wait. */
const flush = async (): Promise<void> => { for (let i = 0; i < 4; i++) await Promise.resolve(); };
/** A run that never settles and ignores its abort signal, i.e. the wedged import this fix is about. */
const wedged = (_onTick: (t: ImportProgressTick) => void, _signal: AbortSignal): Promise<ImportResult> => new Promise(() => {});
beforeEach(() => __resetImportJob());

test("start returns a jobId, reports running with live counts, then done", async () => {
  let finish!: (v: unknown) => void;
  const started = startImport({
    vendor: "openai",
    run: (onTick) => new Promise((res) => { finish = res; onTick({ conversations: 0, totalConversations: 2, messages: 1, totalMessages: 4, learned: 1, blocked: 0 }); }),
  });
  expect(started.ok).toBe(true);
  const jobId = (started as { jobId: string }).jobId;
  let st = importJobStatus(jobId)!;
  expect(st.state).toBe("running");
  expect(st.totalMessages).toBe(4);
  expect(st.learned).toBe(1);
  finish({ ok: true, learned: 3, messages: 4, conversations: 2 });
  await settle();
  st = importJobStatus(jobId)!;
  expect(st.state).toBe("done");
  expect(st.result?.learned).toBe(3);
});

test("a second start is refused while one is running (no two writers)", () => {
  startImport({ run: () => new Promise(() => {}) }); // never settles
  const second = startImport({ run: async () => ({ ok: true }) });
  expect(second.ok).toBe(false);
  if (!second.ok) expect(second.error).toContain("already running");
});

test("cancel aborts the run; the result is marked cancelled", async () => {
  let sawAbort = false;
  const started = startImport({
    run: (_onTick, signal) => new Promise((res) => signal.addEventListener("abort", () => { sawAbort = true; res({ ok: true, cancelled: true, learned: 1 }); })),
  });
  const jobId = (started as { jobId: string }).jobId;
  expect(cancelImport(jobId).ok).toBe(true);
  await settle();
  expect(sawAbort).toBe(true);
  expect(importJobStatus(jobId)!.state).toBe("cancelled");
});

// ── P-KG-INGEST.5 (ADR-0264): Stop must always terminate, even when the run itself is wedged ──

test("cancel marks the job stopping and stays running while it unwinds", () => {
  const jobId = jobIdOf(startImport({ run: wedged }));
  expect(cancelImport(jobId).ok).toBe(true);
  const st = importJobStatus(jobId)!;
  expect(st.state).toBe("running");           // still unwinding, not yet terminal
  expect(st.cancelRequestedAt).toBeGreaterThan(0); // the UI reads this to show "Stopping"
});

test("pressing Stop twice force-cancels a run that ignores its abort signal", () => {
  const jobId = jobIdOf(startImport({ run: wedged }));
  cancelImport(jobId);
  expect(importJobStatus(jobId)!.state).toBe("running");
  cancelImport(jobId); // second press: stop waiting for the unwind
  expect(importJobStatus(jobId)!.state).toBe("cancelled");
});

test("a force-cancelled job releases single-flight so the user can retry", async () => {
  const first = jobIdOf(startImport({ run: wedged }));
  cancelImport(first);
  cancelImport(first);
  const second = startImport({ run: async () => ({ ok: true, learned: 0 }) });
  expect(second.ok).toBe(true); // before the fix this stayed refused until app restart
  await flush();
  expect(importJobStatus(jobIdOf(second))!.state).toBe("done");
});

test("a late result cannot resurrect a job the user already force-cancelled", async () => {
  let finish!: (v: ImportResult) => void;
  const jobId = jobIdOf(startImport({ run: () => new Promise<ImportResult>((res) => { finish = res; }) }));
  cancelImport(jobId);
  cancelImport(jobId);
  expect(importJobStatus(jobId)!.state).toBe("cancelled");
  finish({ ok: true, learned: 9 });
  await flush();
  const st = importJobStatus(jobId)!;
  expect(st.state).toBe("cancelled"); // stays terminal
  expect(st.result?.learned).toBe(9); // but the partial facts are still reported
});

test("status is jobId-scoped (a stale/foreign id sees nothing)", () => {
  const started = startImport({ run: () => new Promise(() => {}) });
  expect(importJobStatus("not-the-job")).toBeNull();
  expect(importJobStatus((started as { jobId: string }).jobId)!.state).toBe("running");
});

test("a throwing run is reported as failed with the message", async () => {
  const started = startImport({ run: async () => { throw new Error("boom"); } });
  await settle();
  const st = importJobStatus((started as { jobId: string }).jobId)!;
  expect(st.state).toBe("failed");
  expect(st.error).toContain("boom");
});
