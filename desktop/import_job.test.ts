// Tests for the background-import job registry (P-KG-INGEST.1, ADR-0076).

import { beforeEach, expect, test } from "bun:test";
import { __resetImportJob, cancelImport, importJobStatus, startImport } from "./import_job.ts";

const settle = () => new Promise((r) => setTimeout(r, 5));
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
