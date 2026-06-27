// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/model_pricing.ts
//
// P-GOAL.7 (ADR-0049): a per-model token PRICE, used to put a rough dollar figure on a /goal loop run.
// Two sources, in priority order:
//   1. ACTUAL — the user's own usage ledger (omp reports real cost + tokens per model). If they've run
//      a model before, that's the truest price for THEM (their plan, their region, their discounts).
//   2. LIST — a built-in per-tier table (approximate public list prices, USD per 1M tokens) so a model
//      they've never run still gets a sensible estimate.
// Both are estimates; the UI says so. PURE + unit-tested; no I/O (the ledger is passed in).

export interface Price { inPerM: number; outPerM: number } // USD per 1,000,000 tokens

// Built-in list prices by tier, matched in order (cheapest/most-specific markers first so e.g.
// "flash-lite" matches lite, "gpt-5-mini" matches mini, before the broader family fallbacks).
const TABLE: [RegExp, Price][] = [
  [/nano/, { inPerM: 0.05, outPerM: 0.40 }],
  [/lite/, { inPerM: 0.10, outPerM: 0.40 }],
  [/\bmini\b/, { inPerM: 0.25, outPerM: 2.00 }], // \b so it never matches the "mini" inside "geMINI"
  [/haiku/, { inPerM: 0.80, outPerM: 4.00 }],
  [/flash/, { inPerM: 0.30, outPerM: 2.50 }],
  [/oss/, { inPerM: 0.10, outPerM: 0.40 }],
  [/spark/, { inPerM: 0.25, outPerM: 2.00 }],
  [/opus/, { inPerM: 15.0, outPerM: 75.0 }],
  [/sonnet/, { inPerM: 3.00, outPerM: 15.0 }],
  [/\bpro\b/, { inPerM: 1.25, outPerM: 10.0 }],
  [/\bo[34]\b|o3|o4/, { inPerM: 2.00, outPerM: 8.00 }],
  [/gpt-?5|gpt-?4|codex/, { inPerM: 1.25, outPerM: 10.0 }],
  [/gemini/, { inPerM: 1.25, outPerM: 10.0 }],
];
const DEFAULT_PRICE: Price = { inPerM: 3.00, outPerM: 15.0 }; // sonnet-ish, when nothing matches

/** List price for a model id, matched by tier markers. Always returns a price (default if unknown). */
export function listPrice(model: string): Price {
  const n = (model || "").toLowerCase();
  for (const [re, p] of TABLE) if (re.test(n)) return p;
  return DEFAULT_PRICE;
}

// Just the shape we need from the usage ledger (kept loose so callers can pass the full ledger).
export interface LedgerModel { model: string; tokens?: { input?: number; output?: number }; cost?: { input?: number; output?: number } }
export interface LedgerLike { models?: LedgerModel[]; totals?: { cacheHitRate?: number } }

/** The price for a model: derived from the user's actual usage if that model has metered input AND
 *  output in the ledger, otherwise the list price. */
export function priceFor(model: string, ledger?: LedgerLike | null): { price: Price; source: "actual" | "list" } {
  const m = ledger?.models?.find((x) => x.model === model);
  const ti = m?.tokens?.input ?? 0, to = m?.tokens?.output ?? 0;
  const ci = m?.cost?.input ?? 0, co = m?.cost?.output ?? 0;
  if (ti > 0 && to > 0 && ci > 0 && co > 0) {
    return { price: { inPerM: (ci / ti) * 1e6, outPerM: (co / to) * 1e6 }, source: "actual" };
  }
  return { price: listPrice(model), source: "list" };
}

/** The cache-hit rate to assume (0..1): the user's observed overall rate if the ledger has one, else a
 *  modest default — a goal loop re-sends a large, identical prefix every iteration, so reuse is real. */
export function assumedCacheRate(ledger?: LedgerLike | null): number {
  const r = ledger?.totals?.cacheHitRate;
  return typeof r === "number" && r >= 0 && r <= 1 ? r : 0.35;
}
