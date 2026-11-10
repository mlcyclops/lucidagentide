// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-TUI.0 (ADR-0419): the engine discovery seam - how a terminal client (`lucid hub`, docs/TUI.md)
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
//
// ADR-0503: the engine ALSO publishes a nonce-only record, engine-nonce-<port>.json: the same
// coordinates WITHOUT the UI token. It is what a controller client (one that holds only a controller
// token, ADR-0438) reads to find and health-verify the engine, so that client never needs read access
// to the token-bearing file and can run as its own OS user. By default it sits beside the token file,
// 0600, exactly the desktop posture. An operator who runs the controller client as another user names
// a directory (LUCID_DISCOVERY_NONCE_DIR) and a group (LUCID_DISCOVERY_NONCE_GROUP, a name or a gid);
// the record is then chowned to that group and made 0640. The token file never changes: 0600, owner.

import { chmodSync, chownSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { healthVerdict } from "./port_guard.ts";

/** The nonce-only record (ADR-0503): enough to find and prove the engine, nothing that opens a route. */
export interface EngineNonceRecord {
  /** Shape version. Bump only with a migration note in DECISIONS.md. */
  v: 1;
  pid: number;
  port: number;
  /** The per-launch health nonce (LUCID_ENGINE_NONCE). Non-secret; the handshake's proof-of-launch. */
  nonce: string;
  version: string;
  flavor: string;
  startedAt: string;
}

/** The token-bearing discovery file (ADR-0419): the nonce record plus the UI token. Human/UI clients only. */
export interface EngineDiscovery extends EngineNonceRecord {
  /** The per-launch UI token (x-lucid-token). Secret at the same-user boundary; opens every /api route. */
  token: string;
}

const FILE_RE = /^engine-discovery-(\d+)\.json$/;
const NONCE_FILE_RE = /^engine-nonce-(\d+)\.json$/;
/** Exactly the keys a nonce record may carry: a record with a `token` (or anything else) is off-shape. */
const NONCE_KEYS = ["v", "pid", "port", "nonce", "version", "flavor", "startedAt"] as const;

/** Where discovery files live: the install's userData when Electron launched us, else ~/.omp. */
export function discoveryDir(env: Readonly<Record<string, string | undefined>>): string {
  return env.LUCID_DATA_ROOT || join(homedir(), ".omp");
}

/** One file per bound port, so Agent (5319) and Creator (5320) engines coexist without clobbering. */
export function discoveryPath(dir: string, port: number): string {
  return join(dir, `engine-discovery-${port}.json`);
}

/** Where the nonce-only record lives: LUCID_DISCOVERY_NONCE_DIR when the operator names one, else beside
 *  the token file. */
export function nonceDir(env: Readonly<Record<string, string | undefined>>): string {
  return env.LUCID_DISCOVERY_NONCE_DIR || discoveryDir(env);
}

/** One nonce record per bound port, named apart from the token file so no reader can confuse the two. */
export function noncePath(dir: string, port: number): string {
  return join(dir, `engine-nonce-${port}.json`);
}

/** The shared field checks; null when any is off-shape. */
function parseFields(d: Record<string, unknown>): EngineNonceRecord | null {
  if (d.v !== 1) return null;
  if (typeof d.pid !== "number" || !Number.isInteger(d.pid) || d.pid <= 0) return null;
  if (typeof d.port !== "number" || !Number.isInteger(d.port) || d.port <= 0 || d.port > 65535) return null;
  for (const k of ["nonce", "version", "flavor", "startedAt"] as const)
    if (typeof d[k] !== "string" || !(d[k] as string).trim()) return null;
  return {
    v: 1, pid: d.pid, port: d.port, nonce: d.nonce as string,
    version: d.version as string, flavor: d.flavor as string, startedAt: d.startedAt as string,
  };
}

function parseObject(raw: string): Record<string, unknown> | null {
  let b: unknown;
  try { b = JSON.parse(raw); } catch { return null; }
  return typeof b === "object" && b !== null && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
}

/** Parse + validate one file's content. Anything off-shape is null - a client never acts on a guess. */
export function parseDiscovery(raw: string): EngineDiscovery | null {
  const d = parseObject(raw);
  const fields = d ? parseFields(d) : null;
  const token = d?.token;
  if (!fields || typeof token !== "string" || !token.trim()) return null;
  return { ...fields, token };
}

/** Parse a nonce record. Exactly NONCE_KEYS: a record that carries a token (or any other key) is null, so a
 *  controller client can never pick a UI token up through this path. */
export function parseNonceRecord(raw: string): EngineNonceRecord | null {
  const d = parseObject(raw);
  if (!d || Object.keys(d).length !== NONCE_KEYS.length || !NONCE_KEYS.every((k) => Object.hasOwn(d, k))) return null;
  return parseFields(d);
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

/** Write the nonce-only record via tmp + rename. Only NONCE_KEYS are serialized, whatever object the caller
 *  hands in, so an EngineDiscovery passed here still writes no token. `gid` null: 0600, owner only (the
 *  desktop default). A gid: the tmp file is chowned to that group and made 0640 BEFORE the rename, so the
 *  record never appears with the wrong group; a chown the OS refuses throws and leaves no record. */
export function writeNonceRecord(path: string, r: EngineNonceRecord, gid: number | null): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp-${r.pid}`;
  const body = { v: r.v, pid: r.pid, port: r.port, nonce: r.nonce, version: r.version, flavor: r.flavor, startedAt: r.startedAt };
  writeFileSync(tmp, JSON.stringify(body, null, 2) + "\n", { mode: 0o600 });
  try {
    if (gid !== null) {
      chownSync(tmp, -1, gid);
      chmodSync(tmp, 0o640);
    }
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** The gid the nonce record is shared with: null when no group is configured; a numeric spec as is; a name
 *  looked up in the group database file. An unknown name throws (the engine then publishes no record and
 *  says why) rather than falling back to owner-only or to some other group. */
export function resolveNonceGroup(spec: string | undefined, groupFile = "/etc/group"): number | null {
  const s = spec?.trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  let text: string;
  try { text = readFileSync(groupFile, "utf8"); } catch { throw new Error(`cannot read ${groupFile} to resolve group "${s}"`); }
  for (const line of text.split("\n")) {
    const [name, , gid] = line.split(":");
    if (name === s && gid !== undefined && /^\d+$/.test(gid)) return Number(gid);
  }
  throw new Error(`group "${s}" is not in ${groupFile}`);
}

/** Read one discovery file; unreadable or off-shape is null. */
export function readDiscovery(path: string): EngineDiscovery | null {
  try { return parseDiscovery(readFileSync(path, "utf8")); } catch { return null; }
}

/** Read one nonce record; unreadable or off-shape (a token in it included) is null. */
export function readNonceRecord(path: string): EngineNonceRecord | null {
  try { return parseNonceRecord(readFileSync(path, "utf8")); } catch { return null; }
}

/** Parseable entries of `dir` whose names match `re`, newest launch first. Junk and torn files drop out. */
function listNewestFirst<T extends EngineNonceRecord>(dir: string, re: RegExp, read: (p: string) => T | null): { path: string; record: T }[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  return names
    .filter((n) => re.test(n))
    .map((n) => ({ path: join(dir, n), record: read(join(dir, n)) }))
    .filter((e): e is { path: string; record: T } => e.record !== null)
    .sort((a, b) => b.record.startedAt.localeCompare(a.record.startedAt));
}

/** Every parseable discovery file in `dir`, newest launch first. Human/UI clients only: it carries the token. */
export function listDiscoveries(dir: string): { path: string; discovery: EngineDiscovery }[] {
  return listNewestFirst(dir, FILE_RE, readDiscovery).map((e) => ({ path: e.path, discovery: e.record }));
}

/** Every parseable nonce record in `dir`, newest launch first. What a controller client reads. */
export function listNonceRecords(dir: string): { path: string; record: EngineNonceRecord }[] {
  return listNewestFirst(dir, NONCE_FILE_RE, readNonceRecord);
}

/** Prove the engine behind a discovery file or nonce record is alive AND ours: fetch /api/health and demand
 *  the record's own nonce back (healthVerdict "ours", ADR-0305). Any error, timeout, non-200 or foreign
 *  answer is false - the fail-closed law: "someone answered" is not "my engine is up". */
export async function verifyDiscovery(
  d: Pick<EngineNonceRecord, "port" | "nonce">,
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

/** Whether a process with this pid exists: signal 0 probes without signaling, and EPERM means it
 *  exists but belongs to someone else. */
export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

/** A file left by an engine that was killed (no exit handler ran: SIGKILL, taskkill /F, any kill on
 *  Windows) stays inert, but piles up with its token in it. Call only after verifyDiscovery failed:
 *  the file goes when its process is gone; a live pid (an engine still booting, or a reused pid) keeps
 *  it, so pruning can never remove a running engine's file. Returns whether the file was removed. */
export function pruneStaleDiscovery(path: string, d: EngineDiscovery, alive: (pid: number) => boolean = pidAlive): boolean {
  if (alive(d.pid)) return false;
  removeDiscovery(path);
  return true;
}
