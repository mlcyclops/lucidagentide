// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/auth_status.ts
//
// Per-provider auth status for the Settings page: reads omp's credential vault
// (~/.omp/agent/agent.db → auth_credentials) for OAuth/subscription logins, and
// the local key store + env for API keys. Returns masked status only.

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { load } from "./settings_store.ts";

export interface ProviderAuth {
  id: string; name: string; env: string; oauthId: string; canOauth: boolean;
  oauthActive: boolean; oauthIdentity?: string;
  keySet: boolean; keyLast4?: string;
}

// The AskSage gov gateway (ADR-0007): API-key only, key in keys.ASKSAGE_API_KEY. Surfaced ABOVE the
// Providers section in its own card (it routes through an accredited gov proxy, not a direct provider).
export const GATEWAY = [
  { id: "asksage", name: "AskSage · Gov gateway", env: "ASKSAGE_API_KEY", oauthId: "", canOauth: false },
];
// Primary providers (the Providers card): U.S. frontier labs, key or OAuth. omp's broker provider ids
// drive the OAuth path.
export const MAJORS = [
  { id: "openai", name: "OpenAI · ChatGPT", env: "OPENAI_API_KEY", oauthId: "openai-codex", canOauth: true },
  { id: "google", name: "Google · Gemini", env: "GEMINI_API_KEY", oauthId: "google-gemini-cli", canOauth: true },
  { id: "anthropic", name: "Anthropic · Claude", env: "ANTHROPIC_API_KEY", oauthId: "anthropic", canOauth: true },
  { id: "xai", name: "xAI · Grok", env: "XAI_API_KEY", oauthId: "xai-oauth", canOauth: true },
];
// More providers (third-party / non-U.S. / custom aggregators) - gated behind a typed acknowledgement
// in the UI because they route to servers outside U.S. jurisdiction or aggregate many origins.
export const OTHERS = [
  { id: "openrouter", name: "OpenRouter", env: "OPENROUTER_API_KEY", oauthId: "openrouter", canOauth: true },
  // Perplexity (Sonar). omp supports OAuth too, but its login is interactive email-OTP / the macOS app
  // token — neither works through our non-interactive broker spawn — so we expose the API-key path.
  { id: "perplexity", name: "Perplexity · Sonar", env: "PERPLEXITY_API_KEY", oauthId: "perplexity", canOauth: false },
  { id: "deepseek", name: "DeepSeek", env: "DEEPSEEK_API_KEY", oauthId: "deepseek", canOauth: false },
  { id: "moonshot", name: "Moonshot · Kimi", env: "MOONSHOT_API_KEY", oauthId: "moonshot", canOauth: false },
  { id: "groq", name: "Groq", env: "GROQ_API_KEY", oauthId: "", canOauth: false },
];

function vaultRows(): any[] {
  const p = join(homedir(), ".omp", "agent", "agent.db");
  if (!existsSync(p)) return [];
  try {
    const db = new Database(p, { readonly: true });
    try { return db.query("select provider, credential_type, identity_key, disabled_cause from auth_credentials").all() as any[]; }
    finally { db.close(); }
  } catch { return []; }
}

export function providerAuth(): { gateway: ProviderAuth[]; majors: ProviderAuth[]; others: ProviderAuth[] } {
  const rows = vaultRows();
  const keys = load().keys ?? {};
  const map = (m: typeof MAJORS[number]): ProviderAuth => {
    const oauth = m.oauthId ? rows.find((r) => r.provider === m.oauthId && r.credential_type === "oauth" && !r.disabled_cause) : undefined;
    const key = keys[m.env] ?? process.env[m.env];
    return {
      ...m,
      oauthActive: !!oauth, oauthIdentity: oauth?.identity_key ?? undefined,
      keySet: !!key, keyLast4: key ? String(key).slice(-4) : undefined,
    };
  };
  return { gateway: GATEWAY.map(map), majors: MAJORS.map(map), others: OTHERS.map(map) };
}
