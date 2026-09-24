// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/incident_store.ts - P-RECOVER.1 (ADR-0385): where incident reports live on disk.
//
// One directory, ~/.omp/incidents, shared by the Electron main process (it records what it found and
// stopped before the engine existed) and the engine (it records agent-child and session failures, and
// serves the list to the window). Each incident is two files:
//   <id>.md    the full redacted report a human reads or attaches
//   <id>.json  the metadata the window needs: kind, outcome, prefilled issue, and whether the user has
//              seen the notice yet, plus the redacted input so a later outcome can rebuild the report
// Writes are atomic (tmp + rename) and best-effort: a report that cannot be written must never turn a
// recovery into a failure. The newest KEEP incidents are retained.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildIncident, redact, type Incident, type IncidentEvent, type IncidentInput, type IncidentOutcome } from "./incident_report.ts";

export const INCIDENT_KEEP = 20;

export function incidentDir(home: string = homedir()): string {
  return join(home, ".omp", "incidents");
}

export interface IncidentMeta {
  id: string;
  createdAt: number;
  kind: Incident["kind"];
  outcome: IncidentOutcome;
  issueTitle: string;
  issueBody: string;
  /** Absolute path of the full report, for "Show report". */
  reportPath: string;
  /** False until the window has shown the notice for it. */
  seen: boolean;
  /** Redacted input, kept so an outcome update rebuilds the same report. */
  input: IncidentInput;
}

const ID_SHAPE = /^[0-9TZ]+-[0-9a-z]{4}$/;

function atomicWrite(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

function persist(dir: string, inc: Incident, input: IncidentInput, seen: boolean): IncidentMeta {
  mkdirSync(dir, { recursive: true });
  const reportPath = join(dir, `${inc.id}.md`);
  const meta: IncidentMeta = {
    id: inc.id, createdAt: inc.createdAt, kind: inc.kind, outcome: inc.outcome,
    issueTitle: inc.issueTitle, issueBody: inc.issueBody, reportPath, seen, input,
  };
  atomicWrite(reportPath, inc.markdown);
  atomicWrite(join(dir, `${inc.id}.json`), JSON.stringify(meta, null, 2));
  return meta;
}

/** Record a new incident. Log tails are redacted BEFORE they touch disk. Returns null if nothing could be written. */
export function recordIncident(input: IncidentInput, dir: string = incidentDir(), now: number = Date.now()): IncidentMeta | null {
  try {
    const safe: IncidentInput = { ...input, logs: input.logs?.map((l) => ({ name: l.name, text: redact(l.text, input.home) })) };
    const meta = persist(dir, buildIncident(safe, now), safe, false);
    prune(dir);
    return meta;
  } catch {
    return null;
  }
}

/** Every readable incident, newest first. Unreadable or foreign files are skipped. */
export function listIncidents(dir: string = incidentDir()): IncidentMeta[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const out: IncidentMeta[] = [];
  for (const name of names) {
    if (!name.endsWith(".json") || !ID_SHAPE.test(name.slice(0, -5))) continue;
    try {
      const meta = JSON.parse(readFileSync(join(dir, name), "utf8")) as IncidentMeta;
      if (meta && typeof meta.id === "string" && typeof meta.createdAt === "number") out.push(meta);
    } catch { /* a half-written or foreign file is not an incident */ }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export function readIncident(id: string, dir: string = incidentDir()): IncidentMeta | null {
  if (!ID_SHAPE.test(id)) return null; // ids come from the window: never let one address a path
  const path = join(dir, `${id}.json`);
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")) as IncidentMeta; } catch { return null; }
}

/** Mark the notice as shown. */
export function markIncidentSeen(id: string, dir: string = incidentDir()): boolean {
  const meta = readIncident(id, dir);
  if (!meta) return false;
  try { atomicWrite(join(dir, `${id}.json`), JSON.stringify({ ...meta, seen: true }, null, 2)); return true; } catch { return false; }
}

/** Settle an incident's outcome and append what happened, rebuilding the report under the same id. */
export function updateIncident(id: string, patch: { outcome: IncidentOutcome; events?: IncidentEvent[]; summary?: string }, dir: string = incidentDir()): IncidentMeta | null {
  const meta = readIncident(id, dir);
  if (!meta) return null;
  try {
    const input: IncidentInput = {
      ...meta.input,
      outcome: patch.outcome,
      summary: patch.summary ?? meta.input.summary,
      events: [...meta.input.events, ...(patch.events ?? [])],
    };
    return persist(dir, buildIncident(input, meta.createdAt, Math.random, meta.id), input, meta.seen);
  } catch {
    return null;
  }
}

function prune(dir: string): void {
  for (const old of listIncidents(dir).slice(INCIDENT_KEEP)) {
    for (const ext of [".json", ".md"]) { try { rmSync(join(dir, `${old.id}${ext}`), { force: true }); } catch { /* best-effort */ } }
  }
}
