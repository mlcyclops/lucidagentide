// desktop/loop_estimate.ts
//
// P-GOAL.6.1 (ADR-0048): a rough TOKEN estimate for a /goal loop run, shown in the launcher so the user
// can confirm the cost before starting. A loop is N iterations; each iteration is one MAKER turn (the
// agent works toward the goal — context + reasoning + tool output) plus one CHECKER call (a short judge
// or a command run + a one-line JSON verdict). We can't know the real token count ahead of time, so this
// is a transparent, deliberately-rough upper-ish estimate with named per-iteration assumptions the UI
// surfaces in a tooltip. PURE + unit-tested; no I/O, safe to import in the renderer bundle.

// Per-iteration token assumptions, split input/output so a dollar estimate can price them separately and
// apply the prompt-cache discount to the (large, repeated) input. Totals: maker 9k, checker 1.5k.
export const MAKER_IN_PER_ITER = 7_000;
export const MAKER_OUT_PER_ITER = 2_000;
export const CHECKER_IN_PER_ITER = 1_200;
export const CHECKER_OUT_PER_ITER = 300;
/** Assumed output+context tokens for one maker iteration (working turn with tool calls). */
export const MAKER_TOKENS_PER_ITER = MAKER_IN_PER_ITER + MAKER_OUT_PER_ITER;
/** Assumed tokens for one checker call (small judge prompt / command run + short JSON verdict). */
export const CHECKER_TOKENS_PER_ITER = CHECKER_IN_PER_ITER + CHECKER_OUT_PER_ITER;

export interface LoopEstimate { iters: number; maker: number; checker: number; total: number }

export interface Price { inPerM: number; outPerM: number }
export interface LoopCost { iters: number; net: number; full: number; savings: number; cacheRate: number }

/** Estimate total tokens for a loop of `maxIters` iterations. Clamped to the loop's 1..20 range so the
 *  number tracks what will actually run. A loop usually stops EARLY (the moment the condition holds), so
 *  this is the ceiling, not the expectation — the tooltip says so. */
export function estimateGoalTokens(opts: { maxIters: number }): LoopEstimate {
  const iters = Math.min(20, Math.max(1, Math.floor(opts.maxIters) || 1));
  const maker = iters * MAKER_TOKENS_PER_ITER;
  const checker = iters * CHECKER_TOKENS_PER_ITER;
  return { iters, maker, checker, total: maker + checker };
}

/** Cost of one piece (one model's work) in USD, with the prompt-cache discount applied to input:
 *  cached input is billed at ~10% of the input price. Returns net (after cache) and full (no cache). */
function pieceCost(inTok: number, outTok: number, price: Price, cacheRate: number): { net: number; full: number } {
  const cached = inTok * cacheRate;
  const fresh = inTok - cached;
  const net = (fresh * price.inPerM + cached * price.inPerM * 0.1 + outTok * price.outPerM) / 1e6;
  const full = (inTok * price.inPerM + outTok * price.outPerM) / 1e6;
  return { net, full };
}

/** Estimate the DOLLAR cost of a loop: maker iterations priced on `makerPrice`, checker checks on
 *  `checkerPrice`, both discounted by `cacheRate` on input (the loop re-sends a large identical prefix
 *  each round, so cache reuse is real). `net` is what you'd pay; `savings` is what the cache saves. */
export function estimateGoalCost(opts: { maxIters: number; makerPrice: Price; checkerPrice: Price; cacheRate: number }): LoopCost {
  const iters = Math.min(20, Math.max(1, Math.floor(opts.maxIters) || 1));
  const rate = Math.min(1, Math.max(0, opts.cacheRate));
  const maker = pieceCost(MAKER_IN_PER_ITER, MAKER_OUT_PER_ITER, opts.makerPrice, rate);
  const checker = pieceCost(CHECKER_IN_PER_ITER, CHECKER_OUT_PER_ITER, opts.checkerPrice, rate);
  const net = (maker.net + checker.net) * iters;
  const full = (maker.full + checker.full) * iters;
  return { iters, net, full, savings: full - net, cacheRate: rate };
}

/** Round to whole cents, "$0.00". */
export function formatUSD(n: number): string { return `$${(Math.round(n * 100) / 100).toFixed(2)}`; }

/** Compact token count: 1500 → "1.5k", 21000 → "21k", 1_200_000 → "1.2M". */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 10_000) return `${Math.round(n / 1_000)}k`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}
