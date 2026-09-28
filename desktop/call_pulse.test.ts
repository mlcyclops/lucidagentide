// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/call_pulse.test.ts - P-LIVENESS.1 (ADR-0415): an open call is marked likely stuck only on OBSERVED
// flatness (no counter movement, no process churn, no subagent write, no stream event) past the threshold,
// and never on a look that failed, on a platform that cannot measure, or while anything moves.

import { describe, expect, test } from "bun:test";
import { PULSE_SAMPLE_MS, PULSE_STUCK_MS, PULSE_STUCK_SUBAGENT_MS, PulseTracker, type WorkerProcs } from "./call_pulse.ts";
import { workerProcesses } from "./call_pulse_proc.ts";
import { livenessVerdict } from "./turn_progress.ts";
import type { ProcRow } from "./leftover_reaper.ts";

const T0 = 1_790_000_000_000;
const CALL = T0 + 60_000; // the open call started a minute into the agent's life
const proc = (pid: number, ppid: number, name: string, startedAt: number, cpuMs = 0, ioBytes = 0): ProcRow =>
  ({ pid, ppid, name, exe: null, command: null, startedAt, cpuMs, ioBytes });
const work = (...procs: ProcRow[]): WorkerProcs => ({ procs, measurable: true });
const NO_SUB = { lastWriteAt: 0, live: 0 };

/** Feed `n` looks PULSE_SAMPLE_MS apart starting at `from`; `at(i)` builds the look. */
function feed(t: PulseTracker, from: number, n: number, at: (i: number) => WorkerProcs | null, sub = NO_SUB): number {
  let now = from;
  for (let i = 0; i < n; i++) { now = from + i * PULSE_SAMPLE_MS; t.observe({ at: now, work: at(i), callStartedAt: CALL, subagent: sub }); }
  return now;
}

/** The liveness verdict for a call open since CALL, with the last stream event at `signalAt`. */
function verdict(t: PulseTracker, now: number, signalAt = CALL) {
  return livenessVerdict({ busy: true, dead: false, lastSignalMs: now - signalAt, stepsOpen: [{ label: "bash: node scrape.ts", elapsedMs: now - CALL }], pulse: t.evidence, now });
}

describe("PulseTracker + livenessVerdict", () => {
  test("a process whose counters never move is marked likely stuck at the threshold, not before", () => {
    const t = new PulseTracker();
    const looks = Math.ceil(PULSE_STUCK_MS / PULSE_SAMPLE_MS);
    let now = feed(t, CALL + 30_000, looks, () => work(proc(40, 10, "node.exe", CALL + 500, 120, 4096)));
    expect(verdict(t, now).state).toBe("working"); // one look short of the threshold
    now = feed(t, now + PULSE_SAMPLE_MS, 1, () => work(proc(40, 10, "node.exe", CALL + 500, 120, 4096)));
    const v = verdict(t, now);
    expect(v.state).toBe("stuck");
    expect(v.canStopCall).toBe(true);
    expect(v.detail).toContain("node.exe");
  });

  test("any CPU tick, any process starting or exiting, keeps the call alive", () => {
    const t = new PulseTracker();
    const n = Math.ceil(PULSE_STUCK_MS / PULSE_SAMPLE_MS) + 4;
    // 16 ms of CPU every fourth look: the rate a script making one small HTTPS request per few seconds shows.
    const now = feed(t, CALL + 30_000, n, (i) => work(proc(40, 10, "node.exe", CALL + 500, 120 + 16 * Math.floor(i / 4))));
    const v = verdict(t, now);
    expect(v.state).toBe("working");
    expect(v.label).toContain("node.exe active");

    const churn = new PulseTracker();
    const end = feed(churn, CALL + 30_000, n, (i) => work(proc(40, 10, "node.exe", CALL + 500), ...(i === n - 2 ? [proc(41, 40, "curl.exe", CALL + 1000)] : [])));
    expect(verdict(churn, end).state).not.toBe("stuck");
  });

  test("a stream event after the last movement restarts the flat clock", () => {
    const t = new PulseTracker();
    const n = Math.ceil(PULSE_STUCK_MS / PULSE_SAMPLE_MS) + 2;
    const now = feed(t, CALL + 30_000, n, () => work(proc(40, 10, "node.exe", CALL + 500)));
    expect(verdict(t, now).state).toBe("stuck");
    expect(verdict(t, now, now - 60_000).state).toBe("working");
  });

  test("failed looks never age into a verdict: flatness counts only up to the last successful look", () => {
    const t = new PulseTracker();
    const flat = () => work(proc(40, 10, "node.exe", CALL + 500));
    let now = feed(t, CALL + 30_000, 3, flat);
    now = feed(t, now + PULSE_SAMPLE_MS, 40, () => null); // ten minutes of failed looks
    expect(t.evidence?.sampledAt).toBeLessThan(CALL + 30_000 + 3 * PULSE_SAMPLE_MS);
    expect(verdict(t, now).state).not.toBe("stuck");
  });

  test("a live subagent run raises the threshold, and its transcript writes count as activity", () => {
    const t = new PulseTracker();
    const n = Math.ceil(PULSE_STUCK_MS / PULSE_SAMPLE_MS) + 2;
    let now = feed(t, CALL + 30_000, n, () => work(), { lastWriteAt: CALL + 1000, live: 1 });
    expect(verdict(t, now).state).toBe("working"); // 5 min is normal for one long subagent generation
    now = feed(t, now + PULSE_SAMPLE_MS, Math.ceil((PULSE_STUCK_SUBAGENT_MS - PULSE_STUCK_MS) / PULSE_SAMPLE_MS), () => work(), { lastWriteAt: CALL + 1000, live: 1 });
    const v = verdict(t, now);
    expect(v.state).toBe("stuck");
    expect(v.canStopCall).toBe(false); // nothing of its own to stop: only Stop or Restart agent
    t.observe({ at: now + PULSE_SAMPLE_MS, work: work(), callStartedAt: CALL, subagent: { lastWriteAt: now + 1000, live: 1 } });
    expect(verdict(t, now + PULSE_SAMPLE_MS).state).toBe("working");
  });

  test("where counters cannot be read (POSIX), nothing is ever marked stuck", () => {
    const t = new PulseTracker();
    const now = feed(t, CALL + 30_000, 60, () => ({ procs: [proc(40, 10, "node", CALL + 500)], measurable: false }));
    expect(verdict(t, now).state).toBe("working");
  });
});

describe("workerProcesses", () => {
  test("the agent core and anything not provably a descendant are excluded; the call owns what it started", () => {
    const rows: ProcRow[] = [
      proc(10, 1, "omp.exe", T0),
      proc(11, 10, "bun.exe", T0 + 200), // the shim's real agent: core
      proc(12, 11, "conhost.exe", T0 + 260), // its console host: core
      proc(19, 11, "bun.exe", T0 + 8_000), // a build the agent ran in its first turn: work, even though it is early
      proc(20, 11, "typescript-language-server", T0 + 45_000), // a helper from before the call: work, not the call's
      proc(40, 11, "bash.exe", CALL + 300),
      proc(41, 40, "node.exe", CALL + 900),
      proc(50, 11, "stranger.exe", T0 - 5_000), // recycled pid: created before its "parent"
    ];
    const w = workerProcesses(rows, 10, "win32")!;
    expect(w.procs.map((p) => p.pid).sort((a, b) => a - b)).toEqual([19, 20, 40, 41]);
    expect(w.measurable).toBe(true);
    const t = new PulseTracker();
    t.observe({ at: CALL + 60_000, work: w, callStartedAt: CALL, subagent: NO_SUB });
    expect(t.evidence?.callProcs.sort()).toEqual(["bash.exe", "node.exe"]);
    expect(workerProcesses(rows, 999, "win32")).toBeNull(); // the child is gone from the look: no evidence
  });
});
