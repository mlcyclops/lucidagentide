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

// Majors first; omp's broker provider ids used for the OAuth path.
export const MAJORS = [
  { id: "anthropic", name: "Anthropic · Claude", env: "ANTHROPIC_API_KEY", oauthId: "anthropic", canOauth: true },
  { id: "openai", name: "OpenAI", env: "OPENAI_API_KEY", oauthId: "openai-codex", canOauth: true },
  { id: "google", name: "Google · Gemini", env: "GEMINI_API_KEY", oauthId: "google-gemini-cli", canOauth: true },
  { id: "openrouter", name: "OpenRouter", env: "OPENROUTER_API_KEY", oauthId: "openrouter", canOauth: true },
];
export const OTHERS = [
  { id: "deepseek", name: "DeepSeek", env: "DEEPSEEK_API_KEY", oauthId: "deepseek", canOauth: false },
  { id: "moonshot", name: "Moonshot · Kimi", env: "MOONSHOT_API_KEY", oauthId: "moonshot", canOauth: false },
  { id: "groq", name: "Groq", env: "GROQ_API_KEY", oauthId: "", canOauth: false },
  { id: "xai", name: "xAI · Grok", env: "XAI_API_KEY", oauthId: "xai-oauth", canOauth: true },
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

export function providerAuth(): { majors: ProviderAuth[]; others: ProviderAuth[] } {
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
  return { majors: MAJORS.map(map), others: OTHERS.map(map) };
}
