// harness/memory/promotion_gate.ts
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │  CORRECTNESS KEYSTONE #2 (CLAUDE.md). Suspicious-source content MUST      │
// │  never auto-promote into semantic memory. This is what stops a one-time   │
// │  injection from becoming durable, cross-session memory poisoning.         │
// └─────────────────────────────────────────────────────────────────────────┘
//
// The gate resolves the effective trust of a promotion from its SOURCE artifact
// (provenance), not the caller's say-so. suspicious/quarantined sources are
// blocked until a recorded approval (approve / quarantine_release /
// promotion_approve) clears them. Fail-closed (invariant #3): if provenance
// can't be verified (unknown source), block.

import type { TrustLabel } from "../contracts.ts";
import type { Db } from "./db.ts";
import { promoteFact, type PromoteFactInput } from "./memory.ts";
import type { Telemetry } from "../telemetry/events.ts";

const BLOCKED_TRUST = new Set<string>(["suspicious", "quarantined"]);

export interface PromotionOutcome {
  promoted: boolean;
  blocked: boolean;
  reason: string;
  sourceTrust?: string;
  factId?: string;
  entityId?: string;
}

async function isApproved(db: Db, artifactId: string): Promise<boolean> {
  const row = await db.get(
    `SELECT 1 AS ok FROM approval_events
     WHERE artifact_id = $1 AND action IN ('approve','quarantine_release','promotion_approve')
     LIMIT 1`,
    [artifactId],
  );
  return row !== undefined;
}

/**
 * Promote a fact ONLY if its source is trusted enough (or reviewed). Returns a
 * blocked outcome (and writes nothing to semantic memory) otherwise.
 */
export async function promoteFactGated(
  db: Db,
  input: PromoteFactInput,
  opts: { telemetry?: Telemetry } = {},
): Promise<PromotionOutcome> {
  const tel = opts.telemetry;
  let effectiveTrust: TrustLabel = input.trustLabel;

  if (input.sourceArtifactId) {
    const art = await db.get("SELECT trust_label FROM content_artifacts WHERE artifact_id=$1", [input.sourceArtifactId]);
    if (!art) {
      // fail-closed: a claimed provenance we cannot verify is not trusted.
      tel?.emit("memory_promotion_blocked", {
        artifact_id: input.sourceArtifactId,
        entity: input.entityName,
        reason: "unknown-source",
      });
      return { promoted: false, blocked: true, reason: "fail-closed: source artifact not found (provenance unverifiable)" };
    }
    effectiveTrust = String(art.trust_label) as TrustLabel;
  }

  if (BLOCKED_TRUST.has(effectiveTrust)) {
    const approved = input.sourceArtifactId ? await isApproved(db, input.sourceArtifactId) : false;
    if (!approved) {
      tel?.emit("memory_promotion_blocked", {
        artifact_id: input.sourceArtifactId,
        entity: input.entityName,
        reason: effectiveTrust,
      });
      return {
        promoted: false,
        blocked: true,
        reason: `blocked: source is ${effectiveTrust} (human review required before promotion)`,
        sourceTrust: effectiveTrust,
      };
    }
  }

  // Allowed: write with the effective (provenance-derived) trust label.
  const { factId, entityId } = await promoteFact(db, { ...input, trustLabel: effectiveTrust });
  return {
    promoted: true,
    blocked: false,
    reason: `promoted (source ${effectiveTrust})`,
    sourceTrust: effectiveTrust,
    factId,
    entityId,
  };
}
