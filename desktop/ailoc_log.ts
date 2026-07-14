// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/ailoc_log.ts — P-LOC.4 (ADR-0211): the WRITE side of the GUI-owned AI-authored-LOC ledger.
//
// WHY THIS EXISTS: AI-LOC was recorded ONLY into agent_obs.duckdb by the security gate (P-LOC.1), which
// runs inside the omp child and holds that DuckDB file open READ-WRITE for the whole session. DuckDB is a
// single-writer store — a second process opening it (even READ_ONLY) is refused with a lock conflict — so
// the desktop's read-only `aiLocSummary()` always failed, swallowed the error to null, and the "AI-authored
// code" panel showed "none yet" even though the rows were in the DB. (Confirmed: "Could not set lock on
// file … Conflicting lock is held".) The DuckDB write stays as the BI/audit system-of-record; this ledger
// is the LIVE-readable mirror, exactly like turns_log.ts / security_log.ts / latency_log.ts: the desktop
// observes every edit/write on the ACP stream (it already parses the authored `code` for the inline chip),
// counts lines with the SAME linediff convention the chip uses, and appends a sample. The dashboard reads
// the ledger via ailoc_read.ts — no lock contention.
//
// Best-effort + fail-open: a write failure NEVER breaks or slows the chat. Metadata only — repo/file PATHS
// and line COUNTS, never the authored code text.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { diffStat, lineDiff, patchStat } from "./renderer/linediff.ts";
import { AILOC_LOG_PATH, type AiLocSample } from "./ailoc_read.ts";

/** The authored code of a write/edit tool step — the same shape the chat chip sizes its diffstat from. */
export interface AiLocCode { content?: string; oldText?: string; newText?: string; patch?: string }

/** What acp_backend hands us when the agent wrote/edited a file through the gate. */
export interface AiLocCapture {
  model: string;
  identity: string;
  identitySource: string;
  repo: string;
  filePath?: string;
  tool: string;
  code: AiLocCode;
  sessionId?: string;
}

function countLines(s: string): number {
  if (!s) return 0;
  const n = s.split("\n").length;
  return s.endsWith("\n") ? n - 1 : n; // a trailing newline is a terminator, not an extra line
}

/** Added/removed lines from a tool step's authored code — a hashline `patch`, a written `content` (all
 *  additions), or an old→new pair (line diff). Reuses the P-CHAT.1 linediff helpers so the ledger and the
 *  chat chip agree on one diffstat convention. Returns {0,0} when there's nothing countable. */
export function countCode(code: AiLocCode): { added: number; removed: number } {
  if (!code) return { added: 0, removed: 0 };
  if (code.patch !== undefined) { const s = patchStat(code.patch); return { added: s.add, removed: s.del }; }
  if (code.content !== undefined) return { added: countLines(code.content), removed: 0 };
  if (code.oldText !== undefined || code.newText !== undefined) {
    const s = diffStat(lineDiff(code.oldText ?? "", code.newText ?? ""));
    return { added: s.add, removed: s.del };
  }
  return { added: 0, removed: 0 };
}

/** Record one AI-authored edit. Fully guarded — any failure is swallowed so the chat is never affected.
 *  A no-op (returns null) when the edit counts zero lines (read/search/bash, or an empty change). `logPath`
 *  is injectable for tests. */
export function recordAiLoc(c: AiLocCapture, opts: { logPath?: string } = {}): AiLocSample | null {
  try {
    const { added, removed } = countCode(c.code);
    if (added === 0 && removed === 0) return null;
    const sample: AiLocSample = {
      id: Snowflake.next(),
      ts: Date.now(),
      model: c.model && c.model.length > 0 ? c.model : "unknown",
      identity: c.identity || "unknown",
      identitySource: c.identitySource || "unknown",
      repo: c.repo || "",
      filePath: c.filePath ?? null,
      tool: c.tool || "edit",
      added,
      removed,
      sessionId: c.sessionId || undefined,
    };
    const path = opts.logPath ?? AILOC_LOG_PATH;
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(sample) + "\n");
    return sample;
  } catch {
    return null; // provenance is best-effort; never break the chat on a capture failure
  }
}
