// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/trainer/teachback.ts - P-TRAINER.4 (ADR-0252/0254): verification by teaching it back.
//
// The trainer's practice-exam inversion: the agent recites a captured unit as steps, the EXPERT
// grades it, and the verdict drives the trust machinery:
//   - confirmed: records an approval_events row (the EXISTING `promotion_approve` action) and then
//     projects the unit through promoteFactGated - keystone #2 verbatim, never bypassed. The
//     confirmation is the approval; nothing else promotes.
//   - corrected: mints a superseding unit (append-only, ADR-0253) that re-earns its own
//     confirmation later.
//   - rejected: tombstones the unit with the teachback id; it leaves the live set forever.
// GUARD (ADR-0254 decision 4): confirmation applies to `untrusted` units ONLY. A suspicious or
// quarantined unit gets NO one-click path here - the standard quarantine-release flow (its own
// approval action, outside the interview loop) is the only way, so an enthusiastic "confirm" can
// never free a poisoned or PII-bearing span.

import type { Db } from "../memory/db.ts";
import { promoteFactGated, type PromotionOutcome } from "../memory/promotion_gate.ts";
import { recordApproval } from "../security/approvals.ts";
import type { Telemetry } from "../telemetry/events.ts";
import type { TeachbackVerdict } from "./coverage.ts";
import type { AddUnitInput, KnowledgeUnitRow, TrainerStore } from "./store.ts";

/** The recitation script: what the agent says (or shows) before asking for a verdict. Pure. */
export function reciteUnit(unit: KnowledgeUnitRow): string[] {
  const lines: string[] = [`Here is what I captured for "${unit.title}". Tell me confirm, correct, or reject.`];
  let structure: { steps?: unknown; trigger?: unknown; resolution?: unknown } = {};
  try {
    structure = (JSON.parse(unit.structure) ?? {}) as typeof structure;
  } catch {
    // body_md alone still recites
  }
  const steps = Array.isArray(structure.steps) ? structure.steps.filter((s): s is string => typeof s === "string") : [];
  if (steps.length > 0) {
    steps.forEach((s, i) => lines.push(`Step ${i + 1}: ${s}`));
  } else {
    lines.push(unit.body_md);
  }
  if (typeof structure.trigger === "string" && structure.trigger) lines.push(`It happens when: ${structure.trigger}`);
  if (typeof structure.resolution === "string" && structure.resolution) lines.push(`And the firm resolves it by: ${structure.resolution}`);
  return lines;
}

export interface TeachbackArgs {
  /** agent_obs.duckdb - approvals + the promotion gate live here. */
  memoryDb: Db;
  /** kb_graph.duckdb - units + the teach-back trail live here. */
  store: TrainerStore;
  unitId: string;
  verdict: TeachbackVerdict;
  /** Who graded it (a display handle; recorded on the approval + the confirmation). */
  decidedBy: string;
  notes?: string;
  /** Required for `corrected`: the replacement unit content. */
  replacement?: AddUnitInput;
  telemetry?: Telemetry;
}

export interface TeachbackOutcome {
  teachbackId: string;
  verdict: TeachbackVerdict;
  /** confirmed only: the approval + gate outcome. */
  approvalId?: string;
  promotion?: PromotionOutcome;
  /** corrected only: the successor unit id. */
  successorUnitId?: string;
  refused: boolean;
  reason: string;
}

export async function runTeachback(args: TeachbackArgs): Promise<TeachbackOutcome> {
  const unit = await args.store.getUnit(args.unitId);
  if (!unit) throw new Error(`runTeachback: unknown unit ${args.unitId}`);
  if (unit.superseded_by) throw new Error(`runTeachback: unit ${args.unitId} is superseded (grade the live successor)`);

  if (args.verdict === "confirmed") {
    // The guard: only an untrusted-labeled unit may ride the confirmation path (ADR-0254).
    if (unit.trust_label !== "untrusted") {
      const teachbackId = await args.store.addTeachback({ unitId: args.unitId, verdict: "confirmed", notes: `REFUSED: unit is ${unit.trust_label}` });
      args.telemetry?.emit("trainer_teachback_run", { unit_id: args.unitId, verdict: "confirmed", refused: true, trust_label: unit.trust_label });
      return {
        teachbackId,
        verdict: "confirmed",
        refused: true,
        reason: `refused: unit is ${unit.trust_label} - the standard quarantine-release flow is the only path (never one-click from the interview)`,
      };
    }
    if (!unit.source_artifact_id) {
      const teachbackId = await args.store.addTeachback({ unitId: args.unitId, verdict: "confirmed", notes: "REFUSED: no provenance artifact" });
      args.telemetry?.emit("trainer_teachback_run", { unit_id: args.unitId, verdict: "confirmed", refused: true });
      return { teachbackId, verdict: "confirmed", refused: true, reason: "refused: unit has no provenance artifact (fail-closed)" };
    }
    const approvalId = await recordApproval(
      args.memoryDb,
      {
        artifactId: unit.source_artifact_id,
        action: "promotion_approve",
        decidedBy: args.decidedBy,
        rationale: `teach-back confirmed unit ${args.unitId} (${unit.kind}: ${unit.title})`,
        scope: "trainer",
      },
      args.telemetry,
    );
    // Keystone #2 verbatim: the gate still resolves trust from the artifact's provenance.
    const promotion = await promoteFactGated(
      args.memoryDb,
      {
        entityName: unit.title,
        entityKind: unit.kind,
        statement: firstStatement(unit),
        trustLabel: "untrusted",
        sourceArtifactId: unit.source_artifact_id,
      },
      { telemetry: args.telemetry },
    );
    await args.store.confirmUnit(args.unitId, args.decidedBy);
    const teachbackId = await args.store.addTeachback({ unitId: args.unitId, verdict: "confirmed", notes: args.notes, approvalEventId: approvalId });
    args.telemetry?.emit("trainer_unit_confirmed", {
      artifact_id: unit.source_artifact_id,
      unit_id: args.unitId,
      approval_id: approvalId,
      promoted: promotion.promoted,
    });
    args.telemetry?.emit("trainer_teachback_run", { unit_id: args.unitId, verdict: "confirmed", refused: false });
    return { teachbackId, verdict: "confirmed", approvalId, promotion, refused: false, reason: promotion.reason };
  }

  if (args.verdict === "corrected") {
    if (!args.replacement) throw new Error("runTeachback: corrected verdict requires a replacement unit");
    const successorUnitId = await args.store.supersedeUnit(args.unitId, args.replacement);
    const teachbackId = await args.store.addTeachback({ unitId: args.unitId, verdict: "corrected", notes: args.notes });
    args.telemetry?.emit("trainer_teachback_run", { unit_id: args.unitId, verdict: "corrected", successor_unit_id: successorUnitId, refused: false });
    return { teachbackId, verdict: "corrected", successorUnitId, refused: false, reason: `superseded by ${successorUnitId} (re-earns confirmation)` };
  }

  // rejected: tombstone, no successor.
  const teachbackId = await args.store.addTeachback({ unitId: args.unitId, verdict: "rejected", notes: args.notes });
  await args.store.tombstoneUnit(args.unitId, teachbackId);
  args.telemetry?.emit("trainer_unit_rejected", { unit_id: args.unitId, teachback_id: teachbackId });
  args.telemetry?.emit("trainer_teachback_run", { unit_id: args.unitId, verdict: "rejected", refused: false });
  return { teachbackId, verdict: "rejected", refused: false, reason: "rejected: tombstoned, out of the live set" };
}

/** The semantic-memory projection statement: one sentence, role-shaped. */
function firstStatement(unit: KnowledgeUnitRow): string {
  let steps: string[] = [];
  try {
    const s = (JSON.parse(unit.structure) ?? {}) as { steps?: unknown };
    steps = Array.isArray(s.steps) ? s.steps.filter((x): x is string => typeof x === "string") : [];
  } catch {
    // fall through to body
  }
  if (steps.length > 0) return `${unit.title}: ${steps.length} steps, starting with "${steps[0]}"`;
  const firstLine = unit.body_md.split("\n").find((l) => l.trim().length > 0) ?? unit.title;
  return `${unit.title}: ${firstLine.trim()}`;
}
