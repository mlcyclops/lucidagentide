// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/startup_model.ts - P-MODEL.1 (ADR-0250): what the model picker DEFAULTS to on a fresh session.
//
// omp opens every new session on its own default no matter what the user configured or was just using.
// This PURE module resolves what a fresh session should open on instead:
//   1. the user's EXPLICIT picker choice, when it is still offered and its provider holds a credential;
//   2. else the LAST-USED model, but only a CLOUD one;
//   3. else the best CLOUD model among the providers the user actually configured, ranked by the CURATED
//      DEFAULT_MODEL_PREFERENCE list in model_families.ts (P-MODEL.2), direct route before the gov gateway;
//   4. else null - no cloud model to open on yet (or no options reported).
// The caller (acp_backend.ensureSession) applies the pick via session/set_config_option FIRE-AND-FORGET,
// mirroring the ADR-0217 lockdown pattern (a hung model switch must never block session init). Lockdown
// wins: when the AskSage lock is ON the caller runs enforceAsksageLock INSTEAD of this.
//
// P-MODEL.2: ranking goes through preferredDefaultModel (one capability heuristic, one definition), not a
// cross-family version-digit sort that handed the default to whichever vendor had the bigger number.
//
// Cloud-only default (fix/v2.5.1-provider-default-models): the AUTOMATIC pick only ever lands on a CLOUD
// model. A local model (an omp implicit engine such as Ollama, or a configured Local Provider) is restored
// only when the user explicitly chose it in the picker (`chosen`; settings_store.chosenModel() already
// narrows legacy values to explicit picks). An auto-stamped `lastUsed` that is local is never resurrected,
// and when no cloud model is available yet the result is null, so the renderer holds the composer and the
// post-OAuth re-run picks the cloud model instead of LUCID opening on a local model nobody asked for.

import { isAuxiliaryModel, isGovModel, preferredDefaultModel } from "./renderer/model_families.ts";
import type { ModelOption } from "./checker_model.ts";

export interface StartupModelInput {
  /** The user's EXPLICIT picker choice ("" when none). Local or cloud, it wins while still offered. */
  chosen?: string;
  /** The persisted last-used model ("" on a fresh install). Auto-stamped from omp's active model, so it is
   *  NOT an explicit choice: honored only when it is a cloud model. */
  lastUsed: string;
  /** The model omp reports active right now (its default on a fresh session). */
  current: string;
  /** The accessible picker options omp reported (provider-prefixed values). */
  options: ModelOption[];
  /** Whether the model's provider holds a usable credential (key / OAuth / gateway). Unknown providers
   *  (a user-added local provider) should return true - they only exist because the user configured them. */
  isConfigured: (value: string) => boolean;
  /** Whether the model is LOCAL (isLocalModel with the user's Local Provider prefixes). Defaults to "never". */
  isLocal?: (value: string) => boolean;
}

export interface StartupModelPick { value: string; source: "chosen" | "last-used" | "best-configured" }

/** Resolve the model a fresh session should open on. Null = no cloud model to open on yet (or nothing
 *  offered): the caller leaves omp's model alone and the renderer holds the composer until one appears. */
export function resolveStartupModel(input: StartupModelInput): StartupModelPick | null {
  const { chosen = "", lastUsed, options, isConfigured } = input;
  const isLocal = input.isLocal ?? (() => false);
  if (!options.length) return null;
  const usable = (v: string) => !!v && !isAuxiliaryModel(v) && options.some((o) => o.value === v) && isConfigured(v);
  // 1) The explicit picker choice is never re-litigated by any heuristic, however "better" the curated
  //    default looks, and it is the ONLY way a local model is ever restored. Non-chat (embedding) ids are
  //    never honored: they were never a real choice, and keeping one means every turn returns nothing.
  if (usable(chosen)) return { value: chosen, source: "chosen" };
  // 2) Last used, CLOUD only: an auto-stamped local value (the v2.5.1 Ollama embedding default) must not
  //    come back. A cloud last-used is kept (P-MODEL.2): it is itself a cloud default, and dropping it
  //    re-opens the "keeps going back to Opus" bug for users who never clicked a picker row.
  if (usable(lastUsed) && !isLocal(lastUsed)) return { value: lastUsed, source: "last-used" };
  // 3) Best CLOUD model among configured providers, per the curated list. preferredDefaultModel already
  //    drops auxiliary routes, deprecated ids, China-origin models and the RAG route, so `accept` carries
  //    only what is session-specific: a credential, and not local. Two passes keep the ADR-0250 "direct
  //    route before the gov gateway" preference: the gov gateway is a COMPLIANCE route with its own quota,
  //    so a user with any direct provider opens on it and only a gov-only user lands on AskSage.
  const cloud = (v: string) => isConfigured(v) && !isLocal(v);
  const pick = preferredDefaultModel(options, (v) => cloud(v) && !isGovModel(v))
    ?? preferredDefaultModel(options, cloud);
  return pick ? { value: pick.value, source: "best-configured" } : null;
}
