// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/judgment/judge_bans.ts - P-JEV.5 (ADR-0416): a LOCAL model that failed as a judge more than once is not
// asked again. Local means a LUCID local provider (Settings > Local Providers, materialized into omp's
// models.yml under its `ompProvider` slug) or omp's own on-device `local/*` runner: the boxes that go away
// (VPN down, DGX asleep) and time out instead of answering. Cloud judges are not counted: a transient 5xx
// there is not a reason to lose the judge for good.
//
// The ledger is fed by the judgment trace every child already POSTs (harness/omp/judgment_extension.ts,
// P-JEV.2): a report with `error` for a local label counts one failure. From JUDGE_BAN_FAILURES on, the
// model is banned: it is left out of the chain at the next spawn (judgment_policy.judgeChain) and the
// extension skips it in-process at once (LUCID_JUDGE_BANS / LUCID_JUDGE_LOCAL_PROVIDERS env). A ban holds
// until the user resets it in Settings > Judgment. Pure functions over a plain record; the store lives in
// settings_store.ts.

/** Failures after which a local model is no longer asked ("more than once"). */
export const JUDGE_BAN_FAILURES = 2;

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

/** PURE: the ledger after one judgment report. Only a FAILED judgment of a LOCAL model changes it. */
export function noteJudgeOutcome(
  ledger: JudgeFailureLedger,
  report: { label: string; error?: string },
  localProviders: readonly string[],
  now: number,
): JudgeFailureLedger {
  if (!report.error || !isLocalJudge(report.label, localProviders)) return ledger;
  const prev = ledger[report.label];
  return { ...ledger, [report.label]: { failures: (prev?.failures ?? 0) + 1, lastAt: now, lastError: report.error.slice(0, 200) } };
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
