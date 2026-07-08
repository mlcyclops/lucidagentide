// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/latency_log.ts — P-EVAL.2 (ADR-0187): GUI-owned per-turn API-latency capture.
//
// WHY THIS EXISTS: the one place that observes a whole model turn (t_sent -> first token -> end) is the
// GUI's acp_backend.prompt() stream. But the GUI process can't co-write agent_obs.duckdb (the omp child
// holds that single writer), so — exactly like turns_log.ts / security_log.ts — samples are appended
// HERE to an append-only JSONL (~/.omp/lucid-latency.jsonl); the single writer ingests them into the
// api_latency table (harness/memory/latency_ingest.ts) for the per-model p50/p95 rollup (evals.ts).
//
// Best-effort + fail-open: a write failure NEVER breaks or slows the chat turn. Metadata only — no prompt
// or reply text is ever recorded here (only timings, model, token counts, cost).

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { Snowflake } from "@oh-my-pi/pi-utils";
import type { LatencySample } from "../harness/memory/latency_ingest.ts";

const LOG_PATH = join(homedir(), ".omp", "lucid-latency.jsonl");

/** What acp_backend hands us at turn end. Timestamps are UNIX ms; tFirstToken is null if none arrived. */
export interface LatencyCapture {
  model: string;
  sessionId?: string;
  tSent: number;
  tFirstToken: number | null;
  tEnd: number;
  ok: boolean;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
}

/** Record one turn's latency. Fully guarded — any failure is swallowed so the chat is never affected.
 *  `logPath` is injectable for tests. Returns the written sample (or null if nothing was recorded). */
export function recordLatency(c: LatencyCapture, opts: { logPath?: string } = {}): LatencySample | null {
  try {
    if (!c.model || !Number.isFinite(c.tSent) || !Number.isFinite(c.tEnd)) return null;
    const sample: LatencySample = {
      id: Snowflake.next(),
      model: c.model,
      ts: c.tSent,
      ttftMs: c.tFirstToken != null ? Math.max(0, c.tFirstToken - c.tSent) : 0,
      totalMs: Math.max(0, c.tEnd - c.tSent),
      ok: c.ok,
      tokensIn: c.tokensIn != null ? Math.trunc(c.tokensIn) : undefined,
      tokensOut: c.tokensOut != null ? Math.trunc(c.tokensOut) : undefined,
      costUsd: c.costUsd != null ? c.costUsd : undefined,
      sessionId: c.sessionId || undefined,
    };
    const path = opts.logPath ?? LOG_PATH;
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(sample) + "\n");
    return sample;
  } catch {
    return null; // audit is best-effort; never break the chat on a capture failure
  }
}

export { LOG_PATH as LATENCY_LOG_PATH };
