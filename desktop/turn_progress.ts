// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/turn_progress.ts - P-PROGRESS.1: the one thing a worker (the master chat, a fleet lane) reports
// about a turn in flight beyond its tool steps: whether its agent process is still there. A dead process
// is the only state the user can act on (Restart agent / Restart this lane), so it is the only one shown;
// a running or idle worker says nothing extra. Estimates, ETAs and signal ages were removed on operator
// request (ADR-0409/ADR-0408 amendments): they raised more questions than they answered.
//
// Pure: DOM-free, IO-free, global-free.

/** The polling cadence of the engine's `progress` event during a turn (how soon a dead child shows). */
export const PROGRESS_TICK_MS = 5_000;

export type LivenessState = "idle" | "running" | "dead";

export interface ProgressView {
  liveness: LivenessState;
}

export interface LivenessInput {
  busy: boolean;
  /** The worker's agent process is gone. */
  dead: boolean;
}

/** The progress view for one worker: a dead child outranks everything, else it is running a turn or idle.
 *  Pure. */
export function progressView(i: LivenessInput): ProgressView {
  return { liveness: i.dead ? "dead" : i.busy ? "running" : "idle" };
}

/** A length in plain words ("42 s", "3 m 5 s", "1 h 2 m"); "?" for an unusable value. */
export function humanMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs ? `${m} m ${rs} s` : `${m} m`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} m`;
}
