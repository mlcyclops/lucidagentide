// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/trainer/planner.ts - P-TRAINER.1 (ADR-0252/0255): the interview session planner.
//
// A pure, deterministic state machine (the gov_onboarding / loop_preflight pattern: no DOM, no IO,
// no clock - the caller supplies elapsed time). It encodes the ADR-0255 cadence rules as testable
// invariants:
//   - ONE question at a time: nextQuestion() re-issues the pending question until the answer lands.
//   - Scenario-first: an unexplored (L0) objective opens with a scenario probe, never a direct one.
//   - Energy-following: a deviation cue in an answer ("except", "unless", "one time", ...) queues
//     why-probes BEFORE the planner returns to the map, capped at FIVE_WHYS_MAX per thread.
//   - Edge-hunting: every L2 objective gets the standing "what goes wrong here" probe.
//   - Session cap: past the time budget the planner closes with a recap, it never asks on.
//   - Never re-ask confirmed ground: L3 objectives are excluded by the gap queue.
// Phrasing rotates deterministically by ask-count (the ADR-0249 lesson: rotation beats random -
// testable, and no line repeats back to back).

import {
  type CoverageObjective,
  type UnitForCoverage,
  gapQueue,
  objectiveLevel,
  coverageScore,
} from "./coverage.ts";

export const FIVE_WHYS_MAX = 5;
export const DEFAULT_SESSION_CAP_MS = 25 * 60 * 1000; // ADR-0255: 20-30 minute sittings

/** Answer text cues that signal a deviation/story worth chasing before returning to the map. */
export const DEVIATION_CUES = [
  "except",
  "unless",
  "depends",
  "one time",
  "that time",
  "usually",
  "normally",
  "workaround",
  "manually",
  "edge case",
  "special case",
  "unofficial",
] as const;

export type QuestionKind = "scenario" | "direct" | "edge_probe" | "followup";

export interface PlannedQuestion {
  objectiveId: string;
  kind: QuestionKind;
  text: string;
  /** why-thread depth for followups (1..FIVE_WHYS_MAX), 0 otherwise. */
  whyDepth: number;
}

export interface AnsweredTurn {
  question: PlannedQuestion;
  answer: string;
}

export interface PlannerState {
  objectives: readonly CoverageObjective[];
  unitsByObjective: ReadonlyMap<string, readonly UnitForCoverage[]>;
  sessionCapMs: number;
  /** Deterministic rotation counters, per objective. */
  askCounts: Readonly<Record<string, number>>;
  /** Queued follow-up probes (energy-following), consumed before the gap queue. */
  followups: readonly PlannedQuestion[];
  pending: PlannedQuestion | null;
  history: readonly AnsweredTurn[];
  closed: boolean;
}

export interface NextResult {
  state: PlannerState;
  /** null when the session is (now) closed - read `closing` instead. */
  question: PlannedQuestion | null;
  closing?: string;
}

export function startSession(
  objectives: readonly CoverageObjective[],
  unitsByObjective: ReadonlyMap<string, readonly UnitForCoverage[]>,
  opts: { sessionCapMs?: number } = {},
): PlannerState {
  return {
    objectives,
    unitsByObjective,
    sessionCapMs: opts.sessionCapMs ?? DEFAULT_SESSION_CAP_MS,
    askCounts: {},
    followups: [],
    pending: null,
    history: [],
    closed: false,
  };
}

/** The spoken/visual opener: where the map stands before the first question (ADR-0255 rule 3). */
export function openingRecap(state: PlannerState): string {
  const score = coverageScore(state.objectives, state.unitsByObjective);
  const gaps = gapQueue(state.objectives, state.unitsByObjective);
  if (gaps.length === 0) return "Every objective on this map is fully captured and confirmed. Nothing left to extract.";
  const head = gaps[0]!.objective;
  return `Coverage is at ${score} percent. The biggest gap is ${head.domain}: ${head.title}. Let's start there.`;
}

function rotate<T>(items: readonly T[], count: number): T | undefined {
  if (items.length === 0) return undefined;
  return items[count % items.length];
}

function questionFor(objective: CoverageObjective, units: readonly UnitForCoverage[], askCount: number): PlannedQuestion {
  const level = objectiveLevel(units);
  const e = objective.elicitation;
  if (level === 0) {
    const text = rotate(e.scenarios, askCount) ?? rotate(e.probes, askCount) ?? `Walk me through ${objective.title}.`;
    return { objectiveId: objective.objectiveId, kind: "scenario", text, whyDepth: 0 };
  }
  if (level === 1) {
    const text = rotate(e.probes, askCount) ?? `Step by step, how does ${objective.title} actually run?`;
    return { objectiveId: objective.objectiveId, kind: "direct", text, whyDepth: 0 };
  }
  // level 2: the standing edge hunt.
  const text = rotate(e.edgeProbes, askCount) ?? `What goes wrong in ${objective.title}, and what do you do when it does?`;
  return { objectiveId: objective.objectiveId, kind: "edge_probe", text, whyDepth: 0 };
}

/**
 * Produce the next question (or re-issue the pending one - one question at a time, always), or
 * close the session when the time budget is spent or the map is fully extracted.
 */
export function nextQuestion(state: PlannerState, elapsedMs: number): NextResult {
  if (state.closed) return { state, question: null, closing: closingSummary(state) };
  if (state.pending) return { state, question: state.pending }; // never two open questions

  if (elapsedMs >= state.sessionCapMs) {
    const closed = { ...state, closed: true };
    return { state: closed, question: null, closing: closingSummary(closed) };
  }

  // Energy-following: queued why-probes run before the planner returns to the map.
  if (state.followups.length > 0) {
    const [q, ...rest] = state.followups;
    const next: PlannerState = { ...state, followups: rest, pending: q! };
    return { state: next, question: q! };
  }

  const gaps = gapQueue(state.objectives, state.unitsByObjective);
  if (gaps.length === 0) {
    const closed = { ...state, closed: true };
    return { state: closed, question: null, closing: closingSummary(closed) };
  }
  const target = gaps[0]!.objective;
  const askCount = state.askCounts[target.objectiveId] ?? 0;
  const q = questionFor(target, state.unitsByObjective.get(target.objectiveId) ?? [], askCount);
  const next: PlannerState = {
    ...state,
    askCounts: { ...state.askCounts, [target.objectiveId]: askCount + 1 },
    pending: q,
  };
  return { state: next, question: q };
}

/** True when the answer contains a deviation/story cue worth chasing (case-insensitive). */
export function hasDeviationCue(answer: string): boolean {
  const a = answer.toLowerCase();
  return DEVIATION_CUES.some((cue) => a.includes(cue));
}

const WHY_PROBES = [
  "Why does it work that way instead of the standard path?",
  "What causes that situation in the first place?",
  "Why is that the fix, and what happens if it is skipped?",
  "Who decided it should work that way, and why?",
  "Why has that not been folded into the written procedure?",
] as const;

/**
 * Record the expert's answer to the pending question. A deviation cue queues the next why-probe on
 * the same objective (five-whys, capped); the caller separately distills the answer into units and
 * refreshes `unitsByObjective` via withUnits().
 */
export function recordAnswer(state: PlannerState, answer: string): PlannerState {
  if (!state.pending) throw new Error("recordAnswer: no pending question (one question at a time)");
  const q = state.pending;
  const history = [...state.history, { question: q, answer }];
  let followups = state.followups;
  const depth = q.kind === "followup" ? q.whyDepth : 0;
  if (hasDeviationCue(answer) && depth < FIVE_WHYS_MAX) {
    const nextDepth = depth + 1;
    followups = [
      ...followups,
      {
        objectiveId: q.objectiveId,
        kind: "followup",
        text: WHY_PROBES[(nextDepth - 1) % WHY_PROBES.length]!,
        whyDepth: nextDepth,
      },
    ];
  }
  return { ...state, pending: null, history, followups };
}

/** Refresh the planner's view of captured units (after distillation/teach-back writes). */
export function withUnits(state: PlannerState, unitsByObjective: ReadonlyMap<string, readonly UnitForCoverage[]>): PlannerState {
  return { ...state, unitsByObjective };
}

/** The closing recap: visible progress is the engagement contract (ADR-0255 rule 3). */
export function closingSummary(state: PlannerState): string {
  const score = coverageScore(state.objectives, state.unitsByObjective);
  const asked = state.history.length;
  const gaps = gapQueue(state.objectives, state.unitsByObjective);
  const next = gaps.length > 0 ? ` Next time: ${gaps[0]!.objective.title}.` : " The map is fully captured.";
  return `That's a wrap: ${asked} answers captured, coverage now ${score} percent.${next}`;
}
