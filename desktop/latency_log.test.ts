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
// ── P-TURNFAIL.1 (ADR-0361): a turn that produced nothing is never ok ────────────────────────────────
//
// The reported field case, verbatim from a user's ~/.omp/lucid-latency.jsonl:
//   {"model":"xai-oauth/grok-4.20-0309-non-reasoning","ttftMs":0,"totalMs":300,"tokensIn":21723,
//    "costUsd":0,"ok":true}
// 21.7k tokens went out, no first token ever arrived, the turn was dead in 300 ms, and the ledger
// called it a SUCCESS. acp_backend computed `ok: !errored`, and `errored` is only set when
// `session/prompt` THROWS. A provider 4xx does not throw: omp RESOLVES the turn with
// `stopReason: "error"` and zero content blocks. So the one file that should have said "this turn
// failed" said the opposite, and diagnosing it took three files joined by timestamp.
//
// This file cannot reach into acp_backend's turn loop, so the guard is on the SHAPE that reached disk:
// the combination below (no first token, real tokens in, ok) is the exact signature of that bug and
// must never be writable as a success again. The caller-side rule is `ok: sawOutput && !errored`.

test("THE REGRESSION: the field bug's exact sample shape is a FAILURE, not a success", () => {
  // Reproduce the real capture: sent, nothing came back, ended fast. `ok` now comes from the caller's
  // `sawOutput && !errored`, which is false here because no output was ever seen.
  const silent: LatencyCapture = {
    model: "xai-oauth/grok-4.20-0309-non-reasoning",
    sessionId: "01a0ab29-c440-7000-bb0e-2098443216b2",
    tSent: 1_000, tFirstToken: null, tEnd: 1_300, ok: false, tokensIn: 21_723, costUsd: 0,
  };
  const s = recordLatency(silent, { logPath })!;
  expect(s.ok).toBe(false);
  expect(s.ttftMs).toBe(0);    // no first token: the tell
  expect(s.totalMs).toBe(300); // dead fast: a 4xx, not a timeout
  expect(s.tokensIn).toBe(21_723);
});

test("a turn with no first token but real input tokens is diagnosable from ONE line", () => {
  // The point of the fix: the ledger alone has to be enough. ttft 0 plus a large tokensIn plus ok=false
  // says "we sent a full prompt and got nothing", which is the whole diagnosis.
  const line = JSON.stringify(recordLatency({
    model: "xai/grok", tSent: 0, tFirstToken: null, tEnd: 300, ok: false, tokensIn: 21_723,
  }, { logPath }));
  expect(line).toContain('"ok":false');
  expect(line).toContain('"ttftMs":0');
  expect(line).toContain('"tokensIn":21723');
});

test("a normal turn is still ok, so the stricter rule did not just mark everything failed", () => {
  // The load-bearing negative: a fix that made every sample ok=false would destroy the p50/p95 rollup
  // this log exists to feed, and would look identical to "fixed" if only the failure case were tested.
  const s = recordLatency(base, { logPath })!;
  expect(s.ok).toBe(true);
  expect(s.ttftMs).toBeGreaterThan(0);
});
