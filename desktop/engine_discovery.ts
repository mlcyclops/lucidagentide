// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-TUI.0 (ADR-0416): the engine discovery seam - how a terminal client (`lucid hub`, docs/TUI.md)
// finds a running engine without guessing ports or re-spawning one that already exists.
//
// The engine publishes one small JSON file per launch: port, per-launch nonce, the UI token, pid,
// version and flavor. A client reads the newest file, then PROVES the engine behind it is ours by
// fetching /api/health and running the answer through port_guard's healthVerdict (ADR-0305): only a
// process that was handed this launch's nonce can echo it back, so a stale file, a recycled port or
// a squatter all fail the handshake instead of being trusted. Fail-closed throughout: any parse,
// read, fetch or shape problem is "no engine", never "probably fine".
//
// Security posture: the file carries the UI token, so it is written 0600 (owner-only) into the
// install's userData (LUCID_DATA_ROOT) or ~/.omp - the same same-user trust boundary that already
// holds omp's credential vault (ADR-0022 threat model: loopback + same OS user). The token is
// per-launch and dies with the process; the engine removes the file on exit, and a leftover file
// verifies as dead the moment anyone checks it against /api/health.

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { healthVerdict } from "./port_guard.ts";

export interface EngineDiscovery {
  /** Shape version. Bump only with a migration note in DECISIONS.md. */
  v: 1;
  pid: number;
  port: number;
  /** The per-launch health nonce (LUCID_ENGINE_NONCE). Non-secret; the handshake's proof-of-launch. */
  nonce: string;
  /** The per-launch UI token (x-lucid-token). Secret at the same-user boundary; opens every /api route. */
  token: string;
  version: string;
  flavor: string;
  startedAt: string;
}

const FILE_RE = /^engine-discovery-(\d+)\.json$/;

/** Where discovery files live: the install's userData when Electron launched us, else ~/.omp. */
export function discoveryDir(env: Readonly<Record<string, string | undefined>>): string {
  return env.LUCID_DATA_ROOT || join(homedir(), ".omp");
}

/** One file per bound port, so Agent (5319) and Creator (5320) engines coexist without clobbering. */
export function discoveryPath(dir: string, port: number): string {
  return join(dir, `engine-discovery-${port}.json`);
}

/** Parse + validate one file's content. Anything off-shape is null - a client never acts on a guess. */
export function parseDiscovery(raw: string): EngineDiscovery | null {
  let b: unknown;
  try { b = JSON.parse(raw); } catch { return null; }
  if (typeof b !== "object" || b === null || Array.isArray(b)) return null;
  const d = b as Record<string, unknown>;
  if (d.v !== 1) return null;
  if (typeof d.pid !== "number" || !Number.isInteger(d.pid) || d.pid <= 0) return null;
  if (typeof d.port !== "number" || !Number.isInteger(d.port) || d.port <= 0 || d.port > 65535) return null;
  for (const k of ["nonce", "token", "version", "flavor", "startedAt"] as const)
    if (typeof d[k] !== "string" || !(d[k] as string).trim()) return null;
  return {
    v: 1, pid: d.pid, port: d.port,
    nonce: d.nonce as string, token: d.token as string,
    version: d.version as string, flavor: d.flavor as string, startedAt: d.startedAt as string,
  };
}

/** Write the file 0600 via tmp + rename, so a concurrent reader sees the old file or the new one,
 *  never a torn write. The tmp name carries the pid: two engines on different ports never collide,
 *  and a crashed write leaves only a junk tmp that FILE_RE ignores. */
export function writeDiscovery(path: string, d: EngineDiscovery): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp-${d.pid}`;
  writeFileSync(tmp, JSON.stringify(d, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

/** Read one discovery file; unreadable or off-shape is null. */
export function readDiscovery(path: string): EngineDiscovery | null {
  try { return parseDiscovery(readFileSync(path, "utf8")); } catch { return null; }
}

/** Every parseable discovery file in `dir`, newest launch first. Junk and torn files drop out. */
export function listDiscoveries(dir: string): { path: string; discovery: EngineDiscovery }[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  return names
    .filter((n) => FILE_RE.test(n))
    .map((n) => ({ path: join(dir, n), discovery: readDiscovery(join(dir, n)) }))
    .filter((e): e is { path: string; discovery: EngineDiscovery } => e.discovery !== null)
    .sort((a, b) => b.discovery.startedAt.localeCompare(a.discovery.startedAt));
}

/** Prove the engine behind a discovery file is alive AND ours: fetch /api/health and demand the
 *  file's own nonce back (healthVerdict "ours", ADR-0305). Any error, timeout, non-200 or foreign
 *  answer is false - the fail-closed law: "someone answered" is not "my engine is up". */
export async function verifyDiscovery(
  d: EngineDiscovery,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${d.port}/api/health`, { signal: AbortSignal.timeout(2000) });
    const body: unknown = await res.json();
    return healthVerdict(d.nonce, res.ok, body) === "ours";
  } catch {
    return false;
  }
}

/** Remove the engine's own file on exit. Best-effort and idempotent: a file that is already gone,
 *  or a dir that vanished, is fine - a leftover file fails verifyDiscovery anyway. */
export function removeDiscovery(path: string): void {
  try { rmSync(path, { force: true }); } catch { /* verification catches leftovers */ }
}
