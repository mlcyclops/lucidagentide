// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/security_log.ts — a GUI-owned record of the security gate's live blocks (ADR-0019 C).
//
// WHY THIS EXISTS: the gate runs inside the omp CHILD process and can only signal a block over
// stderr; it cannot co-write agent_obs.duckdb because the GUI server holds that single-writer DB
// (two-process DuckDB contention). So blocks never reached the Security panel and the toast
// "Review" opened an empty tab. The fix: the GUI process (which observes every block via the ACP
// client) records them HERE — an append-only JSONL audit at ~/.omp/lucid-blocks.jsonl plus an
// in-memory view — and the dashboard reads from this. Metadata only (tool/severity/findings/
// reason), never raw scanned content.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { emitSecurityEvent, type SecuritySeverity } from "./audit_export.ts";

/** Coerce a free-form severity string into the OCSF-aligned set (fail-safe to "high"). */
function sev(s?: string): SecuritySeverity {
  const v = (s ?? "").toLowerCase();
  return v === "critical" || v === "high" || v === "medium" || v === "low" || v === "info" ? v : "high";
}

export interface BlockRecord {
  id: string;
  tool: string; // the tool whose call was blocked (e.g. "write", "eval", "bash")
  severity: string;
  findings: string; // short finding summary (e.g. "zero-width×2"); never raw content
  reason: string;
  sessionId?: string;
  at: string; // ISO timestamp
  status: "quarantined" | "approved" | "dismissed";
  reviewer?: string;
  approvedAt?: string;
  dismissedAt?: string;
}

const LOG_PATH = join(homedir(), ".omp", "lucid-blocks.jsonl");
let mem: BlockRecord[] | null = null;

/** Load the append-only log into memory, applying approval markers in order. */
function load(): BlockRecord[] {
  if (mem) return mem;
  const byId = new Map<string, BlockRecord>();
  try {
    if (existsSync(LOG_PATH)) {
      for (const line of readFileSync(LOG_PATH, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const o = JSON.parse(line) as BlockRecord & { _approval?: boolean; _dismiss?: boolean };
        if (o._approval) { const r = byId.get(o.id); if (r) { r.status = "approved"; r.reviewer = o.reviewer; r.approvedAt = o.approvedAt; } }
        else if (o._dismiss) { const r = byId.get(o.id); if (r) { r.status = "dismissed"; r.reviewer = o.reviewer; r.dismissedAt = o.dismissedAt; } }
        else byId.set(o.id, { ...o, status: o.status ?? "quarantined" });
      }
    }
  } catch { /* corrupt line / unreadable — best-effort, keep what we have */ }
  mem = [...byId.values()];
  return mem;
}

function append(obj: unknown): void {
  try { mkdirSync(dirname(LOG_PATH), { recursive: true }); appendFileSync(LOG_PATH, JSON.stringify(obj) + "\n"); }
  catch { /* audit is best-effort; the in-memory view still works for the session */ }
}

/** Record a freshly-observed gate block. Returns the new record (its id wires the UI's review). */
export function recordBlock(b: { tool: string; severity?: string; findings?: string; reason: string; sessionId?: string }): BlockRecord {
  const rec: BlockRecord = {
    id: Snowflake.next(), tool: b.tool || "tool", severity: b.severity || "high",
    findings: b.findings || "", reason: b.reason, sessionId: b.sessionId,
    at: new Date().toISOString(), status: "quarantined",
  };
  load().push(rec);
  append(rec);
  // P-ENT.2 (ADR-0069): the scanner block is also a canonical SecurityEvent for the SIEM export. Additive
  // + fail-safe — emit never throws, and a logging failure never affects the (already-applied) block.
  emitSecurityEvent({ category: "scanner", type: "scanner_block", decision: "block", severity: sev(rec.severity), tool: rec.tool, reason: rec.reason, sessionId: rec.sessionId });
  return rec;
}

/** Mark a block approved (the audited fail-closed override). Returns false if unknown/already approved. */
export function approveBlock(id: string, reviewer = "user"): BlockRecord | null {
  const r = load().find((x) => x.id === id);
  if (!r || r.status === "approved") return null;
  r.status = "approved"; r.reviewer = reviewer; r.approvedAt = new Date().toISOString();
  append({ _approval: true, id, reviewer, approvedAt: r.approvedAt });
  // P-ENT.2: the audited fail-closed OVERRIDE is itself a security decision (block → allow).
  emitSecurityEvent({ category: "approval", type: "block_approved", decision: "allow", severity: sev(r.severity), tool: r.tool, reason: `override by ${reviewer}`, sessionId: r.sessionId, identity: reviewer });
  return r;
}

/** Acknowledge a block WITHOUT releasing it: the call stays blocked (never imported/run) — this only
 *  moves it out of the active queue into the Dismissed section so a reviewed, correctly-blocked event
 *  stops lighting the "quarantined" count. The audit record is RETAINED (never deleted). Returns null
 *  if unknown or not currently quarantined (approved blocks aren't dismissable). */
export function dismissBlock(id: string, reviewer = "user"): BlockRecord | null {
  const r = load().find((x) => x.id === id);
  if (!r || r.status !== "quarantined") return null;
  r.status = "dismissed"; r.reviewer = reviewer; r.dismissedAt = new Date().toISOString();
  append({ _dismiss: true, id, reviewer, dismissedAt: r.dismissedAt });
  // P-ENT.2: acknowledged-but-still-BLOCKED — the decision stays block; this records the review action.
  emitSecurityEvent({ category: "approval", type: "block_dismissed", decision: "block", severity: sev(r.severity), tool: r.tool, reason: `acknowledged by ${reviewer}`, sessionId: r.sessionId, identity: reviewer });
  return r;
}

export interface LiveBlocks { quarantined: BlockRecord[]; approved: BlockRecord[]; dismissed: BlockRecord[]; total: number }

/** The live-block view for the Security panel (most-recent first, capped). */
export function liveBlocks(): LiveBlocks {
  const all = load();
  const recent = (s: BlockRecord["status"]) => all.filter((b) => b.status === s).slice(-100).reverse();
  return { quarantined: recent("quarantined"), approved: recent("approved"), dismissed: recent("dismissed"), total: all.length };
}
