// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/omp/azure_entra_extension.ts
//
// P-AZURE-ENTRA.1 (ADR-0499): loaded with every gated omp spawn (desktop/acp_backend.ts and the `lucid`
// launcher), alongside the AskSage extension. A no-op unless AZURE_OPENAI_AUTH_MODE names an Entra mode
// (`managed-identity` or `azure-cli`): the key mode is omp's built-in `azure` provider, untouched.
//
// In an Entra mode it re-registers omp's `azure` provider (same provider id, so model ids, the picker and
// the saved model choice do not change) with omp's own Azure catalog, routed through the custom API in
// azure_entra.ts, which signs every request with an Entra bearer instead of AZURE_OPENAI_API_KEY. Base URL,
// API version and deployment map stay the AZURE_OPENAI_* env omp already reads; the Settings Azure card
// and a headless engine's environment set the same names.

import type { Api, Model } from "@oh-my-pi/pi-ai";
import { getBundledModels } from "@oh-my-pi/pi-catalog";
import { AZURE_ENTRA_API, createTokenSource, ENTRA_KEY_PLACEHOLDER, makeAzureEntraStream, resolveAzureAuth, type EntraSourceDeps } from "./azure_entra.ts";

/** The slice of omp's extension API this needs (a test can hand in a recorder). */
export interface ProviderRegistrar { registerProvider(name: string, config: Record<string, unknown>): void }
export type AzureEntraOutcome = "key" | "entra" | "invalid";

/** Register the Entra-signed `azure` provider when the env asks for it. Returns what it did. */
export function registerAzureEntra(
  pi: ProviderRegistrar,
  env: Record<string, string | undefined>,
  deps: EntraSourceDeps & { log?: (line: string) => void } = {},
): AzureEntraOutcome {
  const log = deps.log ?? ((line: string) => console.error(line));
  const auth = resolveAzureAuth(env);
  if (auth.kind === "key") return "key";
  if (auth.kind === "invalid") {
    log(`[azure-entra] ${auth.reason}; Entra sign-in is off and Azure OpenAI needs AZURE_OPENAI_API_KEY`);
    return "invalid";
  }
  const catalog = new Map<string, Model<Api>>(getBundledModels("azure").map((m) => [m.id, m]));
  pi.registerProvider("azure", {
    baseUrl: auth.config.baseUrl,
    api: AZURE_ENTRA_API,
    apiKey: ENTRA_KEY_PLACEHOLDER,
    streamSimple: makeAzureEntraStream({
      source: createTokenSource(auth.config, deps),
      mode: auth.config.mode,
      azureModel: (id) => catalog.get(id),
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    }),
    models: [...catalog.values()].map((m) => ({
      id: m.id,
      name: m.name,
      reasoning: m.reasoning,
      ...(m.thinking ? { thinking: m.thinking } : {}),
      input: m.input,
      cost: { input: m.cost.input, output: m.cost.output, cacheRead: m.cost.cacheRead, cacheWrite: m.cost.cacheWrite },
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
    })),
  });
  log(`[azure-entra] Azure OpenAI signs in with Microsoft Entra ID (${auth.config.mode}${auth.config.clientId ? ", user-assigned identity" : ""}) at ${new URL(auth.config.baseUrl).host}`);
  return "entra";
}

export default function azureEntraExtension(pi: ProviderRegistrar): void {
  try {
    registerAzureEntra(pi, process.env);
  } catch (e) {
    // A provider registration failure must never take the omp launch down with it.
    console.error(`[azure-entra] not registered: ${e instanceof Error ? e.message : String(e)}`);
  }
}
