// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/loop_budget.ts
//
// P-GOAL.11 (ADR-0056): live per-loop SPEND accounting + a budget KILL SWITCH. loop-engineering's
// costliest failure mode is "Token Burn" — an unattended loop running full turns until the bill spikes;
// its mitigation is a "daily budget limit" / "kill switch". ADR-0049 already shows a pre-run cost
// ESTIMATE; this adds the ACTUALS and a hard ceiling that halts the loop the moment spend crosses it.
//
// PURE module (no I/O, no Date.now()), unit-tested. The backend folds each maker turn's peak usage into
// a running `LoopSpend`; because runGoal owns the turn boundaries, accounting is just "sum the per-turn
// peak cost" — exact for omp's per-turn `cost`, with no fragile counter-reset detection. Context tokens
// (`used`) are cumulative within the persistent maker session, so they are tracked as a PEAK, never summed.

export interface LoopSpend {
  /** total dollars spent so far = sum of each finished maker turn's peak cost. */
  usd: number;
  /** peak context-window fill seen (informational; NOT summed — context is cumulative per session). */
  peakContextTokens: number;
  /** number of turns folded in (maker iterations that reported usage). */
  turns: number;
}

export function newLoopSpend(): LoopSpend {
  return { usd: 0, peakContextTokens: 0, turns: 0 };
}

/** Fold a finished turn into the running spend: add its peak cost, raise the peak-context high-water
 *  mark. Non-finite / negative inputs are treated as zero (best-effort telemetry must never corrupt
 *  the total). Returns a NEW object (pure). */
export function addTurnSpend(spend: LoopSpend, turnPeakUsd: number, turnPeakContextTokens: number): LoopSpend {
  const usd = Number.isFinite(turnPeakUsd) && turnPeakUsd > 0 ? turnPeakUsd : 0;
  const ctx = Number.isFinite(turnPeakContextTokens) && turnPeakContextTokens > 0 ? turnPeakContextTokens : 0;
  return {
    usd: spend.usd + usd,
    peakContextTokens: Math.max(spend.peakContextTokens, ctx),
    turns: spend.turns + 1,
  };
}

/** The kill switch: true once a POSITIVE cap has been reached or exceeded. A non-positive cap (the
 *  default) means "no budget" and never trips — the iteration cap stays the only ceiling. */
export function overBudget(spentUsd: number, capUsd: number): boolean {
  return capUsd > 0 && spentUsd >= capUsd;
}

/** Clamp/normalize a user-entered budget cap: a finite, non-negative dollar amount (0 = no cap). */
export function normalizeBudget(capUsd: unknown): number {
  const n = Number(capUsd);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0;
}
