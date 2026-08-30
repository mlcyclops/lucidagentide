// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, test } from "bun:test";
import {
  JOB_HISTORY_MAX, canTransition, createJob, finishJob, foldJobs, jobDurationMs, jobStats, jobsLedger,
  listJobs, recordJobArtifact, requestJobCancel, startJob, type JobAdmissionSnapshot, type JobIo,
} from "./creator_jobs.ts";

function fakeIo(): JobIo & { ledger(): string; raw: Record<string, string> } {
  let seq = 0;
  let clock = 1_700_000_000_000;
  const raw: Record<string, string> = {};
  return {
    raw,
    ledger: () => raw[jobsLedger("/creator")] ?? "",
    ensureDir: () => {},
    readText: (p) => raw[p] ?? "",
    appendLine: (p, line) => { raw[p] = (raw[p] ?? "") + line + "\n"; },
    now: () => (clock += 1000),
    id: () => `job${++seq}`,
  };
}
const admitted: JobAdmissionSnapshot = { ok: true, cpuPct: 22, memPct: 40, gpuPct: 15, vramPct: 30, gpuEvidenceMissing: false, reason: "" };
const refusedAdmission: JobAdmissionSnapshot = { ok: false, cpuPct: 97, memPct: 94, gpuPct: null, vramPct: null, gpuEvidenceMissing: true, reason: "system memory has been at 94% for 42s" };

describe("the job state machine (CREATOR-1, ADR-0292)", () => {
  test("only legal transitions exist, and a settled job is final", () => {
    expect(canTransition("queued", "running")).toBe(true);
    expect(canTransition("running", "done")).toBe(true);
    expect(canTransition("running", "cancelled")).toBe(true);
    expect(canTransition("queued", "done")).toBe(false); // a job cannot finish without running
    expect(canTransition("done", "running")).toBe(false);
    expect(canTransition("failed", "done")).toBe(false);
    expect(canTransition("refused", "running")).toBe(false);
  });

  test("a job runs, records artifacts, and settles with a duration", () => {
    const io = fakeIo();
    const job = createJob(io, "/creator", { kind: "image", label: "neon alley", provider: "comfyui", admission: admitted });
    expect(job.state).toBe("queued");
    expect(startJob(io, "/creator", job.id, admitted)).toBe(true);
    expect(recordJobArtifact(io, "/creator", job.id, "art_1")).toBe(true);
    expect(recordJobArtifact(io, "/creator", job.id, "art_2")).toBe(true);
    expect(finishJob(io, "/creator", job.id, "done")).toBe(true);
    const [settled] = listJobs(io, "/creator");
    expect(settled).toMatchObject({ state: "done", provider: "comfyui", label: "neon alley" });
    expect(settled!.artifacts).toEqual(["art_1", "art_2"]);
    expect(jobDurationMs(settled!, 0)).toBeGreaterThan(0);
  });

  test("the admission snapshot is recorded, so 'why did this run' is answerable later", () => {
    const io = fakeIo();
    const job = createJob(io, "/creator", { kind: "gif", label: "walk cycle", admission: admitted });
    startJob(io, "/creator", job.id, admitted);
    const [live] = listJobs(io, "/creator");
    expect(live!.admission).toMatchObject({ ok: true, cpuPct: 22, gpuPct: 15 });
  });

  test("a REFUSED admission is written as a job, not silently dropped", () => {
    const io = fakeIo();
    const job = createJob(io, "/creator", { kind: "render", label: "a diffusion batch", admission: refusedAdmission });
    expect(job.state).toBe("refused");
    expect(job.error).toContain("94% for 42s");
    expect(job.endedAt).not.toBeNull();
    expect(startJob(io, "/creator", job.id)).toBe(false); // a refusal cannot be started
    expect(listJobs(io, "/creator")[0]!.state).toBe("refused");
  });

  test("a late runner cannot overwrite a settled outcome", () => {
    const io = fakeIo();
    const job = createJob(io, "/creator", { kind: "sheet", label: "sprite" });
    startJob(io, "/creator", job.id);
    expect(finishJob(io, "/creator", job.id, "failed", "encoder said no")).toBe(true);
    expect(finishJob(io, "/creator", job.id, "done")).toBe(false);
    const [j] = listJobs(io, "/creator");
    expect(j).toMatchObject({ state: "failed", error: "encoder said no" });
  });

  test("cancel is a REQUEST: the state changes only when the runner confirms", () => {
    const io = fakeIo();
    const job = createJob(io, "/creator", { kind: "image", label: "slow render" });
    startJob(io, "/creator", job.id);
    expect(requestJobCancel(io, "/creator", job.id).ok).toBe(true);
    const mid = listJobs(io, "/creator")[0]!;
    expect(mid.cancelRequested).toBe(true);
    expect(mid.state).toBe("running"); // NOT cancelled yet - claiming otherwise would be a lie
    expect(finishJob(io, "/creator", job.id, "cancelled")).toBe(true);
    expect(listJobs(io, "/creator")[0]!.state).toBe("cancelled");
    expect(requestJobCancel(io, "/creator", job.id).error).toContain("already cancelled");
    expect(requestJobCancel(io, "/creator", "ghost").error).toContain("not in the ledger");
  });

  test("a queued job can be cancelled before it ever starts", () => {
    const io = fakeIo();
    const job = createJob(io, "/creator", { kind: "build", label: "cook" });
    expect(requestJobCancel(io, "/creator", job.id).ok).toBe(true);
    expect(finishJob(io, "/creator", job.id, "cancelled")).toBe(true);
    expect(listJobs(io, "/creator")[0]!.state).toBe("cancelled");
  });
});

describe("the ledger is append-only and damage-tolerant", () => {
  test("a torn tail or an unknown op costs one record, never the ledger", () => {
    const io = fakeIo();
    const a = createJob(io, "/creator", { kind: "image", label: "one" });
    createJob(io, "/creator", { kind: "gif", label: "two" });
    const folded = foldJobs(io.ledger() + '{"op":"create","at":1,"id":"x","jo\n' + '{"op":"frobnicate","at":2,"id":"y"}\n' + "garbage\n");
    expect(folded).toHaveLength(2);
    expect(folded.some((j) => j.id === a.id)).toBe(true);
  });

  test("an op for an unknown job id is ignored", () => {
    expect(foldJobs('{"op":"start","at":1,"id":"ghost"}')).toEqual([]);
    expect(foldJobs("")).toEqual([]);
  });

  test("an illegal transition in the LEDGER is skipped on fold, not applied", () => {
    const io = fakeIo();
    const job = createJob(io, "/creator", { kind: "image", label: "one" });
    // Two finishes, hand-appended: only the first can win.
    io.appendLine(jobsLedger("/creator"), JSON.stringify({ op: "start", at: 2, id: job.id }));
    io.appendLine(jobsLedger("/creator"), JSON.stringify({ op: "finish", at: 3, id: job.id, state: "done" }));
    io.appendLine(jobsLedger("/creator"), JSON.stringify({ op: "finish", at: 4, id: job.id, state: "failed", error: "late" }));
    const [j] = foldJobs(io.ledger());
    expect(j).toMatchObject({ state: "done", error: "" });
  });

  test("history is bounded and newest first", () => {
    const io = fakeIo();
    for (let i = 0; i < JOB_HISTORY_MAX + 25; i++) createJob(io, "/creator", { kind: "image", label: `job ${i}` });
    const jobs = listJobs(io, "/creator");
    expect(jobs).toHaveLength(JOB_HISTORY_MAX);
    expect(jobs[0]!.label).toBe(`job ${JOB_HISTORY_MAX + 24}`);
  });

  test("stats separate active work from settled outcomes", () => {
    const io = fakeIo();
    const running = createJob(io, "/creator", { kind: "image", label: "live" });
    startJob(io, "/creator", running.id);
    const okJob = createJob(io, "/creator", { kind: "gif", label: "ok" });
    startJob(io, "/creator", okJob.id);
    finishJob(io, "/creator", okJob.id, "done");
    const badJob = createJob(io, "/creator", { kind: "sheet", label: "bad" });
    startJob(io, "/creator", badJob.id);
    finishJob(io, "/creator", badJob.id, "failed", "nope");
    createJob(io, "/creator", { kind: "render", label: "refused", admission: refusedAdmission });
    expect(jobStats(listJobs(io, "/creator"))).toEqual({ total: 4, active: 1, done: 1, failed: 1, refused: 1 });
  });

  test("duration is null until a job starts, and freezes when it ends", () => {
    const io = fakeIo();
    const job = createJob(io, "/creator", { kind: "image", label: "x" });
    expect(jobDurationMs(listJobs(io, "/creator")[0]!, 9_999_999_999_999)).toBeNull();
    startJob(io, "/creator", job.id);
    const live = listJobs(io, "/creator")[0]!;
    expect(jobDurationMs(live, live.startedAt! + 5000)).toBe(5000);
    finishJob(io, "/creator", job.id, "done");
    const settled = listJobs(io, "/creator")[0]!;
    expect(jobDurationMs(settled, 9_999_999_999_999)).toBe(settled.endedAt! - settled.startedAt!);
  });
});
