// desktop/checker_model.ts
//
// P-GOAL.6 (ADR-0048): pick a good CHECKER model for the /goal loop. The loop's checker (ADR-0046) runs
// once per iteration to decide whether the verifiable condition holds — a small, frequent, read-only
// judgement. Running it on the maker's model (often a flagship) is wasteful: a checker wants a model
// that's CHEAP and FAST yet capable and RECENT. This module recommends one from the user's OWN model
// picker — i.e. only models their configured providers/subscriptions actually expose — so the default
// always works, and the user can still override it with any model they like.
//
// PURE module: no I/O. `recommendCheckerModel(models, current)` is fully unit-tested. The heuristic,
// in order: (1) stay in the user's CURRENT provider family when it offers a small-tier model — same
// credentials/billing they're already using; (2) prefer the small-but-capable tier (haiku / flash /
// mini) over both ultra-cheap-but-weak (nano / lite / oss) and flagship overkill (opus / sonnet / pro /
// full gpt); (3) prefer the NEWEST version; (4) prefer a clean "latest" alias over a date-pinned id.

/** A model option as omp reports it in the `model` config (provider-prefixed value + display name). */
export interface ModelOption { value: string; name?: string; description?: string }

/** Checker fitness tier of a model name. Higher = better fit for a frequent, cheap judgement call. */
function tier(name: string): 0 | 1 | 2 {
  const n = name.toLowerCase();
  // Ultra-cheap / possibly-too-weak FIRST (so "flash-lite" scores as lite, not flash).
  if (/nano|lite|oss/.test(n)) return 1;
  if (/haiku|flash|mini|spark/.test(n)) return 2;        // small + capable: the checker sweet spot
  return 0;                                              // sonnet / opus / pro / full gpt / o3 — overkill
}

/** Numeric version of a model id, version-comparable WITHIN a family. Dates are stripped first so a
 *  date suffix never reads as a huge version. "claude-3-5-haiku" → 3.5, "claude-haiku-4-5" → 4.5,
 *  "gpt-5.4-mini" → 5.4, "gemini-2.5-flash" → 2.5, "gpt-5" → 5. Unknown → 0. */
function version(value: string): number {
  const id = value.split("/").pop() ?? value;
  const noDate = id.replace(/\d{6,8}/g, " ");           // drop YYYYMMDD-style pins
  const m = /(\d+)(?:[.\-](\d+))?/.exec(noDate);
  if (!m) return 0;
  const major = Number(m[1]);
  const minor = m[2] != null ? Number(m[2]) : 0;
  return major + minor / 10;
}

function provider(value: string): string {
  const i = value.indexOf("/");
  return i < 0 ? "" : value.slice(0, i);
}

/** Cost penalty for flagship markers — only breaks ties WITHIN a tier (so a flagship-only fallback
 *  prefers the cheaper family, e.g. sonnet over opus, and "max" tiers rank last). */
function sizePenalty(name: string): number {
  const n = name.toLowerCase();
  if (/opus|ultra|-max\b/.test(n)) return 400;
  if (/\bpro\b|-pro\b/.test(n)) return 150;
  return 0;
}

/** True for a clean "latest"-pointer id (no date pin / "-latest" alias) — preferred so the checker
 *  tracks the newest snapshot automatically. */
function isAlias(value: string): boolean {
  const id = value.split("/").pop() ?? value;
  return !/\d{6,8}/.test(id);
}

/** A RAG / image / preview-only route can't act as a checker. */
function isUsable(value: string): boolean {
  const n = value.toLowerCase();
  return !/\b(rag|image|review|tab_)\b|antigravity\/tab|query\/rag|codex-auto-review/.test(n);
}

export interface CheckerRecommendation { value: string; why: string }

/** Recommend a checker model from the user's accessible `models`, biased toward the `current` (chat)
 *  model's provider. Returns null only when the list is empty. */
export function recommendCheckerModel(models: ModelOption[], current: string): CheckerRecommendation | null {
  const usable = models.filter((m) => m?.value && isUsable(m.value));
  if (!usable.length) return null;
  const curProvider = provider(current);

  const score = (m: ModelOption): number => {
    const t = tier(m.value);
    const sameProvider = provider(m.value) === curProvider && curProvider ? 1 : 0;
    // tier dominates; then same-provider (same auth/billing); then newest, minus a flagship-cost
    // penalty (only matters within a tier); then a clean "latest" alias.
    return t * 1_000_000 + sameProvider * 100_000 + version(m.value) * 100 - sizePenalty(m.value) + (isAlias(m.value) ? 5 : 0);
  };

  let best = usable[0]!;
  let bestScore = score(best);
  for (const m of usable) { const s = score(m); if (s > bestScore) { best = m; bestScore = s; } }

  const t = tier(best.value);
  const same = provider(best.value) === curProvider && curProvider;
  const why = t === 2
    ? `newest small-tier model${same ? ` in your ${curProvider} family` : ""} — fast and cheap to run every iteration`
    : t === 1
    ? `lightest capable model available${same ? ` in your ${curProvider} family` : ""} — keeps per-iteration checks cheap`
    : `no small/fast model in your providers; using the most economical capable one available`;
  return { value: best.value, why };
}

/** Resolve the model the checker should actually use: the user's explicit choice if it's still in the
 *  accessible list, else the recommendation, else the maker's `current` model (the ADR-0046 default).
 *  Fail-safe: a stale/removed override never blocks the loop — it falls through to the recommendation. */
export function resolveCheckerModel(opts: { chosen: string; models: ModelOption[]; current: string }): { value: string; source: "chosen" | "recommended" | "maker" } {
  const has = (v: string) => opts.models.some((m) => m.value === v);
  if (opts.chosen && has(opts.chosen)) return { value: opts.chosen, source: "chosen" };
  const rec = recommendCheckerModel(opts.models, opts.current);
  if (rec) return { value: rec.value, source: "recommended" };
  return { value: opts.current, source: "maker" };
}
