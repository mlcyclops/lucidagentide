// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/run_ledger.ts - P-RECOVER.1 (ADR-0384): did the previous run exit cleanly, and what did it start?
//
// The Electron main process keeps ONE small file, <userData>/run-state.json, for the life of a run:
//   - written with clean:false the moment this process wins the single-instance lock,
//   - updated with the engine's pid, real start time, and image path once the engine spawns,
//   - rewritten with clean:true on a normal quit (and on the deliberate app.exit paths).
// A crash, a Task Manager kill, or a power loss therefore leaves clean:false behind, and the next launch
// knows two things it could never know before: that the previous run died, and exactly which engine
// process it owned (pid + start time + image). That record is the ownership proof leftover_reaper.ts
// needs before it may stop anything.
//
// A file that cannot be parsed, has the wrong version, or carries a malformed engine record makes NO
// claim: the verdict is "none" and nothing is stopped on its word. Writes are atomic (tmp + rename) so a
// crash mid-write leaves the previous content, never a torn file.
//
// Pure parse/serialize/decide, plus two tiny file helpers the tests exercise against a temp dir.

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const RUN_LEDGER_FILE = "run-state.json";

export const runLedgerPath = (userData: string): string => join(userData, RUN_LEDGER_FILE);

/** The engine the run spawned. `startedAt` is the OS-reported creation time (epoch ms) when it could be
 *  read, else the spawn time; `exe` is the OS-reported image path on win32, else the spawned command. */
export interface EngineRecord {
  pid: number;
  startedAt: number;
  exe: string;
}

export interface RunLedger {
  version: 1;
  mainPid: number;
  mainStartedAt: number;
  port: number;
  appVersion: string;
  engine: EngineRecord | null;
  clean: boolean;
}

export type PreviousRun =
  /** No ledger, or one that makes no trustworthy claim (corrupt, foreign version, malformed fields). */
  | { verdict: "none" }
  | { verdict: "clean"; ledger: RunLedger }
  | { verdict: "unclean"; ledger: RunLedger };

const isPid = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;
const isTime = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

function parseEngine(v: unknown): EngineRecord | null | undefined {
  if (v === null) return null;
  if (typeof v !== "object") return undefined;
  const e = v as Record<string, unknown>;
  if (!isPid(e.pid) || !isTime(e.startedAt) || typeof e.exe !== "string" || e.exe.length === 0) return undefined;
  return { pid: e.pid, startedAt: e.startedAt, exe: e.exe };
}

/** Strict parse. Anything off (including a malformed engine record) returns null: no claim. */
export function parseLedger(text: string | null | undefined): RunLedger | null {
  if (!text) return null;
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== 1 || !isPid(r.mainPid) || !isTime(r.mainStartedAt) || typeof r.clean !== "boolean") return null;
  if (typeof r.port !== "number" || !Number.isInteger(r.port) || r.port <= 0 || r.port > 65535) return null;
  const engine = parseEngine(r.engine);
  if (engine === undefined) return null;
  return {
    version: 1,
    mainPid: r.mainPid,
    mainStartedAt: r.mainStartedAt,
    port: r.port,
    appVersion: typeof r.appVersion === "string" ? r.appVersion : "",
    engine,
    clean: r.clean,
  };
}

export function serializeLedger(l: RunLedger): string {
  return JSON.stringify(l, null, 2);
}

/** The ledger a run writes the moment it owns the single-instance lock: nothing spawned, not clean. */
export function freshLedger(o: { mainPid: number; mainStartedAt: number; port: number; appVersion: string }): RunLedger {
  return { version: 1, mainPid: o.mainPid, mainStartedAt: o.mainStartedAt, port: o.port, appVersion: o.appVersion, engine: null, clean: false };
}

export const withEngine = (l: RunLedger, engine: EngineRecord | null): RunLedger => ({ ...l, engine });
export const markClean = (l: RunLedger): RunLedger => ({ ...l, clean: true });

/** What the previous run left behind. `selfPid` guards the impossible-but-cheap case of reading our own
 *  ledger back (a record naming this very process is not a previous run). */
export function assessPreviousRun(text: string | null | undefined, selfPid: number): PreviousRun {
  const ledger = parseLedger(text);
  if (!ledger || ledger.mainPid === selfPid) return { verdict: "none" };
  return ledger.clean ? { verdict: "clean", ledger } : { verdict: "unclean", ledger };
}

/** The raw previous ledger text, or null when there is none or it cannot be read. */
export function readLedgerText(path: string): string | null {
  try { return readFileSync(path, "utf8"); } catch { return null; }
}

/** Atomic write (tmp + rename). Best-effort: returns false instead of throwing, because the ledger must
 *  never turn a launch or a quit into a failure. */
export function writeLedger(path: string, l: RunLedger): boolean {
  try {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, serializeLedger(l), "utf8");
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}
