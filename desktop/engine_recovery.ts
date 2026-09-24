// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/engine_recovery.ts - P-RECOVER.1 (ADR-0385): the engine's side of self-recovery.
//
// Three small jobs, kept out of acp_backend.ts and dev.ts so they are tested without an omp child:
//   1. The last-session file. Whenever the master chat session id becomes non-null the engine writes
//      ~/.omp/lucid-last-session-<PORT>.json (atomically), and at engine start it reads the file BEFORE
//      anything can overwrite it. That snapshot is what "resume your previous chat" offers after an
//      unclean exit: the id of the session the PREVIOUS engine process was talking to.
//   2. Validation of everything the window sends to the recovery and incident routes. Ids address
//      files and ACP sessions, so a malformed one is refused here and never reaches either.
//   3. The engine's incident input (product, version, platform, a redacted log tail) and the view the
//      window gets. The view names the report path the engine derived itself, never a path read back
//      from a metadata file.

import { mkdirSync, openSync, closeSync, readSync, fstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { issueUrl, LOG_TAIL_CHARS, type IncidentEvent, type IncidentInput, type IncidentKind, type IncidentOutcome } from "./incident_report.ts";
import { incidentDir, type IncidentMeta } from "./incident_store.ts";
import { APP_VERSION } from "./version.ts";
import { flavorInfo, resolveBuildFlavor } from "./build_flavor.ts";

// ---- 1. the last-session file ---------------------------------------------------------------------

export interface LastSession { sessionId: string; cwd: string; at: number }

/** An ACP session id as the window may name it: no path separators, no whitespace, bounded. omp mints
 *  hex/uuid-like ids; anything else is refused before it can reach session/load. */
const SESSION_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isSessionId(v: unknown): v is string {
  return typeof v === "string" && SESSION_ID_SHAPE.test(v) && !v.includes("..");
}

export function lastSessionPath(port: number, home: string = homedir()): string {
  return join(home, ".omp", `lucid-last-session-${port}.json`);
}

/** The persisted session, or null when absent, unreadable, or not the expected shape. */
export function readLastSession(path: string): LastSession | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!raw || typeof raw !== "object") return null;
    const { sessionId, cwd, at } = raw as Record<string, unknown>;
    if (!isSessionId(sessionId) || typeof cwd !== "string" || cwd.length > 4096 || typeof at !== "number" || !Number.isFinite(at)) return null;
    return { sessionId, cwd, at };
  } catch {
    return null;
  }
}

/** Atomic (tmp + rename) so a crash mid-write leaves the previous record, never half of one. Best-effort:
 *  returns false instead of throwing, because a chat must never fail over a bookkeeping file. */
export function writeLastSession(path: string, s: LastSession): boolean {
  if (!isSessionId(s.sessionId)) return false;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ sessionId: s.sessionId, cwd: s.cwd, at: s.at }), "utf8");
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

// ---- 2. request validation ------------------------------------------------------------------------

/** Same shape incident_store enforces; checked here too so a bad id is a 400, not a silent null. */
const INCIDENT_ID_SHAPE = /^[0-9TZ]+-[0-9a-z]{4}$/;
export const INCIDENT_NOTE_MAX = 300;
const OUTCOMES: Record<IncidentOutcome, true> = { recovered: true, "not-recovered": true, pending: true };

export function isIncidentId(v: unknown): v is string {
  return typeof v === "string" && v.length <= 64 && INCIDENT_ID_SHAPE.test(v);
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function asObject(body: unknown): Record<string, unknown> | null {
  return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
}

export function parseResumeBody(body: unknown): Parsed<{ sessionId: string }> {
  const b = asObject(body);
  if (!b || !isSessionId(b.sessionId)) return { ok: false, error: "sessionId must be a session id string" };
  return { ok: true, value: { sessionId: b.sessionId } };
}

export function parseIncidentIdBody(body: unknown): Parsed<{ id: string }> {
  const b = asObject(body);
  if (!b || !isIncidentId(b.id)) return { ok: false, error: "id must be an incident id string" };
  return { ok: true, value: { id: b.id } };
}

export function parseIncidentUpdate(body: unknown): Parsed<{ id: string; outcome: IncidentOutcome; note?: string }> {
  const b = asObject(body);
  if (!b || !isIncidentId(b.id)) return { ok: false, error: "id must be an incident id string" };
  if (typeof b.outcome !== "string" || !Object.hasOwn(OUTCOMES, b.outcome)) return { ok: false, error: "outcome must be recovered, not-recovered or pending" };
  if (b.note !== undefined && typeof b.note !== "string") return { ok: false, error: "note must be a string" };
  const note = typeof b.note === "string" ? b.note.trim() : "";
  if (note.length > INCIDENT_NOTE_MAX) return { ok: false, error: `note must be at most ${INCIDENT_NOTE_MAX} characters` };
  return { ok: true, value: { id: b.id, outcome: b.outcome as IncidentOutcome, ...(note ? { note } : {}) } };
}

// ---- 3. incidents -----------------------------------------------------------------------------------

export interface IncidentView {
  id: string;
  kind: IncidentKind;
  outcome: IncidentOutcome;
  createdAt: number;
  issueTitle: string;
  issueBody: string;
  issueUrl: string;
  reportPath: string;
  seen: boolean;
}

/** What the window sees. `reportPath` is rebuilt from the id and the directory, never trusted from the
 *  metadata file, so a tampered .json cannot point "Show report" at an arbitrary path. */
export function incidentView(m: IncidentMeta, dir: string = incidentDir()): IncidentView {
  return {
    id: m.id, kind: m.kind, outcome: m.outcome, createdAt: m.createdAt,
    issueTitle: m.issueTitle, issueBody: m.issueBody, issueUrl: issueUrl(m),
    reportPath: join(dir, `${m.id}.md`), seen: m.seen === true,
  };
}

/** The newest `max` characters of a log file, read from the end so a large log costs one bounded read.
 *  "" when the file is missing. The store redacts it before it touches disk. */
export function logTail(path: string, max: number = LOG_TAIL_CHARS): string {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const len = Math.min(size, Math.max(0, max));
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

const PRODUCT = flavorInfo(resolveBuildFlavor(process.env)).productName;

/** The engine's incident input. `summary` and `events` are harness-authored plain language: callers never
 *  pass prompts, transcripts or model text. */
export function engineIncident(
  kind: IncidentKind, outcome: IncidentOutcome, summary: string, events: IncidentEvent[],
  logs?: { name: string; text: string }[],
): IncidentInput {
  return {
    kind, outcome, product: PRODUCT, version: APP_VERSION, platform: process.platform, arch: process.arch,
    summary, events, ...(logs?.length ? { logs } : {}), home: homedir(),
  };
}
