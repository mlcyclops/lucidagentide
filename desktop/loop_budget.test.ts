// desktop/loop_budget.test.ts — P-GOAL.11 (ADR-0056): the per-loop spend meter + budget kill switch.

import { describe, expect, test } from "bun:test";
import { addTurnSpend, type LoopSpend, newLoopSpend, normalizeBudget, overBudget } from "./loop_budget.ts";

describe("addTurnSpend", () => {
  test("sums per-turn peak cost and counts turns", () => {
    let s = newLoopSpend();
    s = addTurnSpend(s, 0.02, 1200);
    s = addTurnSpend(s, 0.05, 3400);
    expect(s.usd).toBeCloseTo(0.07, 10);
    expect(s.turns).toBe(2);
  });
  test("context tokens are a PEAK high-water mark, never summed", () => {
    let s = newLoopSpend();
    s = addTurnSpend(s, 0.01, 5000);
    s = addTurnSpend(s, 0.01, 9000);
    s = addTurnSpend(s, 0.01, 7000);
    expect(s.peakContextTokens).toBe(9000); // max, not 21000
  });
  test("non-finite / negative usage folds in as zero (telemetry never corrupts the total)", () => {
    let s = newLoopSpend();
    s = addTurnSpend(s, Number.NaN, -100);
    s = addTurnSpend(s, -0.5, Number.POSITIVE_INFINITY);
    expect(s.usd).toBe(0);
    expect(s.peakContextTokens).toBe(0);
    expect(s.turns).toBe(2); // a turn still counts even if it reported no usable usage
  });
  test("is pure — does not mutate its input", () => {
    const a: LoopSpend = newLoopSpend();
    const b = addTurnSpend(a, 0.03, 100);
    expect(a.usd).toBe(0);
    expect(b.usd).toBeCloseTo(0.03, 10);
  });
});

describe("overBudget (kill switch)", () => {
  test("trips at or above a positive cap", () => {
    expect(overBudget(0.49, 0.5)).toBe(false);
    expect(overBudget(0.5, 0.5)).toBe(true);
    expect(overBudget(0.51, 0.5)).toBe(true);
  });
  test("a non-positive cap means no budget — never trips", () => {
    expect(overBudget(9999, 0)).toBe(false);
    expect(overBudget(9999, -1)).toBe(false);
  });
});

describe("normalizeBudget", () => {
  test("accepts a positive amount, rounds to cents", () => {
    expect(normalizeBudget(2.5)).toBe(2.5);
    expect(normalizeBudget("1.239")).toBe(1.24);
  });
  test("zero / negative / junk ⇒ 0 (no cap)", () => {
    expect(normalizeBudget(0)).toBe(0);
    expect(normalizeBudget(-3)).toBe(0);
    expect(normalizeBudget("abc")).toBe(0);
    expect(normalizeBudget(undefined)).toBe(0);
  });
});
