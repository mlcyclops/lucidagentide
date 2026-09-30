// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/judgment/judge_bans.ts - P-JEV.5 (ADR-0416): a LOCAL model that failed as a judge more than once is not
// asked again. Local means a LUCID local provider (Settings > Local Providers, materialized into omp's
// models.yml under its `ompProvider` slug) or omp's own on-device `local/*` runner: the boxes that go away
// (VPN down, DGX asleep) and time out instead of answering. A cloud judge's TRANSIENT failure (5xx,
// overloaded, rate limit) is not counted: it is not a reason to lose the judge for good.
//
// P-JEV.6 (ADR-0421): a judge whose account says the MODEL DOES NOT EXIST is not asked again either, cloud
// or local, from the first such answer. omp's smol priority patterns name `gpt-5.3-codex-spark` for the
// openai-codex OAuth provider, and the same pattern matches `openai/gpt-5.3-codex-spark` under an API-key
// account that has no such model; that judge answered every judgment with a 404 (`model_not_found`) before
// the chain moved on. A 404 for a model is deterministic for that account: retrying it is only latency.
//
// The ledger is fed by the judgment trace every child already POSTs (harness/omp/judgment_extension.ts,
// P-JEV.2): a report with `error` for a local label counts one failure; a report whose error names a
// missing model counts as banned outright. From JUDGE_BAN_FAILURES on, the model is banned: it is left out
// of the chain at the next spawn (judgment_policy.judgeChain) and the extension skips it in-process at once
// (LUCID_JUDGE_BANS / LUCID_JUDGE_LOCAL_PROVIDERS env). A ban holds until the user resets it in Settings >
// Judgment. Pure functions over a plain record; the store lives in settings_store.ts.

/** Failures after which a local model is no longer asked ("more than once"). */
export const JUDGE_BAN_FAILURES = 2;

/** P-JEV.6: the provider's own words for "this model is not yours to call": OpenAI's `model_not_found` /
 *  "does not exist or you do not have access", Anthropic's `not_found_error` for a model, the generic
 *  "unknown model" of OpenAI-compatible servers. Rate limits, overloads, 5xx and timeouts do not match. */
const MISSING_MODEL_ERROR = /model_not_found|not_found_error|no such model|unknown model|model .{0,80}(does not exist|not found|is not available)|(does not exist|do not have access).{0,80}model/i;

/** Whether a judge's failure means its model cannot be called from this account at all (not a transient). */
export function isMissingModelError(error: string | undefined): boolean {
  return !!error && MISSING_MODEL_ERROR.test(error);
}

export interface JudgeFailure {
  failures: number;
  lastAt: number;
  lastError: string;
}
/** Keyed by the judge label omp reports: `provider/model`. */
export type JudgeFailureLedger = Record<string, JudgeFailure>;

/** The provider of a judge label (`dgx-spark/glm-5.3-flash` -> `dgx-spark`), or "" when unqualified. */
export function labelProvider(label: string): string {
  const i = label.indexOf("/");
  return i > 0 ? label.slice(0, i) : "";
}

/** Whether a judge label names a local model: a LUCID local provider slug, or omp's on-device `local`. */
export function isLocalJudge(label: string, localProviders: readonly string[]): boolean {
  const p = labelProvider(label);
  return p === "local" || localProviders.includes(p);
}

/** PURE: the ledger after one judgment report. A FAILED judgment of a LOCAL model counts one; a failure
 *  that says the model does not exist for this account (any provider) counts as banned outright. */
export function noteJudgeOutcome(
  ledger: JudgeFailureLedger,
  report: { label: string; error?: string },
  localProviders: readonly string[],
  now: number,
): JudgeFailureLedger {
  if (!report.error) return ledger;
  const missing = isMissingModelError(report.error);
  if (!missing && !isLocalJudge(report.label, localProviders)) return ledger;
  const prev = ledger[report.label];
  const failures = Math.max((prev?.failures ?? 0) + 1, missing ? JUDGE_BAN_FAILURES : 0);
  return { ...ledger, [report.label]: { failures, lastAt: now, lastError: report.error.slice(0, 200) } };
}

/** PURE: the labels that failed JUDGE_BAN_FAILURES times or more, oldest ban first. */
export function bannedJudges(ledger: JudgeFailureLedger): string[] {
  return Object.entries(ledger)
    .filter(([, f]) => f.failures >= JUDGE_BAN_FAILURES)
    .sort((a, b) => a[1].lastAt - b[1].lastAt)
    .map(([label]) => label);
}

/** The env the judgment extension reads: comma lists, empty when there is nothing to say. */
export function judgeBanEnv(localProviders: readonly string[], banned: readonly string[]): { LUCID_JUDGE_LOCAL_PROVIDERS: string; LUCID_JUDGE_BANS: string } {
  return { LUCID_JUDGE_LOCAL_PROVIDERS: localProviders.join(","), LUCID_JUDGE_BANS: banned.join(",") };
}

/** Parse one of those comma lists back (the extension side). */
export function parseCommaList(v: string | undefined): string[] {
  return (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}
