// harness/memory/compaction.ts
//
// Security-aware compaction (P4.2). A deliberate transform, not an emergency
// summary. The load-bearing security property: summaries are generated from
// SANITIZED derivatives only — this module never reads content_artifacts.raw_content.
// Raw spans stay in archive_chunks; provenance + security findings tied to the
// span are preserved; suspicious/quarantined sources are NOT eligible for
// semantic promotion (the enforced gate is P4.3).

import { createHash } from "node:crypto";
import { Snowflake } from "@oh-my-pi/pi-utils";
import type { Db } from "./db.ts";

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export type CompactionTrigger =
  | "token_threshold"
  | "verification_milestone"
  | "session_boundary"
  | "manual"
  | "handoff"
  | "security";

export interface SanitizedPart {
  artifactId: string;
  trustLabel: string;
  sanitized: string;
  findingCount: number;
}

/** Structured fields a compaction MUST preserve (PRD compaction rules). */
export interface PreservedState {
  goals?: string;
  blockers?: string;
  decisions?: string;
  nextSteps?: string;
}

export type Summarizer = (parts: SanitizedPart[], state: PreservedState) => string;

export interface CompactSpanInput {
  runId: string;
  artifactIds: string[];
  trigger: CompactionTrigger;
  state?: PreservedState;
  /** Override the summary generator (e.g. an LLM). Default is deterministic. */
  summarizer?: Summarizer;
}

export interface PromotionDecision {
  artifactId: string;
  trustLabel: string;
  promoted: boolean;
  reason: string;
}

export interface CompactionResult {
  spanId: string;
  summaryId: string;
  summary: string;
  findingCount: number;
  promotions: PromotionDecision[];
}

/** Deterministic extractive summary over sanitized parts + preserved state. */
function defaultSummarizer(parts: SanitizedPart[], state: PreservedState): string {
  const lines: string[] = [];
  if (state.goals) lines.push(`Goals: ${state.goals}`);
  if (state.blockers) lines.push(`Blockers: ${state.blockers}`);
  if (state.decisions) lines.push(`Decisions: ${state.decisions}`);
  if (state.nextSteps) lines.push(`Next: ${state.nextSteps}`);
  lines.push(`Compacted ${parts.length} artifact(s):`);
  for (const p of parts) {
    const snippet = p.sanitized.replace(/\s+/g, " ").trim().slice(0, 120);
    lines.push(`- [${p.artifactId} trust=${p.trustLabel} findings=${p.findingCount}] ${snippet}`);
  }
  return lines.join("\n");
}

/** Sources that may be promoted from a compacted span. Suspicious/quarantined
 *  are blocked here and hard-gated in P4.3. */
function promotionEligible(trustLabel: string): boolean {
  return trustLabel === "trusted" || trustLabel === "untrusted";
}

/**
 * Compact a span of artifacts: summarize from sanitized derivatives, persist the
 * span/summary/promotion-decisions with provenance. Returns the result.
 */
export async function compactSpan(db: Db, input: CompactSpanInput): Promise<CompactionResult> {
  const now = new Date().toISOString();
  const parts: SanitizedPart[] = [];

  for (const artifactId of input.artifactIds) {
    // NOTE: deliberately selects the sanitized derivative, never raw_content.
    const row = await db.get(
      `SELECT a.trust_label AS trust_label,
              (SELECT s.sanitized_content FROM sanitized_artifacts s
                 WHERE s.artifact_id = a.artifact_id ORDER BY s.created_at DESC LIMIT 1) AS sanitized,
              (SELECT count(*)::INT FROM content_scans sc
                 JOIN security_findings f ON f.scan_id = sc.scan_id
                 WHERE sc.artifact_id = a.artifact_id) AS finding_count
       FROM content_artifacts a
       WHERE a.artifact_id = $1`,
      [artifactId],
    );
    if (!row) continue; // unknown artifact id -> skip
    parts.push({
      artifactId,
      trustLabel: String(row.trust_label),
      sanitized: typeof row.sanitized === "string" ? row.sanitized : "",
      findingCount: Number(row.finding_count ?? 0),
    });
  }

  const summarize = input.summarizer ?? defaultSummarizer;
  const summary = summarize(parts, input.state ?? {});
  const findingCount = parts.reduce((n, p) => n + p.findingCount, 0);

  const spanId = Snowflake.next();
  await db.run(
    `INSERT INTO compaction_spans (span_id, run_id, trigger, artifact_ids, finding_count, created_at)
     VALUES ($1,$2,$3,CAST($4 AS JSON),$5,$6)`,
    [spanId, input.runId, input.trigger, JSON.stringify(input.artifactIds), findingCount, now],
  );

  const summaryId = Snowflake.next();
  await db.run(
    `INSERT INTO compaction_summaries (summary_id, span_id, generated_from, summary, summary_sha256, created_at)
     VALUES ($1,$2,'sanitized',$3,$4,$5)`,
    [summaryId, spanId, summary, sha256(summary), now],
  );

  const promotions: PromotionDecision[] = [];
  for (const p of parts) {
    const promoted = promotionEligible(p.trustLabel);
    const reason = promoted
      ? `${p.trustLabel} -> eligible for promotion`
      : `${p.trustLabel} -> blocked (review required)`;
    promotions.push({ artifactId: p.artifactId, trustLabel: p.trustLabel, promoted, reason });
    await db.run(
      `INSERT INTO compaction_promotions (promotion_id, span_id, artifact_id, trust_label, promoted, reason, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [Snowflake.next(), spanId, p.artifactId, p.trustLabel, promoted, reason, now],
    );
  }

  return { spanId, summaryId, summary, findingCount, promotions };
}
