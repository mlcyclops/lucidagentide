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

export interface BlockRecord {
  id: string;
  tool: string; // the tool whose call was blocked (e.g. "write", "eval", "bash")
  severity: string;
  findings: string; // short finding summary (e.g. "zero-width×2"); never raw content
  reason: string;
  sessionId?: string;
  at: string; // ISO timestamp
  status: "quarantined" | "approved";
  reviewer?: string;
  approvedAt?: string;
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
        const o = JSON.parse(line) as BlockRecord & { _approval?: boolean };
        if (o._approval) { const r = byId.get(o.id); if (r) { r.status = "approved"; r.reviewer = o.reviewer; r.approvedAt = o.approvedAt; } }
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
  return rec;
}

/** Mark a block approved (the audited fail-closed override). Returns false if unknown/already approved. */
export function approveBlock(id: string, reviewer = "user"): BlockRecord | null {
  const r = load().find((x) => x.id === id);
  if (!r || r.status === "approved") return null;
  r.status = "approved"; r.reviewer = reviewer; r.approvedAt = new Date().toISOString();
  append({ _approval: true, id, reviewer, approvedAt: r.approvedAt });
  return r;
}

export interface LiveBlocks { quarantined: BlockRecord[]; approved: BlockRecord[]; total: number }

/** The live-block view for the Security panel (most-recent first, capped). */
export function liveBlocks(): LiveBlocks {
  const all = load();
  const recent = (s: BlockRecord["status"]) => all.filter((b) => b.status === s).slice(-100).reverse();
  return { quarantined: recent("quarantined"), approved: recent("approved"), total: all.length };
}
