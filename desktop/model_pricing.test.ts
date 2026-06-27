// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/model_pricing.test.ts
//
// P-GOAL.7 (ADR-0049): per-model pricing. Verifies the tier table matches the right markers in the right
// order (lite/mini before the family fallback), that actual usage overrides the list price, and that the
// assumed cache rate prefers the ledger's observed value.

import { describe, expect, test } from "bun:test";
import { assumedCacheRate, listPrice, priceFor, type LedgerLike } from "./model_pricing.ts";

describe("listPrice tiers", () => {
  test("matches the cheapest/most-specific marker first", () => {
    expect(listPrice("openai-codex/gpt-5.4-nano").inPerM).toBe(0.05);
    expect(listPrice("google/gemini-3.1-flash-lite").inPerM).toBe(0.10); // lite, not flash
    expect(listPrice("asksage-openai/gpt-5-mini").inPerM).toBe(0.25);    // mini, not the gpt fallback
    expect(listPrice("anthropic/claude-haiku-4-5").inPerM).toBe(0.80);
    expect(listPrice("asksage-google/google-gemini-3.5-flash-gov").inPerM).toBe(0.30);
  });
  test("flagships and family fallbacks", () => {
    expect(listPrice("anthropic/claude-opus-4-8")).toEqual({ inPerM: 15, outPerM: 75 });
    expect(listPrice("anthropic/claude-sonnet-4-6")).toEqual({ inPerM: 3, outPerM: 15 });
    expect(listPrice("google/gemini-3-pro").inPerM).toBe(1.25);
    expect(listPrice("openai-codex/gpt-5.5").inPerM).toBe(1.25);
  });
  test("unknown ⇒ a sane default", () => {
    expect(listPrice("acme/whatever-7")).toEqual({ inPerM: 3, outPerM: 15 });
  });
});

describe("priceFor", () => {
  const ledger: LedgerLike = {
    models: [{ model: "anthropic/claude-opus-4-8", tokens: { input: 1_000_000, output: 500_000 }, cost: { input: 12, output: 30 } }],
    totals: { cacheHitRate: 0.6 },
  };
  test("derives the ACTUAL per-million price from the user's usage when metered", () => {
    const r = priceFor("anthropic/claude-opus-4-8", ledger);
    expect(r.source).toBe("actual");
    expect(r.price.inPerM).toBeCloseTo(12, 5);  // $12 / 1M input tokens
    expect(r.price.outPerM).toBeCloseTo(60, 5); // $30 / 0.5M output tokens
  });
  test("falls back to LIST price for a model not in the ledger (or with no metered usage)", () => {
    expect(priceFor("anthropic/claude-haiku-4-5", ledger).source).toBe("list");
    expect(priceFor("anthropic/claude-haiku-4-5", ledger).price.inPerM).toBe(0.80);
    expect(priceFor("anthropic/claude-opus-4-8", null).source).toBe("list");
  });
});

describe("assumedCacheRate", () => {
  test("prefers the ledger's observed rate, else a modest default", () => {
    expect(assumedCacheRate({ totals: { cacheHitRate: 0.7 } })).toBe(0.7);
    expect(assumedCacheRate(null)).toBe(0.35);
    expect(assumedCacheRate({ totals: { cacheHitRate: 2 } })).toBe(0.35); // out of range ⇒ default
  });
});
