// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/memory/latency_ingest.test.ts — P-EVAL.2 (ADR-0187): api_latency ingest + readback.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "./db.ts";
import { ingestLatency, readLatencyCalls, type LatencySample } from "./latency_ingest.ts";
import { rollupLatency } from "../brief/evals.ts";

let dir: string;
let db: Db;
let jsonl: string;

// 2026-07-07 is a Tuesday; 14:00 UTC = 10:00 ET (business hours), a stable anchor.
const T0 = Date.parse("2026-07-07T14:00:00.000Z");

function sample(i: number, over: Partial<LatencySample> = {}): LatencySample {
  return {
    id: `lat-${i}`, model: "claude-opus-4-8", ts: T0 + i * 60_000,
    ttftMs: 400 + i * 10, totalMs: 3000 + i * 100, ok: true,
    tokensIn: 40_000, costUsd: 0.5, sessionId: "s1", ...over,
  };
}

function writeJsonl(samples: LatencySample[]): void {
  writeFileSync(jsonl, samples.map((s) => JSON.stringify(s)).join("\n") + "\n");
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "latingest-"));
  db = await Db.open(join(dir, "t.duckdb"));
  jsonl = join(dir, "lucid-latency.jsonl");
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

test("migration 0011 created api_latency + eval_metrics + the latency_rollup view", async () => {
  const applied = await db.appliedVersions();
  expect(applied).toContain(11);
  // both tables + the view are queryable
  expect((await db.get("SELECT count(*)::INT AS n FROM api_latency"))?.n).toBe(0);
  expect((await db.get("SELECT count(*)::INT AS n FROM eval_metrics"))?.n).toBe(0);
  expect((await db.get("SELECT count(*)::INT AS n FROM latency_rollup"))?.n).toBe(0);
});

test("ingests samples into api_latency", async () => {
  writeJsonl([sample(0), sample(1), sample(2)]);
  const stats = await ingestLatency(db, jsonl);
  expect(stats.inserted).toBe(3);
  expect(stats.skipped).toBe(0);
  const row = await db.get("SELECT model, ttft_ms, total_ms, ok FROM api_latency WHERE id='lat-0'");
  expect(row?.model).toBe("claude-opus-4-8");
  expect(Number(row?.ttft_ms)).toBe(400);
  expect(Number(row?.total_ms)).toBe(3000);
  expect(Boolean(row?.ok)).toBe(true);
});

test("ingestion is idempotent on id", async () => {
  writeJsonl([sample(0), sample(1)]);
  expect((await ingestLatency(db, jsonl)).inserted).toBe(2);
  const again = await ingestLatency(db, jsonl);
  expect(again.inserted).toBe(0);
  expect(again.duplicates).toBe(2);
});

test("malformed / incomplete lines are skipped, not dropped silently", async () => {
  writeFileSync(jsonl, [
    "{ not json",
    JSON.stringify(sample(0)),
    JSON.stringify({ id: "x", model: "m", ts: T0 }),          // missing ttftMs/totalMs/ok
    JSON.stringify({ ...sample(1), ok: "yes" }),               // wrong type for ok
    "",
  ].join("\n"));
  const stats = await ingestLatency(db, jsonl);
  expect(stats.inserted).toBe(1);
  expect(stats.skipped).toBe(3);
});

test("readLatencyCalls round-trips ts to UNIX ms and yields ApiLatencyCall shape", async () => {
  writeJsonl([sample(0), sample(1)]);
  await ingestLatency(db, jsonl);
  const calls = await readLatencyCalls(db);
  expect(calls.length).toBe(2);
  expect(calls[0]).toEqual({ model: "claude-opus-4-8", ts: T0, ttftMs: 400, totalMs: 3000, ok: true });
  // the readback feeds evals.ts rollupLatency without any adaptation
  const roll = rollupLatency(calls, { period: "weekly", periodStart: Date.parse("2026-07-06T00:00:00Z"), metric: "ttft" });
  expect(roll.models.length).toBe(1);
  expect(roll.models[0]!.model).toBe("claude-opus-4-8");
  expect(roll.models[0]!.calls).toBe(2);
});

test("the latency_rollup view aggregates ok calls per model+hour", async () => {
  // 3 ok calls in one UTC hour + 1 failed (excluded by the view's WHERE ok)
  writeJsonl([sample(0), sample(1), sample(2), sample(3, { ok: false })]);
  await ingestLatency(db, jsonl);
  const rows = await db.all("SELECT model, calls FROM latency_rollup ORDER BY hour_bucket");
  expect(rows.length).toBe(1);
  expect(Number(rows[0]!.calls)).toBe(3); // the failed call is excluded
});

test("readLatencyCalls is ok-only by default; includeFailed reads errored turns too", async () => {
  writeJsonl([sample(0), sample(1, { ok: false }), sample(2)]);
  await ingestLatency(db, jsonl);
  const okOnly = await readLatencyCalls(db);
  expect(okOnly.length).toBe(2);
  expect(okOnly.every((c) => c.ok)).toBe(true);
  const all = await readLatencyCalls(db, { includeFailed: true });
  expect(all.length).toBe(3);
});

test("a window read scopes to [sinceMs, untilMs)", async () => {
  writeJsonl([sample(0), sample(1), sample(2)]);
  await ingestLatency(db, jsonl);
  const mid = await readLatencyCalls(db, { sinceMs: T0 + 60_000, untilMs: T0 + 120_000 });
  expect(mid.length).toBe(1);
  expect(mid[0]!.ts).toBe(T0 + 60_000);
});
