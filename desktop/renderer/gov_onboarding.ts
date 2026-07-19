// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/gov_onboarding.ts - P-GOVCUI.1: the Government / GovCon + CUI onboarding step (pure, DOM-free).
//
// During first-run onboarding LUCID asks whether the user is a Government / GovCon user who handles CUI
// (Controlled Unclassified Information). A "yes" puts them on the accredited AskSage gov gateway in LOCKDOWN
// (every turn routed through the gateway; direct commercial providers hidden) - the CUI-safe posture - and
// prefills the AskSage CIV (government) routing endpoint so a novice (a manager, an exec, a new dev) does not
// have to know any of that. This module holds the PURE decision + the constants + the token-acquisition steps
// so the flow is unit-tested headless; app.ts owns the modals + DOM.
//
// This is COSMETIC onboarding state. It never weakens the gate. The real sovereignty control is `asksageOnly`
// (lockdown) plus the fail-closed server-side clamp (ADR-0217); this step just walks a new user into turning
// it on.

/** The AskSage CIV (government) routing endpoint LUCID prefills for a CUI user, so their gateway points at the
 *  accredited gov proxy rather than the commercial one (https://api.asksage.ai/server). Matches the in-repo
 *  default base (desktop/asksage.ts DEFAULT_BASE). */
export const CIV_ASKSAGE_BASE = "https://api.civ.asksage.ai/server";

/** Where a user generates an AskSage API key. */
export const ASKSAGE_ACCOUNT_URL = "https://asksage.ai";
/** AskSage's API-key documentation (the numbered steps below are the plain-language version). */
export const ASKSAGE_DOCS_URL = "https://docs.asksage.ai/docs/asksage-platform/getting-started/account-settings.html";

/** Plain-language steps a novice follows to obtain an AskSage API key. Verified against AskSage's docs
 *  (Settings -> Account tab -> "Manage your API Keys" -> generate). Kept as data so the modal + the demo +
 *  the tests all render the SAME steps. */
export const ASKSAGE_TOKEN_STEPS: readonly string[] = [
  "Sign in to AskSage at asksage.ai (use your government / CIV tenant if your team has one).",
  "Open Settings, then switch to the Account tab.",
  "Scroll to \"Manage your API Keys\" and generate a new API key.",
  "Copy the key (treat it like a password) and paste it below.",
];

/** The next action for the first-run Government/CUI step:
 *   - "skip"        the user already answered (either way) - never ask twice.
 *   - "auto-enable" an enterprise policy already forces gov-gateway-only routing, so there is nothing to ask;
 *                   just RECORD the CUI posture (the backend already enforces it).
 *   - "ask"         show the Yes/No question. */
export type GovOnboardingStep = "skip" | "auto-enable" | "ask";

/** Decide the first-run Government/CUI step. A prior answer always wins (ask exactly once). Failing that, an
 *  org that already mandates gov routing needs no question. Otherwise, ask. Pure. */
export function decideGovOnboarding(opts: { decided: boolean; managedGovLocked: boolean }): GovOnboardingStep {
  if (opts.decided) return "skip";
  if (opts.managedGovLocked) return "auto-enable";
  return "ask";
}

/** The saves the "Set up CUI mode" step performs, resolved from what the user provided. Splitting this out
 *  keeps the effectful renderer thin and lets the decision be unit-tested:
 *   - `baseUrl` is ALWAYS persisted (the CIV endpoint is prefilled even when the key is deferred);
 *   - `key` is saved (into ASKSAGE_API_KEY) only when non-empty;
 *   - lockdown (`only:true`) is enabled ONLY when a key is present - enabling it without a gateway key would
 *     leave no gov model to route to, which the backend then fail-closes on (blocking every turn). So a
 *     key-less "later" choice records the CUI intent + prefilled endpoint but does NOT flip lockdown. */
export interface GovSetupPlan {
  key: string | null;         // trimmed key to save, or null to leave the key untouched
  baseUrl: string;            // the routing endpoint to persist (CIV unless the user edited it)
  enableLockdown: boolean;    // flip asksageOnly on (only when a key is present)
}
export function planGovSetup(opts: { key: string; base: string }): GovSetupPlan {
  const key = opts.key.trim();
  const base = opts.base.trim() || CIV_ASKSAGE_BASE;
  return { key: key || null, baseUrl: base, enableLockdown: key.length > 0 };
}
