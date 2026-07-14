// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/knowledge/embed_config.test.ts — ADR-0215: the config→embedder resolver is fail-safe (null keeps
// retrieval lexical) and won't build a bearer/apikey embedder without a secret.

import { describe, expect, test } from "bun:test";
import { resolveApiEmbedder, type EmbeddingsConfig } from "./embed_config.ts";

const base: EmbeddingsConfig = { enabled: true, baseUrl: "http://localhost:11434/v1", model: "nomic-embed-text", dim: 768, authKind: "none" };

describe("resolveApiEmbedder", () => {
  test("a complete, enabled, no-auth (local Ollama) config → an embedder", () => {
    const e = resolveApiEmbedder(base, undefined);
    expect(e?.id).toBe("api:nomic-embed-text");
    expect(e?.dim).toBe(768);
  });
  test("bearer config → embedder only WITH a secret; null without", () => {
    const cfg = { ...base, authKind: "bearer" as const, baseUrl: "https://api.openai.com/v1", model: "text-embedding-3-small", dim: 1536 };
    expect(resolveApiEmbedder(cfg, undefined)).toBeNull();
    expect(resolveApiEmbedder(cfg, "sk-xxx")?.id).toBe("api:text-embedding-3-small");
  });
  test("off / incomplete → null (retrieval stays lexical)", () => {
    expect(resolveApiEmbedder(null, undefined)).toBeNull();
    expect(resolveApiEmbedder({ ...base, enabled: false }, undefined)).toBeNull();
    expect(resolveApiEmbedder({ ...base, baseUrl: "" }, undefined)).toBeNull();
    expect(resolveApiEmbedder({ ...base, model: "" }, undefined)).toBeNull();
    expect(resolveApiEmbedder({ ...base, dim: 0 }, undefined)).toBeNull();
  });
});
