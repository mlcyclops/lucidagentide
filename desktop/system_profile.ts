// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/system_profile.ts — P-SYSRES.1 (ADR-0182): the system resource profile + guard verdict.
//
// The KG force simulation and the Code Graph AST ingest are the app's two big CPU spikes. On a weak
// processor that is ALREADY pegged (or nearly out of memory) they turn the whole machine to syrup.
// This module samples the machine (CPU busy% from two os.cpus() readings, RAM headroom, core count
// and clock) and classifies it into a CLOSED verdict set - `ok | strained | blocked` - that the
// renderer uses to pause those features behind a notice until resources free up. It also lists the
// top resource-consuming processes (read-only, fixed argv - never shell-interpolated) so the notice
// can tell the user WHAT to close.
//
// This is a UX guard, not a security gate: it FAILS OPEN. No sample / no evidence → "ok" (mirrors
// ADR-0129's "degrade only on evidence"). Invariant 3 (fail-closed) governs SCANS; blocking user
// features because a profiler hiccuped would be hostile, not safe. Battery-aware render fidelity
// stays with the perf tiers (ADR-0129); this verdict is about load, not power.

import { execFileSync } from "node:child_process";
import { cpus as osCpus, freemem as osFreemem, totalmem as osTotalmem } from "node:os";

// ── snapshot ─────────────────────────────────────────────────────────────────

export interface SystemSnapshot {
  cpuModel: string;
  cores: number;
  speedMHz: number;       // reported clock of core 0 (0 = unknown)
  cpuBusyPct: number | null; // 0..100 sampled over the delta window; null = could not sample
  memTotalMB: number;
  memFreeMB: number;
}

/** Aggregate os.cpus() times into one {busy, total} pair. */
export function cpuTotals(list: { times: Record<string, number> }[]): { busy: number; total: number } {
  let busy = 0, total = 0;
  for (const c of list) {
    for (const [k, v] of Object.entries(c.times)) { total += v; if (k !== "idle") busy += v; }
  }
  return { busy, total };
}

/** Busy% across two aggregate readings. Null when the window is empty/regressed (evidence only). */
export function busyPct(prev: { busy: number; total: number }, next: { busy: number; total: number }): number | null {
  const dt = next.total - prev.total;
  if (dt <= 0) return null;
  const db = next.busy - prev.busy;
  return Math.max(0, Math.min(100, Math.round((db / dt) * 100)));
}

export interface ProfileIo {
  cpus: () => { model: string; speed: number; times: Record<string, number> }[];
  totalmem: () => number;
  freemem: () => number;
  sleep: (ms: number) => Promise<void>;
}
const REAL_IO: ProfileIo = {
  cpus: () => osCpus() as unknown as { model: string; speed: number; times: Record<string, number> }[],
  totalmem: osTotalmem,
  freemem: osFreemem,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** Two-point CPU sample (delayMs window) + RAM + specs. Never throws - a failed sample returns a
 *  snapshot with cpuBusyPct null and zeroed specs, which assessSystem treats as "no evidence". */
export async function sampleSystem(io: ProfileIo = REAL_IO, delayMs = 250): Promise<SystemSnapshot> {
  try {
    const a = io.cpus();
    const t0 = cpuTotals(a);
    await io.sleep(delayMs);
    const b = io.cpus();
    const mb = (n: number) => Math.round(n / (1024 * 1024));
    return {
      cpuModel: (a[0]?.model ?? "").trim(),
      cores: a.length,
      speedMHz: a[0]?.speed ?? 0,
      cpuBusyPct: busyPct(t0, cpuTotals(b)),
      memTotalMB: mb(io.totalmem()),
      memFreeMB: mb(io.freemem()),
    };
  } catch {
    return { cpuModel: "", cores: 0, speedMHz: 0, cpuBusyPct: null, memTotalMB: 0, memFreeMB: 0 };
  }
}

// ── verdict ──────────────────────────────────────────────────────────────────

/** Closed set (AGENTS.md invariant-7 style): no other values, ever. */
export type SystemLevel = "ok" | "strained" | "blocked";

export interface SystemVerdict {
  level: SystemLevel;
  weakCpu: boolean;
  reasons: string[]; // human one-liners for the notice, empty when ok
}

/** Weak-processor line: few cores (aligned with perf_tier's WEAK_CORES) or a slow reported clock. */
export const WEAK_CORES = 4;
export const WEAK_SPEED_MHZ = 2000;
/** Load lines. HIGH only blocks on a weak CPU; CRIT blocks everywhere. */
export const CPU_HIGH_PCT = 85;
export const CPU_CRIT_PCT = 95;
/** Memory headroom lines: low = the larger of 1.5 GB or 10% of RAM; crit = under 768 MB free. */
export const MEM_LOW_MB = 1536;
export const MEM_LOW_FRAC = 0.10;
export const MEM_CRIT_MB = 768;

/** Classify a snapshot. Evidence-only: unknown busy% never raises the level; a zeroed snapshot is
 *  "ok" (fail-open). `blocked` = heavy features (KG render, Code Graph ingest) should pause. */
export function assessSystem(s: SystemSnapshot): SystemVerdict {
  const weakCpu = (s.cores > 0 && s.cores <= WEAK_CORES) || (s.speedMHz > 0 && s.speedMHz < WEAK_SPEED_MHZ);
  const reasons: string[] = [];
  const memKnown = s.memTotalMB > 0;
  const memLowLine = memKnown ? Math.max(MEM_LOW_MB, Math.round(s.memTotalMB * MEM_LOW_FRAC)) : 0;
  const cpuHigh = s.cpuBusyPct !== null && s.cpuBusyPct >= CPU_HIGH_PCT;
  const cpuCrit = s.cpuBusyPct !== null && s.cpuBusyPct >= CPU_CRIT_PCT;
  const memLow = memKnown && s.memFreeMB < memLowLine;
  const memCrit = memKnown && s.memFreeMB < MEM_CRIT_MB;

  if (cpuHigh) reasons.push(`CPU is at ${s.cpuBusyPct}% across ${s.cores} core${s.cores === 1 ? "" : "s"}`);
  if (memLow) reasons.push(`only ${fmtMB(s.memFreeMB)} of ${fmtMB(s.memTotalMB)} RAM is free`);
  if (weakCpu && (cpuHigh || memLow)) reasons.push("this processor is below the comfortable line for graph builds");

  const blocked = cpuCrit || memCrit || (weakCpu && (cpuHigh || memLow));
  if (blocked) return { level: "blocked", weakCpu, reasons };
  if (cpuHigh || memLow) return { level: "strained", weakCpu, reasons };
  return { level: "ok", weakCpu, reasons: [] };
}

/** 1536 → "1.5 GB", 8192 → "8 GB", 900 → "900 MB". */
export function fmtMB(mb: number): string {
  if (mb >= 1024) { const g = mb / 1024; return `${g >= 10 ? Math.round(g) : Math.round(g * 10) / 10} GB`; }
  return `${Math.max(0, Math.round(mb))} MB`;
}

// ── top processes (what to close) ────────────────────────────────────────────

export interface ProcGroup {
  name: string;   // process/service name (renderer must esc() - this is external text)
  count: number;  // instances aggregated (browsers spawn dozens)
  memMB: number;  // summed working set
  cpuSec: number | null; // summed cumulative CPU seconds where the platform reports it
}

/** Parse `Get-Process | Select ProcessName,Id,CPU,WorkingSet64 | ConvertTo-Json`. Tolerates a single
 *  object (one match) or an array; anything torn → []. */
export function parsePsProcesses(jsonText: string): { name: string; memMB: number; cpuSec: number | null }[] {
  try {
    const v = JSON.parse(jsonText);
    const arr = Array.isArray(v) ? v : [v];
    const out: { name: string; memMB: number; cpuSec: number | null }[] = [];
    for (const r of arr) {
      const name = typeof r?.ProcessName === "string" ? r.ProcessName : "";
      const ws = typeof r?.WorkingSet64 === "number" ? r.WorkingSet64 : 0;
      if (!name || ws <= 0) continue;
      out.push({ name, memMB: Math.round(ws / (1024 * 1024)), cpuSec: typeof r?.CPU === "number" ? Math.round(r.CPU) : null });
    }
    return out;
  } catch { return []; }
}

/** Parse `ps axo comm,pid,pcpu,rss` (rss in KB). Header line skipped; torn lines contribute nothing. */
export function parseUnixProcesses(text: string): { name: string; memMB: number; cpuSec: number | null }[] {
  const out: { name: string; memMB: number; cpuSec: number | null }[] = [];
  for (const ln of text.split("\n").slice(1)) {
    const m = ln.trim().match(/^(.+?)\s+(\d+)\s+([\d.]+)\s+(\d+)$/);
    if (!m) continue;
    const memMB = Math.round(Number(m[4]) / 1024);
    if (memMB <= 0) continue;
    out.push({ name: m[1]!.trim(), memMB, cpuSec: null });
  }
  return out;
}

/** Aggregate rows by process name (chrome × 40 is one line), sort by memory desc, keep the top N. */
export function aggregateProcs(rows: { name: string; memMB: number; cpuSec: number | null }[], top = 10): ProcGroup[] {
  const by = new Map<string, ProcGroup>();
  for (const r of rows) {
    const g = by.get(r.name) ?? { name: r.name, count: 0, memMB: 0, cpuSec: null };
    g.count += 1;
    g.memMB += r.memMB;
    if (r.cpuSec !== null) g.cpuSec = (g.cpuSec ?? 0) + r.cpuSec;
    by.set(r.name, g);
  }
  return [...by.values()].sort((a, b) => b.memMB - a.memMB).slice(0, top);
}

export type ExecIo = (argv: string[]) => string;
const realExec: ExecIo = (argv) =>
  execFileSync(argv[0]!, argv.slice(1), { encoding: "utf8", timeout: 8000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });

/** Read-only process listing via a FIXED argv (nothing user-controlled reaches the command line).
 *  Fail-quiet: any spawn/parse failure → [] - the panel just shows no rows, features stay usable. */
export function topProcesses(platform: NodeJS.Platform = process.platform, exec: ExecIo = realExec, top = 10): ProcGroup[] {
  try {
    if (platform === "win32") {
      const out = exec(["powershell", "-NoProfile", "-NonInteractive", "-Command",
        "Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 40 ProcessName,CPU,WorkingSet64 | ConvertTo-Json -Compress"]);
      return aggregateProcs(parsePsProcesses(out), top);
    }
    const out = exec(["ps", "axo", "comm,pid,pcpu,rss"]);
    return aggregateProcs(parseUnixProcesses(out), top);
  } catch { return []; }
}
