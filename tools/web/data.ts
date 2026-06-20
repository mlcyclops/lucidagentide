// tools/web/data.ts
//
// JSON snapshots for the web dashboard. The SECURITY snapshot reuses the exact
// SQL in harness/dashboards/views.ts (single source of truth for the dashboard
// contract) via a READ_ONLY DuckDB adapter — so the browser can never contend
// with the live gate's writer, and can never see raw_content (the views only
// ever select metadata). The MEMORY snapshot comes from tools/memory_data.ts.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import type { Db } from "../../harness/memory/db.ts";
import * as views from "../../harness/dashboards/views.ts";
import { OBS_DB_PATH, memorySnapshot, type MemorySnapshot } from "../memory_data.ts";

export { memorySnapshot, type MemorySnapshot };

/** Convert BigInt → number and any non-plain object (e.g. DuckDB timestamps) →
 *  string so every row serializes cleanly to JSON. */
function clean(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((r) => {
    const o: Record<string, unknown> = {};
    for (const k in r) {
      const v = r[k];
      o[k] = typeof v === "bigint" ? Number(v) : v && typeof v === "object" && !Array.isArray(v) ? String(v) : v;
    }
    return o;
  });
}

/** A minimal READ_ONLY object shaped like `Db` — the views only ever call .all(). */
async function openReadOnly(path: string) {
  const instance = await DuckDBInstance.create(path, { access_mode: "READ_ONLY" });
  const conn = await instance.connect();
  const all = async (sql: string, params?: unknown[]) =>
    ((params === undefined ? await conn.runAndReadAll(sql) : await conn.runAndReadAll(sql, params as never)).getRowObjects() as Record<string, unknown>[]);
  const dbLike = { all, get: async (sql: string, p?: unknown[]) => (await all(sql, p))[0] } as unknown as Db;
  return { dbLike, close: () => { conn.closeSync(); instance.closeSync(); } };
}

export interface SecuritySnapshot {
  findings: Record<string, unknown>[];
  unicode: Record<string, unknown>[];
  approvals: Record<string, unknown>[];
  quarantine: Record<string, unknown>[];
  promotion: Record<string, unknown>[];
  exports: Record<string, unknown>[];
  runs: Record<string, unknown>[];
}

/** Read-only security dashboard snapshot from agent_obs.duckdb (null if absent). */
export async function securitySnapshot(): Promise<SecuritySnapshot | null> {
  const dbPath = join(import.meta.dir, "..", "..", "agent_obs.duckdb");
  if (!existsSync(dbPath)) return null;
  let ro: Awaited<ReturnType<typeof openReadOnly>> | undefined;
  try {
    ro = await openReadOnly(dbPath);
    const { dbLike } = ro;
    return {
      findings: clean(await views.findingsOverview(dbLike)),
      unicode: clean(await views.unicodeAnalysis(dbLike)),
      approvals: clean(await views.approvalQueue(dbLike)),
      quarantine: clean(await views.quarantineReview(dbLike)),
      promotion: clean(await views.memoryPromotionRisk(dbLike)),
      exports: clean(await views.exportAudit(dbLike)),
      runs: clean(await views.activeRuns(dbLike)),
    };
  } catch {
    return null; // missing schema or held read-write by the live gate
  } finally {
    ro?.close();
  }
}

export interface DevSnapshot {
  telemetry: Record<string, unknown>[];
  runs: Record<string, unknown>[];
  exports: Record<string, unknown>[];
}

/** ADR-0009 Phase D: read-only developer-logging snapshot from agent_obs.duckdb (null if absent).
 *  Metadata only (the views never select raw content). The caller gates on Developer mode. */
export async function devSnapshot(): Promise<DevSnapshot | null> {
  const dbPath = join(import.meta.dir, "..", "..", "agent_obs.duckdb");
  if (!existsSync(dbPath)) return null;
  let ro: Awaited<ReturnType<typeof openReadOnly>> | undefined;
  try {
    ro = await openReadOnly(dbPath);
    const { dbLike } = ro;
    return {
      telemetry: clean(await views.telemetryStream(dbLike)),
      runs: clean(await views.activeRuns(dbLike)),
      exports: clean(await views.exportAudit(dbLike)),
    };
  } catch {
    return null;
  } finally {
    ro?.close();
  }
}

export const OBS_DB = OBS_DB_PATH;
