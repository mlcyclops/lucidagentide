// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/telemetry/ingest_jsonl.ts
//
// Ingest the telemetry JSONL stream (events.jsonl) into DuckDB's telemetry_events
// table (P3.2), making security events queryable + replayable. Idempotent:
// event_id is the PK, so re-ingesting the same file inserts zero new rows.
// Malformed/incomplete lines are COUNTED (skipped), never silently dropped.

import { readFileSync } from "node:fs";
import type { Db } from "../memory/db.ts";

const PROMOTED = new Set(["event_id", "ts", "event", "run_id", "session_id", "artifact_id"]);

export interface IngestStats {
  processed: number; // valid events seen
  inserted: number; // newly written (deduped)
  duplicates: number; // already present
  skipped: number; // malformed / missing required envelope fields
}

async function count(db: Db): Promise<number> {
  const r = await db.get("SELECT count(*)::INT AS n FROM telemetry_events");
  return Number(r?.n ?? 0);
}

/** Ingest every event line from `jsonlPath` into telemetry_events. */
export async function ingestTelemetryJsonl(db: Db, jsonlPath: string): Promise<IngestStats> {
  const text = readFileSync(jsonlPath, "utf8");
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const before = await count(db);
  let processed = 0;
  let skipped = 0;
  const ingestedAt = new Date().toISOString();

  for (const line of lines) {
    let ev: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== "object") {
        skipped++;
        continue;
      }
      ev = parsed as Record<string, unknown>;
    } catch {
      skipped++;
      continue;
    }
    const { event_id, ts, event, run_id, session_id, artifact_id } = ev;
    if (![event_id, ts, event, run_id, session_id].every((v) => typeof v === "string")) {
      skipped++; // missing required envelope field
      continue;
    }
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(ev)) if (!PROMOTED.has(k)) fields[k] = v;
    try {
      await db.run(
        `INSERT OR IGNORE INTO telemetry_events
           (event_id, ts, event, run_id, session_id, artifact_id, fields, ingested_at)
         VALUES ($1,$2,$3,$4,$5,$6,CAST($7 AS JSON),$8)`,
        [
          event_id as string,
          ts as string,
          event as string,
          run_id as string,
          session_id as string,
          (typeof artifact_id === "string" ? artifact_id : null),
          JSON.stringify(fields),
          ingestedAt,
        ],
      );
    } catch {
      // a row that fails to insert (e.g. a non-timestamp ts) is skipped and
      // counted — never aborts ingestion of the rest of the file.
      skipped++;
      continue;
    }
    processed++;
  }

  const inserted = (await count(db)) - before;
  return { processed, inserted, duplicates: processed - inserted, skipped };
}
