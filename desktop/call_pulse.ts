// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/call_pulse.ts - P-LIVENESS.1 (ADR-0415): is an OPEN tool call still doing anything?
//
// ADR-0263 made an open call un-killable by the harness (a ten-minute build is work), and health_watch caps
// its verdict at `quiet` forever. That left the user blind: a command blocked on a server that never
// answers and a long build both read "waiting on 1 task, quiet for N min", and a Check-in cannot reach an
// agent that is inside a call (notes land at the next tool boundary). This module supplies EVIDENCE instead
// of a clock, and never acts on it: the verdict only MARKS a call "likely stuck"; stopping it is the user's
// decision (user call, 2026-09-28).
//
// The evidence, measured on this machine before any threshold was picked:
//   - The agent's work processes: descendants of the omp child the engine spawned, minus the agent core
//     (the spawn chain that boots it: the Windows shim, the real bun, a sandbox wrapper; see
//     call_pulse_proc.ts). A blocked process accrues exactly 0 ms CPU and 0 bytes I/O; a script making one
//     HTTPS request every 1.5 s accrued 31 ms per 20 s. So ANY counter movement, or a process starting or
//     exiting, is activity. The core is excluded because omp itself burns 0 to 330 ms per 5 s whether it
//     is streaming or waiting on a tool, which proves nothing.
//   - Subagent transcripts: a run writes its transcript at every message. They are silent while a model
//     generates one long message (up to 8.3 min observed on 2026-09-24), so a live subagent run raises the
//     threshold to PULSE_STUCK_SUBAGENT_MS.
//   - Windows does not count socket traffic in process I/O, so a pure network wait is invisible here. The
//     label says so, and that is why the verdict is "likely", not "stuck".
// POSIX `ps` has no per-process I/O and only whole-second CPU, so there the evidence is marked not
// measurable and the verdict never fires.
//
// Pure and browser-safe (turn_progress.ts, which the renderer bundles, reads the verdict from here). The
// process-table side (walking the tree, stopping a call) is call_pulse_proc.ts.

import type { ProcRow } from "./leftover_reaper.ts";

/** How often the engine samples the process table while some worker has a quiet open call. */
export const PULSE_SAMPLE_MS = 15_000;
/** Observed flatness (no counter movement, no process churn, no stream event) before a call is marked
 *  likely stuck. */
export const PULSE_STUCK_MS = 5 * 60_000;
/** The same, while a subagent run of this turn is still open: a single long generation writes nothing. */
export const PULSE_STUCK_SUBAGENT_MS = 12 * 60_000;
/** Movement this recent reads as "active" (a script that polls once a minute is alive, not flat). */
const ACTIVE_WINDOW_MS = 2 * 60_000;
/** A call's own processes may start marginally before the engine stamps the call (omp announces the call,
 *  then spawns, and the engine reads the announcement a few ms later). Kept small: anything older belongs
 *  to an earlier call and must never be stopped by this one's Stop command. */
const CALL_SLACK_MS = 500;

/** The agent's work processes (call_pulse_proc.workerProcesses) and whether their counters can prove
 *  activity. */
export interface WorkerProcs {
  procs: ProcRow[];
  measurable: boolean;
}

/** PURE: the processes a call started at `callStartedAt` owns: the only ones "Stop command" may end. */
export function callProcesses(work: WorkerProcs, callStartedAt: number): ProcRow[] {
  return work.procs.filter((p) => p.startedAt !== null && p.startedAt >= callStartedAt - CALL_SLACK_MS);
}

/** PURE: when the oldest still-open call started, or null with none open. */
export function oldestCallStart(open: ReadonlyMap<string, { startedAt: number }>): number | null {
  let min: number | null = null;
  for (const c of open.values()) if (min === null || c.startedAt < min) min = c.startedAt;
  return min;
}

/** What a worker's subagent transcripts say (subagent_activity.subagentPulse). */
export interface SubagentSignal {
  /** Newest transcript write of this turn, epoch ms; 0 for none. */
  lastWriteAt: number;
  /** Runs of this turn still open (transcript, no result file yet). */
  live: number;
}

/** Everything the liveness verdict needs, carried on the progress view. */
export interface PulseEvidence {
  /** First successful look of this watch. */
  since: number;
  /** Last successful look. */
  sampledAt: number;
  /** Last look that showed movement (`since` until something moves). */
  lastActiveAt: number;
  measurable: boolean;
  liveSubagents: number;
  /** What moved last ("node.exe", "a subagent"), for the label. */
  mover: string | null;
  /** Live processes the oldest open call started (the Stop command targets), by name. */
  callProcs: string[];
}

interface Counters { name: string; cpu?: number; io?: number }

/** One worker's watch over its open call. Time always arrives as `at`. */
export class PulseTracker {
  #prev = new Map<string, Counters>();
  #ev: PulseEvidence | null = null;

  get evidence(): PulseEvidence | null { return this.#ev; }

  /** Forget the watch: the worker is streaming again, idle, or on a new turn. */
  reset(): void {
    this.#prev.clear();
    this.#ev = null;
  }

  /** Fold one look. `work` null = the look failed: nothing advances, so a broken sampler can never
   *  accumulate flatness. */
  observe(o: { at: number; work: WorkerProcs | null; callStartedAt: number; subagent: SubagentSignal }): void {
    if (!o.work || !Number.isFinite(o.at)) return;
    const next = new Map<string, Counters>();
    for (const p of o.work.procs) next.set(`${p.pid}:${p.startedAt}`, { name: p.name, cpu: p.cpuMs, io: p.ioBytes });
    const prev = this.#ev;
    let mover: string | null = null;
    if (prev) {
      let best = 0;
      for (const [k, c] of next) {
        const was = this.#prev.get(k);
        if (!was) { mover ??= c.name; continue; }
        const moved = (c.cpu ?? 0) - (was.cpu ?? 0) + ((c.io ?? 0) - (was.io ?? 0) > 0 ? 1 : 0);
        if (moved > best) { best = moved; mover = c.name; }
      }
      for (const [k, c] of this.#prev) if (!next.has(k)) mover ??= `${c.name} (exited)`;
      if (!mover && o.subagent.lastWriteAt > prev.sampledAt) mover = "a subagent";
    }
    this.#prev = next;
    this.#ev = {
      since: prev?.since ?? o.at,
      sampledAt: o.at,
      lastActiveAt: !prev || mover ? o.at : prev.lastActiveAt,
      measurable: o.work.measurable,
      liveSubagents: Math.max(0, Math.floor(o.subagent.live) || 0),
      mover: mover ?? prev?.mover ?? null,
      callProcs: callProcesses(o.work, o.callStartedAt).map((p) => p.name),
    };
  }
}

export interface PulseVerdict {
  /** Observed flatness: no movement and no stream event, measured between looks only. */
  flatMs: number;
  thresholdMs: number;
  /** Mark the call likely stuck. Never an action. */
  stuck: boolean;
  /** Movement seen within ACTIVE_WINDOW_MS of the last look. */
  active: boolean;
}

/** PURE: read the evidence against the last stream event (`lastSignalAt`) and how long the oldest open call
 *  has run. Flatness is counted from the later of the last movement and the last stream event, and only up
 *  to the last successful look, so a stale sample cannot age into a verdict. */
export function pulseVerdict(ev: PulseEvidence, lastSignalAt: number, callElapsedMs: number): PulseVerdict {
  const thresholdMs = ev.liveSubagents > 0 ? PULSE_STUCK_SUBAGENT_MS : PULSE_STUCK_MS;
  const flatSince = Math.max(ev.lastActiveAt, Number.isFinite(lastSignalAt) ? lastSignalAt : ev.lastActiveAt);
  const flatMs = Math.max(0, ev.sampledAt - flatSince);
  return {
    flatMs,
    thresholdMs,
    stuck: ev.measurable && flatMs >= thresholdMs && callElapsedMs >= thresholdMs,
    active: ev.lastActiveAt > ev.since && ev.sampledAt - ev.lastActiveAt <= ACTIVE_WINDOW_MS,
  };
}

/** The operator note queued after the user stops a call, so the agent reads why its command failed. */
export function stoppedCallNote(label: string, flatMs: number): string {
  const mins = Math.max(1, Math.round(flatMs / 60_000));
  return `Operator note from the LUCID harness: the user stopped the running call (${label}) because it showed no CPU or disk activity for about ${mins} min. ` +
    "Do not rerun it unchanged. Work out what it was waiting on (a server that never answered, a prompt waiting for input, a lock), " +
    "then continue the task another way, with a timeout if you retry.";
}
