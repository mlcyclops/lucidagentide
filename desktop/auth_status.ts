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

// P-PROV.1 (ADR-0207): extra per-provider config env beyond the single primary key. Azure OpenAI and
// Vertex/Gemini-Enterprise need MORE than one value (resource/base/version; project/location/ADC path),
// and the Gemini-CLI OAuth needs a GCP project for Workspace/Enterprise accounts. Each field is just an
// omp-read env var; it rides the SAME setKey→process.env→omp seam as the primary key (applyEnv reapplies
// all on startup, /api/auth/key restarts omp), so no new storage is introduced. `secret:false` values are
// non-sensitive (a project id, a region, a resource name) and are echoed back to pre-fill the input; a
// secret field is masked like the primary key.
export interface ProviderField { env: string; label: string; placeholder?: string; secret?: boolean }
export interface ProviderFieldAuth extends ProviderField { set: boolean; value?: string; last4?: string }

export interface ProviderAuth {
  id: string; name: string; env: string; oauthId: string; canOauth: boolean;
  oauthActive: boolean; oauthIdentity?: string;
  keySet: boolean; keyLast4?: string;
  fields?: ProviderFieldAuth[];
}

// The AskSage gov gateway (ADR-0007): API-key only, key in keys.ASKSAGE_API_KEY. Surfaced ABOVE the
// Providers section in its own card (it routes through an accredited gov proxy, not a direct provider).
export const GATEWAY: Provider[] = [
  { id: "asksage", name: "AskSage · Gov gateway", env: "ASKSAGE_API_KEY", oauthId: "", canOauth: false },
];
// A provider descriptor: primary key `env` (may be "" for OAuth-only providers), the omp broker `oauthId`,
// and optional extra config `fields`. Every string here (env names, oauthId) must match what omp 16.x reads.
export interface Provider { id: string; name: string; env: string; oauthId: string; canOauth: boolean; fields?: ProviderField[] }

// Primary providers (the Providers card): U.S. frontier labs, key or OAuth. omp's broker provider ids
// drive the OAuth path.
export const MAJORS: Provider[] = [
  { id: "openai", name: "OpenAI · ChatGPT", env: "OPENAI_API_KEY", oauthId: "openai-codex", canOauth: true },
  // Google consumer Gemini (AI Studio key) OR the Gemini-CLI / Code-Assist OAuth. omp's google-gemini-cli
  // login ALREADY onboards Workspace/Enterprise (standard-tier) accounts — but only when GOOGLE_CLOUD_PROJECT
  // is set; without it omp aborts non-personal accounts with "requires setting GOOGLE_CLOUD_PROJECT". So we
  // expose that project field here to make Enterprise OAuth work (personal accounts leave it blank).
  { id: "google", name: "Google · Gemini", env: "GEMINI_API_KEY", oauthId: "google-gemini-cli", canOauth: true,
    fields: [
      { env: "GOOGLE_CLOUD_PROJECT", label: "GCP project ID (Workspace / Enterprise OAuth)", placeholder: "my-project-123 — required for non-personal Google accounts" },
    ] },
  { id: "anthropic", name: "Anthropic · Claude", env: "ANTHROPIC_API_KEY", oauthId: "anthropic", canOauth: true },
  { id: "xai", name: "xAI · Grok", env: "XAI_API_KEY", oauthId: "xai-oauth", canOauth: true },
  // GitHub Copilot (ADR-0207): omp's `github-copilot` broker runs a device-code OAuth that signs in a
  // Copilot Business/Enterprise (or individual) subscription and enables its model catalog. OAuth-only
  // (env ""), device-flow (the paste-code UI + DEVICE_FLOW_IDS already handle it), and the broker prompts
  // for a GitHub Enterprise domain (blank = github.com) so GHE/self-hosted orgs work too.
  { id: "github-copilot", name: "GitHub · Copilot", env: "", oauthId: "github-copilot", canOauth: true },
  // Azure OpenAI (ADR-0207): key-only (no OAuth broker). omp reads AZURE_OPENAI_API_KEY plus a base:
  // either AZURE_OPENAI_RESOURCE_NAME (→ https://<name>.openai.azure.com/openai/v1) or a full
  // AZURE_OPENAI_BASE_URL; API version defaults to "v1"; an optional deployment-name map aliases model
  // ids to Azure deployment names. All ride the same setKey→env→omp seam as any key.
  { id: "azure", name: "Azure · OpenAI", env: "AZURE_OPENAI_API_KEY", oauthId: "", canOauth: false,
    fields: [
      { env: "AZURE_OPENAI_RESOURCE_NAME", label: "Resource name", placeholder: "my-resource → my-resource.openai.azure.com" },
      { env: "AZURE_OPENAI_BASE_URL", label: "…or full base URL", placeholder: "https://my-resource.openai.azure.com/openai/v1" },
      { env: "AZURE_OPENAI_API_VERSION", label: "API version", placeholder: "v1 (default)" },
      { env: "AZURE_OPENAI_DEPLOYMENT_NAME_MAP", label: "Deployment map (optional)", placeholder: "gpt-4o=my-deploy,o3=my-o3" },
    ] },
  // Google Cloud Vertex AI = Gemini Enterprise (ADR-0207): key-only card. omp's google-vertex provider
  // authenticates with EITHER a GOOGLE_CLOUD_API_KEY, OR Application Default Credentials (a service-account
  // JSON via GOOGLE_APPLICATION_CREDENTIALS, or `gcloud auth application-default login`) together with a
  // project + location. Paste the API key in the key box, or leave it blank and fill the fields for ADC.
  { id: "google-vertex", name: "Google Cloud · Vertex AI (Gemini Enterprise)", env: "GOOGLE_CLOUD_API_KEY", oauthId: "", canOauth: false,
    fields: [
      { env: "GOOGLE_CLOUD_PROJECT", label: "GCP project ID", placeholder: "my-project-123" },
      { env: "GOOGLE_CLOUD_LOCATION", label: "Location", placeholder: "us-central1 (or global)" },
      { env: "GOOGLE_APPLICATION_CREDENTIALS", label: "Service-account JSON path (ADC)", placeholder: "/path/to/sa.json — blank to use gcloud ADC" },
    ] },
  // Perplexity (Sonar) is U.S.-based. omp supports OAuth too, but its login is interactive email-OTP /
  // the macOS app token — neither works through our non-interactive broker spawn — so we expose the
  // API-key path. canOauth:false hides the dead OAuth button.
  { id: "perplexity", name: "Perplexity · Sonar", env: "PERPLEXITY_API_KEY", oauthId: "perplexity", canOauth: false },
];
// More providers (third-party / non-U.S. / custom aggregators) - gated behind a typed acknowledgement
// in the UI because they route to servers outside U.S. jurisdiction or aggregate many origins.
export const OTHERS: Provider[] = [
  { id: "openrouter", name: "OpenRouter", env: "OPENROUTER_API_KEY", oauthId: "openrouter", canOauth: true },
  { id: "deepseek", name: "DeepSeek", env: "DEEPSEEK_API_KEY", oauthId: "deepseek", canOauth: false },
  { id: "moonshot", name: "Moonshot · Kimi", env: "MOONSHOT_API_KEY", oauthId: "moonshot", canOauth: false },
  { id: "groq", name: "Groq", env: "GROQ_API_KEY", oauthId: "", canOauth: false },
  // P-VOICE.1 (ADR-0115): ElevenLabs is a VOICE provider (TTS/STT), not a chat model. It's listed here so
  // the key gets the same masked keySet/last4 plumbing, but the Settings UI renders it in a dedicated
  // "Voice" card (secVoice) and EXCLUDES it from the model-provider list — it never enters the model picker.
  { id: "elevenlabs", name: "ElevenLabs · Voice", env: "ELEVENLABS_API_KEY", oauthId: "", canOauth: false },
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
  const valueFor = (env: string): string | undefined => (env ? (keys[env] ?? process.env[env]) : undefined) || undefined;
  const map = (m: Provider): ProviderAuth => {
    const oauth = m.oauthId ? rows.find((r) => r.provider === m.oauthId && r.credential_type === "oauth" && !r.disabled_cause) : undefined;
    const key = valueFor(m.env);
    // Field status: `set` always; secret fields report only last4 (never the value); non-secret config
    // (project id, region, resource name, ADC path) echoes its value so the input pre-fills.
    const fields: ProviderFieldAuth[] | undefined = m.fields?.map((f) => {
      const v = valueFor(f.env);
      return {
        ...f, set: !!v,
        value: v && !f.secret ? String(v) : undefined,
        last4: v && f.secret ? String(v).slice(-4) : undefined,
      };
    });
    return {
      id: m.id, name: m.name, env: m.env, oauthId: m.oauthId, canOauth: m.canOauth,
      oauthActive: !!oauth, oauthIdentity: oauth?.identity_key ?? undefined,
      keySet: !!key, keyLast4: key ? String(key).slice(-4) : undefined,
      ...(fields ? { fields } : {}),
    };
  };
  return { gateway: GATEWAY.map(map), majors: MAJORS.map(map), others: OTHERS.map(map) };
}
