// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/memory/obs_mirror.ts - the lock-free mirror of the "Memory layers" dashboard summary.
//
// WHY THIS EXISTS: omp's gate child (harness/omp/security_extension.ts) opens agent_obs.duckdb
// READ-WRITE and holds it for the whole session. DuckDB is single-writer across processes: while
// the gate owns the file, ANY other open is refused - even READ_ONLY, even a plain byte copy on
// Windows (sharing violation). So the desktop's harnessMemory() reader lock-failed, swallowed the
// error to null, and the Memory panel showed "No harness memory yet" for as long as a session was
// live - the exact bug class ADR-0211 fixed for AI-LOC. Same cure, same shape: the SINGLE WRITER
// also maintains a compact JSON summary snapshot beside the DB; readers fall back to it whenever
// the DuckDB open is refused. The DuckDB stays the BI/audit system-of-record; the mirror is only
// the live-readable dashboard copy (counts + a few recent facts - no raw content).

import { existsSync, readFileSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
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

/** Every figure in ONE statement, so all of them come from a single DuckDB snapshot. The gate writes
 *  memory fire-and-forget on the same connection, and separate SELECTs could straddle a promotion
 *  (a fact count from before it, fact rows from after). */
const SNAPSHOT_SQL = `SELECT
  (SELECT count(*) FROM working_state)::INT AS working,
  (SELECT count(*) FROM archive_chunks)::INT AS archive,
  (SELECT count(*) FROM semantic_entities)::INT AS entities,
  (SELECT count(*) FROM semantic_facts)::INT AS facts,
  (SELECT count(*) FROM telemetry_events WHERE event = 'memory_promotion_blocked')::INT AS blocked,
  (SELECT to_json(list(struct_pack(entity := e.name, statement := f.statement, trust_label := f.trust_label) ORDER BY f.promoted_at DESC)[1:8])::VARCHAR
     FROM semantic_facts f JOIN semantic_entities e ON e.entity_id = f.entity_id) AS recent`;

function summary(n: { working: number; archive: number; entities: number; facts: number; blocked: number }, facts: HarnessMemory["facts"]): HarnessMemory {
  return {
    counts: { working: n.working, archive: n.archive, entities: n.entities, facts: n.facts },
    layers: [
      { layer: "working", rows: String(n.working), detail: "current goal / next-step / blockers per run" },
      { layer: "archive", rows: String(n.archive), detail: "raw source-of-truth spans (immutable)" },
      { layer: "semantic", rows: `${n.facts} facts / ${n.entities} entities`, detail: "promoted facts w/ provenance + trust" },
    ],
    facts,
    gate: { promoted: n.facts, blocked: n.blocked },
  };
}

/** Build the dashboard summary over an OPEN handle (the writer's, or a read-only one). One statement,
 *  one snapshot; when it fails (a partial schema is missing a table) each figure is read on its own
 *  and a missing table counts as 0 rows. */
export async function snapshotHarnessMemory(db: Db): Promise<HarnessMemory> {
  try {
    const r = await db.get(SNAPSHOT_SQL);
    if (r) {
      const recent = typeof r.recent === "string" ? (JSON.parse(r.recent) as unknown) : [];
      const facts = (Array.isArray(recent) ? recent : []).map((x) => {
        const f = asRecord(x) ?? {};
        return { entity: String(f.entity ?? ""), statement: String(f.statement ?? ""), trust_label: String(f.trust_label ?? "") };
      });
      return summary({ working: Number(r.working ?? 0), archive: Number(r.archive ?? 0), entities: Number(r.entities ?? 0), facts: Number(r.facts ?? 0), blocked: Number(r.blocked ?? 0) }, facts);
    }
  } catch { /* partial schema: fall through to per-figure reads */ }
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
  return summary({ working, archive, entities, facts, blocked }, factRows);
}

/** Refresh the mirror from the writer's own handle. Atomic (tmp + rename) so a reader never sees a
 *  torn file; best-effort - a mirror failure must never affect the gate or the session. */
export async function writeHarnessMirror(db: Db, dbPath: string): Promise<void> {
  try {
    const memory = await snapshotHarnessMemory(db);
    const path = mirrorPathFor(dbPath);
    const tmp = `${path}.tmp-${process.pid}`;
    // Async I/O: this runs inside the gate process, and a synchronous write/rename would stall every
    // security hook behind a slow disk or an antivirus scan of the new file.
    await writeFile(tmp, JSON.stringify({ generated_at: new Date().toISOString(), memory }));
    await rename(tmp, path);
  } catch {
    await rm(`${mirrorPathFor(dbPath)}.tmp-${process.pid}`, { force: true }).catch(() => { /* ignore */ });
  }
}

/** Runtime narrowing for the parsed mirror file (outside-controlled bytes): reads become `unknown`
 *  field lookups on a plain record, coerced explicitly below - never a fabricated typed shape. */
function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Read the mirror when the DuckDB open is refused (or the DB is absent). Null on a missing,
 *  torn, or shape-invalid file - the caller renders its honest empty state then. */
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
