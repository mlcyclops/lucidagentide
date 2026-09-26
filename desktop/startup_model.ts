// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/startup_model.ts - P-MODEL.1 (ADR-0250): what the model picker DEFAULTS to on a fresh session.
//
// omp opens every new session on its own hardcoded default (the Claude Opus flagship) no matter what the
// user configured or was just using. This PURE module resolves what a fresh session should open on instead:
//   1. the LAST-USED model, when it is still in the picker and its provider still holds a credential;
//   2. else the best model among the providers the user actually configured, ranked by the CURATED
//      DEFAULT_MODEL_PREFERENCE list in model_families.ts (P-MODEL.2), direct route before the gov gateway;
//   3. else null - keep omp's default (nothing configured yet, or no options reported).
// The caller (acp_backend.ensureSession) applies the pick via session/set_config_option FIRE-AND-FORGET,
// mirroring the ADR-0217 lockdown pattern (a hung model switch must never block session init). Lockdown
// wins: when the AskSage lock is ON the caller runs enforceAsksageLock INSTEAD of this.
//
// P-MODEL.2: step 2 no longer sorts by a local capability rank plus raw version digits. Digits are not
// comparable across families, so that sort handed the fresh-install default to whichever vendor happened to
// have the bigger number (`gpt-6-astra` [6] over `claude-opus-5` [5]). Ranking now goes through
// preferredDefaultModel, and the private `capability()` copy of capabilityTier that had drifted from the
// real one (it knew `grok`/`spark`, capabilityTier did not) is gone: one heuristic, one definition.

import { isGovModel, preferredDefaultModel } from "./renderer/model_families.ts";
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

/** Resolve the model a fresh session should open on. Null = no better signal than omp's own default. */
export function resolveStartupModel(input: StartupModelInput): StartupModelPick | null {
  const { lastUsed, options, isConfigured } = input;
  if (!options.length) return null;
  // 1) Last used: an EXPLICIT user choice is never re-litigated by any heuristic, however "better" the
  //    curated default looks. Only require that it is still offered and its provider still has a
  //    credential - deprecation/China gating never evicts an explicit pick (the user made it once;
  //    re-making it every launch is the bug this whole module fixes).
  if (lastUsed && options.some((o) => o.value === lastUsed) && isConfigured(lastUsed)) {
    return { value: lastUsed, source: "last-used" };
  }
  // 2) Best among configured providers, per the curated list. preferredDefaultModel already drops
  //    auxiliary routes, deprecated ids, China-origin models and the RAG route, so `accept` only carries
  //    what is session-specific: does this provider hold a credential.
  //    Two passes keep the ADR-0250 "direct route before the gov gateway" preference intact: the gov
  //    gateway is a COMPLIANCE route with its own quota, not a capability upgrade, so a user who has any
  //    direct provider configured opens on it and only a gov-only user lands on AskSage.
  const pick = preferredDefaultModel(options, (v) => isConfigured(v) && !isGovModel(v))
    ?? preferredDefaultModel(options, isConfigured);
  return pick ? { value: pick.value, source: "best-configured" } : null;
}
