// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/memory/latency_ingest.ts
//
// P-EVAL.2 (ADR-0187): load the GUI-captured API-latency samples (lucid-latency.jsonl, written at
// the chat seam by desktop/latency_log.ts) into the api_latency table (migration 0011). The GUI opens
// agent_obs.duckdb READ-ONLY — the single writer ingests here, exactly like telemetry events.jsonl ->
// telemetry_events (ingest_jsonl.ts). Idempotent: `id` is the PK, so re-ingesting inserts zero new rows.
// Malformed / incomplete lines are COUNTED (skipped), never silently dropped.
//
// readLatencyCalls() reads the persisted rows back into evals.ts's ApiLatencyCall shape (ts as UNIX ms),
// which is what rollupLatency() consumes — so the persisted schema and the pure rollup stay in lockstep.

import { readFileSync } from "node:fs";
import type { Db } from "./db.ts";
import type { ApiLatencyCall } from "../brief/evals.ts";

/** One captured turn's latency, as written to lucid-latency.jsonl. `ts` is UNIX ms (t_sent). */
export interface LatencySample {
  id: string;
  model: string;
  ts: number;       // UNIX ms — when the prompt was sent (t_sent)
  ttftMs: number;   // t_first_token - t_sent (0 when no token arrived)
  totalMs: number;  // t_end - t_sent
  ok: boolean;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  sessionId?: string;
}

export interface IngestStats {
  processed: number; // valid samples seen
  inserted: number;  // newly written (deduped on id)
  duplicates: number;
  skipped: number;   // malformed / missing a required field
}

async function count(db: Db): Promise<number> {
  const r = await db.get("SELECT count(*)::INT AS n FROM api_latency");
  return Number(r?.n ?? 0);
}

function validSample(s: unknown): s is LatencySample {
  if (!s || typeof s !== "object") return false;
  const o = s as Record<string, unknown>;
  return typeof o.id === "string" && o.id.length > 0
    && typeof o.model === "string"
    && typeof o.ts === "number" && Number.isFinite(o.ts)
    && typeof o.ttftMs === "number" && Number.isFinite(o.ttftMs)
    && typeof o.totalMs === "number" && Number.isFinite(o.totalMs)
    && typeof o.ok === "boolean";
}

/** Ingest every latency sample from `jsonlPath` into api_latency. Idempotent on `id`. */
export async function ingestLatency(db: Db, jsonlPath: string): Promise<IngestStats> {
  const text = readFileSync(jsonlPath, "utf8");
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const before = await count(db);
  let processed = 0;
  let skipped = 0;
  const ingestedAt = new Date().toISOString();

  for (const line of lines) {
    let s: LatencySample;
    try {
      const parsed = JSON.parse(line);
      if (!validSample(parsed)) { skipped++; continue; }
      s = parsed;
    } catch { skipped++; continue; }
    try {
      await db.run(
        `INSERT OR IGNORE INTO api_latency
           (id, model, ts, ttft_ms, total_ms, ok, tokens_in, tokens_out, cost_usd, session_id, ingested_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          s.id,
          s.model,
          new Date(s.ts).toISOString(), // UNIX ms -> ISO; DuckDB stores as (UTC) TIMESTAMP
          Math.max(0, Math.trunc(s.ttftMs)),
          Math.max(0, Math.trunc(s.totalMs)),
          s.ok,
          s.tokensIn != null ? Math.trunc(s.tokensIn) : null,
          s.tokensOut != null ? Math.trunc(s.tokensOut) : null,
          s.costUsd != null ? Number(s.costUsd) : null,
          s.sessionId ?? null,
          ingestedAt,
        ],
      );
    } catch { skipped++; continue; } // a row that fails to insert never aborts the rest
    processed++;
  }

  const inserted = (await count(db)) - before;
  return { processed, inserted, duplicates: processed - inserted, skipped };
}

/** Read persisted latency rows back into evals.ts's ApiLatencyCall shape (ts as UNIX ms), ordered by
 *  send time. Defaults to SUCCESSFUL turns only (a stall is a failure, not a latency measurement, and
 *  rollupLatency does not filter on `ok`) — matching the latency_rollup view; pass includeFailed to also
 *  read errored turns (e.g. for an error-rate report). Optional [sinceMs, untilMs) window scopes a period. */
export async function readLatencyCalls(
  db: Db,
  opts: { sinceMs?: number; untilMs?: number; includeFailed?: boolean } = {},
): Promise<ApiLatencyCall[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (!opts.includeFailed) where.push("ok");
  if (opts.sinceMs != null) { params.push(new Date(opts.sinceMs).toISOString()); where.push(`ts >= $${params.length}`); }
  if (opts.untilMs != null) { params.push(new Date(opts.untilMs).toISOString()); where.push(`ts < $${params.length}`); }
  const rows = await db.all(
    `SELECT model, epoch_ms(ts) AS ts_ms, ttft_ms, total_ms, ok FROM api_latency
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY ts`,
    params,
  );
  return rows.map((r) => ({
    model: String(r.model),
    ts: Number(r.ts_ms),
    ttftMs: Number(r.ttft_ms),
    totalMs: Number(r.total_ms),
    ok: Boolean(r.ok),
  }));
}
