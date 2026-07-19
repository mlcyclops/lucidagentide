// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/omp/block_log.ts
//
// P-NVIM.7: the security gate's lock-free block mirror. On a block, the gate (security_extension.ts) calls
// mirrorBlock, which — WHEN the launcher opts in via LUCID_BLOCK_LOG — appends one metadata line to a
// JSONL the `lucid blocks` CLL / :LucidBlocks read (~/.omp/lucid-blocks.jsonl by default). This lets a
// block be listed DURING a live session, when the gate holds agent_obs.duckdb read-write (a cross-process
// READ_ONLY open of that DB fails). The desktop GUI records blocks its own way and does NOT set the env,
// so it never double-writes.
//
// Kept in its OWN module (no scanner/omp imports) so it is cheap + unit-testable without starting the
// scanner sidecar that importing security_extension.ts would. FAIL-SAFE by construction: every write is
// env-gated + wrapped, and the caller invokes it AFTER the (already-made) block decision — it can never
// throw into, or alter, the gate's fail-closed decision. Metadata only — never raw scanned content.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

const SEVERITY_ORDER = ["info", "low", "medium", "high", "critical"];

/** A blocked tool call, in the JSONL shape desktop/security_log.ts reads (so the GUI + CLI share one file). */
export interface BlockLogRecord {
  id: string;
  tool: string;
  severity: string;
  findings: string; // short summary e.g. "zero-width×2" — never raw content
  reason: string;
  at: string; // ISO timestamp
  status: "quarantined";
}

/** Build the metadata record for a block (pure). Severity = the max finding severity but never below
 *  "high" (a block is >= high), or "high" when fail-closed; findings = a "type×n" summary, or
 *  "scanner-unavailable" when the scan itself failed. */
export function buildBlockRecord(
  toolName: string,
  decision: { reason: string; findings: ReadonlyArray<{ type: string; severity: string }>; failClosed: boolean },
): BlockLogRecord {
  const severity = decision.failClosed
    ? "high"
    : decision.findings.reduce((top, f) => (SEVERITY_ORDER.indexOf(f.severity) > SEVERITY_ORDER.indexOf(top) ? f.severity : top), "high");
  const counts = new Map<string, number>();
  for (const f of decision.findings) counts.set(f.type, (counts.get(f.type) ?? 0) + 1);
  const findings = decision.failClosed
    ? "scanner-unavailable"
    : [...counts].map(([t, n]) => (n > 1 ? `${t}×${n}` : t)).join(", ") || "quarantined";
  return { id: randomUUID(), tool: toolName, severity, findings, reason: decision.reason, at: new Date().toISOString(), status: "quarantined" };
}

/** Append a block to the lock-free JSONL at $LUCID_BLOCK_LOG, if set. No-op when the env is unset (so the
 *  desktop GUI never double-writes). Best-effort + fail-safe: a write failure is swallowed — observability
 *  must NEVER affect the gate's decision. */
export function mirrorBlock(
  toolName: string,
  decision: { reason: string; findings: ReadonlyArray<{ type: string; severity: string }>; failClosed: boolean },
): void {
  const path = process.env.LUCID_BLOCK_LOG;
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(buildBlockRecord(toolName, decision))}\n`);
  } catch {
    /* observability only — a logging failure must never affect the gate */
  }
}
