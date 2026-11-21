// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/relogin.ts - P-AUTH.RELOGIN1 (ADR-0640): what the titlebar re-login notice and the picker's
// Login row show. The engine decides WHICH sign-ins were lost (desktop/oauth_relogin.ts, `relogin` on each
// /api/auth row); this module only orders and words them. Pure, so the copy is testable without a DOM.

import type { AuthStatus, ProviderAuth } from "./bridge.ts";

/** The premium hover on every Login button. Users who never met the word "OAuth" learn what they agree to. */
export const LOGIN_TIP = "Log in with your account|This is OAuth: you sign in on the provider's own page (Claude, ChatGPT, Gemini) and approve LUCID there. LUCID never sees your password; it gets a token you can revoke anytime, and it uses the subscription you already pay for, so no API key is needed.";

/** The product half of a provider card name: "Anthropic · Claude" reads as "Claude". */
export function providerShortName(name: string): string {
  const i = name.lastIndexOf("\u00b7");
  return (i >= 0 ? name.slice(i + 1) : name).trim();
}

/** A readable name for a model the picker does not list right now (its provider is signed out, so there is
 *  no catalog name): "anthropic/claude-opus-5-5" reads "Claude Opus 5.5", "openai-codex/gpt-6.1-terra" "GPT 6.1 Terra". */
export function humanModelId(value: string): string {
  const words: string[] = [];
  for (const part of value.slice(value.lastIndexOf("/") + 1).split("-").filter(Boolean)) {
    if (/^\d+(\.\d+)*$/.test(part) && /\d$/.test(words.at(-1) ?? "")) words[words.length - 1] += `.${part}`;
    else words.push(/^gpt$/i.test(part) ? "GPT" : part[0]!.toUpperCase() + part.slice(1));
  }
  return words.join(" ");
}

/** Sign-ins that used to work and are gone, minus the ones the user waved off this launch. */
export function reloginTargets(auth: AuthStatus | null, dismissed: ReadonlySet<string>): ProviderAuth[] {
  if (!auth) return [];
  return [...auth.majors, ...auth.others, ...auth.gateway].filter((p) => p.relogin && !p.oauthActive && !dismissed.has(p.oauthId));
}

export type LoginState = "relogin" | "signed-out" | "signed-in";
export interface LoginChoice { provider: ProviderAuth; state: LoginState }

/** The providers the picker's Login row offers: every main subscription sign-in, plus any other provider whose
 *  sign-in was lost. Lost first, then not signed in, then signed in, so the one that needs a click leads. */
export function loginChoices(auth: AuthStatus | null): LoginChoice[] {
  if (!auth) return [];
  const rank: Record<LoginState, number> = { relogin: 0, "signed-out": 1, "signed-in": 2 };
  const pool = [...auth.majors.filter((p) => p.canOauth && p.oauthId), ...[...auth.others, ...auth.gateway].filter((p) => p.relogin && !p.oauthActive)];
  return pool
    .map((provider): LoginChoice => ({ provider, state: provider.oauthActive ? "signed-in" : provider.relogin ? "relogin" : "signed-out" }))
    .sort((a, b) => rank[a.state] - rank[b.state]);
}

/** The notice's words. `restoreName` is the display name of the model the lost sign-in displaced, if any. */
export function reloginCopy(targets: readonly ProviderAuth[], upgradedFrom: string | undefined, restoreName: (p: ProviderAuth) => string | undefined): { title: string; body: string } {
  const names = targets.map((p) => providerShortName(p.name));
  const list = names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  const title = `Log in to ${list} again`;
  const one = targets.length === 1 ? targets[0]! : null;
  const why = one?.relogin?.reason === "expired"
    ? `${names[0]} ended your saved sign-in, so its models left the picker.`
    : `${list} ${targets.length === 1 ? "is" : "are"} no longer signed in, so ${targets.length === 1 ? "its" : "their"} models left the picker.`;
  const upgrade = upgradedFrom ? ` This often happens after an update (LUCID was on ${upgradedFrom}).` : "";
  const back = one ? restoreName(one) : undefined;
  const fix = back ? ` Log in to get back to ${back}.` : " Logging in brings them back.";
  return { title, body: why + upgrade + fix };
}
