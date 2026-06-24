// desktop/loop_estimate.test.ts
//
// P-GOAL.6.1 (ADR-0048): the /goal loop token estimate. Verifies the per-iteration math, clamping to the
// 1..20 loop range, and the compact token formatter.

import { describe, expect, test } from "bun:test";
import { CHECKER_TOKENS_PER_ITER, estimateGoalTokens, formatTokens, MAKER_TOKENS_PER_ITER } from "./loop_estimate.ts";

describe("estimateGoalTokens", () => {
  test("scales linearly: total = iters × (maker + checker) per iteration", () => {
    const e = estimateGoalTokens({ maxIters: 6 });
    expect(e.iters).toBe(6);
    expect(e.maker).toBe(6 * MAKER_TOKENS_PER_ITER);
    expect(e.checker).toBe(6 * CHECKER_TOKENS_PER_ITER);
    expect(e.total).toBe(6 * (MAKER_TOKENS_PER_ITER + CHECKER_TOKENS_PER_ITER));
  });

  test("clamps to the loop's 1..20 range (matches what can actually run)", () => {
    expect(estimateGoalTokens({ maxIters: 0 }).iters).toBe(1);
    expect(estimateGoalTokens({ maxIters: 99 }).iters).toBe(20);
    expect(estimateGoalTokens({ maxIters: NaN as unknown as number }).iters).toBe(1);
  });
});

describe("formatTokens", () => {
  test("compact human form", () => {
    expect(formatTokens(900)).toBe("900");
    expect(formatTokens(1_500)).toBe("1.5k");
    expect(formatTokens(21_000)).toBe("21k");
    expect(formatTokens(63_000)).toBe("63k");
    expect(formatTokens(1_200_000)).toBe("1.2M");
  });
});
