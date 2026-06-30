// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/model_families.ts
//
// P-IDE.1 (ADR-0029): model family classification for the picker. Pure, DOM-free, and unit-tested
// here so the regex order + grouping behaviour can't silently regress as the model list grows. The
// renderer (app.ts) wraps these in collapsible sections + the per-model hover card.

export interface ModelOption { value: string; name: string }
export interface ModelFamily { id: string; label: string; icon: string; match: RegExp }

// ORDER MATTERS: the o-series bucket is matched BEFORE the general GPT bucket, so `gpt-o3` lands in
// o-series, not GPT. Classification is on the model id (robust to provider prefixes like
// `asksage-openai/`). Families with no matching models are dropped by `groupByFamily`.
export const MODEL_FAMILIES: ModelFamily[] = [
  { id: "claude", label: "Anthropic Claude", icon: "spark", match: /claude|fable/i },
  { id: "gpt-o", label: "OpenAI o-series", icon: "brain", match: /gpt-o\d/i },
  { id: "gpt", label: "OpenAI GPT", icon: "command", match: /gpt/i },
  { id: "gemini", label: "Google Gemini", icon: "graph", match: /gemini/i },
  { id: "rag", label: "AskSage RAG", icon: "search", match: /(^|[/-])rag$/i },
];
// Catch-all for anything unmatched (e.g. a newly-added open-source provider). `/.^/` never matches,
// so `familyOf` only returns this via the explicit fallback - keeping it out of the ordered scan.
export const OTHER_FAMILY: ModelFamily = { id: "other", label: "Other models", icon: "bolt", match: /.^/ };

/** The family a model id belongs to (first match wins; OTHER_FAMILY if none). */
export function familyOf(value: string): ModelFamily {
  for (const f of MODEL_FAMILIES) if (f.match.test(value)) return f;
  return OTHER_FAMILY;
}

// ── P-IDE.1c (ADR-0029): catalog curation + data-sovereignty gating ──────────
// omp exposes no deprecation/provider metadata over ACP, so these rules live here (pure + tested).

/** Gov-gateway (AskSage CIV/MIL) model - only shown when an AskSage key is configured. */
export function isGovModel(value: string): boolean { return /asksage/i.test(value); }

/** omp auxiliary (non-chat) models - tab-completion + codex auto-review. Never shown in the picker. */
export function isAuxiliaryModel(value: string): boolean { return /tab_flash|tab_jump|auto-review/i.test(value); }

/** China-origin model (no U.S. data sovereignty). Hidden until the user acknowledges in Settings.
 *  Forward-looking: matches the providers the user flagged (DeepSeek, Kimi/Moonshot, MiniMax, GLM/Zhipu)
 *  plus common siblings, so a newly-configured one is gated by default rather than silently listed. */
export function isChinaModel(value: string): boolean {
  return /deepseek|kimi|moonshot|minimax|(^|[-/])glm(-|\b)|zhipu|qwen|ernie|hunyuan|doubao|(^|[-/])yi-|01-ai/i.test(value);
}

/** The GPT-5.x/4.x numeric version (e.g. 5.4), or null for non-versioned GPT (o-series, gpt-oss). */
export function gptVersion(value: string): number | null {
  const m = /gpt-(\d+(?:\.\d+)?)/i.exec(value);
  return m ? parseFloat(m[1]!) : null;
}

/** Deprecated/superseded model under the "moderate" policy (ADR-0029 P-IDE.1c):
 *  - dated-snapshot duplicates (…-20251001) and `-latest` aliases
 *  - clearly-legacy families: Claude 3.x and Claude 4.0/4.1 (keep 4.5+), Gemini 2.0 (keep 2.5+)
 *  - GPT below 5.4 everywhere (gov AND direct) - o-series and gpt-oss are version-less, kept. */
export function isDeprecatedModel(value: string): boolean {
  const s = value.toLowerCase();
  if (/-\d{8}(\b|$)/.test(s) || /-latest(\b|$)/.test(s)) return true;     // dated snapshot / alias
  if (/claude-3(\b|[-.])/.test(s)) return true;                            // Claude 3.x
  if (/claude-(?:opus|sonnet|haiku)-4-[01](\b|[-.])/.test(s)) return true; // Claude 4.0 / 4.1
  if (/gemini-2\.0(\b|[-.])/.test(s)) return true;                         // Gemini 2.0
  const gv = gptVersion(s);
  if (gv !== null && gv < 5.4) return true;                                // GPT < 5.4 (gov + direct)
  return false;
}

/** Sort key: numeric version groups, newest first. Ignores dates / param-counts (≥1000 and ≥100). */
function versionGroups(value: string): number[] {
  const tail = value.replace(/^[^/]*\//, "");
  return (tail.match(/\d+/g) ?? []).map(Number).filter((n) => n < 100);
}
/** Compare two model ids newest→oldest by version, breaking ties alphabetically. */
export function cmpModelsNewestFirst(a: string, b: string): number {
  const va = versionGroups(a), vb = versionGroups(b);
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const d = (vb[i] ?? -1) - (va[i] ?? -1);
    if (d) return d;
  }
  return a.localeCompare(b);
}
/** Order a model list so that, WITHIN each family (groupByFamily preserves relative order), gov models
 *  come first and each group is newest→oldest. (ADR-0029 P-IDE.1c.) */
export function sortGovFirstNewest(models: ModelOption[]): ModelOption[] {
  return models.slice().sort((a, b) => {
    const ga = isGovModel(a.value), gb = isGovModel(b.value);
    if (ga !== gb) return ga ? -1 : 1;
    return cmpModelsNewestFirst(a.value, b.value);
  });
}

/** Filter models by a free-text query across id + display name (empty query → all). */
export function filterModels(models: ModelOption[], q: string): ModelOption[] {
  const ql = q.trim().toLowerCase();
  if (!ql) return models;
  return models.filter((o) => o.name.toLowerCase().includes(ql) || o.value.toLowerCase().includes(ql));
}

/** Bucket models into families, dropping empty ones. Family order defaults to MODEL_FAMILIES (OTHER
 *  last); pass `order` (a list of family ids) to override - e.g. gov-first when AskSage is configured.
 *  Any family omitted from `order` is appended in its default position. Order WITHIN a family
 *  preserves the caller's input order (already curated upstream). */
export function groupByFamily(models: ModelOption[], order?: string[]): { fam: ModelFamily; models: ModelOption[] }[] {
  const buckets = new Map<string, ModelOption[]>();
  for (const m of models) {
    const id = familyOf(m.value).id;
    if (!buckets.has(id)) buckets.set(id, []);
    buckets.get(id)!.push(m);
  }
  const all = [...MODEL_FAMILIES, OTHER_FAMILY];
  let seq = all;
  if (order) {
    const ranked = all.filter((f) => order.includes(f.id)).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    const rest = all.filter((f) => !order.includes(f.id));
    seq = [...ranked, ...rest];
  }
  return seq.filter((f) => buckets.has(f.id)).map((f) => ({ fam: f, models: buckets.get(f.id)! }));
}

/** Family order when the AskSage gov gateway is configured: GPT + o-series + Gemini ABOVE Claude
 *  (the gov gateway's OpenAI/Google models are the user's primary surface in that mode). */
export const ASKSAGE_FAMILY_ORDER = ["gpt-o", "gpt", "gemini", "claude", "rag", "other"];
