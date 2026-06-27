// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/runs/loc_ledger.ts
//
// P-LOC.1 (ADR-0031): persist AI-authored line counts into the frozen `ai_loc_ledger`
// table (migration 0007) and read the per-(model, repo, identity) roll-up the dashboard
// and the future BI add-on push. Writes are best-effort provenance, layered on top of the
// gate's fail-closed scan — recording an edit NEVER influences the security decision.
//
// The counting itself is the pure `countEdit` in ./loc_count.ts; this module only owns the
// DB shape and the attribution context (model/identity/repo) supplied by the caller.

import { Snowflake } from "@oh-my-pi/pi-utils";
import type { Db } from "../memory/db.ts";
import type { Telemetry } from "../telemetry/events.ts";
import { countEdit, type EditResultLike } from "./loc_count.ts";

export type IdentitySource = "email" | "workstation" | "unknown";

/** The attribution context for a recorded edit — who/what authored it, and where. */
export interface AttributionContext {
  model: string;
  identity: string;
  identitySource: IdentitySource;
  repo: string;
  runId?: string;
  sessionId?: string;
}

export interface RecordedEdit {
  recorded: boolean;
  rows: number;
  added: number;
  removed: number;
  reason: string;
}

/**
 * Count an omp `write`/`edit` tool_result and write one ledger row per file touched.
 * No-op (recorded=false) for non-edit / errored / empty results. Best-effort: callers
 * fire-and-forget; this never throws into the gate.
 */
export async function recordAiEdit(db: Db, ev: EditResultLike, ctx: AttributionContext, tel?: Telemetry): Promise<RecordedEdit> {
  const c = countEdit(ev);
  if (!c.countable) return { recorded: false, rows: 0, added: 0, removed: 0, reason: "not a countable edit" };

  // One row per file so the roll-up can attribute per repo/file; an edit with no resolved
  // file path still records a single row (file_path NULL) so the lines aren't lost.
  const files = c.files.length > 0 ? c.files : [null];
  const perFileAdded = Math.round(c.added / files.length);
  const perFileRemoved = Math.round(c.removed / files.length);
  const model = ctx.model && ctx.model.length > 0 ? ctx.model : "unknown";
  const now = new Date().toISOString();

  let rows = 0;
  for (let i = 0; i < files.length; i++) {
    // Put the rounding remainder on the last row so the per-file rows sum to the total.
    const added = i === files.length - 1 ? c.added - perFileAdded * (files.length - 1) : perFileAdded;
    const removed = i === files.length - 1 ? c.removed - perFileRemoved * (files.length - 1) : perFileRemoved;
    await db.run(
      `INSERT INTO ai_loc_ledger
         (edit_id, run_id, session_id, model, identity, identity_source, repo, file_path, tool, added_lines, removed_lines, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        Snowflake.next(),
        ctx.runId ?? null,
        ctx.sessionId ?? null,
        model,
        ctx.identity,
        ctx.identitySource,
        ctx.repo,
        files[i],
        c.tool,
        added,
        removed,
        now,
      ],
    );
    rows++;
  }

  tel?.emit("ai_edit_recorded", {
    run_id: ctx.runId,
    model,
    identity: ctx.identity,
    identity_source: ctx.identitySource,
    repo: ctx.repo,
    tool: c.tool,
    added_lines: c.added,
    removed_lines: c.removed,
    files: c.files.length,
  });

  return { recorded: true, rows, added: c.added, removed: c.removed, reason: `recorded ${c.tool} (+${c.added}/-${c.removed})` };
}

export interface LocRollupRow {
  model: string;
  repo: string;
  identity: string;
  identitySource: string;
  edits: number;
  added: number;
  removed: number;
}

/** Per-(model, repo, identity) roll-up for the dashboard / BI push, newest activity first. */
export async function aiLocRollup(db: Db): Promise<LocRollupRow[]> {
  const rows = await db.all(
    `SELECT model, repo, identity,
            any_value(identity_source) AS identity_source,
            count(*)::INT            AS edits,
            sum(added_lines)::INT    AS added,
            sum(removed_lines)::INT  AS removed
       FROM ai_loc_ledger
      GROUP BY model, repo, identity
      ORDER BY added DESC`,
  );
  return rows.map((r) => ({
    model: String(r.model),
    repo: String(r.repo),
    identity: String(r.identity),
    identitySource: String(r.identity_source),
    edits: Number(r.edits ?? 0),
    added: Number(r.added ?? 0),
    removed: Number(r.removed ?? 0),
  }));
}
