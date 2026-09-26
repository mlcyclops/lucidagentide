// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/leftover_reaper.ts - P-RECOVER.1 (ADR-0385): stop what the previous run PROVABLY left behind.
//
// When the run ledger (run_ledger.ts) says the previous run did not exit cleanly, the processes that run
// started may still be alive: its engine, the omp agent under it, whisper, headroom, the scanner. They hold
// the port, the DuckDB file, and the omp session, and the user's only remedy used to be Task Manager.
// P-PORTGUARD.3 (ADR-0382) already offers to reap a port holder that LOOKS like a LUCID engine, after a
// dialog, because a name match proves nothing. The ledger lets this module go further WITHOUT asking,
// because here ownership is proven, not guessed:
//
//   1. The previous engine is ours only if its recorded pid is alive AND that process's image path equals
//      the recorded exe (case-insensitive on win32) AND its creation time is within 5s of the recorded
//      start. A recycled pid fails the image or the start-time check, so it is never touched.
//   2. The engine's descendants are ours, walked by ParentProcessId with a creation-order check on every
//      edge (a child must be created no earlier than its parent). Windows never clears ParentProcessId,
//      so a process whose original parent died and whose pid was later recycled can "look like" a child
//      of our engine; the creation-order check rejects it.
//   3. When the engine itself is gone, Windows keeps its children's ParentProcessId pointing at the dead
//      pid. Children still naming the recorded engine pid that were created after the recorded engine
//      start (and, if some other process now holds that pid, before THAT process started) are the dead
//      engine's orphans, plus their descendants by rule 2.
//   4. Never the current main process or any of its descendants, never pids 0-4, and nothing else. Names
//      are never evidence: an unrelated `bun.exe` or `lucid-engine.exe` is left alone.
//
// Kill policy: every selected pid is named explicitly. win32 runs ONE `taskkill /F /PID a /PID b ...`
// WITHOUT /T, because /T walks ParentProcessId with no creation-order check and could reach a process
// that merely inherited a recycled parent pid; the tree was already walked safely above. POSIX sends
// SIGTERM to each, waits, then SIGKILLs survivors. Liveness is re-checked by (pid, creation time), so a
// pid recycled during the wait never counts as "still ours".
//
// Pure classification + parsing; plus the two I/O helpers (enumerate, stop) that main.ts and the proof
// script share, so the code proven on a real machine is the code that ships. No Electron.

import { execFile } from "node:child_process";
import type { EngineRecord } from "./run_ledger.ts";

export interface ProcRow {
  pid: number;
  ppid: number;
  /** Image name ("lucid-engine.exe", "bun"). */
  name: string;
  /** Full image path when the OS reports it (win32 ExecutablePath). */
  exe: string | null;
  /** Full command line (POSIX `args`); null on win32. */
  command: string | null;
  /** Creation time, epoch ms. POSIX `lstart` has one-second resolution. */
  startedAt: number | null;
}

export type EngineVerdict = "no-record" | "alive-ours" | "gone" | "pid-reused";

export interface LeftoverTarget extends ProcRow {
  role: string;
  /** Why this process is provably ours, for the incident and engine.log. */
  why: string;
}

export interface LeftoverPlan {
  engineVerdict: EngineVerdict;
  /** Roots first, then descendants in walk order. */
  targets: LeftoverTarget[];
}

export const START_TOLERANCE_MS = 5000;

/** What LUCID used a process for, guessed from its image name. */
export function roleOf(name: string): string {
  const n = name.toLowerCase().replace(/\.exe$/, "");
  if (n === "lucid-engine") return "engine";
  if (n === "omp" || n === "bun") return "agent (omp)";
  if (n.startsWith("whisper-server")) return "speech (whisper)";
  if (n.startsWith("headroom")) return "context proxy (headroom)";
  if (/^python(?:w|3(?:\.\d+)?)?$/.test(n)) return "scanner";
  return "helper";
}

function sameImage(platform: string, row: ProcRow, exe: string): boolean {
  if (platform === "win32") {
    const norm = (p: string): string => p.replace(/\//g, "\\").toLowerCase();
    return row.exe !== null && norm(row.exe) === norm(exe);
  }
  if (row.exe) return row.exe === exe;
  // POSIX has no image-path column in ps; the recorded exe is the command main spawned, so the command
  // line must start with it (a whole token, not a prefix of a longer path).
  return row.command !== null && (row.command === exe || row.command.startsWith(`${exe} `));
}

/** Child created no earlier than parent. POSIX start times are second-resolution, so compare seconds. */
function notBefore(platform: string, child: number, parent: number): boolean {
  return platform === "win32" ? child >= parent : Math.floor(child / 1000) >= Math.floor(parent / 1000);
}

/** Every pid reachable from `root` by ParentProcessId, no creation-order filter. Used only to EXCLUDE,
 *  where over-reach is the safe direction. */
function looseSubtree(rows: ProcRow[], root: number): Set<number> {
  const out = new Set<number>([root]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of rows) if (!out.has(r.pid) && out.has(r.ppid) && r.pid !== r.ppid) { out.add(r.pid); grew = true; }
  }
  return out;
}

/** Descendants of `root` whose every edge passes the creation-order check. `root` itself is excluded. */
export function strictDescendants(rows: ProcRow[], root: ProcRow, platform: string): ProcRow[] {
  const out: ProcRow[] = [];
  const seen = new Set<number>([root.pid]);
  const queue: ProcRow[] = [root];
  while (queue.length) {
    const parent = queue.shift()!;
    if (parent.startedAt === null) continue;
    for (const r of rows) {
      if (r.ppid !== parent.pid || seen.has(r.pid) || r.startedAt === null) continue;
      if (!notBefore(platform, r.startedAt, parent.startedAt)) continue;
      seen.add(r.pid);
      out.push(r);
      queue.push(r);
    }
  }
  return out;
}

/**
 * Decide which live processes the previous run provably left behind. See the header for the rules.
 * `rows` is one enumeration of the whole process table; `prev` the previous ledger's engine record.
 */
export function planLeftovers(
  rows: ProcRow[],
  prev: EngineRecord | null,
  o: { selfPid: number; platform: string; toleranceMs?: number },
): LeftoverPlan {
  if (!prev) return { engineVerdict: "no-record", targets: [] };
  const tol = o.toleranceMs ?? START_TOLERANCE_MS;
  const excluded = looseSubtree(rows, o.selfPid);
  const holder = rows.find((r) => r.pid === prev.pid) ?? null;
  const engineOurs = holder !== null && holder.startedAt !== null
    && sameImage(o.platform, holder, prev.exe) && Math.abs(holder.startedAt - prev.startedAt) <= tol;
  const engineVerdict: EngineVerdict = engineOurs ? "alive-ours" : holder ? "pid-reused" : "gone";

  const picked = new Map<number, LeftoverTarget>();
  const add = (r: ProcRow, why: string, isEngine = false): void => {
    if (r.pid <= 4 || excluded.has(r.pid) || picked.has(r.pid)) return;
    picked.set(r.pid, { ...r, role: isEngine ? "engine" : roleOf(r.name), why });
  };
  const addTree = (root: ProcRow, why: string, isEngine: boolean): void => {
    add(root, why, isEngine);
    for (const d of strictDescendants(rows, root, o.platform)) add(d, `descendant of pid ${root.pid}`);
  };

  if (engineOurs) {
    addTree(holder!, "the previous run's engine (pid, image path and start time match the run ledger)", true);
  } else {
    // Orphans of the dead engine: still naming its pid as parent, created after it started, and (when a
    // stranger now holds that pid) before the stranger started, since later ones are the stranger's.
    const ceiling = holder ? holder.startedAt : Number.POSITIVE_INFINITY;
    if (ceiling !== null) {
      for (const r of rows) {
        if (r.ppid !== prev.pid || r.pid === prev.pid || r.startedAt === null) continue;
        if (!notBefore(o.platform, r.startedAt, prev.startedAt) || r.startedAt >= ceiling) continue;
        addTree(r, `orphaned child of the previous run's engine (pid ${prev.pid}), created after it started`, false);
      }
    }
  }
  return { engineVerdict, targets: [...picked.values()] };
}

/** The engine record a run writes to its ledger once the spawned engine is visible in the process table.
 *  win32 records the OS image path (the real exe, whatever the spawn command looked like); POSIX records
 *  the spawned command, matched against `args` later. A missing creation time falls back to spawn time. */
export function engineRecordFromProbe(platform: string, pid: number, row: ProcRow | null, spawnedCmd: string, spawnedAt: number): EngineRecord {
  return {
    pid,
    startedAt: row?.startedAt ?? spawnedAt,
    exe: platform === "win32" ? (row?.exe ?? spawnedCmd) : spawnedCmd,
  };
}

// ── Enumeration ────────────────────────────────────────────────────────────────────────────────────

/** One process-table query. win32: a single Get-CimInstance call projecting pid, parent, name, image and
 *  creation time (as epoch ms, so no locale or PowerShell-version date format leaks in). POSIX: ps with
 *  LC_ALL=C so `lstart` is parseable. `pid` narrows to one process (validated: it is interpolated). */
export function processListSpec(platform: string, pid?: number): { cmd: string; args: string[]; env?: Record<string, string> } {
  if (pid !== undefined && (!Number.isInteger(pid) || pid <= 0)) throw new Error(`invalid pid ${pid}`);
  if (platform === "win32") {
    const filter = pid !== undefined ? ` -Filter 'ProcessId=${pid}'` : "";
    const script =
      `$ErrorActionPreference = 'SilentlyContinue'; ` +
      `Get-CimInstance Win32_Process${filter} | ForEach-Object { [pscustomobject]@{ ` +
      `p = $_.ProcessId; pp = $_.ParentProcessId; n = $_.Name; x = $_.ExecutablePath; ` +
      `c = $(if ($_.CreationDate) { ([DateTimeOffset]($_.CreationDate)).ToUnixTimeMilliseconds() } else { $null }) } } | ConvertTo-Json -Compress`;
    return { cmd: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", script] };
  }
  const sel = pid !== undefined ? ["-p", String(pid)] : ["-e"];
  return { cmd: "ps", args: [...sel, "-o", "pid=,ppid=,lstart=,args="], env: { LC_ALL: "C" } };
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** `ps` line: pid, ppid, five lstart tokens (weekday month day hh:mm:ss year), then the command. */
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+\S+\s+(\S+)\s+(\d+)\s+(\d+):(\d+):(\d+)\s+(\d{4})\s+(\S.*)$/;

export function parseProcessList(platform: string, stdout: string): ProcRow[] {
  const text = stdout.trim();
  if (!text) return [];
  const rows: ProcRow[] = [];
  if (platform === "win32") {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return []; }
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
      if (typeof item !== "object" || item === null) continue;
      const r = item as Record<string, unknown>;
      if (typeof r.p !== "number" || typeof r.pp !== "number") continue;
      rows.push({
        pid: r.p,
        ppid: r.pp,
        name: typeof r.n === "string" ? r.n : "",
        exe: typeof r.x === "string" && r.x.length > 0 ? r.x : null,
        command: null,
        startedAt: typeof r.c === "number" && Number.isFinite(r.c) && r.c > 0 ? r.c : null,
      });
    }
    return rows;
  }
  for (const line of text.split("\n")) {
    const m = PS_LINE.exec(line);
    if (!m) continue;
    const month = MONTHS.indexOf(m[3]!.toLowerCase());
    const started = month < 0 ? NaN : new Date(Number(m[8]), month, Number(m[4]), Number(m[5]), Number(m[6]), Number(m[7])).getTime();
    const command = m[9]!.trim();
    const first = command.split(/\s+/)[0] ?? "";
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      name: first.split(/[\\/]/).pop() ?? first,
      exe: null,
      command,
      startedAt: Number.isFinite(started) ? started : null,
    });
  }
  return rows;
}

function run(cmd: string, args: string[], env: Record<string, string> | undefined, timeout: number): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: env ? { ...process.env, ...env } : process.env }, (err, out) => {
    if (err) reject(err); else resolve(String(out));
  });
  return promise;
}

/** Enumerate the process table (or one pid). Throws when the query itself fails, so a caller can tell
 *  "nothing is running" from "could not look". */
export async function listProcesses(platform: string = process.platform, pid?: number): Promise<ProcRow[]> {
  const spec = processListSpec(platform, pid);
  try {
    return parseProcessList(platform, await run(spec.cmd, spec.args, spec.env, 15_000));
  } catch (e) {
    // `ps -p <pid>` exits 1 when the pid is gone: that is an answer (no rows), not a failure.
    if (pid !== undefined && platform !== "win32" && e && typeof e === "object" && "code" in e && e.code === 1) return [];
    throw e;
  }
}

// ── Stopping ───────────────────────────────────────────────────────────────────────────────────────

/** The win32 kill: every proven pid named, no /T (see the header). */
export function taskkillArgs(pids: number[]): string[] {
  return ["/F", ...pids.flatMap((p) => ["/PID", String(p)])];
}

const same = (a: ProcRow, b: ProcRow): boolean => a.pid === b.pid && a.startedAt === b.startedAt;

/** Which of `targets` are still alive as the SAME process (pid and creation time). Enumeration failure
 *  counts as "all alive": never report a stop that was not observed. */
async function survivors(platform: string, targets: ProcRow[]): Promise<ProcRow[]> {
  try {
    const now = await listProcesses(platform);
    return targets.filter((t) => now.some((r) => same(r, t)));
  } catch {
    return targets;
  }
}

function pause(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/**
 * Stop exactly `targets` and report each one's fate. win32: one taskkill /F naming every pid. POSIX:
 * SIGTERM, up to `graceMs` for them to go, then SIGKILL. Never throws.
 */
export async function stopProcesses(
  targets: ProcRow[],
  o: { platform?: string; graceMs?: number } = {},
): Promise<Map<number, "stopped" | "stop-failed">> {
  const platform = o.platform ?? process.platform;
  const grace = o.graceMs ?? 3000;
  const fate = new Map<number, "stopped" | "stop-failed">();
  if (targets.length === 0) return fate;
  if (platform === "win32") {
    // taskkill exits non-zero when any one pid was already gone; the survivor check is the truth.
    try { await run("taskkill.exe", taskkillArgs(targets.map((t) => t.pid)), undefined, 15_000); } catch { /* see survivors */ }
  } else {
    for (const t of targets) { try { process.kill(t.pid, "SIGTERM"); } catch { /* gone or not permitted */ } }
  }
  let left = await survivors(platform, targets);
  const deadline = Date.now() + grace;
  while (left.length && Date.now() < deadline) {
    await pause(250);
    left = await survivors(platform, left);
  }
  if (left.length && platform !== "win32") {
    for (const t of left) { try { process.kill(t.pid, "SIGKILL"); } catch { /* gone */ } }
    await pause(300);
    left = await survivors(platform, left);
  }
  for (const t of targets) fate.set(t.pid, left.some((l) => same(l, t)) ? "stop-failed" : "stopped");
  return fate;
}
