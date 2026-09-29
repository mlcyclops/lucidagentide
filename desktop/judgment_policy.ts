// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-JEV.1 (ADR-0374) + P-JEV.5 (ADR-0416): the judgment-backend policy.
//
// omp answers typed judgments (choice / yes-no / score: the per-turn auto-thinking effort, the unexpected
// stop check, the eval `judge()` bridge, `find`) through its `judge` MODEL ROLE: `modelRoles.judge` is the
// first candidate and `retry.fallbackChains.judge` the rest, tried in order (omp 18.2.10,
// `src/judgment/index.ts`). The `providers.judgmentProvider` key P-JEV.1 wrote is legacy there: omp migrates
// it into that role, `llm` becoming `@tiny, @smol, @default`, and `@tiny` resolves through omp's built-in
// "smol" priority patterns (`glm-5.3-flash`, `spark`, `haiku`, ...), which is how a LUCID local provider
// on an unreachable DGX box (dgx-spark/glm-5.3-flash) became the judge of every turn. A judge that times
// out ends the whole judgment (omp rethrows aborts; no fallback), so every judgment failed after 4 s.
//
// LUCID now writes the role explicitly and owns the chain:
//   none      -> no judge model at all (the DEFAULT; judging is opt-in). `modelRoles.judge` is a selector
//                nothing matches and the fallback chain is empty. omp still appends the SESSION model for
//                the judgments it cannot skip (auto-thinking with Thinking: Auto), so those are answered by
//                the chat model already in use and never wait on another provider.
//   llm       -> LUCID's local providers (fast, on your own hardware) then the chat model; never Jev
//   typesafe  -> Jev (typesafe/jev-latest) first, then the same
//   auto      -> Jev only when a TypeSafe key is saved, else the llm chain
// A LOCAL model that failed as a judge more than once is left out of the chain (judge_bans.ts), and the
// judgment extension skips it in-process from the second failure on, so a dead local box costs two
// judgments, not every one until a restart.
//
// A judgment carries session STATE (conversation text, tool output) to the judge, so under AskSage lockdown
// it is exactly the CUI backflow the model clamp (ADR-0217) exists to prevent: lockdown pins `llm` (or
// keeps `none`) whatever is stored, and the stored preference is kept so lifting the lock restores it.
// Pure, so it is unit-tested without a settings file.

import { closeSync, openSync, writeFileSync } from "node:fs";

export type JudgmentProvider = "none" | "auto" | "typesafe" | "llm";
export const JUDGMENT_PROVIDERS: readonly JudgmentProvider[] = ["none", "auto", "typesafe", "llm"] as const;
/** The default: no judge model until the user opts in (P-JEV.5). */
export const DEFAULT_JUDGMENT_PROVIDER: JudgmentProvider = "none";
/** omp's native System One judge (TypeSafe Jev), as a judge-role selector. */
export const JEV_SELECTOR = "typesafe/jev-latest";
/** A judge-role selector no catalog model matches: the role resolves to nothing. Provider-qualified so
 *  omp's pattern matcher cannot fuzzy-match it to a real model. */
export const NO_JUDGE_SELECTOR = "lucid-none/none";

/** Parse an untrusted value into the closed set; anything else is the default, `none`. */
export function parseJudgmentProvider(v: unknown): JudgmentProvider {
  return v === "auto" || v === "typesafe" || v === "llm" ? v : DEFAULT_JUDGMENT_PROVIDER;
}

export interface ResolvedJudgmentProvider {
  /** What the user chose (or the default). Survives a lockdown so lifting it restores the choice. */
  stored: JudgmentProvider;
  /** What omp is actually told. */
  effective: JudgmentProvider;
  /** True when lockdown overrode the stored choice. */
  clamped: boolean;
  locked: boolean;
}

/** Fail-closed: AskSage lockdown (user or org-managed) pins `llm`; `none` sends nothing anywhere and stays. */
export function resolveJudgmentProvider(stored: unknown, locked: boolean): ResolvedJudgmentProvider {
  const s = parseJudgmentProvider(stored);
  if (locked && s !== "none") return { stored: s, effective: "llm", clamped: s !== "llm", locked: true };
  return { stored: s, effective: s, clamped: false, locked };
}

/** P-JEV.2 (ADR-0377): whether Jev can answer a judgment in the running child, as LUCID configured it:
 *  `typesafe` always tries (omp fails and falls back without a key, which the trace then shows); `auto`
 *  only with a saved key; `llm` and `none` never. Gates the per-turn "Jev not consulted" note. */
export function jevActive(effective: JudgmentProvider, keySet: boolean): boolean {
  return effective === "typesafe" || (effective === "auto" && keySet);
}

/** What the chain is built from. `locals` are LUCID local-provider models as `provider/model` selectors,
 *  already without the banned ones; `chatModel` is the session's chat model (`provider/model`, or "" before
 *  omp reported one). */
export interface JudgeChainInput {
  effective: JudgmentProvider;
  keySet: boolean;
  locals: readonly string[];
  chatModel: string;
}

/** PURE: the judge-role candidates omp is told, in attempt order. Empty means no judge model. */
export function judgeChain(i: JudgeChainInput): string[] {
  if (i.effective === "none") return [];
  const out: string[] = [];
  if (i.effective === "typesafe" || (i.effective === "auto" && i.keySet)) out.push(JEV_SELECTOR);
  for (const l of i.locals) if (l && !out.includes(l)) out.push(l);
  if (i.chatModel && !out.includes(i.chatModel)) out.push(i.chatModel);
  return out;
}

/** The omp `--config` overlay body: the judge role and its fallback chain, nothing else. Later overlays
 *  deep-merge over earlier ones in omp's Settings, so this file rides AFTER harness/omp/acp_config.yml. */
export function judgmentOverlayYaml(chain: readonly string[]): string {
  const [first, ...rest] = chain;
  return `# Written by LUCID at every omp spawn (P-JEV.5). Do not edit: Settings > Judgment owns this value.\n` +
    `modelRoles:\n  judge: ${JSON.stringify(first ?? NO_JUDGE_SELECTOR)}\n` +
    `retry:\n  fallbackChains:\n    judge: [${rest.map((s) => JSON.stringify(s)).join(", ")}]\n`;
}

/** Write the overlay through ONE descriptor (open-then-write, never exists-then-write). */
export function writeJudgmentOverlay(path: string, chain: readonly string[]): void {
  const fd = openSync(path, "w");
  try { writeFileSync(fd, judgmentOverlayYaml(chain), "utf8"); } finally { closeSync(fd); }
}
