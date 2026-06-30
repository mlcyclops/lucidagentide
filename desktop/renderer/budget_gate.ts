// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/budget_gate.ts - which provider governs the current model, and whether to show the
// status-bar budget pill.
//
// PURE (no DOM), so the OAuth-vs-API-key gate is unit-testable. omp's agent.db "N-hour" budget is the
// OAuth / subscription window, which lags and reads inaccurately; the status-bar pill is only meaningful
// when the provider is set with an API KEY (the figure then comes from real rate-limit headers). So we
// SHOW the pill for key-authed providers and HIDE it for OAuth-only configs.

import type { AuthStatus, ProviderAuth } from "./bridge.ts";

/** Provider keywords for the active model, so we can find the budget/auth that governs the next turn. */
export function providerKeywords(model: string): string[] {
  const m = model.toLowerCase();
  if (m.includes("claude") || m.includes("anthropic")) return ["claude", "anthropic"];
  if (m.includes("gpt") || m.includes("openai") || /\bo[0-9]/.test(m)) return ["openai", "gpt"];
  if (m.includes("gemini") || m.includes("google")) return ["gemini", "google"];
  if (m.includes("grok") || m.includes("xai")) return ["grok", "xai"];
  if (m.includes("deepseek")) return ["deepseek"];
  return [m.split(/[-/]/)[0] ?? m];
}

/** The ProviderAuth that governs `model`, searched across every auth group, or undefined if none match. */
export function providerForModel(auth: AuthStatus | null, model: string): ProviderAuth | undefined {
  if (!auth) return undefined;
  const kws = providerKeywords(model);
  const all = [...(auth.gateway ?? []), ...(auth.majors ?? []), ...(auth.others ?? [])];
  return all.find((p) => { const id = p.id.toLowerCase(); return kws.some((k) => id.includes(k) || k.includes(id)); });
}

/** Whether the current model's provider is authenticated with an API KEY (vs OAuth-only). Unknown
 *  (auth not loaded yet, or an unrecognised provider) → true, so the pill is left as-is, never hidden
 *  on a guess. OAuth-only (oauth active, no key) → false → hide the inaccurate budget pill. */
export function providerHasApiKey(auth: AuthStatus | null, model: string): boolean {
  if (!auth) return true;
  const prov = providerForModel(auth, model);
  return prov ? prov.keySet : true;
}
