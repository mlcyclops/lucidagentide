// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/knowledge/api_embedder.ts — ADR-0215 (increment 2): a "bring-your-own-embeddings" Embedder that calls
// an OpenAI-COMPATIBLE `/embeddings` endpoint — the user's own OpenAI/Azure key, or a local Ollama / vLLM /
// llama.cpp / LM Studio box (via Local Providers, ADR-0135). It drops in behind the SAME `Embedder` seam as
// HashEmbedder/TransformersEmbedder (embedder.ts), so ingest/store/retrieve are untouched. This sidesteps the
// unshipped WASM bundle (P-RAG.1c) entirely: no native binaries, no bundled weights — real semantic vectors
// come from an endpoint the user already runs.
//
// PURE + testable: `fetchImpl` is injected (defaults to global fetch). It holds NO secret at rest — the desktop
// resolves the token from the OS vault and passes it in per construction. Fail-LOUD: any non-2xx, a
// count/dimension mismatch, or a non-finite component throws, so a broken endpoint can never silently store
// garbage vectors (which would poison cosine retrieval).

import type { Embedder } from "./embedder.ts";

export type EmbedAuthKind = "none" | "bearer" | "apikey";

export interface ApiEmbedderConfig {
  baseUrl: string;            // OpenAI-compatible base, e.g. https://api.openai.com/v1 or http://localhost:11434/v1
  model: string;             // e.g. text-embedding-3-small · nomic-embed-text · bge-m3
  dim: number;               // expected vector dimensionality (recorded on the dataset; a mismatch throws)
  authKind?: EmbedAuthKind;  // default "none"
  secret?: string;           // bearer token / api key (resolved from the vault by the desktop; never persisted here)
  headerName?: string;       // for authKind "apikey" (e.g. "api-key" for Azure); default "Authorization"
  fetchImpl?: typeof fetch;  // injected for tests
}

/** The `<baseUrl>/embeddings` URL (trailing slashes trimmed). */
export function embeddingsUrl(baseUrl: string): string {
  return `${(baseUrl ?? "").trim().replace(/\/+$/, "")}/embeddings`;
}

/** Auth header for a config, or {} for none. `bearer` → Authorization: Bearer <t>; `apikey` → <headerName>: <t>
 *  (raw value, e.g. Azure's `api-key`). PURE. */
export function embedAuthHeader(cfg: Pick<ApiEmbedderConfig, "authKind" | "secret" | "headerName">): Record<string, string> {
  const kind = cfg.authKind ?? "none";
  if (kind === "none" || !cfg.secret) return {};
  if (kind === "apikey") return { [cfg.headerName || "Authorization"]: cfg.secret };
  return { Authorization: `Bearer ${cfg.secret}` };
}

/** Parse the OpenAI-compatible embeddings response into ordered vectors. Sorts by `index` defensively (OpenAI
 *  returns sorted, some proxies don't). Throws on shape/count/dim/finite violations. PURE + exported for tests. */
export function parseEmbeddingsResponse(body: unknown, expectedCount: number, dim: number): number[][] {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) throw new Error("embeddings response has no `data` array");
  const vecs = data
    .slice()
    .sort((a, b) => (Number((a as { index?: number })?.index ?? 0)) - (Number((b as { index?: number })?.index ?? 0)))
    .map((d) => (d as { embedding?: unknown })?.embedding);
  if (vecs.length !== expectedCount) throw new Error(`embeddings count ${vecs.length} != ${expectedCount}`);
  return vecs.map((v, i) => {
    if (!Array.isArray(v) || v.length !== dim) throw new Error(`embedding[${i}] dim ${Array.isArray(v) ? v.length : "?"} != ${dim}`);
    for (const x of v) if (typeof x !== "number" || !Number.isFinite(x)) throw new Error(`embedding[${i}] has a non-finite component`);
    return v as number[];
  });
}

export class ApiEmbedder implements Embedder {
  readonly id: string;
  readonly dim: number;
  constructor(private readonly cfg: ApiEmbedderConfig) {
    if (!cfg.baseUrl?.trim()) throw new Error("ApiEmbedder: baseUrl required");
    if (!cfg.model?.trim()) throw new Error("ApiEmbedder: model required");
    if (!(cfg.dim > 0)) throw new Error("ApiEmbedder: positive dim required");
    this.id = `api:${cfg.model}`;   // vector-space tag recorded on the dataset (endpoint-agnostic within a model)
    this.dim = Math.floor(cfg.dim);
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    const f = this.cfg.fetchImpl ?? fetch;
    const headers: Record<string, string> = { "content-type": "application/json", ...embedAuthHeader(this.cfg) };
    const r = await f(embeddingsUrl(this.cfg.baseUrl), {
      method: "POST",
      headers,
      body: JSON.stringify({ model: this.cfg.model, input: texts }),
    });
    if (!r.ok) throw new Error(`embeddings HTTP ${r.status}`);
    const body = await r.json().catch(() => { throw new Error("embeddings response was not JSON"); });
    return parseEmbeddingsResponse(body, texts.length, this.dim);
  }
}
