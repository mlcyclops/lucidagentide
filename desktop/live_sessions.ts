// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/live_sessions.ts
//
// P-SESS-ARCHIVE.1 (ADR-0554): which sessions ANY running LUCID engine holds. Archiving moves a session's
// file; omp does not keep that file open (measured: a rename succeeds while the session is loaded), so the
// OS never refuses the move, and an engine still holding the session would append to a recreated file and
// split it in two. Each engine knows only its own Main and spokes, and engines do not share a data folder
// (an installed app's discovery files live in its own userData), but they all share the sessions folder. So
// every engine writes the ids it holds into one file per process beside the sessions folder, refreshed on a
// heartbeat, and archiving skips every id a living engine lists. Engines older than this build write
// nothing; the archive rule's age floor (days, never minutes) is the margin for those.

import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pidAlive } from "./engine_discovery.ts";

/** One registry file per engine process. */
export const liveSessionsDir = (): string => join(homedir(), ".omp", "agent", "lucid-live-sessions");
/** A record older than this is ignored even if its pid is alive (a hung or reused pid). Three heartbeats. */
export const LIVE_STALE_MS = 90_000;
export const LIVE_HEARTBEAT_MS = 30_000;

interface LiveRecord { pid: number; at: number; ids: string[] }

function parseRecord(raw: string): LiveRecord | null {
  let o: unknown;
  try { o = JSON.parse(raw); } catch { return null; }
  if (!o || typeof o !== "object" || !("pid" in o) || typeof o.pid !== "number" || !("at" in o) || typeof o.at !== "number" || !("ids" in o) || !Array.isArray(o.ids)) return null;
  return { pid: o.pid, at: o.at, ids: o.ids.filter((x): x is string => typeof x === "string" && x.length > 0) };
}

/** Publish this engine's held session ids (temp file + rename, so a reader never sees half a file). */
export function publishLiveSessions(ids: Iterable<string>, dir: string = liveSessionsDir(), pid: number = process.pid, now: number = Date.now()): void {
  const file = join(dir, `engine-${pid}.json`);
  const tmp = `${file}.tmp`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, JSON.stringify({ pid, at: now, ids: [...ids] }));
    renameSync(tmp, file);
  } catch { /* best effort: the other engines then see nothing from us, and the age floor still holds */ }
}

/** Remove this engine's record (clean exit). */
export function withdrawLiveSessions(dir: string = liveSessionsDir(), pid: number = process.pid): void {
  try { rmSync(join(dir, `engine-${pid}.json`), { force: true }); } catch { /* a stale record ages out anyway */ }
}

/** Every session id held by another living engine. Records of dead processes are deleted; stale or
 *  malformed ones are ignored. `self` is skipped: the caller already knows its own ids live. */
export function otherEnginesSessions(dir: string = liveSessionsDir(), self: number = process.pid, now: number = Date.now(), alive: (pid: number) => boolean = pidAlive): Set<string> {
  const out = new Set<string>();
  let names: string[];
  try { names = readdirSync(dir); } catch { return out; }
  for (const n of names) {
    if (!/^engine-\d+\.json$/.test(n)) continue;
    const p = join(dir, n);
    let rec: LiveRecord | null;
    try { rec = parseRecord(readFileSync(p, "utf8")); } catch { continue; }
    if (!rec || rec.pid === self) continue;
    if (!alive(rec.pid)) { try { rmSync(p, { force: true }); } catch { /* next reader retries */ } continue; }
    if (now - rec.at > LIVE_STALE_MS) continue;
    for (const id of rec.ids) out.add(id);
  }
  return out;
}
