// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/memory/obs_mirror.ts — the lock-free mirror of the "Memory layers" dashboard summary.
//
// WHY THIS EXISTS: omp's gate child (harness/omp/security_extension.ts) opens agent_obs.duckdb
// READ-WRITE and holds it for the whole session. DuckDB is single-writer across processes: while
// the gate owns the file, ANY other open is refused — even READ_ONLY, even a plain byte copy on
// Windows (sharing violation). So the desktop's harnessMemory() reader lock-failed, swallowed the
// error to null, and the Memory panel showed "No harness memory yet" for as long as a session was
// live — the exact bug class ADR-0211 fixed for AI-LOC. Same cure, same shape: the SINGLE WRITER
// also maintains a compact JSON summary snapshot beside the DB; readers fall back to it whenever
// the DuckDB open is refused. The DuckDB stays the BI/audit system-of-record; the mirror is only
// the live-readable dashboard copy (counts + a few recent facts — no raw content).

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { Db } from "./db.ts";

export interface HarnessMemory {
  counts: { working: number; archive: number; entities: number; facts: number };
  layers: { layer: string; rows: string; detail: string }[];
  facts: { entity: string; statement: string; trust_label: string }[];
  gate: { promoted: number; blocked: number };
}

/** The mirror sits beside the DB it summarizes, so per-repo DBs keep per-repo mirrors. */
export function mirrorPathFor(dbPath: string): string {
  return `${dbPath}.mirror.json`;
}

/** Build the dashboard summary over an OPEN handle (the writer's, or a read-only one).
 *  Per-query fail-soft: a missing table (fresh DB, partial schema) counts as 0 rows. */
export async function snapshotHarnessMemory(db: Db): Promise<HarnessMemory> {
  const one = async (sql: string): Promise<number> => {
    try {
      return Number((await db.get(sql))?.n ?? 0);
    } catch {
      return 0;
    }
  };
  const rows = async (sql: string): Promise<Record<string, unknown>[]> => {
    try {
      return await db.all(sql);
    } catch {
      return [];
    }
  };

  const working = await one("SELECT count(*)::INT n FROM working_state");
  const archive = await one("SELECT count(*)::INT n FROM archive_chunks");
  const entities = await one("SELECT count(*)::INT n FROM semantic_entities");
  const facts = await one("SELECT count(*)::INT n FROM semantic_facts");
  const blocked = await one("SELECT count(*)::INT n FROM telemetry_events WHERE event = 'memory_promotion_blocked'");
  const factRows = (await rows(
    `SELECT e.name AS entity, f.statement, f.trust_label
     FROM semantic_facts f JOIN semantic_entities e ON e.entity_id = f.entity_id
     ORDER BY f.promoted_at DESC LIMIT 8`,
  )).map((r) => ({ entity: String(r.entity), statement: String(r.statement), trust_label: String(r.trust_label) }));

  return {
    counts: { working, archive, entities, facts },
    layers: [
      { layer: "working", rows: String(working), detail: "current goal / next-step / blockers per run" },
      { layer: "archive", rows: String(archive), detail: "raw source-of-truth spans (immutable)" },
      { layer: "semantic", rows: `${facts} facts / ${entities} entities`, detail: "promoted facts w/ provenance + trust" },
    ],
    facts: factRows,
    gate: { promoted: facts, blocked },
  };
}

/** Refresh the mirror from the writer's own handle. Atomic (tmp + rename) so a reader never sees a
 *  torn file; best-effort — a mirror failure must never affect the gate or the session. */
export async function writeHarnessMirror(db: Db, dbPath: string): Promise<void> {
  try {
    const memory = await snapshotHarnessMemory(db);
    const path = mirrorPathFor(dbPath);
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ generated_at: new Date().toISOString(), memory }));
    renameSync(tmp, path);
  } catch {
    try { rmSync(`${mirrorPathFor(dbPath)}.tmp-${process.pid}`, { force: true }); } catch { /* ignore */ }
  }
}

/** Runtime narrowing for the parsed mirror file (outside-controlled bytes): reads become `unknown`
 *  field lookups on a plain record, coerced explicitly below — never a fabricated typed shape. */
function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Read the mirror when the DuckDB open is refused (or the DB is absent). Null on a missing,
 *  torn, or shape-invalid file — the caller renders its honest empty state then. */
export function readHarnessMirror(dbPath: string): HarnessMemory | null {
  const path = mirrorPathFor(dbPath);
  if (!existsSync(path)) return null;
  try {
    const file = asRecord(JSON.parse(readFileSync(path, "utf8")));
    const m = asRecord(file?.memory);
    const counts = asRecord(m?.counts);
    const gate = asRecord(m?.gate);
    if (!m || !counts || !gate || !Array.isArray(m.layers) || !Array.isArray(m.facts)) return null;
    const str = (v: unknown): string => (typeof v === "string" ? v : String(v ?? ""));
    return {
      counts: {
        working: Number(counts.working ?? 0),
        archive: Number(counts.archive ?? 0),
        entities: Number(counts.entities ?? 0),
        facts: Number(counts.facts ?? 0),
      },
      layers: m.layers.map((l) => {
        const r = asRecord(l);
        return { layer: str(r?.layer), rows: str(r?.rows), detail: str(r?.detail) };
      }),
      facts: m.facts.map((f) => {
        const r = asRecord(f);
        return { entity: str(r?.entity), statement: str(r?.statement), trust_label: str(r?.trust_label) };
      }),
      gate: { promoted: Number(gate.promoted ?? 0), blocked: Number(gate.blocked ?? 0) },
    };
  } catch {
    return null;
  }
}
