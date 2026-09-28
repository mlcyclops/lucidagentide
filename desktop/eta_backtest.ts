// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/eta_backtest.ts - P-PROGRESS.4 (ADR-0413): score a turn estimator against turns that already
// happened, so a change to the ETA is adopted on numbers, not on taste.
//
// Replay: the turns in order, into an empty history bounded like the live one. At 10%, 25%, 50% and 75% of
// each turn's real length the estimator is asked for the time left, then the turn joins the history (so
// every prediction uses only turns that had finished before it, as live). The score is the median absolute
// error of the predictions and the share of checkpoints predicted within +/-30% of the real time left. A
// checkpoint with no prediction counts as a miss in that share, so an estimator cannot look better by
// saying nothing; `predicted` reports how many it answered.
//
// Pure: no IO. harness/scripts/eta_backtest.ts feeds it the real latency ledger.

import { DurationHistory, type EstimateInput, type TurnEstimate, type TurnSample } from "./turn_progress.ts";

/** Where in each past turn the estimator is asked, as fractions of the turn's real length. */
export const CHECKPOINTS: readonly number[] = [0.1, 0.25, 0.5, 0.75];
/** A prediction this close to the real time left, relative to it, is a hit. */
export const HIT_BAND = 0.3;

export interface BacktestScore {
  /** Checkpoints asked (turns x CHECKPOINTS). */
  points: number;
  /** Checkpoints the estimator answered with a number. */
  predicted: number;
  /** Median of |predicted - real| time left over the answered checkpoints; null when none was answered. */
  medianAbsErrMs: number | null;
  /** Share (0..1) of ALL checkpoints predicted within HIT_BAND of the real time left. */
  within30: number;
}

/** Replay `turns` in order and score `estimate` (a turn_progress estimator: typicalEstimate is the
 *  P-PROGRESS.1 baseline, estimateTurn the current one). Pure. */
export function backtest(turns: readonly TurnSample[], estimate: (i: EstimateInput) => TurnEstimate, checkpoints: readonly number[] = CHECKPOINTS): BacktestScore {
  const history = new DurationHistory();
  const errs: number[] = [];
  let points = 0;
  let hits = 0;
  for (const t of turns) {
    for (const f of checkpoints) {
      const elapsedMs = f * t.totalMs;
      const actual = t.totalMs - elapsedMs;
      points++;
      const left = estimate({ elapsedMs, model: t.model, scope: t.scope, history }).etaMs;
      if (left === null) continue;
      const err = Math.abs(left - actual);
      errs.push(err);
      if (err <= HIT_BAND * actual) hits++;
    }
    history.addTurn(t.model, t.totalMs, t.scope);
  }
  errs.sort((a, b) => a - b);
  const mid = errs.length >> 1;
  const medianAbsErrMs = !errs.length ? null : errs.length % 2 ? errs[mid]! : (errs[mid - 1]! + errs[mid]!) / 2;
  return { points, predicted: errs.length, medianAbsErrMs, within30: points ? hits / points : 0 };
}

/** A deterministic stand-in for a machine's ledger, shaped like the real one: most sessions mix quick chat
 *  answers (about 20 s) with long agentic runs (minutes), in proportions and lengths that differ by session
 *  and model, with lognormal spread. Same seed, same corpus. Pure. */
export function syntheticTurns(seed = 413, n = 400): TurnSample[] {
  let s = seed >>> 0;
  const rand = (): number => { // mulberry32
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const sessions = [
    { scope: "s-chat", model: "model-a", longShare: 0.25, longMs: 150_000 },
    { scope: "s-build", model: "model-a", longShare: 0.7, longMs: 450_000 },
    { scope: "s-mixed", model: "model-b", longShare: 0.45, longMs: 300_000 },
  ];
  const out: TurnSample[] = [];
  for (let i = 0; i < n; i++) {
    const sess = sessions[Math.floor(rand() * sessions.length)]!;
    const median = rand() < sess.longShare ? sess.longMs : 20_000;
    const normal = Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
    out.push({ model: sess.model, scope: sess.scope, totalMs: Math.max(1_000, Math.round(median * Math.exp(0.5 * normal))) });
  }
  return out;
}
