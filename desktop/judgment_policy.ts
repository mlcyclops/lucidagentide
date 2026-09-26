// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-JEV.1 (ADR-0374): the judgment-backend policy. omp 18.2.4+ answers typed judgments (choice / yes-no /
// score) through `providers.judgmentProvider`:
//   auto      -> TypeSafe (Jev, api.typesafe.ai) whenever a TYPESAFE_API_KEY credential exists, else the LLM chain
//   typesafe  -> TypeSafe first; a failed call falls back to the online LLM chain (omp's behavior, not ours)
//   llm       -> never TypeSafe
// A judgment request carries session STATE (conversation text, tool output) to the judge, so under AskSage
// lockdown it is exactly the CUI backflow the model clamp (ADR-0217) exists to prevent. The resolver below is
// the one place that rule lives: lockdown pins `llm` no matter what is stored, and the stored preference is
// kept intact so lifting the lock restores it. Pure, so it is unit-tested without a settings file.

import { closeSync, openSync, writeFileSync } from "node:fs";

export type JudgmentProvider = "auto" | "typesafe" | "llm";
export const JUDGMENT_PROVIDERS: readonly JudgmentProvider[] = ["auto", "typesafe", "llm"] as const;

/** Parse an untrusted value into the closed set; anything else is omp's default, `auto`. */
export function parseJudgmentProvider(v: unknown): JudgmentProvider {
  return v === "typesafe" || v === "llm" ? v : "auto";
}

export interface ResolvedJudgmentProvider {
  /** What the user chose (or the default). Survives a lockdown so lifting it restores the choice. */
  stored: JudgmentProvider;
  /** What omp is actually told. */
  effective: JudgmentProvider;
  /** True when lockdown overrode the stored choice (or would override a non-llm choice). */
  clamped: boolean;
  locked: boolean;
}

/** Fail-closed: AskSage lockdown (user or org-managed) pins `llm`. Everything else passes through. */
export function resolveJudgmentProvider(stored: unknown, locked: boolean): ResolvedJudgmentProvider {
  const s = parseJudgmentProvider(stored);
  if (locked) return { stored: s, effective: "llm", clamped: s !== "llm", locked: true };
  return { stored: s, effective: s, clamped: false, locked: false };
}

/** P-JEV.2 (ADR-0377): whether Jev can answer a judgment in the running child, as LUCID configured it.
 *  Mirrors omp's `usesTypeSafeJudge` from the desktop's side: `llm` never; `typesafe` always tries (omp
 *  will fail and fall back without a key, which the trace then shows); `auto` only with a saved key. This
 *  gates the per-turn "Jev not consulted" note: a user who never set Jev up must not be told about it. */
export function jevActive(effective: JudgmentProvider, keySet: boolean): boolean {
  return effective === "typesafe" || (effective === "auto" && keySet);
}

/** The omp `--config` overlay body. Later overlays deep-merge over earlier ones in omp's Settings, so this
 *  file rides AFTER harness/omp/acp_config.yml and touches only the one key. */
export function judgmentOverlayYaml(effective: JudgmentProvider): string {
  return `# Written by LUCID at every omp spawn (P-JEV.1). Do not edit: Settings > Judgment owns this value.\nproviders:\n  judgmentProvider: ${effective}\n`;
}

/** Write the overlay through ONE descriptor (open-then-write, never exists-then-write). */
export function writeJudgmentOverlay(path: string, effective: JudgmentProvider): void {
  const fd = openSync(path, "w");
  try { writeFileSync(fd, judgmentOverlayYaml(effective), "utf8"); } finally { closeSync(fd); }
}
