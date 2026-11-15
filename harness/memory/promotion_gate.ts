// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

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
//
// P-CAP.1b (ADR-0590): a fact DERIVED from several artifacts (`derivedFrom`) is gated on all of them. It
// carries the most severe label among its sources, and every source that needs review needs its own
// approval, so a derived fact can never launder a source.

import type { TrustLabel } from "../contracts.ts";
import type { Db } from "./db.ts";
import { promoteFact, type PromoteFactInput } from "./memory.ts";
import type { Telemetry } from "../telemetry/events.ts";
import { mostSevere } from "../security/trust_propagation.ts"; // P-CAP.1b (ADR-0590): the label of a derived fact

// The trust labels that may NEVER auto-promote into semantic memory (correctness keystone #2).
// EXPORTED (P-KG.3) so the agent-facing personal-KG write path in harness/personal/agent_kg.ts gates on
// the SAME set rather than re-listing the labels: two copies of this set is how a "suspicious" fact
// eventually slips through one path and not the other.
export const BLOCKED_TRUST = new Set<string>(["suspicious", "quarantined"]);

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

  // P-CAP.1b (ADR-0590): a fact may derive from SEVERAL artifacts (a count over two tool results, a
  // lookup joined with a document). Every one of them is a source: each must be found, the fact carries
  // the most severe label among them, and each source that needs review needs its OWN approval. One
  // reviewed source never clears another.
  const sources = [...new Set([...(input.sourceArtifactId ? [input.sourceArtifactId] : []), ...(input.derivedFrom ?? [])])];
  const labels = new Map<string, TrustLabel>();
  for (const id of sources) {
    const art = await db.get("SELECT trust_label FROM content_artifacts WHERE artifact_id=$1", [id]);
    if (!art) {
      // fail-closed: a claimed provenance we cannot verify is not trusted.
      tel?.emit("memory_promotion_blocked", {
        artifact_id: id,
        entity: input.entityName,
        reason: "unknown-source",
      });
      return { promoted: false, blocked: true, reason: "fail-closed: source artifact not found (provenance unverifiable)" };
    }
    // A stored label that is not one of the four counts as quarantined (invariant 7: the set is closed).
    labels.set(id, mostSevere([art.trust_label], "trusted"));
  }
  if (sources.length > 0) effectiveTrust = mostSevere([...labels.values()], "trusted");

  if (BLOCKED_TRUST.has(effectiveTrust)) {
    // With no source at all, the caller's own label is blocked and nothing can approve it.
    let unapproved: { id: string | undefined; trust: TrustLabel } | null = sources.length === 0 ? { id: undefined, trust: effectiveTrust } : null;
    for (const id of sources) {
      const trust = labels.get(id)!;
      if (!BLOCKED_TRUST.has(trust) || (await isApproved(db, id))) continue;
      if (unapproved === null || mostSevere([trust], unapproved.trust) !== unapproved.trust) unapproved = { id, trust };
    }
    if (unapproved !== null) {
      tel?.emit("memory_promotion_blocked", {
        artifact_id: unapproved.id,
        entity: input.entityName,
        reason: unapproved.trust,
      });
      return {
        promoted: false,
        blocked: true,
        reason: sources.length > 1
          ? `blocked: a source this fact derives from is ${unapproved.trust} (human review required before promotion)`
          : `blocked: source is ${unapproved.trust} (human review required before promotion)`,
        sourceTrust: effectiveTrust,
      };
    }
  }

  // Allowed: write with the effective (provenance-derived) trust label. A fact with only derived sources
  // keeps the first of them as its recorded source, so its lineage is never empty.
  const { derivedFrom: _derived, ...fact } = input;
  const { factId, entityId } = await promoteFact(db, { ...fact, trustLabel: effectiveTrust, ...(fact.sourceArtifactId === undefined && sources[0] !== undefined ? { sourceArtifactId: sources[0] } : {}) });
  return {
    promoted: true,
    blocked: false,
    reason: `promoted (source ${effectiveTrust})`,
    sourceTrust: effectiveTrust,
    factId,
    entityId,
  };
}
