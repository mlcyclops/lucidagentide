// desktop/loop_estimate.ts
//
// P-GOAL.6.1 (ADR-0048): a rough TOKEN estimate for a /goal loop run, shown in the launcher so the user
// can confirm the cost before starting. A loop is N iterations; each iteration is one MAKER turn (the
// agent works toward the goal — context + reasoning + tool output) plus one CHECKER call (a short judge
// or a command run + a one-line JSON verdict). We can't know the real token count ahead of time, so this
// is a transparent, deliberately-rough upper-ish estimate with named per-iteration assumptions the UI
// surfaces in a tooltip. PURE + unit-tested; no I/O, safe to import in the renderer bundle.

/** Assumed output+context tokens for one maker iteration (working turn with tool calls). */
export const MAKER_TOKENS_PER_ITER = 9_000;
/** Assumed tokens for one checker call (small judge prompt / command run + short JSON verdict). */
export const CHECKER_TOKENS_PER_ITER = 1_500;

export interface LoopEstimate { iters: number; maker: number; checker: number; total: number }

/** Estimate total tokens for a loop of `maxIters` iterations. Clamped to the loop's 1..20 range so the
 *  number tracks what will actually run. A loop usually stops EARLY (the moment the condition holds), so
 *  this is the ceiling, not the expectation — the tooltip says so. */
export function estimateGoalTokens(opts: { maxIters: number }): LoopEstimate {
  const iters = Math.min(20, Math.max(1, Math.floor(opts.maxIters) || 1));
  const maker = iters * MAKER_TOKENS_PER_ITER;
  const checker = iters * CHECKER_TOKENS_PER_ITER;
  return { iters, maker, checker, total: maker + checker };
}

/** Compact token count: 1500 → "1.5k", 21000 → "21k", 1_200_000 → "1.2M". */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 10_000) return `${Math.round(n / 1_000)}k`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}
