// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/trainer/quizgen.ts - P-TRAINER.6 (ADR-0252/0255): trainee mode - the flywheel's TRAIN leg.
//
// Quiz items are generated FROM CONFIRMED UNITS ONLY and every item cites its source unit (the
// TacticalGenAI `verifiedSource` idea with the unit as the source of record). Deterministic template
// generation, pure: procedures become next-step questions with decoy steps drawn from the SAME unit
// (plausible by construction), edge cases become what-does-the-firm-do questions with decoy
// resolutions drawn from OTHER units. A trainee miss appends an extraction target - under-specified
// knowledge flows back to the interview planner (the weakDomains inversion, closing the loop).
// Seeded shuffling only (no Math.random): same units + same seed -> the same exam, replayable.

import type { KnowledgeUnitRow } from "./store.ts";

export interface TraineeQuizItem {
  id: string;
  objectiveId: string;
  sourceUnitId: string; // the citation - trainee content is never unsourced
  question: string;
  options: string[]; // exactly 4 when generable
  correctAnswer: number; // index into options
  explanation: string;
}

export interface TraineeResult {
  item: TraineeQuizItem;
  chosen: number;
}

/** xorshift32 - a tiny deterministic PRNG; seeded, replayable, no Math.random (repo rule). */
function rng(seed: number): () => number {
  let x = seed || 0x9e3779b9;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 0xffffffff;
  };
}

function shuffled<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

interface ParsedStructure {
  steps: string[];
  trigger: string;
  resolution: string;
}

function parseStructure(unit: KnowledgeUnitRow): ParsedStructure {
  try {
    const s = (JSON.parse(unit.structure) ?? {}) as Record<string, unknown>;
    return {
      steps: Array.isArray(s.steps) ? s.steps.filter((x): x is string => typeof x === "string") : [],
      trigger: typeof s.trigger === "string" ? s.trigger : "",
      resolution: typeof s.resolution === "string" ? s.resolution : "",
    };
  } catch {
    return { steps: [], trigger: "", resolution: "" };
  }
}

function isConfirmedLive(u: KnowledgeUnitRow): boolean {
  return u.confirmed_at != null && u.superseded_by == null && u.trust_label === "untrusted";
}

/**
 * Generate a deterministic trainee quiz from confirmed units. Units that cannot yield a fair
 * 4-option item (procedures under 5 steps - anchor + correct + 3 decoys, edge cases without 3
 * decoy resolutions) are skipped - a thin option set telegraphs the answer.
 */
export function quizFromUnits(units: readonly KnowledgeUnitRow[], seed: number): TraineeQuizItem[] {
  const confirmed = units.filter(isConfirmedLive);
  const rand = rng(seed);
  const items: TraineeQuizItem[] = [];

  const allResolutions = confirmed
    .map((u) => parseStructure(u).resolution)
    .filter((r) => r.trim().length > 0);

  for (const u of confirmed) {
    const s = parseStructure(u);
    if ((u.kind === "procedure" || u.kind === "checklist") && s.steps.length >= 5) {
      // next-step question: pick an anchor step, decoys are the unit's OTHER steps.
      const anchorIdx = Math.floor(rand() * (s.steps.length - 1));
      const anchor = s.steps[anchorIdx]!;
      const correct = s.steps[anchorIdx + 1]!;
      const decoys = shuffled(s.steps.filter((x) => x !== correct && x !== anchor), rand).slice(0, 3);
      if (decoys.length < 3) continue;
      const options = shuffled([correct, ...decoys], rand);
      items.push({
        id: `q-${u.unit_id}-${anchorIdx}`,
        objectiveId: u.objective_id,
        sourceUnitId: u.unit_id,
        question: `In "${u.title}", what is the correct next step after: "${anchor}"?`,
        options,
        correctAnswer: options.indexOf(correct),
        explanation: `Per the confirmed procedure "${u.title}", the step after "${anchor}" is "${correct}".`,
      });
    } else if ((u.kind === "edge_case" || u.kind === "exception") && s.trigger && s.resolution) {
      const decoys = shuffled(allResolutions.filter((r) => r !== s.resolution), rand).slice(0, 3);
      if (decoys.length < 3) continue;
      const options = shuffled([s.resolution, ...decoys], rand);
      items.push({
        id: `q-${u.unit_id}-edge`,
        objectiveId: u.objective_id,
        sourceUnitId: u.unit_id,
        question: `${s.trigger} What does the firm do?`,
        options,
        correctAnswer: options.indexOf(s.resolution),
        explanation: `Confirmed edge case "${u.title}": ${s.resolution}`,
      });
    }
  }
  return items;
}

/** Trainee mastery per objective, 0-100 (the TacticalGenAI masteryMap, same shape). */
export function masteryFromResults(results: readonly TraineeResult[]): Record<string, number> {
  const byObjective = new Map<string, { right: number; total: number }>();
  for (const r of results) {
    const t = byObjective.get(r.item.objectiveId) ?? { right: 0, total: 0 };
    t.total++;
    if (r.chosen === r.item.correctAnswer) t.right++;
    byObjective.set(r.item.objectiveId, t);
  }
  const out: Record<string, number> = {};
  for (const [id, t] of byObjective) out[id] = Math.round((t.right / t.total) * 100);
  return out;
}

/** Objectives whose trainee mastery falls below the bar - these are NEW EXTRACTION TARGETS: a
 *  trainee miss on confirmed material means the material under-specifies, so it goes back to the
 *  interview planner's gap queue (the flywheel's return edge). */
export function extractionTargetsFromMisses(results: readonly TraineeResult[], passBar = 70): string[] {
  const mastery = masteryFromResults(results);
  return Object.entries(mastery)
    .filter(([, score]) => score < passBar)
    .map(([objectiveId]) => objectiveId)
    .sort();
}
