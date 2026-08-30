// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/creator_jobs.ts - CREATOR-1 (ADR-0292): the durable Creator job ledger.
//
// Creative work is long: a diffusion batch, a Blender frame range, a cook. Before this, a Creator action was
// a fetch that either returned or did not, with nothing to look at while it ran and nothing to read after it
// failed. The job spine fixes that with the same discipline as every other ledger in this repo:
//
//   * APPEND-ONLY JSONL under the Creator data root. A torn tail costs one record, never the ledger.
//   * A closed state machine with legal transitions only, so a job cannot go from done back to running.
//   * The ADMISSION SNAPSHOT is recorded at start (the measured CPU, memory, GPU, and the policy that let it
//     through), so "why did this run when the box was busy" is answerable after the fact.
//   * Cancellation is a REQUEST plus an observed end. `cancelRequested` is recorded immediately; the job is
//     only `cancelled` once the runner confirms it stopped, because claiming otherwise would be a lie.
//
// Pure fold + guarded operations over injected IO, so the state machine is unit-testable with no disk.

export type CreatorJobKind = "probe" | "image" | "sheet" | "gif" | "meme" | "render" | "build" | "test";
export const CREATOR_JOB_KINDS: readonly CreatorJobKind[] = ["probe", "image", "sheet", "gif", "meme", "render", "build", "test"] as const;

export type CreatorJobState = "queued" | "running" | "done" | "failed" | "cancelled" | "refused";
export const CREATOR_JOB_STATES: readonly CreatorJobState[] = ["queued", "running", "done", "failed", "cancelled", "refused"] as const;

/** What the resource governor measured at the moment this job was admitted (or refused). */
export interface JobAdmissionSnapshot {
  readonly ok: boolean;
  readonly cpuPct: number | null;
  readonly memPct: number | null;
  readonly gpuPct: number | null;
  readonly vramPct: number | null;
  readonly gpuEvidenceMissing: boolean;
  readonly reason: string;
}

export interface CreatorJob {
  readonly id: string;
  readonly kind: CreatorJobKind;
  readonly state: CreatorJobState;
  /** One line the user reads in the list: "sdxl_base.safetensors - neon alley". */
  readonly label: string;
  readonly provider: string;
  readonly createdAt: number;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  /** Set the moment a cancel is requested; the state only changes when the runner confirms. */
  readonly cancelRequested: boolean;
  readonly error: string;
  /** Artifact ids this job produced. */
  readonly artifacts: readonly string[];
  readonly admission: JobAdmissionSnapshot | null;
}

export interface JobIo {
  ensureDir(dir: string): void;
  /** "" when the file does not exist - a fresh ledger folds to empty, not an error. */
  readText(path: string): string;
  appendLine(path: string, line: string): void;
  now(): number;
  id(): string;
}

const join = (...parts: string[]): string => parts.join("/").replace(/\/{2,}/g, "/");
export const jobsDir = (base: string): string => join(base, "jobs");
export const jobsLedger = (base: string): string => join(jobsDir(base), "jobs.jsonl");

/** Bounded history: the newest N jobs are what a human reads; older rows stay on disk but are not folded. */
export const JOB_HISTORY_MAX = 200;

/** Legal transitions. Anything absent here is refused, so a late runner cannot resurrect a settled job. */
const LEGAL: Record<CreatorJobState, readonly CreatorJobState[]> = {
  queued: ["running", "cancelled", "failed", "refused"],
  running: ["done", "failed", "cancelled"],
  done: [],
  failed: [],
  cancelled: [],
  refused: [],
};

export function canTransition(from: CreatorJobState, to: CreatorJobState): boolean {
  return (LEGAL[from] ?? []).includes(to);
}

interface JobRecord {
  op: "create" | "start" | "finish" | "cancel-request" | "artifact";
  at: number;
  id: string;
  job?: CreatorJob;
  state?: CreatorJobState;
  error?: string;
  artifact?: string;
  admission?: JobAdmissionSnapshot;
}

/** Fold the ledger into live jobs, newest first. Illegal transitions and torn lines are skipped. */
export function foldJobs(jsonl: string): CreatorJob[] {
  const byId = new Map<string, CreatorJob>();
  for (const line of (jsonl ?? "").split("\n")) {
    const raw = line.trim();
    if (!raw) continue;
    let rec: JobRecord | null = null;
    try { rec = JSON.parse(raw) as JobRecord; } catch { continue; }
    if (!rec || typeof rec.op !== "string" || typeof rec.id !== "string") continue;
    if (rec.op === "create") {
      if (rec.job && typeof rec.job.id === "string") byId.set(rec.job.id, { ...rec.job, artifacts: [...(rec.job.artifacts ?? [])] });
      continue;
    }
    const cur = byId.get(rec.id);
    if (!cur) continue;
    if (rec.op === "start") {
      if (!canTransition(cur.state, "running")) continue;
      byId.set(cur.id, { ...cur, state: "running", startedAt: rec.at, admission: rec.admission ?? cur.admission });
      continue;
    }
    if (rec.op === "cancel-request") {
      byId.set(cur.id, { ...cur, cancelRequested: true });
      continue;
    }
    if (rec.op === "artifact") {
      if (!rec.artifact) continue;
      byId.set(cur.id, { ...cur, artifacts: [...cur.artifacts, rec.artifact] });
      continue;
    }
    if (rec.op === "finish") {
      const to = rec.state;
      if (!to || !canTransition(cur.state, to)) continue;
      byId.set(cur.id, { ...cur, state: to, endedAt: rec.at, error: rec.error ?? "" });
    }
  }
  return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, JOB_HISTORY_MAX);
}

export interface CreateJobInput {
  readonly kind: CreatorJobKind;
  readonly label: string;
  readonly provider?: string;
  /** The governor's verdict. `ok:false` records the job as REFUSED, so a refusal is auditable too. */
  readonly admission?: JobAdmissionSnapshot;
}

/** Record a new job. A refused admission is written as a `refused` job rather than silently dropped: the
 *  user asked for work, and the ledger should say why it did not happen. */
export function createJob(io: JobIo, base: string, input: CreateJobInput): CreatorJob {
  const at = io.now();
  const refused = !!input.admission && !input.admission.ok;
  const job: CreatorJob = {
    id: io.id(),
    kind: CREATOR_JOB_KINDS.includes(input.kind) ? input.kind : "image",
    state: refused ? "refused" : "queued",
    label: (input.label ?? "").slice(0, 200),
    provider: (input.provider ?? "local").slice(0, 40),
    createdAt: at,
    startedAt: null,
    endedAt: refused ? at : null,
    cancelRequested: false,
    error: refused ? input.admission!.reason : "",
    artifacts: [],
    admission: input.admission ?? null,
  };
  io.ensureDir(jobsDir(base));
  io.appendLine(jobsLedger(base), JSON.stringify({ op: "create", at, id: job.id, job }));
  return job;
}

export function startJob(io: JobIo, base: string, id: string, admission?: JobAdmissionSnapshot): boolean {
  const cur = foldJobs(io.readText(jobsLedger(base))).find((j) => j.id === id);
  if (!cur || !canTransition(cur.state, "running")) return false;
  io.appendLine(jobsLedger(base), JSON.stringify({ op: "start", at: io.now(), id, admission }));
  return true;
}

export function recordJobArtifact(io: JobIo, base: string, id: string, artifactId: string): boolean {
  const cur = foldJobs(io.readText(jobsLedger(base))).find((j) => j.id === id);
  if (!cur || !artifactId) return false;
  io.appendLine(jobsLedger(base), JSON.stringify({ op: "artifact", at: io.now(), id, artifact: artifactId }));
  return true;
}

/** Settle a job. An illegal transition is refused so a slow runner cannot overwrite a settled outcome. */
export function finishJob(io: JobIo, base: string, id: string, state: "done" | "failed" | "cancelled", error = ""): boolean {
  const cur = foldJobs(io.readText(jobsLedger(base))).find((j) => j.id === id);
  if (!cur || !canTransition(cur.state, state)) return false;
  io.appendLine(jobsLedger(base), JSON.stringify({ op: "finish", at: io.now(), id, state, error: error.slice(0, 500) }));
  return true;
}

/** Ask a running job to stop. The state does NOT change here: only the runner's confirmation settles it. */
export function requestJobCancel(io: JobIo, base: string, id: string): { ok: boolean; error?: string } {
  const cur = foldJobs(io.readText(jobsLedger(base))).find((j) => j.id === id);
  if (!cur) return { ok: false, error: "That job is not in the ledger." };
  if (cur.state !== "queued" && cur.state !== "running") return { ok: false, error: `That job already ${cur.state}.` };
  io.appendLine(jobsLedger(base), JSON.stringify({ op: "cancel-request", at: io.now(), id }));
  return { ok: true };
}

export function listJobs(io: JobIo, base: string): CreatorJob[] {
  return foldJobs(io.readText(jobsLedger(base)));
}

export interface JobStats {
  readonly total: number;
  readonly active: number;
  readonly done: number;
  readonly failed: number;
  readonly refused: number;
}

export function jobStats(jobs: readonly CreatorJob[]): JobStats {
  let active = 0, done = 0, failed = 0, refused = 0;
  for (const j of jobs) {
    if (j.state === "queued" || j.state === "running") active++;
    else if (j.state === "done") done++;
    else if (j.state === "failed") failed++;
    else if (j.state === "refused") refused++;
  }
  return { total: jobs.length, active, done, failed, refused };
}

/** How long a job took, or has been running. Null when it never started. */
export function jobDurationMs(job: CreatorJob, now: number): number | null {
  if (job.startedAt === null) return null;
  return Math.max(0, (job.endedAt ?? now) - job.startedAt);
}
