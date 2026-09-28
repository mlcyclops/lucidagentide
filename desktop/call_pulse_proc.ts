// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/call_pulse_proc.ts - P-LIVENESS.1 (ADR-0415): the process-table side of call_pulse.ts. Which
// processes are the agent's WORK (not its core), and stopping the ones an open call started. Engine-only:
// it reuses the leftover reaper's enumeration, creation-order tree walk and verified kill, so the rules that
// keep the reaper from touching a stranger's process are the same rules here.

import { listProcesses, stopProcesses, strictDescendants, type ProcRow } from "./leftover_reaper.ts";
import { callProcesses, type WorkerProcs } from "./call_pulse.ts";

/** The agent core is the spawn CHAIN that boots the agent: the child, and any process started within this
 *  long of its own parent while that parent is core (the Windows shim's real bun ~100 ms later, a sandbox
 *  wrapper). omp's own CPU moves whether it streams or waits, so it proves nothing and is left out. A tool
 *  process can never qualify: a tool call needs a model turn first, which takes far longer than this. */
const CORE_CHAIN_MS = 5_000;

/** PURE: the work processes under the agent child `rootPid`, or null when the child is not in `rows` (a
 *  failed or stale look proves nothing). */
export function workerProcesses(rows: readonly ProcRow[], rootPid: number, platform: string): WorkerProcs | null {
  const root = rows.find((r) => r.pid === rootPid);
  if (!root || root.startedAt === null) return null;
  const all = strictDescendants([...rows], root, platform);
  const core = new Map<number, number>([[root.pid, root.startedAt]]);
  for (const r of all) { // walk order is parent-before-child, so a core parent is known before its children
    const parentAt = core.get(r.ppid);
    if (parentAt !== undefined && r.startedAt !== null && r.startedAt - parentAt <= CORE_CHAIN_MS) core.set(r.pid, r.startedAt);
  }
  const procs = all.filter((r) => !core.has(r.pid));
  return { procs, measurable: platform === "win32" && procs.every((p) => p.cpuMs !== undefined && p.ioBytes !== undefined) };
}

/** Stop the live processes the open call started, and only those: a fresh look, the same ownership rule
 *  the verdict used, then the reaper's verified kill (pid AND creation time, never /T). Never throws. */
export async function stopCallProcesses(rootPid: number, callStartedAt: number, platform: string = process.platform): Promise<{ stopped: string[]; failed: string[] }> {
  let rows: ProcRow[];
  try { rows = await listProcesses(platform); } catch { return { stopped: [], failed: [] }; }
  const work = workerProcesses(rows, rootPid, platform);
  const targets = work ? callProcesses(work, callStartedAt) : [];
  const fate = await stopProcesses(targets, { platform });
  return {
    stopped: targets.filter((t) => fate.get(t.pid) === "stopped").map((t) => t.name),
    failed: targets.filter((t) => fate.get(t.pid) !== "stopped").map((t) => t.name),
  };
}
