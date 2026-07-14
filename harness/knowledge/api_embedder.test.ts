// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/knowledge/api_embedder.test.ts
//
// ADR-0215: the bring-your-own-embeddings Embedder. Covers the pure helpers (URL, auth header, response parse)
// and the embed() path with an INJECTED fetch (OpenAI shape, an out-of-order proxy, and the fail-LOUD guards
// that stop a broken endpoint from storing garbage vectors that would poison cosine retrieval).

import { describe, expect, test } from "bun:test";
import { ApiEmbedder, embedAuthHeader, embeddingsUrl, parseEmbeddingsResponse, probeEmbeddings } from "./api_embedder.ts";
import type { Embedder } from "./embedder.ts";

describe("embeddingsUrl / embedAuthHeader", () => {
  test("appends /embeddings, trimming trailing slashes", () => {
    expect(embeddingsUrl("https://api.openai.com/v1/")).toBe("https://api.openai.com/v1/embeddings");
    expect(embeddingsUrl("http://localhost:11434/v1")).toBe("http://localhost:11434/v1/embeddings");
  });
  test("auth header by kind", () => {
    expect(embedAuthHeader({ authKind: "none" })).toEqual({});
    expect(embedAuthHeader({ authKind: "bearer", secret: "tok" })).toEqual({ Authorization: "Bearer tok" });
    expect(embedAuthHeader({ authKind: "apikey", secret: "tok", headerName: "api-key" })).toEqual({ "api-key": "tok" });
    expect(embedAuthHeader({ authKind: "bearer" })).toEqual({}); // no secret → no header
  });
});

describe("parseEmbeddingsResponse", () => {
  test("returns ordered vectors (sorts by index)", () => {
    const body = { data: [{ index: 1, embedding: [3, 4] }, { index: 0, embedding: [1, 2] }] };
    expect(parseEmbeddingsResponse(body, 2, 2)).toEqual([[1, 2], [3, 4]]);
  });
  test("throws on missing data / count mismatch / dim mismatch / non-finite", () => {
    expect(() => parseEmbeddingsResponse({}, 1, 2)).toThrow(/no .data. array/);
    expect(() => parseEmbeddingsResponse({ data: [{ index: 0, embedding: [1, 2] }] }, 2, 2)).toThrow(/count 1 != 2/);
    expect(() => parseEmbeddingsResponse({ data: [{ index: 0, embedding: [1, 2, 3] }] }, 1, 2)).toThrow(/dim 3 != 2/);
    expect(() => parseEmbeddingsResponse({ data: [{ index: 0, embedding: [1, NaN] }] }, 1, 2)).toThrow(/non-finite/);
  });
});

describe("ApiEmbedder", () => {
  const okFetch = (rows: number[][]): typeof fetch => (async (_url: any, init: any) => {
    const input = JSON.parse(init.body).input as string[];
    return { ok: true, json: async () => ({ data: input.map((_, i) => ({ index: i, embedding: rows[i] })) }) } as Response;
  }) as any;

  test("id is model-tagged; dim is recorded", () => {
    const e = new ApiEmbedder({ baseUrl: "http://x/v1", model: "text-embedding-3-small", dim: 3 });
    expect(e.id).toBe("api:text-embedding-3-small");
    expect(e.dim).toBe(3);
  });
  test("constructor validates config", () => {
    expect(() => new ApiEmbedder({ baseUrl: "", model: "m", dim: 3 })).toThrow(/baseUrl/);
    expect(() => new ApiEmbedder({ baseUrl: "http://x", model: "", dim: 3 })).toThrow(/model/);
    expect(() => new ApiEmbedder({ baseUrl: "http://x", model: "m", dim: 0 })).toThrow(/dim/);
  });
  test("embed() posts input + parses ordered vectors; satisfies the Embedder seam", async () => {
    const e: Embedder = new ApiEmbedder({ baseUrl: "http://x/v1", model: "m", dim: 2, fetchImpl: okFetch([[1, 0], [0, 1]]) });
    expect(await e.embed(["a", "b"])).toEqual([[1, 0], [0, 1]]);
    expect(await e.embed([])).toEqual([]); // no call for empty input
  });
  test("embed() throws on a non-2xx endpoint (fail-loud, never stores garbage)", async () => {
    const bad = (async () => ({ ok: false, status: 429 })) as any;
    const e = new ApiEmbedder({ baseUrl: "http://x/v1", model: "m", dim: 2, fetchImpl: bad });
    await expect(e.embed(["a"])).rejects.toThrow(/HTTP 429/);
  });
  test("probeEmbeddings DISCOVERS the endpoint's dim (does not enforce a configured one)", async () => {
    const f = (async () => ({ ok: true, json: async () => ({ data: [{ index: 0, embedding: [1, 2, 3, 4] }] }) })) as any;
    expect(await probeEmbeddings({ baseUrl: "http://x/v1", model: "m", fetchImpl: f })).toEqual({ dim: 4 });
  });
  test("probeEmbeddings throws a short message on a non-2xx / empty vector", async () => {
    const bad = (async () => ({ ok: false, status: 401 })) as any;
    await expect(probeEmbeddings({ baseUrl: "http://x/v1", model: "m", fetchImpl: bad })).rejects.toThrow(/HTTP 401/);
    const empty = (async () => ({ ok: true, json: async () => ({ data: [{ index: 0, embedding: [] }] }) })) as any;
    await expect(probeEmbeddings({ baseUrl: "http://x/v1", model: "m", fetchImpl: empty })).rejects.toThrow(/no embedding vector/);
  });
  test("embed() sends the bearer token when configured", async () => {
    let seen: Record<string, string> = {};
    const cap = (async (_u: any, init: any) => { seen = init.headers; const input = JSON.parse(init.body).input; return { ok: true, json: async () => ({ data: input.map((_: any, i: number) => ({ index: i, embedding: [1, 1] })) }) }; }) as any;
    const e = new ApiEmbedder({ baseUrl: "http://x/v1", model: "m", dim: 2, authKind: "bearer", secret: "S3CRET", fetchImpl: cap });
    await e.embed(["a"]);
    expect(seen.Authorization).toBe("Bearer S3CRET");
  });
});
