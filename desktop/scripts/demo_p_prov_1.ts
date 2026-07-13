// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Increment P-PROV.1 — first-party enterprise providers (ADR-0207). Exposes three omp-native providers the
// Settings UI didn't surface, plus the missing env that made Gemini Enterprise OAuth fail:
//   • GitHub Copilot   — OAuth device-flow (`github-copilot` broker); the Business/Enterprise "easy button".
//   • Azure OpenAI     — key + AZURE_OPENAI_* config (resource/base/version) omp already reads.
//   • Google Vertex AI — Gemini Enterprise: GOOGLE_CLOUD_API_KEY, or ADC (project + location + credentials).
//   • Gemini (existing)— now carries GOOGLE_CLOUD_PROJECT, without which omp aborts Workspace/Enterprise OAuth.
// Each extra field is just an omp-read env var riding the SAME setKey→env→omp seam as the primary key, so no
// new storage exists. This demo proves the descriptor set + the field-status reporting headlessly.

import { MAJORS, providerAuth, type Provider } from "../auth_status.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) { console.error("  ✗ " + msg); process.exit(1); }
  console.log("  ✓ " + msg);
}
const find = (id: string): Provider | undefined => MAJORS.find((m) => m.id === id);
const envs = (p: Provider | undefined): string[] => (p?.fields ?? []).map((f) => f.env);

console.log("== #ADR-0207 P-PROV.1: Azure OpenAI + GitHub Copilot OAuth + Gemini Enterprise (Vertex) ==\n");

console.log("[1] GitHub Copilot — OAuth-only major, device-flow broker id");
const cp = find("github-copilot");
assert(cp && cp.oauthId === "github-copilot" && cp.canOauth, "github-copilot present, canOauth via omp broker");
assert(cp!.env === "", "OAuth-only → no primary key env (the card omits the key row)");

console.log("\n[2] Azure OpenAI — key + the exact AZURE_OPENAI_* envs omp reads");
const az = find("azure");
assert(az && az.env === "AZURE_OPENAI_API_KEY" && !az.canOauth, "azure key-only provider present");
assert(envs(az).includes("AZURE_OPENAI_RESOURCE_NAME"), "resource-name config field present");
assert(envs(az).includes("AZURE_OPENAI_BASE_URL"), "full base-URL config field present");
assert(envs(az).includes("AZURE_OPENAI_API_VERSION"), "api-version config field present");

console.log("\n[3] Google Vertex AI = Gemini Enterprise — key OR ADC (project + location + credentials)");
const vx = find("google-vertex");
assert(vx && vx.env === "GOOGLE_CLOUD_API_KEY", "vertex uses omp's GOOGLE_CLOUD_API_KEY (not the wrong VERTEX_API_KEY)");
assert(envs(vx).includes("GOOGLE_CLOUD_PROJECT") && envs(vx).includes("GOOGLE_CLOUD_LOCATION"), "project + location fields for ADC");
assert(envs(vx).includes("GOOGLE_APPLICATION_CREDENTIALS"), "service-account JSON (ADC) field present");

console.log("\n[4] Gemini card — GOOGLE_CLOUD_PROJECT is what unblocks Workspace/Enterprise OAuth");
const g = find("google");
assert(g && g.oauthId === "google-gemini-cli", "the existing Gemini OAuth card is intact");
assert(envs(g).includes("GOOGLE_CLOUD_PROJECT"), "GOOGLE_CLOUD_PROJECT field added (omp requires it for non-personal accounts)");

console.log("\n[5] field-status reporting — secret masked to last4, non-secret config echoed to pre-fill");
process.env.AZURE_OPENAI_API_KEY = "sk-azure-SECRET-tail9x42";
process.env.AZURE_OPENAI_RESOURCE_NAME = "contoso-openai";
try {
  const azAuth = providerAuth().majors.find((m) => m.id === "azure")!;
  assert(azAuth.keySet && azAuth.keyLast4 === "9x42", "the API key reports set + last4 only (never the whole key)");
  const res = azAuth.fields?.find((f) => f.env === "AZURE_OPENAI_RESOURCE_NAME");
  assert(res?.set && res?.value === "contoso-openai", "a non-secret config value is echoed back (input pre-fills)");
  const unset = azAuth.fields?.find((f) => f.env === "AZURE_OPENAI_BASE_URL");
  assert(unset && !unset.set && unset.value === undefined, "an unset field reports set:false with no value");
} finally {
  delete process.env.AZURE_OPENAI_API_KEY;
  delete process.env.AZURE_OPENAI_RESOURCE_NAME;
}

console.log("\n✓ P-PROV.1 demo passed — Azure, Copilot OAuth, Vertex/Gemini-Enterprise exposed with omp's real envs.");
