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
});
