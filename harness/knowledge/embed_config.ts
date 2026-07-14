// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/knowledge/embed_config.ts — ADR-0221 (increment 2): the PURE config → Embedder resolver. The desktop
// stores an EmbeddingsConfig (baseUrl/model/dim/auth) and resolves the secret from the OS vault; this maps that
// pair to a ready ApiEmbedder, or null when semantic search is OFF / incomplete / needs a secret it doesn't have.
// Fail-safe (returns null, never throws) so a half-configured endpoint just leaves retrieval LEXICAL, never broken.

import { ApiEmbedder, type EmbedAuthKind } from "./api_embedder.ts";

export interface EmbeddingsConfig {
  enabled: boolean;
  baseUrl: string;          // OpenAI-compatible base, e.g. http://localhost:11434/v1 (Ollama) or https://api.openai.com/v1
  model: string;            // e.g. nomic-embed-text · text-embedding-3-small
  dim: number;              // the model's vector dimensionality
  authKind: EmbedAuthKind;  // "none" (local Ollama) | "bearer" (OpenAI) | "apikey" (Azure header)
  headerName?: string;      // for "apikey" (e.g. "api-key")
}

/** Build an ApiEmbedder from a stored config + a vault-resolved secret, or null when semantic search should be
 *  OFF: disabled, incomplete (missing baseUrl/model/dim), or an auth kind whose secret we don't have. PURE +
 *  fail-safe — a bad config yields null (retrieval stays lexical), never a throw. */
export function resolveApiEmbedder(cfg: EmbeddingsConfig | null | undefined, secret: string | undefined): ApiEmbedder | null {
  if (!cfg || !cfg.enabled) return null;
  if (!cfg.baseUrl?.trim() || !cfg.model?.trim() || !(cfg.dim > 0)) return null;
  if ((cfg.authKind === "bearer" || cfg.authKind === "apikey") && !secret) return null; // needs a secret → stay off
  try {
    return new ApiEmbedder({ baseUrl: cfg.baseUrl, model: cfg.model, dim: cfg.dim, authKind: cfg.authKind, headerName: cfg.headerName, secret });
  } catch { return null; }
}
