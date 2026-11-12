// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/job_scheduler.ts - P-SCHED.1 (ADR-0443 decisions 2-3): the timer that fires scheduled jobs and
// the lane wake. Every edge is injected (the fleet manager, the ledger, the clock, the audit sink), so
// the whole decision path is unit-tested with fakes; dev.ts wires the real ones.
//
// One tick (every 30 s, like P-GOAL.5): for each armed job, dueVerdict says whether a fire is owed.
//   - a LIVE lane that is idle gets the prompt NOW through the manager's own prompt path (the renderer's
//     watch stream shows the turn); a live lane that is busy is left alone and the job is retried on the
//     next tick (recorded `waiting`, the fire is not consumed), so a human's turn is never preempted;
//   - a lane that is GONE is brought back exactly as the orbit's Recover does (name, folder, model and the
//     recorded session from the ledger), then prompted;
//   - a target whose folder no longer exists SUSPENDS the job with the reason (never retargeted);
//   - the job's autoApprove snapshot is applied for the run and the lane's previous value restored after;
//   - `maxMinutes` cancels the lane's turn and records `timeout`.
// Runs are recorded in the job's history and as SecurityEvents (category exec, type scheduled_job), so
// overnight work sits in the same audit as daytime work.

import { existsSync } from "node:fs";
import { dueVerdict, loadJobs, saveJobs, withRun, type JobRun, type RunOutcome, type ScheduledJob } from "./scheduled_jobs.ts";

export interface SchedulerLaneView { id: string; name: string; cwd: string; model: string; status: string; autoApprove: boolean }
export interface LedgerHit { laneId: string; name: string; cwd: string; model?: string; sessionId?: string }

export interface JobSchedulerDeps {
  lanes: () => Promise<SchedulerLaneView[]>;
  laneBusy: (laneId: string) => boolean | null;
  /** Resolves when the lane's turn ends; the sink sees the lane's events. */
  prompt: (laneId: string, text: string, sink: (e: { type: string; message?: string }) => void) => Promise<void>;
  /** Bring a recorded lane back (name, cwd, model, session). */
  recover: (hit: LedgerHit) => Promise<{ ok: boolean; lane?: SchedulerLaneView; reason?: string }>;
  /** Newest ledger line for a lane id, else for a name + cwd. */
  ledgerLookup: (target: { laneId?: string; name: string; cwd: string }) => LedgerHit | null;
  setAuto: (laneId: string, on: boolean) => void;
  cancel: (laneId: string) => void;
  audit: (e: { jobId: string; name: string; outcome: RunOutcome | "started"; laneId?: string; note?: string }) => void;
  now?: () => number;
  exists?: (path: string) => boolean;
  load?: () => ScheduledJob[];
  save?: (jobs: ScheduledJob[]) => void;
}

export const JOB_TICK_MS = 30_000;

interface InFlight { jobId: string; laneId: string; startedAt: number; fireAt: number; restoreAuto: boolean | null; timer: Timer }

export class JobScheduler {
  #timer: Timer | null = null;
  #inFlight = new Map<string, InFlight>();
  #ticking = false;
  constructor(private readonly deps: JobSchedulerDeps) {}

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => { void this.tick(); }, JOB_TICK_MS);
    if (typeof this.#timer.unref === "function") this.#timer.unref();
  }
  stop(): void { if (this.#timer) { clearInterval(this.#timer); this.#timer = null; } }

  /** Jobs with a run in progress right now (for the tile's `attn` and the sheet). */
  running(): string[] { return [...this.#inFlight.keys()]; }

  /** One tick: fire every job that is due. Overlapping ticks are refused, never queued. */
  async tick(now = this.#now()): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      const jobs = this.#load();
      for (const job of jobs) {
        if (this.#inFlight.has(job.id)) continue;
        const v = dueVerdict(job, now);
        if (!v.due) {
          if ("skippedFireAt" in v) this.#patch(job.id, (j) => withRun(j, { startedAt: now, endedAt: now, outcome: "cancelled", note: `missed fire at ${new Date(v.skippedFireAt).toLocaleString()} skipped (policy: skip)` }, v.skippedFireAt));
          continue;
        }
        await this.fire(job, v.fireAt, now);
      }
    } finally { this.#ticking = false; }
  }

  /** Fire one job now (the tick, or the sheet's Run now, which passes `manual`). */
  async fire(job: ScheduledJob, fireAt: number, now = this.#now(), manual = false): Promise<void> {
    const target = job.target;
    const exists = this.deps.exists ?? existsSync;
    if (!exists(target.cwd)) {
      this.#patch(job.id, (j) => ({ ...withRun(j, { startedAt: now, endedAt: now, outcome: "suspended", note: `folder not found: ${target.cwd}` }, fireAt), armed: false, suspended: `the lane's folder no longer exists: ${target.cwd}` }));
      this.deps.audit({ jobId: job.id, name: job.name, outcome: "suspended", note: `folder not found: ${target.cwd}` });
      return;
    }
    // Live lane first: by id, then by the durable name + folder pair.
    const live = await this.deps.lanes();
    let lane = live.find((l) => l.status !== "stopped" && ((target.laneId && l.id === target.laneId) || (l.name === target.name && samePath(l.cwd, target.cwd))));
    if (lane && this.deps.laneBusy(lane.id)) {
      // Never preempt: leave the fire owed and try again next tick. Recorded once per fire so the sheet
      // shows "waiting for the lane", without consuming the fire (lastFireAt is not advanced).
      if (job.lastOutcome !== "waiting" || manual) {
        this.#patch(job.id, (j) => ({ ...j, lastOutcome: "waiting", history: [{ startedAt: now, endedAt: now, outcome: "waiting" as const, laneId: lane!.id, note: "the lane is busy; the run starts when it is idle" }, ...j.history].slice(0, 50) }));
      }
      return;
    }
    if (!lane) {
      const hit = this.deps.ledgerLookup({ laneId: target.laneId, name: target.name, cwd: target.cwd }) ?? { laneId: "", name: target.name, cwd: target.cwd, model: target.model };
      const r = await this.deps.recover({ ...hit, model: hit.model ?? target.model });
      if (!r.ok || !r.lane) {
        this.#patch(job.id, (j) => withRun(j, { startedAt: now, endedAt: now, outcome: "error", note: `could not bring the lane back: ${r.reason ?? "unknown"}` }, fireAt));
        this.deps.audit({ jobId: job.id, name: job.name, outcome: "error", note: r.reason });
        return;
      }
      lane = r.lane;
    }
    const laneId = lane.id;
    const restoreAuto = lane.autoApprove === job.autoApprove ? null : lane.autoApprove;
    if (restoreAuto !== null) this.deps.setAuto(laneId, job.autoApprove);
    const startedAt = now;
    this.#patch(job.id, (j) => withRun(j, { startedAt, outcome: "ok", laneId, note: "running" }, fireAt));
    this.deps.audit({ jobId: job.id, name: job.name, outcome: "started", laneId });
    const timer = setTimeout(() => { this.deps.cancel(laneId); }, job.maxMinutes * 60_000);
    if (typeof timer.unref === "function") timer.unref();
    const flight: InFlight = { jobId: job.id, laneId, startedAt, fireAt, restoreAuto, timer };
    this.#inFlight.set(job.id, flight);
    let error: string | null = null;
    let sawError = false;
    try {
      await this.deps.prompt(laneId, job.prompt, (e) => { if (e.type === "error") { sawError = true; error = e.message ?? "error"; } });
    } catch (e) { sawError = true; error = e instanceof Error ? e.message : String(e); }
    finally {
      clearTimeout(timer);
      this.#inFlight.delete(job.id);
      if (restoreAuto !== null) this.deps.setAuto(laneId, restoreAuto);
    }
    const endedAt = this.#now();
    const timedOut = endedAt - startedAt >= job.maxMinutes * 60_000 - 1000;
    const outcome: RunOutcome = timedOut ? "timeout" : sawError ? "error" : "ok";
    this.#patch(job.id, (j) => ({ ...j, lastOutcome: outcome, history: j.history.map((h, i) => (i === 0 && h.startedAt === startedAt ? { ...h, endedAt, outcome, note: timedOut ? `cancelled after ${job.maxMinutes} min` : (error ?? undefined) } : h)) }));
    this.deps.audit({ jobId: job.id, name: job.name, outcome, laneId, note: error ?? undefined });
  }

  #now(): number { return (this.deps.now ?? Date.now)(); }
  #load(): ScheduledJob[] { return (this.deps.load ?? loadJobs)(); }
  #patch(id: string, f: (j: ScheduledJob) => ScheduledJob): void {
    const jobs = this.#load();
    const i = jobs.findIndex((j) => j.id === id);
    if (i < 0) return;
    jobs[i] = f(jobs[i]!);
    (this.deps.save ?? saveJobs)(jobs);
  }
}

function samePath(a: string, b: string): boolean {
  const n = (p: string) => p.replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase();
  return n(a) === n(b);
}

/** PURE: the history row a run left, for the sheet. */
export function runLabel(r: JobRun): string {
  const when = new Date(r.startedAt).toLocaleString();
  const dur = r.endedAt ? ` (${Math.max(1, Math.round((r.endedAt - r.startedAt) / 60_000))} min)` : "";
  return `${when}: ${r.outcome}${dur}${r.note ? ` - ${r.note}` : ""}`;
}
