// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/subagent_filter.ts - pure (DOM-free) run filtering for delegation cards.
//
// P-TASK.5 polls /api/subagents, which returns ALL runs in the parent session; with two `task`
// batches in one turn every card rendered the UNION of runs while its header claimed its own
// batch size. Scope each card to its own batch here: by task id when the delegation carried
// explicit ids (rawInput.tasks[].id), else by assignment-prefix matching, with a single-card
// fallback so a lone batch keeps working even when neither yields a match.

import { ETA_ESTIMATING, estimateFromSamples, etaPhrase, humanMs } from "../turn_progress.ts";

/** The subset of a P-TASK.5 run view the filter needs (see bridge.subagents()). */
export interface BatchRun { name: string; assignment: string }

export interface SubagentBatch {
  /** Per-task ids from the delegation rawInput; absent when they were all auto-generated. */
  names?: string[];
  /** The batch's assignment/description texts (already capped at 200 chars by the backend). */
  assignments: string[];
  /** True when this is the only delegation card in the current turn (enables the show-all fallback). */
  soleCard: boolean;
}

/** trim + collapse whitespace + first 200 chars, so a capped batch assignment and the run's full
 *  assignment compare as prefixes of each other regardless of wrapping. */
const norm = (s: string): string => s.trim().replace(/\s+/g, " ").slice(0, 200);

/** A run is quiet this long (transcript untouched, no final output) = it is not working any more
 *  (cancelled, crashed, or its parent died). Generous: one long tool call writes nothing meanwhile. */
export const RUN_IDLE_MS = 10 * 60_000;
/** A delegation whose runs never appeared this long after the turn ended is not coming. */
export const NO_RUNS_GRACE_MS = 15_000;

/** PURE: may the delegation card stop animating? P-TASK.6 (ADR-0398): omp 18 runs subagents as
 *  BACKGROUND jobs, so the parent turn usually ends first. The card must stay live until its own runs
 *  are finished (`done` = their output exists) or have gone quiet, not until the turn ends. Never
 *  settles while the turn is still running. */
export function delegationSettled(runs: readonly { done: boolean; lastAt: number }[], turnEndedAt: number | null, now: number): boolean {
  if (turnEndedAt === null) return false;
  if (!runs.length) return now - turnEndedAt >= NO_RUNS_GRACE_MS;
  return runs.every((r) => r.done || now - r.lastAt >= RUN_IDLE_MS);
}

/** Keep only the runs that belong to `batch`. Matched results are capped at the batch size
 *  (the header count); an empty match on the turn's only card falls back to showing all runs. */
export function filterRunsForBatch<R extends BatchRun>(runs: readonly R[], batch: SubagentBatch): R[] {
  if (!runs.length) return runs.slice();
  let matched: R[];
  if (batch.names && batch.names.length) {
    const names = new Set(batch.names);
    matched = runs.filter((r) => names.has(r.name));
  } else {
    const batchAsg = batch.assignments.map(norm).filter(Boolean);
    matched = runs.filter((r) => {
      const ra = norm(r.assignment);
      return !!ra && batchAsg.some((a) => a.startsWith(ra) || ra.startsWith(a));
    });
  }
  if (matched.length) {
    const size = Math.max(batch.assignments.length, batch.names?.length ?? 0);
    return size > 0 ? matched.slice(0, size) : matched;
  }
  return batch.soleCard ? runs.slice() : matched;
}

// --- P-PROGRESS.2: an ETA for every subagent run ----------------------------------------------------

/** The timing a run view carries (see bridge.subagents()). `startedAt`/`endedAt` are 0 or absent when the
 *  transcript did not say. */
export interface TimedRun { name: string; done: boolean; lastAt: number; startedAt?: number; endedAt?: number }

/** One finished run's length, kept across sessions so the first delegation of a day has history. */
export interface RunSample { k: string; ms: number }

/** Samples kept in the persisted history, oldest dropped first. */
export const RUN_SAMPLE_CAP = 100;

/** A finished run's length, when both ends are known and the order is sane. */
export function runLengthMs(r: TimedRun): number | null {
  const s = r.startedAt ?? 0, e = r.endedAt ?? 0;
  return r.done && s > 0 && e >= s ? e - s : null;
}

/** Fold newly finished runs into the stored history. A run is keyed by name and start time, so the same run
 *  seen on every poll counts once. Returns the same array when nothing changed. Pure. */
export function mergeRunSamples(stored: readonly RunSample[], runs: readonly TimedRun[], cap = RUN_SAMPLE_CAP): readonly RunSample[] {
  const have = new Set(stored.map((s) => s.k));
  const add: RunSample[] = [];
  for (const r of runs) {
    const ms = runLengthMs(r);
    const k = `${r.name}@${r.startedAt ?? 0}`;
    if (ms === null || have.has(k)) continue;
    have.add(k);
    add.push({ k, ms });
  }
  if (!add.length) return stored;
  const next = [...stored, ...add];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

export interface RunEta {
  /** Still working (not done, not gone quiet past RUN_IDLE_MS). */
  live: boolean;
  /** Ms left while live; null while estimating or once past the typical length (time left unknown). */
  etaMs: number | null;
  /** "about 2 m left (est.)", "longer than usual (typically 3 m)", "ETA estimating", "took 1 m 10 s". */
  label: string;
}

/** A run's ETA against the lengths of finished runs (`samples`). A run with no start time, or too little
 *  history, says "ETA estimating" rather than a guess. Pure. */
export function runEta(r: TimedRun, samples: readonly number[], now: number): RunEta {
  if (r.done) {
    const ms = runLengthMs(r);
    return { live: false, etaMs: 0, label: ms === null ? "done" : `took ${humanMs(ms)}` };
  }
  if (now - r.lastAt >= RUN_IDLE_MS) return { live: false, etaMs: null, label: "stopped reporting" };
  const start = r.startedAt ?? 0;
  if (start <= 0) return { live: true, etaMs: null, label: ETA_ESTIMATING };
  const est = estimateFromSamples(Math.max(0, now - start), samples, 2);
  return { live: true, etaMs: est.overrun ? null : est.etaMs, label: etaPhrase(est) };
}
