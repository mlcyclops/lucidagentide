// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/trainer/coverage.ts - P-TRAINER.1 (ADR-0252/0253): coverage-map types + the L0-L3 rubric.
//
// The TacticalGenAI objective map inverted: a coverage objective describes one part of a business
// role, and its LEVEL measures how completely that part has been EXTRACTED from the expert, not how
// well a learner knows it. Everything here is pure and DOM/IO-free (the loop_preflight pattern):
// levels and scores are DERIVED from live units by these functions, never stored, so the rubric can
// evolve without a migration (ADR-0253).

export const UNIT_KINDS = ["procedure", "edge_case", "exception", "checklist", "glossary", "escalation"] as const;
export type UnitKind = (typeof UNIT_KINDS)[number];
export function isUnitKind(v: unknown): v is UnitKind {
  return typeof v === "string" && (UNIT_KINDS as readonly string[]).includes(v);
}

export const TEACHBACK_VERDICTS = ["confirmed", "corrected", "rejected"] as const;
export type TeachbackVerdict = (typeof TEACHBACK_VERDICTS)[number];
export function isTeachbackVerdict(v: unknown): v is TeachbackVerdict {
  return typeof v === "string" && (TEACHBACK_VERDICTS as readonly string[]).includes(v);
}

/** Elicitation seeds shipped in the pack: scenarios first (they surface tacit knowledge), then
 *  direct probes for structure, then edge probes ("what goes wrong here"). */
export interface Elicitation {
  scenarios: string[];
  probes: string[];
  edgeProbes: string[];
}

export interface CoverageObjective {
  objectiveId: string; // stable, pack-authored (invariant #9), e.g. "wmo-2.1"
  packId: string;
  domain: string;
  title: string;
  description: string;
  weight: number; // extraction priority; relative, > 0
  elicitation: Elicitation;
}

/** The slice of a knowledge unit the rubric needs. `live` units only (superseded_by unset). */
export interface UnitForCoverage {
  kind: UnitKind;
  completeness: number; // 0-100
  confirmed: boolean;
}

// ── The L0-L3 rubric (ADR-0255 decision 2) ─────────────────────────────────
// L0 unexplored -> L1 outline captured -> L2 procedure stepped -> L3 edge cases captured AND the
// procedure confirmed. The thresholds are deliberate: L2 requires a reasonably complete procedure
// (>= L2_PROCEDURE_COMPLETENESS), L3 requires teach-back confirmation, not just capture.
export type CoverageLevel = 0 | 1 | 2 | 3;
export const L2_PROCEDURE_COMPLETENESS = 60;

export function objectiveLevel(units: readonly UnitForCoverage[]): CoverageLevel {
  if (units.length === 0) return 0;
  const procedures = units.filter((u) => u.kind === "procedure");
  const steppedProcedure = procedures.some((u) => u.completeness >= L2_PROCEDURE_COMPLETENESS);
  const confirmedProcedure = procedures.some((u) => u.confirmed && u.completeness >= L2_PROCEDURE_COMPLETENESS);
  const confirmedEdge = units.some((u) => (u.kind === "edge_case" || u.kind === "exception") && u.confirmed);
  if (confirmedProcedure && confirmedEdge) return 3;
  if (steppedProcedure) return 2;
  return 1;
}

/** Weighted coverage across the map, 0-100. An empty map is 0 (nothing to cover is nothing covered,
 *  deliberately: an extraction pack with no objectives should read as unstarted, never as done). */
export function coverageScore(
  objectives: readonly CoverageObjective[],
  unitsByObjective: ReadonlyMap<string, readonly UnitForCoverage[]>,
): number {
  if (objectives.length === 0) return 0;
  let total = 0;
  let earned = 0;
  for (const o of objectives) {
    const w = Math.max(0, o.weight);
    total += w;
    earned += (w * objectiveLevel(unitsByObjective.get(o.objectiveId) ?? [])) / 3;
  }
  return total === 0 ? 0 : Math.round((earned / total) * 100);
}

export interface GapEntry {
  objective: CoverageObjective;
  level: CoverageLevel;
}

/** The gap queue: least-covered first, ties broken by descending weight then stable id order.
 *  Fully-extracted (L3) objectives are EXCLUDED - the planner must never re-ask confirmed ground
 *  (ADR-0255 cadence rule). This is the weakDomains inversion: it drives what to ask next. */
export function gapQueue(
  objectives: readonly CoverageObjective[],
  unitsByObjective: ReadonlyMap<string, readonly UnitForCoverage[]>,
): GapEntry[] {
  return objectives
    .map((objective) => ({ objective, level: objectiveLevel(unitsByObjective.get(objective.objectiveId) ?? []) }))
    .filter((e) => e.level < 3)
    .sort((a, b) => {
      if (a.level !== b.level) return a.level - b.level;
      if (a.objective.weight !== b.objective.weight) return b.objective.weight - a.objective.weight;
      return a.objective.objectiveId < b.objective.objectiveId ? -1 : 1;
    });
}

/** Per-domain coverage rollup for the HUD/dashboard (invariant #11 renders it; this derives it). */
export function domainCoverage(
  objectives: readonly CoverageObjective[],
  unitsByObjective: ReadonlyMap<string, readonly UnitForCoverage[]>,
): Array<{ domain: string; score: number }> {
  const byDomain = new Map<string, CoverageObjective[]>();
  for (const o of objectives) {
    const list = byDomain.get(o.domain) ?? [];
    list.push(o);
    byDomain.set(o.domain, list);
  }
  return [...byDomain.entries()].map(([domain, objs]) => ({ domain, score: coverageScore(objs, unitsByObjective) }));
}
