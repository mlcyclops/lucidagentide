// desktop/loop_estimate.test.ts
//
// P-GOAL.6.1 (ADR-0048): the /goal loop token estimate. Verifies the per-iteration math, clamping to the
// 1..20 loop range, and the compact token formatter.

import { describe, expect, test } from "bun:test";
import { CHECKER_TOKENS_PER_ITER, estimateGoalCost, estimateGoalTokens, formatTokens, formatUSD, MAKER_TOKENS_PER_ITER } from "./loop_estimate.ts";

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

describe("estimateGoalCost (cache-aware dollars)", () => {
  const flat = { inPerM: 10, outPerM: 10 }; // simple round numbers
  test("no cache: net == full == iters × (maker + checker) priced tokens", () => {
    const c = estimateGoalCost({ maxIters: 1, makerPrice: flat, checkerPrice: flat, cacheRate: 0 });
    // maker 7000 in + 2000 out = 9000 tok × $10/1M = $0.09; checker 1500 tok × $10/1M = $0.015
    expect(c.net).toBeCloseTo(0.105, 6);
    expect(c.full).toBeCloseTo(0.105, 6);
    expect(c.savings).toBe(0);
  });
  test("cache discounts input only (cached billed at 10%), producing real savings", () => {
    const c = estimateGoalCost({ maxIters: 1, makerPrice: flat, checkerPrice: flat, cacheRate: 1 });
    // all input cached → input billed at 10%. maker: (7000×0.1 + 2000)×10/1M = 0.027; checker: (1200×0.1+300)×10/1M = 0.0042
    expect(c.net).toBeCloseTo(0.0312, 6);
    expect(c.full).toBeCloseTo(0.105, 6);
    expect(c.savings).toBeCloseTo(0.0738, 6);
  });
  test("scales with iterations and clamps to 1..20", () => {
    const a = estimateGoalCost({ maxIters: 6, makerPrice: flat, checkerPrice: flat, cacheRate: 0 });
    const b = estimateGoalCost({ maxIters: 1, makerPrice: flat, checkerPrice: flat, cacheRate: 0 });
    expect(a.net).toBeCloseTo(b.net * 6, 6);
    expect(estimateGoalCost({ maxIters: 99, makerPrice: flat, checkerPrice: flat, cacheRate: 0 }).iters).toBe(20);
  });
});

describe("formatUSD", () => {
  test("rounds to whole cents", () => {
    expect(formatUSD(0)).toBe("$0.00");
    expect(formatUSD(0.426)).toBe("$0.43");
    expect(formatUSD(12.3)).toBe("$12.30");
  });
});
