// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/latency_log.test.ts — P-EVAL.2 (ADR-0187): the GUI-side latency capture sink.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordLatency, type LatencyCapture } from "./latency_log.ts";
import type { LatencySample } from "../harness/memory/latency_ingest.ts";

let dir: string;
let logPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "latlog-"));
  logPath = join(dir, "lucid-latency.jsonl");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function readLines(): LatencySample[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as LatencySample);
}

const base: LatencyCapture = { model: "claude-opus-4-8", sessionId: "s1", tSent: 1_000, tFirstToken: 1_250, tEnd: 4_000, ok: true };

test("computes ttft + total from the three timestamps", () => {
  const s = recordLatency(base, { logPath });
  expect(s).not.toBeNull();
  expect(s!.ttftMs).toBe(250);   // 1250 - 1000
  expect(s!.totalMs).toBe(3000); // 4000 - 1000
  expect(s!.model).toBe("claude-opus-4-8");
  expect(s!.ts).toBe(1_000);
  expect(s!.ok).toBe(true);
  expect(typeof s!.id).toBe("string");
  expect(s!.id.length).toBeGreaterThan(0);
});

test("appends one JSONL line per capture", () => {
  recordLatency(base, { logPath });
  recordLatency({ ...base, tSent: 2_000, tEnd: 5_000 }, { logPath });
  const lines = readLines();
  expect(lines.length).toBe(2);
  expect(lines[0]!.id).not.toBe(lines[1]!.id); // stable, distinct ids
});

test("a turn with no first token records ttft=0 (never negative)", () => {
  const s = recordLatency({ ...base, tFirstToken: null }, { logPath });
  expect(s!.ttftMs).toBe(0);
  expect(s!.totalMs).toBe(3000);
});

test("carries optional token/cost provenance only when present", () => {
  const withUsage = recordLatency({ ...base, tokensIn: 42_000, costUsd: 0.63 }, { logPath });
  expect(withUsage!.tokensIn).toBe(42_000);
  expect(withUsage!.costUsd).toBe(0.63);
  const without = recordLatency(base, { logPath });
  expect(without!.tokensIn).toBeUndefined();
  expect(without!.costUsd).toBeUndefined();
});

test("a failed turn is recorded ok=false", () => {
  const s = recordLatency({ ...base, ok: false }, { logPath });
  expect(s!.ok).toBe(false);
});

test("guards a malformed capture (no model / non-finite time) and writes nothing", () => {
  expect(recordLatency({ ...base, model: "" }, { logPath })).toBeNull();
  expect(recordLatency({ ...base, tSent: NaN }, { logPath })).toBeNull();
  expect(recordLatency({ ...base, tEnd: Infinity }, { logPath })).toBeNull();
  expect(readLines().length).toBe(0); // nothing appended on a guarded capture
});
