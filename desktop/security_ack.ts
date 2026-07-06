// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/security_ack.ts — P-SECACK.1 (ADR-0170): GUI-owned review-acks for DB-backed security rows.
//
// WHY THIS EXISTS: the Security panel's "Quarantine review" table, "Approval queue" and the findings
// counter come from agent_obs.duckdb, which the GUI only ever opens READ_ONLY (single-writer — the
// live gate owns that DB). So a row a human had already reviewed could never leave the view: the
// "4 quarantined / 4 awaiting review / 24 findings" chips sat lit forever. Mirroring security_log.ts,
// the GUI records "a human has seen this" in its OWN append-only JSONL (~/.omp/lucid-sec-acks.jsonl)
// plus an in-memory view.
//
// AN ACK RELEASES NOTHING. The provenance DB is never written: trust labels stand, fail-closed blocks
// stand, every audit record is kept. An ack only moves the row into the collapsed "reviewed" shelf and
// out of the active counters. Metadata only — artifact ids and timestamps, never scanned content.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { emitSecurityEvent } from "./audit_export.ts";

export interface AckInfo { at: string; reviewer?: string }
export interface AckState {
  artifacts: Record<string, AckInfo>;
  /** The findings-seen WATERMARK: the findings TOTAL at the moment the user last hit "mark seen".
   *  The chip then counts only findings beyond it. null = never acked (everything is new). */
  findingsSeen: number | null;
}

type AckLine =
  | { kind: "artifact"; id: string; at: string; reviewer?: string }
  | { kind: "findings"; total: number; at: string; reviewer?: string };

/** Fold raw JSONL lines into the ack state. PURE + corrupt-tolerant: a bad line is skipped, never a
 *  throw (the file is user-reachable on disk). First artifact ack wins (idempotent re-acks are no-ops);
 *  the findings watermark only ever rises (an old replayed line can't un-see newer findings). */
export function foldAcks(lines: string[]): AckState {
  const s: AckState = { artifacts: {}, findingsSeen: null };
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as Partial<AckLine> & { id?: unknown; total?: unknown };
      if (o.kind === "artifact" && typeof o.id === "string" && o.id) {
        if (!s.artifacts[o.id]) s.artifacts[o.id] = { at: String(o.at ?? ""), reviewer: typeof o.reviewer === "string" ? o.reviewer : undefined };
      } else if (o.kind === "findings" && Number.isFinite(Number(o.total))) {
        s.findingsSeen = Math.max(s.findingsSeen ?? 0, Math.max(0, Number(o.total)));
      }
    } catch { /* skip the corrupt line — keep every parseable ack */ }
  }
  return s;
}

// Test/demo override first (LUCID_SEC_ACK_PATH), else the per-user ledger next to lucid-blocks.jsonl.
const DEFAULT_ACK_PATH = join(homedir(), ".omp", "lucid-sec-acks.jsonl");

let mem: AckState | null = null;
let memPath = ""; // invalidate the cache when the path changes (tests point at temp dirs)

function load(): AckState {
  const p = process.env.LUCID_SEC_ACK_PATH || DEFAULT_ACK_PATH;
  if (mem && memPath === p) return mem;
  let raw = "";
  try { raw = readFileSync(p, "utf8"); } catch { /* no ledger yet — empty state */ }
  mem = foldAcks(raw.split("\n"));
  memPath = p;
  return mem;
}

function append(obj: AckLine): void {
  try { const p = process.env.LUCID_SEC_ACK_PATH || DEFAULT_ACK_PATH; mkdirSync(dirname(p), { recursive: true }); appendFileSync(p, JSON.stringify(obj) + "\n"); }
  catch { /* audit is best-effort; the in-memory view still works for the session */ }
}

/** Mark one DB-backed artifact row (quarantine review / approval queue) as reviewed. Idempotent —
 *  re-acking returns the existing record without a duplicate ledger line. Returns null on a blank id.
 *  `emit` is injectable for tests (P-SANDBOX.3 precedent) so demos never touch the real audit sinks. */
export function ackArtifact(id: string, reviewer = "user", emit: typeof emitSecurityEvent = emitSecurityEvent): AckInfo | null {
  if (!id.trim()) return null;
  const s = load();
  const existing = s.artifacts[id];
  if (existing) return existing;
  const rec: AckInfo = { at: new Date().toISOString(), reviewer };
  s.artifacts[id] = rec;
  append({ kind: "artifact", id, at: rec.at, reviewer });
  // Parity with block_dismissed (P-ENT.2): acknowledged-but-still-ISOLATED — the decision stays block;
  // this records the human review action for the SIEM. Fail-safe: a throwing sink never blocks the ack.
  try { emit({ category: "approval", type: "artifact_reviewed", decision: "block", severity: "info", reason: `acknowledged by ${reviewer}`, tool: undefined }); } catch { /* observability, not the gate */ }
  return rec;
}

/** Raise the findings-seen watermark to `total` (the findings count the user just looked at).
 *  Monotonic — never lowers. Returns the effective watermark. No SecurityEvent: this is a view
 *  preference (what counts as "new"), not a security decision. */
export function ackFindings(total: number, reviewer = "user"): number {
  const t = Math.max(0, Math.floor(Number(total) || 0));
  const s = load();
  const next = Math.max(s.findingsSeen ?? 0, t);
  if (next !== s.findingsSeen) { s.findingsSeen = next; append({ kind: "findings", total: next, at: new Date().toISOString(), reviewer }); }
  return next;
}

/** The ack view merged into /api/security so the renderer can split active vs reviewed. */
export function ackView(): AckState {
  const s = load();
  return { artifacts: { ...s.artifacts }, findingsSeen: s.findingsSeen };
}

/** Drop the in-memory cache so tests can point LUCID_SEC_ACK_PATH at a fresh temp file. */
export function _resetAcksForTest(): void { mem = null; memPath = ""; }
