// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// tools/blocks_cli.ts
//
// P-NVIM.7 (view blocked tool calls from Neovim): the read-only `lucid blocks` data CLI behind :LucidBlocks
// — the GUI Security panel's "blocked things" list, in the terminal. It reads the SAME two sources the GUI
// merges at /api/security:
//   1. the lock-free JSONL block log (~/.omp/lucid-blocks.jsonl, or $LUCID_BLOCK_LOG) — written by the GUI
//      (recordBlock) AND, for bare-lucid TUI/ACP sessions, by the in-process gate itself (P-NVIM.7 mirror),
//      so a block is visible DURING a live session (when the gate holds agent_obs.duckdb locked);
//   2. the DuckDB quarantines (securitySnapshot → views.ts), read READ_ONLY when the DB is free — the
//      persistent, cross-session record.
// Pure read: no agent, no gate spawn, no mutation. It never releases a block — reviewing/approving stays a
// GUI action (the audited fail-closed override).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { securitySnapshot } from "./web/data.ts";

export interface BlockRow {
  id: string;
  tool: string;
  severity: string;
  findings: string;
  reason: string;
  status: string; // quarantined | approved | dismissed | suspicious
  at: string; // ISO timestamp, or "" when unknown (DuckDB rows carry no timestamp column)
  source: "log" | "db";
}

/** Read a string (or number → string) field from a parsed JSON object; `dflt` when absent/other type. */
function readStr(o: Record<string, unknown>, key: string, dflt = ""): string {
  const v = o[key];
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return dflt;
}

/** Parse the append-only JSONL block log into current records, applying approve/dismiss markers in order.
 *  Mirrors desktop/security_log.ts's on-disk format so the GUI and the CLI read the identical file. */
export function readBlockLog(
  path: string = process.env.LUCID_BLOCK_LOG || join(homedir(), ".omp", "lucid-blocks.jsonl"),
): BlockRow[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return []; // no log yet (nothing blocked, or a fresh machine) — not an error
  }
  const byId = new Map<string, BlockRow>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // a corrupt line never breaks the view
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    // A JSONL block record is a flat string-keyed object (validated above); read its fields defensively.
    const r = parsed as Record<string, unknown>;
    const id = readStr(r, "id");
    if (!id) continue;
    if (r._approval === true) {
      const x = byId.get(id);
      if (x) x.status = "approved";
      continue;
    }
    if (r._dismiss === true) {
      const x = byId.get(id);
      if (x) x.status = "dismissed";
      continue;
    }
    byId.set(id, {
      id,
      tool: readStr(r, "tool", "tool"),
      severity: readStr(r, "severity"),
      findings: readStr(r, "findings"),
      reason: readStr(r, "reason"),
      status: readStr(r, "status", "quarantined"),
      at: readStr(r, "at"),
      source: "log",
    });
  }
  return [...byId.values()];
}

/** The DuckDB-persisted quarantines/suspicious artifacts (cross-session), when the DB is free. Returns []
 *  when the DB is absent or held read-write by a live gate — the JSONL log still covers the live session. */
async function dbBlocks(): Promise<BlockRow[]> {
  const rows: BlockRow[] = [];
  try {
    const snap = await securitySnapshot();
    if (!snap) return rows;
    for (const q of snap.quarantine) {
      rows.push({ id: readStr(q, "artifact_id"), tool: readStr(q, "source", "tool"), severity: "", findings: readStr(q, "finding_count"), reason: readStr(q, "trust_label", "quarantined"), status: "quarantined", at: "", source: "db" });
    }
    for (const a of snap.approvals) {
      if (readStr(a, "trust_label") === "quarantined") continue; // already listed by the quarantine view
      rows.push({ id: readStr(a, "artifact_id"), tool: readStr(a, "source", "tool"), severity: "", findings: readStr(a, "finding_count"), reason: readStr(a, "trust_label", "suspicious"), status: readStr(a, "trust_label", "suspicious"), at: "", source: "db" });
    }
  } catch {
    /* DB locked (live gate) or schema absent → the JSONL log is the live source */
  }
  return rows;
}

/** The blocked-tool-call list: active (quarantined) by default; `--all` includes reviewed (approved/dismissed)
 *  JSONL rows. Merges the lock-free log with the DuckDB quarantines (each row tagged with its `source`). */
export async function blockList(opts: { all?: boolean } = {}): Promise<BlockRow[]> {
  const log = readBlockLog();
  const active = opts.all ? log : log.filter((b) => b.status === "quarantined");
  return [...active, ...(await dbBlocks())];
}

function formatBlocks(rows: BlockRow[]): string {
  if (rows.length === 0) return "No blocked tool calls — the security gate has quarantined nothing.";
  return rows
    .map((b) => {
      const sev = b.severity ? ` · ${b.severity}` : "";
      const f = b.findings ? ` · ${b.findings}` : "";
      const st = b.status !== "quarantined" ? ` [${b.status}]` : "";
      const when = b.at ? `  (${b.at})` : "";
      return `🛡️  ${b.tool}${sev}${f}${st}  —  ${b.reason}${when}`;
    })
    .join("\n");
}

/** Run `lucid blocks [--all] [--json]`: the blocked-tool-call list. `--json` → machine output (Neovim);
 *  otherwise human-readable. Returns an exit code + the text — the launcher does the I/O. */
export async function runBlocks(argv: string[]): Promise<{ code: number; out: string }> {
  const json = argv.includes("--json");
  const rows = await blockList({ all: argv.includes("--all") });
  return { code: 0, out: json ? JSON.stringify(rows) : formatBlocks(rows) };
}
