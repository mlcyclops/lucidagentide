// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/budget_gate.ts - which provider governs the current model, and whether to show the
// status-bar budget pill.
//
// PURE (no DOM), so the OAuth-vs-API-key gate is unit-testable. omp's agent.db "N-hour" budget is the
// OAuth / subscription window, which lags and reads inaccurately; the status-bar pill is only meaningful
// when the provider is set with an API KEY (the figure then comes from real rate-limit headers). So we
// SHOW the pill for key-authed providers and HIDE it for OAuth-only configs.

// P-MODEL.1 (ADR-0250): no bridge.ts import - bridge is DOM-typed, and the SERVER (acp_backend's
// fresh-session model default) imports this module too. These minimal structural slices are satisfied by
// bridge.ts's ProviderAuth/AuthStatus (renderer) and auth_status.ts's (server) alike; the generics hand
// back the caller's own element type.
export interface ProviderAuthLike { id: string; keySet: boolean }
export interface AuthGroupsLike<T extends ProviderAuthLike = ProviderAuthLike> { gateway: T[]; majors: T[]; others: T[] }

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

/** The provider-auth row that governs `model`, searched across every auth group, or undefined if none match. */
export function providerForModel<T extends ProviderAuthLike>(auth: AuthGroupsLike<T> | null, model: string): T | undefined {
  if (!auth) return undefined;
  const kws = providerKeywords(model);
  const all = [...(auth.gateway ?? []), ...(auth.majors ?? []), ...(auth.others ?? [])];
  return all.find((p) => { const id = p.id.toLowerCase(); return kws.some((k) => id.includes(k) || k.includes(id)); });
}

/** Whether the current model's provider is authenticated with an API KEY (vs OAuth-only). Unknown
 *  (auth not loaded yet, or an unrecognised provider) → true, so the pill is left as-is, never hidden
 *  on a guess. OAuth-only (oauth active, no key) → false → hide the inaccurate budget pill. */
export function providerHasApiKey(auth: AuthGroupsLike | null, model: string): boolean {
  if (!auth) return true;
  const prov = providerForModel(auth, model);
  return prov ? prov.keySet : true;
}

/** Cached subscription reports have no observation timestamp or account identity. Match provider
 *  labels conservatively; never substitute an API-key probe for a subscription allowance. */
export function providerBudgetRows<T extends { label: string }>(rows: readonly T[], providerId: string): T[] {
  const aliases: Record<string, readonly string[]> = {
    anthropic: ["claude", "anthropic"], openai: ["openai", "codex", "gpt"],
    google: ["google", "gemini"], xai: ["xai", "grok"], "github-copilot": ["github copilot", "copilot"],
  };
  return rows.filter((row) => {
    const label = row.label.toLowerCase();
    return (aliases[providerId] ?? [providerId]).some((alias) =>
      label === alias || (label.startsWith(alias) && /[\s:/-]/.test(label[alias.length] ?? "")));
  });
}

/** A passed reset is not proof of a replenished allowance. Keep unknown values unknown. */
export function budgetWindowState(row: { used: number; resetsAt: number | null }, now = Date.now()): {
  remainingPercent: number | null; resetsAt: number | null; expired: boolean;
} {
  const resetsAt = row.resetsAt != null && Number.isFinite(row.resetsAt) && row.resetsAt > 0
    && row.resetsAt <= 8.64e15 ? row.resetsAt : null;
  const expired = resetsAt != null && resetsAt <= now;
  return {
    remainingPercent: !expired && Number.isFinite(row.used) && row.used >= 0 && row.used <= 1
      ? Math.round((1 - row.used) * 100) : null,
    resetsAt,
    expired,
  };
}
