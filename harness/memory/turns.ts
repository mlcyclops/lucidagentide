// harness/memory/turns.ts
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │  ADR-0009 Phase B (issue #12) — prompt/response traceability. Capture     │
// │  each turn (the user prompt, the assistant reply) with a stable id +      │
// │  provenance, so a run can be replayed and audited turn-by-turn.           │
// │                                                                           │
// │  Two artifacts per turn, NEVER conflated:                                 │
// │    • RAW text   → preserved in archive_chunks (source of truth, by sha).  │
// │    • SANITIZED  → escapeMarkdown'd; the ONLY text a prompt/UI ever shows.  │
// │  The turns row stores the sanitized text + the raw's sha (raw is reached  │
// │  only by joining archive_chunks). The turn_captured event is METADATA     │
// │  ONLY — it never carries the prompt or reply text (invariant #8).         │
// └─────────────────────────────────────────────────────────────────────────┘

import { Snowflake } from "@oh-my-pi/pi-utils";
import { escapeMarkdown } from "../export/safe_export.ts";
import type { TrustLabel } from "../contracts.ts";
import type { Telemetry } from "../telemetry/events.ts";
import { archiveChunk, getArchiveChunk } from "./memory.ts";
import type { Db, Row } from "./db.ts";

/** A turn is one prompt or one reply. Closed set — the role column never holds
 *  anything else. */
export const TURN_ROLES = ["user", "assistant"] as const;
export type TurnRole = (typeof TURN_ROLES)[number];

export interface CaptureTurnInput {
  /** Session the turn belongs to (required — turns are ordered within a session). */
  sessionId: string;
  /** Run that produced the turn (provenance; soft ref). */
  runId?: string;
  /** Monotonic order within the session (user prompt then its reply, etc). */
  seq: number;
  role: TurnRole;
  /** The raw turn text. Preserved verbatim in archive_chunks; never stored raw in `turns`. */
  text: string;
  /** Provenance trust. Defaults to `untrusted` — the safe floor for captured content
   *  (never auto-trust; the caller may raise it, e.g. `trusted` for model output). */
  trustLabel?: TrustLabel;
  /** Count of scanner findings the gate saw on this turn, if known (the "blocked"
   *  metadata on the event). Never the findings' content — just the count. */
  findingCount?: number;
  /** Telemetry sink for the turn_captured event (already bound to run/session). */
  telemetry?: Telemetry;
}

export interface CaptureTurnResult {
  turnId: string;
  archiveChunkId: string;
  rawSha256: string;
  sanitizedText: string;
}

/**
 * Capture one turn. Archives the raw text (source of truth, by sha), escapes it for
 * safe rendering, writes the `turns` row with provenance back to the archive chunk,
 * and emits the metadata-only `turn_captured` event. Returns the new ids + sanitized
 * text. Write-side; mirrors promoteFact/archiveChunk in style.
 */
export async function captureTurn(db: Db, input: CaptureTurnInput): Promise<CaptureTurnResult> {
  if (!(TURN_ROLES as readonly string[]).includes(input.role)) {
    throw new Error(`invalid turn role: ${JSON.stringify(input.role)} (expected ${TURN_ROLES.join("|")})`);
  }
  const trustLabel: TrustLabel = input.trustLabel ?? "untrusted";

  // RAW → archive (preserved verbatim, the replay source of truth). The chunk computes
  // the sha; re-read it so `turns.raw_sha256` mirrors the archive exactly (no duplicate
  // hashing path that could drift).
  const archiveChunkId = await archiveChunk(db, { runId: input.runId, content: input.text });
  const chunk = await getArchiveChunk(db, archiveChunkId);
  const rawSha256 = String(chunk?.content_sha256 ?? "");

  // SANITIZED → the only text ever rendered. escapeMarkdown neutralizes every
  // invisible/control codepoint to U+XXXX notation, so a transcript can't smuggle one.
  const sanitizedText = escapeMarkdown(input.text);

  const turnId = Snowflake.next();
  await db.run(
    `INSERT INTO turns
       (turn_id, run_id, session_id, seq, role, sanitized_text, raw_sha256, archive_chunk_id, trust_label, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      turnId,
      input.runId ?? null,
      input.sessionId,
      Math.trunc(input.seq),
      input.role,
      sanitizedText,
      rawSha256,
      archiveChunkId,
      trustLabel,
      new Date().toISOString(),
    ],
  );

  // METADATA ONLY (invariant #8): ids/role/seq/sha/trust/blocked-count + length —
  // NEVER the prompt or reply text. artifact_id = the raw archive chunk in scope.
  input.telemetry?.emit("turn_captured", {
    turn_id: turnId,
    artifact_id: archiveChunkId,
    role: input.role,
    seq: Math.trunc(input.seq),
    raw_sha256: rawSha256,
    trust_label: trustLabel,
    blocked: Math.max(0, Math.trunc(input.findingCount ?? 0)),
    text_len: input.text.length,
  });

  return { turnId, archiveChunkId, rawSha256, sanitizedText };
}

export interface GetTurnsOptions {
  sessionId?: string;
  runId?: string;
  /** Max rows (most-recent capping is the caller's job via ORDER). Defaults to 200. */
  limit?: number;
}

/**
 * Read captured turns in transcript order (by session, then seq). Read-only; used by
 * replay + the developer Logs view. Sanitized text only — the raw is reached by
 * joining archive_chunks on archive_chunk_id when an audited reveal is warranted.
 */
export async function getTurns(db: Db, opts: GetTurnsOptions = {}): Promise<Row[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.sessionId) { params.push(opts.sessionId); where.push(`session_id = $${params.length}`); }
  if (opts.runId) { params.push(opts.runId); where.push(`run_id = $${params.length}`); }
  const limit = Math.max(0, Math.trunc(opts.limit ?? 200));
  params.push(limit);
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return db.all(
    `SELECT * FROM turns ${clause} ORDER BY session_id, seq, turn_id LIMIT $${params.length}`,
    params,
  );
}
