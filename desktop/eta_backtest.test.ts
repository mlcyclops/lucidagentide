// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/eta_backtest.test.ts - P-PROGRESS.4 (ADR-0413): the replay scores honestly (no peeking at the turn
// being predicted, silence is a miss) and the adopted estimator beats the P-PROGRESS.1 baseline.

import { describe, expect, test } from "bun:test";
import { backtest, syntheticTurns } from "./eta_backtest.ts";
import { estimateTurn, NO_ESTIMATE, typicalEstimate, type TurnSample } from "./turn_progress.ts";

const turn = (totalMs: number): TurnSample => ({ model: "m", scope: "", totalMs });

describe("backtest", () => {
  test("each prediction sees only the turns that finished before it", () => {
    const seen: number[] = [];
    backtest([turn(10_000), turn(20_000), turn(30_000)], (i) => { seen.push(i.history.size); return NO_ESTIMATE; }, [0.5]);
    expect(seen).toEqual([0, 1, 2]);
  });

  test("a checkpoint without a number is a miss; only answered ones enter the median; the band is +/-30%", () => {
    const silent = backtest([turn(100_000)], () => NO_ESTIMATE, [0.5]);
    expect(silent).toEqual({ points: 1, predicted: 0, medianAbsErrMs: null, within30: 0 });
    const says = (etaMs: number) => backtest([turn(100_000)], () => ({ ...NO_ESTIMATE, etaMs }), [0.5]); // 50 s really left
    expect(says(64_000)).toEqual({ points: 1, predicted: 1, medianAbsErrMs: 14_000, within30: 1 });
    expect(says(34_000).within30).toBe(0);
  });

  test("the adopted estimator beats the P-PROGRESS.1 baseline on the synthetic corpus, on both measures", () => {
    const turns = syntheticTurns();
    const base = backtest(turns, typicalEstimate);
    const cur = backtest(turns, estimateTurn);
    expect(cur.predicted).toBe(base.predicted); // same history floors: the win is not from answering less
    expect(cur.medianAbsErrMs!).toBeLessThan(base.medianAbsErrMs!);
    expect(cur.within30).toBeGreaterThan(base.within30);
  });
});
