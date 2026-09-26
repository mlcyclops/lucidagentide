// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/incident_store.ts - P-RECOVER.1 (ADR-0385): where incident reports live on disk.
//
// One directory, <data root>/incidents, where the data root is Electron's userData folder: main writes there
// directly (it records what it found and stopped before the engine existed) and hands the engine the same
// path as LUCID_DATA_ROOT (the engine records agent-child and session failures, and serves the list to the
// window). The contained agent is granted ~/.omp read-write and never userData, so it cannot plant or edit a
// record. There is no fallback into ~/.omp: without a data root outside it (a standalone dev engine, or a
// root that points into ~/.omp) incidents are not recorded at all.
//
// Each incident is two files:
//   <id>.md    the full redacted report a human reads or attaches
//   <id>.json  the record: id, creation time, whether the window has shown the notice, and the report's
//              input, already redacted and without the home path, so a later outcome can rebuild it
// Nothing shown to the user or prefilled into a public issue is read back from disk as text. Every read
// validates the record field by field (kind and outcome from their closed sets, bounded strings and lists)
// and REBUILDS the title, the issue body and the report through buildIncident, so redaction and the
// summary-only rule apply on every read. A record that fails validation is not an incident.
// Writes are atomic (tmp + rename) and best-effort: a report that cannot be written must never turn a
// recovery into a failure. The newest KEEP incidents are retained.

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { buildIncident, incidentId, isIncidentKind, isIncidentOutcome, LOG_TAIL_CHARS, redact, stripDiagnostics, type Incident, type IncidentEvent, type IncidentInput, type IncidentOutcome, type IncidentProcess } from "./incident_report.ts";

export const INCIDENT_KEEP = 20;

/** `<dataRoot>/incidents`, or null when there is no usable data root: unset, relative, or inside ~/.omp,
 *  which the contained agent may write. Main passes its userData; the engine reads LUCID_DATA_ROOT. */
export function incidentDir(dataRoot: string | undefined = process.env.LUCID_DATA_ROOT, home: string = homedir()): string | null {
  if (!dataRoot || !isAbsolute(dataRoot)) return null;
  const root = resolve(dataRoot);
  const fromOmp = relative(resolve(home, ".omp"), root);
  if (fromOmp === "" || (fromOmp !== ".." && !fromOmp.startsWith(`..${sep}`) && !isAbsolute(fromOmp))) return null;
  return join(root, "incidents");
}

/** An incident's input as it is stored: every text redacted, logs without diagnostics, bounded, no `home`. */
export type StoredInput = Omit<IncidentInput, "home">;

export interface IncidentMeta {
  id: string;
  createdAt: number;
  kind: IncidentInput["kind"];
  outcome: IncidentOutcome;
  /** Rebuilt from `input` on every read. */
  issueTitle: string;
  /** Rebuilt from `input` on every read: the summary only, never log text. */
  issueBody: string;
  /** Absolute path of the full report, for "Show report": derived from the directory and the id. */
  reportPath: string;
  /** False until the window has shown the notice for it. */
  seen: boolean;
  input: StoredInput;
}

interface StoredRecord { v: 1; id: string; createdAt: number; seen: boolean; input: StoredInput }

const ID_SHAPE = /^[0-9TZ]+-[0-9a-z]{4}$/;
// Every stored field is written within these bounds and refused on read when it is not.
const TEXT_MAX = 2_000;
const NAME_MAX = 300;
const EVENTS_MAX = 200;
const PROCESSES_MAX = 200;
const LOGS_MAX = 4;
const PROCESS_ACTIONS: Record<IncidentProcess["action"], true> = { stopped: true, "left-running": true, "stop-failed": true };

// ---- writing ----------------------------------------------------------------------------------------

function storedEvents(events: readonly IncidentEvent[] | undefined, home: string | undefined): IncidentEvent[] {
  return (events ?? []).slice(-EVENTS_MAX).map((e) => ({ at: Number.isFinite(e.at) ? e.at : 0, what: redact(String(e.what ?? ""), home).slice(0, TEXT_MAX) }));
}

/** Redact every text with the home folder (then drop the home itself), strip diagnostics from logs, and
 *  clip everything to the bounds a read accepts. Redaction runs before clipping so a cut never leaves a
 *  secret too short for its rule to match. */
function storedInput(i: IncidentInput): StoredInput {
  const r = (s: unknown, max: number): string => redact(String(s ?? ""), i.home).slice(0, max);
  return {
    kind: i.kind,
    outcome: i.outcome,
    product: r(i.product, NAME_MAX),
    version: r(i.version, NAME_MAX),
    platform: r(i.platform, NAME_MAX),
    arch: r(i.arch, NAME_MAX),
    summary: r(i.summary, TEXT_MAX),
    events: storedEvents(i.events, i.home),
    ...(i.processes?.length ? {
      processes: i.processes.slice(0, PROCESSES_MAX).map((p) => ({
        pid: Number.isInteger(p.pid) && p.pid >= 0 ? p.pid : 0,
        name: r(p.name, NAME_MAX),
        role: r(p.role, NAME_MAX),
        ...(p.startedAt ? { startedAt: r(p.startedAt, NAME_MAX) } : {}),
        action: p.action,
      })),
    } : {}),
    ...(i.logs?.length ? {
      logs: i.logs.slice(0, LOGS_MAX).map((l) => ({ name: r(l.name, NAME_MAX), text: redact(stripDiagnostics(String(l.text ?? "")), i.home).slice(-LOG_TAIL_CHARS) })),
    } : {}),
  };
}

function atomicWrite(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

function persist(dir: string, rec: StoredRecord): IncidentMeta {
  mkdirSync(dir, { recursive: true });
  const inc = buildIncident(rec.input, rec.createdAt, Math.random, rec.id);
  atomicWrite(join(dir, `${rec.id}.md`), inc.markdown);
  atomicWrite(join(dir, `${rec.id}.json`), JSON.stringify(rec, null, 2));
  return metaOf(dir, rec, inc);
}

// ---- reading: validate, then rebuild ----------------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const isText = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const isTime = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isAction = (v: unknown): v is IncidentProcess["action"] => typeof v === "string" && Object.hasOwn(PROCESS_ACTIONS, v);

/** Every element parsed, or null when the list is missing, too long, or any element is malformed. */
function parseList<T>(v: unknown, max: number, parse: (e: unknown) => T | null): T[] | null {
  if (!Array.isArray(v) || v.length > max) return null;
  const out: T[] = [];
  for (const e of v) {
    const p = parse(e);
    if (p === null) return null;
    out.push(p);
  }
  return out;
}

function parseEvent(v: unknown): IncidentEvent | null {
  return isObj(v) && isTime(v.at) && isText(v.what, TEXT_MAX) ? { at: v.at, what: v.what } : null;
}

function parseProcess(v: unknown): IncidentProcess | null {
  if (!isObj(v) || typeof v.pid !== "number" || !Number.isInteger(v.pid) || v.pid < 0) return null;
  if (!isText(v.name, NAME_MAX) || !isText(v.role, NAME_MAX)) return null;
  if (v.startedAt !== undefined && !isText(v.startedAt, NAME_MAX)) return null;
  if (!isAction(v.action)) return null;
  return { pid: v.pid, name: v.name, role: v.role, ...(v.startedAt !== undefined ? { startedAt: v.startedAt } : {}), action: v.action };
}

function parseLog(v: unknown): { name: string; text: string } | null {
  return isObj(v) && isText(v.name, NAME_MAX) && isText(v.text, LOG_TAIL_CHARS) ? { name: v.name, text: v.text } : null;
}

/** Only the known fields, each validated; anything else in the file is ignored. */
function parseInput(v: unknown): StoredInput | null {
  if (!isObj(v) || !isIncidentKind(v.kind) || !isIncidentOutcome(v.outcome)) return null;
  const { product, version, platform, arch, summary } = v;
  if (!isText(product, NAME_MAX) || !isText(version, NAME_MAX) || !isText(platform, NAME_MAX) || !isText(arch, NAME_MAX) || !isText(summary, TEXT_MAX)) return null;
  const events = parseList(v.events, EVENTS_MAX, parseEvent);
  const processes = v.processes === undefined ? undefined : parseList(v.processes, PROCESSES_MAX, parseProcess);
  const logs = v.logs === undefined ? undefined : parseList(v.logs, LOGS_MAX, parseLog);
  if (!events || processes === null || logs === null) return null;
  return { kind: v.kind, outcome: v.outcome, product, version, platform, arch, summary, events, ...(processes ? { processes } : {}), ...(logs ? { logs } : {}) };
}

/** The record stored under `id`, or null when it is absent or fails validation. */
function readRecord(dir: string, id: string): StoredRecord | null {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8")); } catch { return null; }
  if (!isObj(raw) || raw.v !== 1 || raw.id !== id || !isTime(raw.createdAt) || typeof raw.seen !== "boolean") return null;
  const input = parseInput(raw.input);
  return input ? { v: 1, id, createdAt: raw.createdAt, seen: raw.seen, input } : null;
}

function metaOf(dir: string, rec: StoredRecord, inc: Incident = buildIncident(rec.input, rec.createdAt, Math.random, rec.id)): IncidentMeta {
  return {
    id: rec.id, createdAt: rec.createdAt, kind: inc.kind, outcome: inc.outcome,
    issueTitle: inc.issueTitle, issueBody: inc.issueBody, reportPath: join(dir, `${rec.id}.md`),
    seen: rec.seen, input: rec.input,
  };
}

// ---- API --------------------------------------------------------------------------------------------

/** Record a new incident. Every text is redacted and the home path dropped BEFORE anything touches disk.
 *  Returns null if nothing could be written, or when there is no incident directory. */
export function recordIncident(input: IncidentInput, dir: string | null = incidentDir(), now: number = Date.now()): IncidentMeta | null {
  if (!dir) return null;
  try {
    const meta = persist(dir, { v: 1, id: incidentId(now), createdAt: now, seen: false, input: storedInput(input) });
    prune(dir);
    return meta;
  } catch {
    return null;
  }
}

/** Every valid incident, newest first. Unreadable, foreign, or malformed files are skipped. */
export function listIncidents(dir: string | null = incidentDir()): IncidentMeta[] {
  if (!dir) return [];
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const out: IncidentMeta[] = [];
  for (const name of names) {
    const id = name.endsWith(".json") ? name.slice(0, -5) : "";
    if (!ID_SHAPE.test(id)) continue;
    const rec = readRecord(dir, id);
    if (rec) out.push(metaOf(dir, rec));
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export function readIncident(id: string, dir: string | null = incidentDir()): IncidentMeta | null {
  if (!dir || !ID_SHAPE.test(id)) return null; // ids come from the window: never let one address a path
  const rec = readRecord(dir, id);
  return rec ? metaOf(dir, rec) : null;
}

/** The full report, rebuilt from the validated record (never the .md file's own text), or null. */
export function incidentReport(id: string, dir: string | null = incidentDir()): string | null {
  if (!dir || !ID_SHAPE.test(id)) return null;
  const rec = readRecord(dir, id);
  return rec ? buildIncident(rec.input, rec.createdAt, Math.random, rec.id).markdown : null;
}

/** Mark the notice as shown. */
export function markIncidentSeen(id: string, dir: string | null = incidentDir()): boolean {
  if (!dir || !ID_SHAPE.test(id)) return false;
  const rec = readRecord(dir, id);
  if (!rec) return false;
  try { atomicWrite(join(dir, `${id}.json`), JSON.stringify({ ...rec, seen: true }, null, 2)); return true; } catch { return false; }
}

/** Settle an incident's outcome and append what happened, rebuilding the report under the same id. New
 *  text is redacted with `home` like a new incident's. */
export function updateIncident(id: string, patch: { outcome: IncidentOutcome; events?: IncidentEvent[]; summary?: string }, dir: string | null = incidentDir(), home: string = homedir()): IncidentMeta | null {
  if (!dir || !ID_SHAPE.test(id) || !isIncidentOutcome(patch.outcome)) return null;
  const rec = readRecord(dir, id);
  if (!rec) return null;
  try {
    const input: StoredInput = {
      ...rec.input,
      outcome: patch.outcome,
      summary: patch.summary !== undefined ? redact(patch.summary, home).slice(0, TEXT_MAX) : rec.input.summary,
      events: [...rec.input.events, ...storedEvents(patch.events, home)].slice(-EVENTS_MAX),
    };
    return persist(dir, { ...rec, input });
  } catch {
    return null;
  }
}

function prune(dir: string): void {
  for (const old of listIncidents(dir).slice(INCIDENT_KEEP)) {
    for (const ext of [".json", ".md"]) { try { rmSync(join(dir, `${old.id}${ext}`), { force: true }); } catch { /* best-effort */ } }
  }
}
