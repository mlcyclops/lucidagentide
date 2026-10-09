// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scheduled_jobs.ts - P-SCHED.1 (ADR-0443 decisions 1-3): scheduled jobs that wake a Fleet LANE
// while the operator is away. The model, its validation, the per-user JSON store, and the PURE "is it
// due / was it missed" math. The timer and the lane wake live in job_scheduler.ts; the routes in dev.ts.
//
// A job is a lane target (which lane, by id when it is live and by its recorded name + folder when it is
// not), a prompt, a five-field cron (the sheet builds it from daily / weekly pickers; cron.ts evaluates
// it in local time), and the unattended knobs: `armed` (jobs are created DISARMED, ADR-0047's rule),
// `autoApprove` (applied for the run and restored after, so a lane left in ask-mode never silently
// becomes auto-mode forever), `maxMinutes` (the run is cancelled past it), `missed` (what to do with a
// fire that fell in a sleep: run once within the grace window, or skip).
//
// Store: `~/.omp/lucid-scheduled-jobs.json` (the sandbox_grants.ts pattern: 0600, fail-safe reads, the
// agent's loopback token never reaches the routes that write it). Jobs reference lanes across workspaces,
// so the store is per user, not per workspace (P-GOAL.5's goal automations stay per workspace).

import { closeSync, fchmodSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { nextFire, parseCron } from "./cron.ts";

export type MissedPolicy = "run-once" | "skip";
export type RunOutcome = "ok" | "error" | "timeout" | "waiting" | "suspended" | "cancelled";

export interface JobTarget {
  /** The lane's id when it was live at creation (may be gone later). */
  laneId?: string;
  /** The lane's name and folder, the durable identity the ledger recovers by. */
  name: string;
  cwd: string;
  /** The lane's model at creation; a recovered lane is spawned with it. */
  model?: string;
  /** Display only: the repo's remote or folder basename. */
  repo?: string;
}

export interface JobRun {
  startedAt: number;
  endedAt?: number;
  outcome: RunOutcome;
  laneId?: string;
  sessionId?: string;
  note?: string;
}

export interface ScheduledJob {
  id: string;
  name: string;
  target: JobTarget;
  prompt: string;
  cron: string;
  armed: boolean;
  autoApprove: boolean;
  maxMinutes: number;
  missed: MissedPolicy;
  createdAt: number;
  /** The last fire the scheduler ACTED on (started, skipped, or suspended), as the scheduled instant. */
  lastFireAt?: number;
  lastRunAt?: number;
  lastOutcome?: RunOutcome;
  /** Why the job was suspended (disarmed by the scheduler), if it was. */
  suspended?: string;
  history: JobRun[];
}

export interface JobSpec {
  name: string;
  target: JobTarget;
  prompt: string;
  cron: string;
  armed?: boolean;
  autoApprove?: boolean;
  maxMinutes?: number;
  missed?: MissedPolicy;
}

export const HISTORY_MAX = 50;
export const MISSED_GRACE_MS = 2 * 3600_000;
export const MAX_MINUTES_DEFAULT = 60;
export const MAX_MINUTES_CAP = 12 * 60;

/** PURE: validate + normalise what the sheet / API sent. A reason instead of a job for anything that
 *  must not arm: no name, no prompt, no folder, a cron that does not parse or never fires. */
export function normalizeJobSpec(raw: unknown): { ok: true; spec: Required<JobSpec> } | { ok: false; reason: string } {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "job must be an object" };
  const o = raw as Record<string, unknown>;
  const name = String(o.name ?? "").trim().slice(0, 80);
  if (!name) return { ok: false, reason: "a job needs a name" };
  const prompt = String(o.prompt ?? "").trim();
  if (!prompt) return { ok: false, reason: "a job needs the prompt it sends to the lane" };
  if (prompt.length > 8000) return { ok: false, reason: "the prompt is longer than 8000 characters" };
  const t = (o.target && typeof o.target === "object" ? o.target : {}) as Record<string, unknown>;
  const cwd = String(t.cwd ?? "").trim();
  if (!cwd) return { ok: false, reason: "a job needs the lane's folder" };
  const target: JobTarget = {
    name: String(t.name ?? "").trim().slice(0, 80) || cwd.split(/[\\/]/).filter(Boolean).pop() || "lane",
    cwd,
    ...(typeof t.laneId === "string" && t.laneId.trim() ? { laneId: t.laneId.trim() } : {}),
    ...(typeof t.model === "string" && t.model.trim() ? { model: t.model.trim() } : {}),
    ...(typeof t.repo === "string" && t.repo.trim() ? { repo: t.repo.trim().slice(0, 160) } : {}),
  };
  const cron = String(o.cron ?? "").trim();
  if (!parseCron(cron)) return { ok: false, reason: `"${cron || "(empty)"}" is not a schedule LUCID understands (minute hour day month weekday)` };
  if (!nextFire(cron, new Date())) return { ok: false, reason: `"${cron}" never fires (no such date)` };
  const maxMinutes = Math.min(MAX_MINUTES_CAP, Math.max(1, Math.round(Number(o.maxMinutes ?? MAX_MINUTES_DEFAULT) || MAX_MINUTES_DEFAULT)));
  const missed: MissedPolicy = o.missed === "skip" ? "skip" : "run-once";
  return { ok: true, spec: { name, prompt, target, cron, armed: o.armed === true, autoApprove: o.autoApprove === true, maxMinutes, missed } };
}

export function createJob(spec: Required<JobSpec>, now = Date.now(), id = `job_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`): ScheduledJob {
  return { id, ...spec, createdAt: now, history: [] };
}

/** PURE: the next scheduled instant after `now` (ms), or null for a dead schedule. */
export function nextFireAt(job: Pick<ScheduledJob, "cron">, now: number): number | null {
  return nextFire(job.cron, new Date(now))?.getTime() ?? null;
}

export type DueVerdict =
  | { due: false }
  | { due: true; fireAt: number; late: boolean }
  | { due: false; skippedFireAt: number };

/** PURE: decide, for one armed job at `now`, whether a fire is owed. The scan starts after the last
 *  fire the scheduler acted on (or the job's creation), so a sleep that swallowed several fires owes at
 *  most ONE catch-up run under `run-once` (within the grace window) and none under `skip`; either way the
 *  job's cursor moves to the latest missed fire so the same fire is never owed twice. */
export function dueVerdict(job: ScheduledJob, now: number, graceMs = MISSED_GRACE_MS): DueVerdict {
  if (!job.armed || job.suspended) return { due: false };
  let cursor = job.lastFireAt ?? job.createdAt;
  let latest: number | null = null;
  // Walk forward through every fire that has already passed; cap the walk so a stale cursor cannot spin.
  for (let i = 0; i < 10_000; i++) {
    const n = nextFireAt(job, cursor);
    if (n === null || n > now) break;
    latest = n;
    cursor = n;
  }
  if (latest === null) return { due: false };
  const late = now - latest > 60_000; // not within the minute it was scheduled for
  if (!late) return { due: true, fireAt: latest, late: false };
  if (job.missed === "run-once" && now - latest <= graceMs) return { due: true, fireAt: latest, late: true };
  return { due: false, skippedFireAt: latest };
}

/** PURE: the job after a run (or a skip) has been recorded; history is capped newest-first. */
export function withRun(job: ScheduledJob, run: JobRun, fireAt: number): ScheduledJob {
  const history = [run, ...job.history].slice(0, HISTORY_MAX);
  return { ...job, lastFireAt: fireAt, lastRunAt: run.startedAt, lastOutcome: run.outcome, history };
}

// ── the store ────────────────────────────────────────────────────────────────────────────────────

function storeFile(): string {
  return process.env.LUCID_SCHEDULED_JOBS_FILE || join(homedir(), ".omp", "lucid-scheduled-jobs.json");
}

function isJob(v: unknown): v is ScheduledJob {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  const t: unknown = o.target;
  return typeof o.id === "string" && typeof o.name === "string" && typeof o.prompt === "string" && typeof o.cron === "string"
    && !!t && typeof t === "object" && "cwd" in t && typeof t.cwd === "string";
}

/** Read the store; any read or parse error is "no jobs" (never a throw into the scheduler's timer). */
export function loadJobs(): ScheduledJob[] {
  try {
    const raw: unknown = JSON.parse(readFileSync(storeFile(), "utf8"));
    let list: unknown[] = [];
    if (Array.isArray(raw)) list = raw;
    else if (raw && typeof raw === "object" && "jobs" in raw && Array.isArray(raw.jobs)) list = raw.jobs;
    return list.filter(isJob).map((j) => ({ ...j, history: Array.isArray(j.history) ? j.history : [], armed: j.armed === true, autoApprove: j.autoApprove === true, missed: j.missed === "skip" ? "skip" : "run-once", maxMinutes: Number(j.maxMinutes) || MAX_MINUTES_DEFAULT }));
  } catch { return []; }
}

export function saveJobs(jobs: ScheduledJob[]): void {
  const file = storeFile();
  try { mkdirSync(dirname(file), { recursive: true }); } catch { /* exists */ }
  const fd = openSync(file, "w");
  try {
    writeFileSync(fd, JSON.stringify({ jobs }, null, 2), "utf8");
    try { fchmodSync(fd, 0o600); } catch { /* best-effort on Windows */ }
  } finally { closeSync(fd); }
}

export function updateJob(id: string, patch: (j: ScheduledJob) => ScheduledJob): ScheduledJob | null {
  const jobs = loadJobs();
  const i = jobs.findIndex((j) => j.id === id);
  if (i < 0) return null;
  jobs[i] = patch(jobs[i]!);
  saveJobs(jobs);
  return jobs[i]!;
}
