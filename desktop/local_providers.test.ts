// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/local_providers.test.ts — P-LOCAL.1 (ADR-0135): the Local Providers pure core.

import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateLocalProvider,
  providerRunnable,
  toOmpConfigOverlay,
  toOmpProviderEntry,
  toOmpRuntimeOverlay,
  providerEnvVar,
  providerModelsUrl,
  egressProposal,
  scanForInlineSecret,
  hostFromBaseUrl,
  newLocalProviderId,
  slugify,
  RESERVED_PROVIDER_IDS,
  sanitizeModelCompat,
  parseDiscoveredModels,
  discoveryHeaders,
  MAX_DISCOVERY_BYTES,
  type LocalProviderDef,
} from "./local_providers.ts";

function def(over: Partial<LocalProviderDef> = {}): LocalProviderDef {
  const now = 1_700_000_000_000;
  return {
    id: "lp_dgx_x",
    name: "DGX Spark · Vienna VA",
    ompProvider: "dgx-vienna",
    baseUrl: "https://10.20.30.40:8000/v1",
    api: "openai-completions",
    authKind: "bearer",
    vaultRef: "cred_apikey_1_abc",
    zone: "internal",
    enabled: true,
    models: [{ id: "llama-3.1-70b-instruct", name: "Llama 3.1 70B", contextWindow: 131072, maxTokens: 8192 }],
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

describe("validation (fail-closed)", () => {
  test("a well-formed provider validates clean", () => {
    expect(validateLocalProvider(def())).toEqual([]);
  });
  test("rejects a non-http(s) base URL, a bad slug, and no models", () => {
    expect(validateLocalProvider(def({ baseUrl: "ftp://x/y" })).join()).toContain("base URL");
    expect(validateLocalProvider(def({ baseUrl: "not a url" })).join()).toContain("base URL");
    expect(validateLocalProvider(def({ ompProvider: "Bad ID!" })).join()).toContain("slug");
    expect(validateLocalProvider(def({ models: [] })).join()).toContain("at least one model");
  });
  test("refuses a provider id that would SHADOW a built-in vendor", () => {
    for (const reserved of ["anthropic", "openai", "gemini"]) {
      expect(RESERVED_PROVIDER_IDS).toContain(reserved);
      expect(validateLocalProvider(def({ ompProvider: reserved })).join()).toContain("reserved");
    }
  });
  test("duplicate model ids and non-positive context windows are caught", () => {
    expect(validateLocalProvider(def({ models: [{ id: "m" }, { id: "m" }] })).join()).toContain("duplicate model id");
    expect(validateLocalProvider(def({ models: [{ id: "m", contextWindow: 0 }] })).join()).toContain("contextWindow");
  });
  test("a pasted secret in a text field is rejected (guardrail)", () => {
    expect(scanForInlineSecret(def({ name: "key sk-abcdefghijklmnopqrstuvwx" }))).toContain("OpenAI");
    expect(validateLocalProvider(def({ baseUrl: "https://h/v1", name: "AKIAABCDEFGHIJKLMNOP box" })).join()).toContain("vault");
    // a clean def has no leak
    expect(scanForInlineSecret(def())).toBeNull();
  });
});

describe("runnability", () => {
  test("bearer/apikey providers need a secret; open providers don't", () => {
    expect(providerRunnable(def({ authKind: "none", vaultRef: undefined }), false).ok).toBe(true);
    expect(providerRunnable(def({ authKind: "bearer" }), false)).toEqual({ ok: false, reason: "needs a credential in the vault" });
    expect(providerRunnable(def({ authKind: "bearer" }), true).ok).toBe(true);
  });
  test("a disabled provider is never runnable", () => {
    expect(providerRunnable(def({ enabled: false }), true)).toEqual({ ok: false, reason: "disabled" });
  });
});

describe("omp config overlay emission", () => {
  test("emits the exact provider+model shape omp loads, with the secret injected", () => {
    const { overlay, included } = toOmpConfigOverlay([def()], () => "SECRET-TOKEN");
    expect(included).toEqual(["dgx-vienna"]);
    const p = overlay.providers["dgx-vienna"];
    expect(p.baseUrl).toBe("https://10.20.30.40:8000/v1");
    expect(p.api).toBe("openai-completions");
    expect(p.apiKey).toBe("SECRET-TOKEN"); // bearer → apiKey
    const m = p.models[0];
    expect(m).toMatchObject({ id: "llama-3.1-70b-instruct", name: "Llama 3.1 70B", reasoning: false, input: ["text"], supportsTools: true, contextWindow: 131072, maxTokens: 8192 });
    expect(m.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });
  test("a custom apikey header goes to headers, not apiKey", () => {
    const e = toOmpProviderEntry(def({ authKind: "apikey", headerName: "X-API-Key" }), "K");
    expect(e.headers).toEqual({ "X-API-Key": "K" });
    expect(e.apiKey).toBeUndefined();
  });
  test("open (no-auth) provider emits auth:none (omp requires it) + no secret; vision model advertises image input", () => {
    const e = toOmpProviderEntry(def({ authKind: "none", vaultRef: undefined, models: [{ id: "llava", vision: true }] }), undefined);
    expect(e.auth).toBe("none"); // omp drops the whole file for an open provider lacking this
    expect(e.apiKey).toBeUndefined();
    expect(e.headers).toBeUndefined();
    expect(e.models[0].input).toEqual(["text", "image"]);
  });
  test("fail-closed: a secret-requiring provider with NO secret is SKIPPED, never emitted", () => {
    const { overlay, included, skipped } = toOmpConfigOverlay([def()], () => undefined);
    expect(included).toEqual([]);
    expect(overlay.providers["dgx-vienna"]).toBeUndefined();
    expect(skipped[0]).toMatchObject({ id: "dgx-vienna" });
  });
  test("disabled providers are excluded from the overlay", () => {
    const { included } = toOmpConfigOverlay([def({ enabled: false })], () => "S");
    expect(included).toEqual([]);
  });
});

describe("runtime overlay (secure env-ref delivery)", () => {
  test("authed provider references its secret by ENV VAR NAME, never the value; env maps name→vaultRef", () => {
    const { overlay, env, included } = toOmpRuntimeOverlay([def()], new Set(["cred_apikey_1_abc"]));
    expect(included).toEqual(["dgx-vienna"]);
    const p = overlay.providers["dgx-vienna"];
    expect(p.apiKey).toBe("LUCID_LP_DGX_VIENNA_KEY"); // an env-var NAME, not a secret
    expect(env).toEqual({ LUCID_LP_DGX_VIENNA_KEY: "cred_apikey_1_abc" }); // name → vault ref (still no secret)
    expect(providerEnvVar(def())).toBe("LUCID_LP_DGX_VIENNA_KEY");
  });
  test("open provider needs no env; a custom apikey header references the env var by name", () => {
    const open = toOmpRuntimeOverlay([def({ authKind: "none", vaultRef: undefined })], new Set());
    expect(open.overlay.providers["dgx-vienna"].auth).toBe("none");
    expect(open.env).toEqual({});
    const hdr = toOmpRuntimeOverlay([def({ authKind: "apikey", headerName: "X-API-Key" })], new Set(["cred_apikey_1_abc"]));
    expect(hdr.overlay.providers["dgx-vienna"].headers).toEqual({ "X-API-Key": "LUCID_LP_DGX_VIENNA_KEY" });
  });
  test("fail-closed: an authed provider whose vault ref is NOT available is skipped, no env leaked", () => {
    const { included, env, skipped } = toOmpRuntimeOverlay([def()], new Set()); // ref not available
    expect(included).toEqual([]);
    expect(env).toEqual({});
    expect(skipped[0]).toMatchObject({ id: "dgx-vienna" });
  });
  test("unsupported 'basic' auth is skipped (never mis-emitted as a bearer)", () => {
    const { included, skipped } = toOmpRuntimeOverlay([def({ authKind: "basic" })], new Set(["cred_apikey_1_abc"]));
    expect(included).toEqual([]);
    expect(skipped[0]).toMatchObject({ id: "dgx-vienna", reason: "basic auth is not yet supported" });
  });
});

describe("providerModelsUrl", () => {
  test("appends /models to the base (trimming trailing slashes); null for a bad URL", () => {
    expect(providerModelsUrl("http://localhost:11434/v1")).toBe("http://localhost:11434/v1/models");
    expect(providerModelsUrl("https://10.0.0.1:8000/v1/")).toBe("https://10.0.0.1:8000/v1/models");
    expect(providerModelsUrl("not-a-url")).toBeNull();
  });
});

describe("egress proposal + url parsing", () => {
  test("an internal IP endpoint proposes an ip whitelist entry carrying its vault ref", () => {
    expect(egressProposal(def())).toEqual({ kind: "ip", pattern: "10.20.30.40", zone: "internal", vaultRef: "cred_apikey_1_abc", authKind: "bearer" });
  });
  test("a hostname endpoint proposes a domain entry; localhost Ollama with no auth carries no ref", () => {
    const p = egressProposal(def({ baseUrl: "http://localhost:11434/v1", authKind: "none", vaultRef: undefined, zone: "internal" }));
    expect(p).toEqual({ kind: "domain", pattern: "localhost", zone: "internal", vaultRef: undefined, authKind: "none" });
  });
  test("hostFromBaseUrl rejects non-http(s) and detects IPs", () => {
    expect(hostFromBaseUrl("https://api.corp.internal:8443/v1")).toEqual({ host: "api.corp.internal", port: "8443", isIp: false });
    expect(hostFromBaseUrl("http://127.0.0.1:11434/v1")?.isIp).toBe(true);
    expect(hostFromBaseUrl("file:///etc/passwd")).toBeNull();
  });
});

describe("ids", () => {
  test("slugify + newLocalProviderId are deterministic given now", () => {
    expect(slugify("DGX Spark · Vienna VA")).toBe("dgx_spark_vienna_va");
    expect(newLocalProviderId("Ollama Box", 1_700_000_000_000)).toMatch(/^lp_ollama_box_[a-z0-9]+$/);
  });
});

// ── persistence: the vault ref is stored, the secret NEVER is ─────────────────────────────────────
describe("settings persistence (secret never on disk)", () => {
  let dir = "";
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ""; delete process.env.LUCID_GUI_SETTINGS_FILE; });
  test("upsert round-trips the declaration; the file holds vaultRef but no secret", async () => {
    dir = mkdtempSync(join(tmpdir(), "lp-"));
    const file = join(dir, "gui.json");
    process.env.LUCID_GUI_SETTINGS_FILE = file;
    const store = await import("./settings_store.ts");
    const saved = store.upsertLocalProvider(def());
    expect(saved.vaultRef).toBe("cred_apikey_1_abc");
    expect(store.listLocalProviders().map((p) => p.id)).toEqual(["lp_dgx_x"]);
    const raw = readFileSync(file, "utf8");
    expect(raw).toContain("cred_apikey_1_abc"); // the opaque ref is persisted
    expect(raw).not.toContain("SECRET"); // no secret value ever
    expect(raw).not.toMatch(/"apiKey"|"secret"|"token"/); // no secret-bearing keys
    // an invalid def is refused, never persisted
    expect(() => store.upsertLocalProvider(def({ id: "bad", ompProvider: "anthropic" }))).toThrow(/reserved/);
    expect(store.listLocalProviders().map((p) => p.id)).toEqual(["lp_dgx_x"]);
    store.removeLocalProvider("lp_dgx_x");
    expect(store.listLocalProviders()).toEqual([]);
    expect(existsSync(file)).toBe(true);
  });

  // P-LOCAL.5: the stored declaration is what the runtime overlay re-reads at every omp launch, and
  // upsert rebuilds a CLEAN copy field by field (so no pasted secret can ride along). Any declaration
  // field missing from that copy is therefore lost on save, which is how `compat` would have gone:
  // enriched in the add form, correct in the preview overlay, silently absent after a restart.
  test("compat survives the clean copy, and a bad value is stripped on the way to disk", async () => {
    dir = mkdtempSync(join(tmpdir(), "lp-"));
    const file = join(dir, "gui.json");
    process.env.LUCID_GUI_SETTINGS_FILE = file;
    const store = await import("./settings_store.ts");
    store.upsertLocalProvider(def({
      models: [
        { id: "glm-5.3-flash", reasoning: true, contextWindow: 131072, compat: { thinkingFormat: "qwen-chat-template", reasoningContentField: "reasoning", supportsReasoningEffort: false } },
        { id: "junk", compat: { thinkingFormat: "glm-native" } as never },
        { id: "plain" },
      ],
    }));
    const [glm, junk, plain] = store.listLocalProviders()[0]!.models;
    expect(glm!.compat).toEqual({ thinkingFormat: "qwen-chat-template", reasoningContentField: "reasoning", supportsReasoningEffort: false });
    expect(glm!.contextWindow).toBe(131072);
    expect(junk!.compat).toBeUndefined(); // out-of-enum value never reaches disk
    expect(plain!).not.toHaveProperty("compat");
    // and it is really on disk, not just in the returned object
    expect(readFileSync(file, "utf8")).toContain("qwen-chat-template");
  });
});

// ── P-LOCAL.5: per-model compat ──────────────────────────────────────────────────────────────────
// omp validates models.yml as a whole and DROPS THE ENTIRE FILE on any schema violation, taking
// every other local provider with it. So the emitter's job is not just to pass compat through, it is
// to guarantee that nothing it emits can be rejected. Hence a closed value set, checked on the way out.

describe("model compat sanitation", () => {
  test("keeps the values omp's OpenAICompatSchema accepts", () => {
    expect(sanitizeModelCompat({ thinkingFormat: "qwen-chat-template", reasoningContentField: "reasoning", supportsReasoningEffort: false }))
      .toEqual({ thinkingFormat: "qwen-chat-template", reasoningContentField: "reasoning", supportsReasoningEffort: false });
  });

  test("drops a value outside the schema's enum rather than letting it invalidate models.yml", () => {
    const dirty = { thinkingFormat: "glm-native", reasoningContentField: "reasoning", supportsReasoningEffort: "yes" } as never;
    expect(sanitizeModelCompat(dirty)).toEqual({ reasoningContentField: "reasoning" });
  });

  test("collapses to undefined when nothing survives, so no empty compat is emitted", () => {
    expect(sanitizeModelCompat({})).toBeUndefined();
    expect(sanitizeModelCompat(undefined)).toBeUndefined();
    expect(sanitizeModelCompat({ thinkingFormat: "nope" } as never)).toBeUndefined();
  });

  test("the overlay omits compat on models that have none, and carries it on models that do", () => {
    const entry = toOmpProviderEntry(def({
      authKind: "none",
      models: [
        { id: "plain" },
        { id: "glm-5.3-flash", reasoning: true, compat: { thinkingFormat: "qwen-chat-template", reasoningContentField: "reasoning", supportsReasoningEffort: false } },
      ],
    }));
    expect(entry.models[0]!).not.toHaveProperty("compat");
    expect(entry.models[1]!.compat).toEqual({ thinkingFormat: "qwen-chat-template", reasoningContentField: "reasoning", supportsReasoningEffort: false });
    // and the emitted JSON stays parseable as the models.yml body LUCID writes
    expect(JSON.parse(JSON.stringify({ providers: { spark: entry } })).providers.spark.models[1].compat.thinkingFormat).toBe("qwen-chat-template");
  });
});

// ── P-LOCAL.6: endpoint model discovery ──────────────────────────────────────────────────────────
// The body comes off a box on the LAN and lands in a config file omp parses plus a comma-separated
// form field, so this parser is the trust boundary. It is tested for what a HOSTILE or broken
// endpoint returns, not just for the happy vLLM payload.

describe("parseDiscoveredModels", () => {
  test("reads a real vLLM payload, taking the window from max_model_len", () => {
    const body = {
      object: "list",
      data: [
        { id: "glm-5.3-flash", object: "model", owned_by: "vllm", root: "zai-org/GLM-5.3-Flash", parent: null, max_model_len: 131072, permission: [] },
        { id: "qwen3-coder-30b", object: "model", owned_by: "vllm", max_model_len: 262144 },
      ],
    };
    const { models, dropped } = parseDiscoveredModels(body);
    expect(models).toEqual([
      { id: "glm-5.3-flash", contextWindow: 131072 },
      { id: "qwen3-coder-30b", contextWindow: 262144 },
    ]);
    expect(dropped).toBe(0);
  });

  test("falls back to context_length, and leaves the window unset when neither is usable", () => {
    const { models } = parseDiscoveredModels({ data: [
      { id: "a", context_length: 8000 },
      { id: "b", max_model_len: 4096, context_length: 999 }, // max_model_len wins (omp's own precedence)
      { id: "c" },
      { id: "d", max_model_len: 0 },
      { id: "e", max_model_len: -1 },
      { id: "f", max_model_len: 1.5 },
      { id: "g", max_model_len: "131072" }, // a string is not a number
    ] });
    expect(models).toEqual([
      { id: "a", contextWindow: 8000 },
      { id: "b", contextWindow: 4096 },
      { id: "c" }, { id: "d" }, { id: "e" }, { id: "f" }, { id: "g" },
    ]);
  });

  test("drops ids that would corrupt the form field or the config, and reports how many", () => {
    const { models, dropped } = parseDiscoveredModels({ data: [
      { id: "good" },
      { id: "has,comma" },        // would split into two ids in the comma-separated field
      { id: "has\nnewline" },
      { id: "zero\u200bwidth" },  // the injection class the scanner sidecar exists to catch
      { id: "bidi\u202eoverride" },
      { id: "x".repeat(201) },
      { id: "  " },
      { id: 42 },
      { id: "good" },             // duplicate
      null,
      "not-an-object",
    ] });
    expect(models).toEqual([{ id: "good" }]);
    expect(dropped).toBe(10);
  });

  test("trims ids and preserves the server's order", () => {
    expect(parseDiscoveredModels({ data: [{ id: " b " }, { id: "a" }] }).models.map((m) => m.id)).toEqual(["b", "a"]);
  });

  test("caps a runaway list rather than filling the form with 5000 entries", () => {
    const { models, dropped } = parseDiscoveredModels({ data: Array.from({ length: 150 }, (_, i) => ({ id: `m${i}` })) });
    expect(models.length).toBe(100);
    expect(dropped).toBe(50);
  });

  test("a body that is not an OpenAI model list yields nothing, never a throw", () => {
    for (const junk of [null, undefined, 0, "", "list", [], { data: null }, { data: {} }, { models: [{ id: "x" }] }]) {
      expect(parseDiscoveredModels(junk), JSON.stringify(junk ?? null)).toEqual({ models: [], dropped: 0 });
    }
  });

  test("the byte cap is a real bound the route can enforce", () => {
    expect(MAX_DISCOVERY_BYTES).toBeGreaterThan(10_000); // a real list must fit
    expect(MAX_DISCOVERY_BYTES).toBeLessThanOrEqual(5_000_000); // but not unbounded
  });
});

describe("discoveryHeaders", () => {
  test("authenticates the way omp will, so a 200 here predicts a working model", () => {
    expect(discoveryHeaders({ authKind: "bearer" }, "tok")).toEqual({ authorization: "Bearer tok" });
    expect(discoveryHeaders({ authKind: "apikey", headerName: "X-Api-Key" }, "tok")).toEqual({ "X-Api-Key": "tok" });
    expect(discoveryHeaders({ authKind: "apikey", headerName: "Authorization" }, "tok")).toEqual({ authorization: "Bearer tok" });
    expect(discoveryHeaders({ authKind: "apikey" }, "tok")).toEqual({ authorization: "Bearer tok" });
  });

  test("sends nothing when there is no secret or the endpoint is open", () => {
    expect(discoveryHeaders({ authKind: "bearer" })).toEqual({});
    expect(discoveryHeaders({ authKind: "bearer" }, "")).toEqual({});
    expect(discoveryHeaders({ authKind: "none" }, "tok")).toEqual({});
  });
});
