// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_peval2.ts
//
// P-EVAL.2 (ADR-0187): the API-latency CAPTURE + PERSISTENCE pipeline. Proves, offline, the full path
// the live chat seam takes:
//   [1] the GUI-side sink (recordLatency) turns three timestamps (t_sent / t_first_token / t_end) into a
//       LatencySample and appends it to an append-only JSONL — the GUI can't co-write the read-only DB,
//   [2] the frozen migration 0011 creates api_latency + eval_metrics + the latency_rollup view,
//   [3] the single-writer ingest loads the JSONL into api_latency, IDEMPOTENTLY (re-ingest inserts 0),
//   [4] readLatencyCalls round-trips the rows back into evals.ts's ApiLatencyCall (ts as UNIX ms), which
//       feeds rollupLatency + renderLatencyRollupMarkdown UNCHANGED (P-EVAL.1 stays the source of truth),
//   [5] the latency_rollup view aggregates ok calls per model+hour for a quick server-side dashboard.
//
// Run with: bun run harness/scripts/demo_peval2.ts

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../memory/db.ts";
import { ingestLatency, readLatencyCalls } from "../memory/latency_ingest.ts";
import { recordLatency } from "../../desktop/latency_log.ts";
import { rollupLatency, renderLatencyRollupMarkdown } from "../brief/evals.ts";

function fail(m: string): never { console.error(`FAIL: ${m}`); process.exit(1); }
function ok(m: string): void { console.log(`  PASS  ${m}`); }

console.log("P-EVAL.2 demo - API-latency capture + persistence pipeline\n");

const dir = mkdtempSync(join(tmpdir(), "peval2-"));
const jsonl = join(dir, "lucid-latency.jsonl");
const jul = (h: number, min = 0): number => Date.UTC(2026, 6, 15, h, min); // 2026-07-15; 14 UTC = 10:00 ET

try {
  const db = await Db.open(join(dir, "obs.duckdb"));

  // [2] the frozen migration applied
  if (!(await db.appliedVersions()).includes(11)) fail("migration 0011 not applied");
  for (const rel of ["api_latency", "eval_metrics", "latency_rollup"]) {
    if ((await db.get(`SELECT count(*)::INT AS n FROM ${rel}`))?.n !== 0) fail(`${rel} not queryable/empty at start`);
  }
  ok("migration 0011: api_latency + eval_metrics tables + latency_rollup view created (frozen contract)");

  // [1] the GUI-side sink: three timestamps -> a JSONL sample. One turn stalled (ok=false).
  const s1 = recordLatency({ model: "claude-opus-4-8", sessionId: "s1", tSent: jul(13), tFirstToken: jul(13) + 520, tEnd: jul(13) + 3100, ok: true, tokensIn: 41_000, costUsd: 0.42 }, { logPath: jsonl });
  recordLatency({ model: "claude-opus-4-8", sessionId: "s1", tSent: jul(13, 5), tFirstToken: jul(13, 5) + 640, tEnd: jul(13, 5) + 3200, ok: true }, { logPath: jsonl });
  recordLatency({ model: "claude-opus-4-8", sessionId: "s1", tSent: jul(13, 9), tFirstToken: null, tEnd: jul(13, 9) + 120_000, ok: false }, { logPath: jsonl }); // stalled -> no token, ok=false
  recordLatency({ model: "haiku-4-5", sessionId: "s2", tSent: jul(13, 2), tFirstToken: jul(13, 2) + 180, tEnd: jul(13, 2) + 800, ok: true }, { logPath: jsonl });
  if (!s1 || s1.ttftMs !== 520 || s1.totalMs !== 3100) fail("sink computed ttft/total wrong");
  ok("sink: t_sent/t_first_token/t_end -> LatencySample (ttft 520ms, total 3100ms) appended to JSONL; a stall records ok=false, ttft 0");

  // [3] ingest -> api_latency, idempotent
  const first = await ingestLatency(db, jsonl);
  if (first.inserted !== 4 || first.skipped !== 0) fail(`ingest expected 4 inserted, got ${first.inserted}/${first.skipped}`);
  const again = await ingestLatency(db, jsonl);
  if (again.inserted !== 0 || again.duplicates !== 4) fail("re-ingest not idempotent");
  ok("ingest: 4 samples -> api_latency; re-ingesting the same file inserts 0 (id is the dedup key)");

  // [4] readback -> ApiLatencyCall -> the P-EVAL.1 rollup, unchanged. Defaults to ok-only (the stall
  // is a failure, not a latency measurement), so 3 of the 4 rows feed the rollup.
  const calls = await readLatencyCalls(db);
  if (calls.length !== 3) fail(`readback should be ok-only (3), got ${calls.length}`);
  if (calls.some((c) => c.ok === false)) fail("ok-only readback leaked a failed turn");
  if ((await readLatencyCalls(db, { includeFailed: true })).length !== 4) fail("includeFailed should read all 4");
  if (calls[0]!.ts !== jul(13) || calls[0]!.ttftMs !== 520) fail("ts did not round-trip to UNIX ms");
  const roll = rollupLatency(calls, { period: "weekly", periodStart: jul(0), metric: "ttft" });
  if (roll.models.map((m) => m.model).join() !== "claude-opus-4-8,haiku-4-5") fail("rollup not sorted by volume");
  if (roll.models[0]!.calls !== 2) fail("the stalled opus turn should be excluded from the rollup");
  const md = renderLatencyRollupMarkdown(roll);
  if (!md.includes("xychart-beta") || /[^\x00-\x7F]/.test(md)) fail("rollup markdown missing chart or not ASCII-safe");
  ok("readback: ok-only (stall excluded) -> ApiLatencyCall (ts UNIX ms) -> rollupLatency + render unchanged; includeFailed reads all");

  // [5] the view: ok calls only, per model+hour
  const view = await db.all("SELECT model, calls FROM latency_rollup ORDER BY calls DESC");
  const opus = view.find((r) => r.model === "claude-opus-4-8");
  if (Number(opus?.calls) !== 2) fail(`view should count 2 ok opus calls (the stall excluded), got ${opus?.calls}`);
  ok("latency_rollup view: aggregates ok calls per model+hour (the stalled turn is excluded)");

  console.log("\n--- sample latency rollup (from persisted rows) ---\n");
  console.log(md);

  db.close();
  console.log("\nP-EVAL.2 demo complete - captured at the seam, persisted via the single-writer ingest, read back into the P-EVAL.1 rollup.");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
