// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/startup_model.ts - P-MODEL.1 (ADR-0250): what the model picker DEFAULTS to on a fresh session.
//
// omp opens every new session on its own hardcoded default (the Claude Opus flagship) no matter what the
// user configured or was just using. This PURE module resolves what a fresh session should open on instead:
//   1. the LAST-USED model, when it is still in the picker and its provider still holds a credential;
//   2. else the BEST model among the providers the user actually configured: most capable tier first,
//      direct route over the gov gateway on ties, then newest version;
//   3. else null - keep omp's default (nothing configured yet, or no options reported).
// The caller (acp_backend.ensureSession) applies the pick via session/set_config_option FIRE-AND-FORGET,
// mirroring the ADR-0217 lockdown pattern (a hung model switch must never block session init). Lockdown
// wins: when the AskSage lock is ON the caller runs enforceAsksageLock INSTEAD of this.

import { cmpModelsNewestFirst, isAuxiliaryModel, isChinaModel, isDeprecatedModel, isGovModel } from "./renderer/model_families.ts";
import type { ModelOption } from "./checker_model.ts";

export interface StartupModelInput {
  /** The persisted last-used model ("" on a fresh install). */
  lastUsed: string;
  /** The model omp reports active right now (its default on a fresh session). */
  current: string;
  /** The accessible picker options omp reported (provider-prefixed values). */
  options: ModelOption[];
  /** Whether the model's provider holds a usable credential (key / OAuth / gateway). Unknown providers
   *  (a user-added local provider) should return true - they only exist because the user configured them. */
  isConfigured: (value: string) => boolean;
}

export interface StartupModelPick { value: string; source: "last-used" | "best-configured" }

/** Capability rank for the "best configured" pick - higher is more capable. Small/cheap tiers are ranked
 *  below balanced ones, flagships on top. `\bmini` (not bare `mini`) so "gemini" never reads as a mini. */
function capability(value: string): number {
  const s = value.toLowerCase();
  if (/\bmini|nano|lite|flash|haiku|oss|spark|-8b|-7b/.test(s)) return 1;
  if (/opus|fable|mythos|ultra|-max\b|\bpro\b|-pro\b|gpt-5|gpt-o|grok/.test(s)) return 3;
  return 2; // sonnet-class workhorses and anything unrecognized
}

/** Resolve the model a fresh session should open on. Null = no better signal than omp's own default. */
export function resolveStartupModel(input: StartupModelInput): StartupModelPick | null {
  const { lastUsed, options, isConfigured } = input;
  if (!options.length) return null;
  // 1) Last used: the user's own standing choice beats any heuristic. Only require that it is still
  //    offered and its provider still has a credential - deprecation/China gating never evicts an
  //    explicit pick (the user made it once; re-making it every launch is the bug this fixes).
  if (lastUsed && options.some((o) => o.value === lastUsed) && isConfigured(lastUsed)) {
    return { value: lastUsed, source: "last-used" };
  }
  // 2) Best among configured providers. Eligible = a real chat model: not an auxiliary/RAG route, not
  //    deprecated, and not a sovereignty-gated China-origin model (those stay a deliberate manual pick).
  const candidates = options.filter((o) =>
    !isAuxiliaryModel(o.value) && !isDeprecatedModel(o.value) && !isChinaModel(o.value)
    && !/(^|\/)rag$/i.test(o.value) && isConfigured(o.value));
  if (!candidates.length) return null;
  candidates.sort((a, b) =>
    capability(b.value) - capability(a.value) // most capable tier first
    || Number(isGovModel(a.value)) - Number(isGovModel(b.value)) // direct route before the gov gateway
    || cmpModelsNewestFirst(a.value, b.value)); // newest version, stable alpha tie-break
  return { value: candidates[0]!.value, source: "best-configured" };
}
