// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/local_providers_ui.test.ts - P-LOCAL.3 (ADR-0135): the Settings Local Providers card.

import { test, expect, describe } from "bun:test";
import { localProvidersCardBody, providerStatus, draftFromForm, modelsFieldValue, providerWithDiscovered } from "./local_providers_ui.ts";
import { enrichModelFromCatalog } from "./local_presets.ts";
import type { LocalProviderDef } from "../local_providers.ts";

function def(over: Partial<LocalProviderDef> = {}): LocalProviderDef {
  const now = 1_700_000_000_000;
  return {
    id: "lp_dgx", name: "DGX Vienna", ompProvider: "dgx-vienna", baseUrl: "https://10.20.30.40:8000/v1",
    api: "openai-completions", authKind: "bearer", vaultRef: "lpkey_lp_dgx", zone: "internal",
    models: [{ id: "llama-3.1-70b", name: "Llama 3.1 70B" }], enabled: true, createdAt: now, updatedAt: now, ...over,
  };
}

describe("card body", () => {
  test("empty state prompts to add; add form has the fields + the add button, inside a collapsible section", () => {
    const h = localProvidersCardBody([], new Set(), true);
    expect(h).toContain("No local providers yet");
    expect(h).toContain('id="lpName"');
    expect(h).toContain('id="lpBaseUrl"');
    expect(h).toContain('id="lpModels"');
    expect(h).toContain('id="lpAuth"');
    expect(h).toContain('id="lpKey"');
    expect(h).toContain("data-lp-add");
    // the add form is its own accordion (collapsed by default, so no `open` class on .lp-add)
    expect(h).toContain("data-lp-addtoggle");
    expect(h).toContain("lp-add-body");
    expect(h).not.toContain('class="lp-add open"');
    // polish: an external-zone toggle + a Test-connection button live in the add form
    expect(h).toContain('id="lpExternal"');
    expect(h).toContain("data-lp-test-form");
    // basic auth is not offered (unsupported)
    expect(h).not.toContain('value="basic"');
  });
  test("lists a provider with endpoint, delete/test buttons, a per-row id; authed rows get a Key + re-key field", () => {
    const h = localProvidersCardBody([def()], new Set(["lpkey_lp_dgx"]), true);
    expect(h).toContain('data-lp-id="lp_dgx"');
    expect(h).toContain("DGX Vienna");
    expect(h).toContain("10.20.30.40:8000/v1");
    expect(h).toContain("data-lp-del");
    expect(h).toContain("data-lp-toggle");
    expect(h).toContain("key in vault"); // ref present in the vault set
    expect(h).toContain("data-lp-test"); // per-row reachability probe
    expect(h).toContain('data-url="https://10.20.30.40:8000/v1"');
    expect(h).toContain("data-lp-rekey"); // authed → a Key affordance + inline paste field
    expect(h).toContain("lp-rekey-input");
  });
  test("an open provider has no Key affordance; the Apply/Restart button shows only in Electron with enabled providers", () => {
    const open = localProvidersCardBody([def({ authKind: "none", vaultRef: undefined })], new Set(), true);
    expect(open).not.toContain("data-lp-rekey");
    expect(open).toContain("data-lp-apply"); // electron + an enabled provider
    // no Apply button in the browser build, or when there are no enabled providers
    expect(localProvidersCardBody([def()], new Set(), false)).not.toContain("data-lp-apply");
    expect(localProvidersCardBody([def({ enabled: false })], new Set(), true)).not.toContain("data-lp-apply");
  });
  test("non-Electron warns the vault is desktop-only; the key field is never pre-filled", () => {
    const h = localProvidersCardBody([def()], new Set(), false);
    expect(h).toContain("desktop app");
    // the def carries only an opaque vaultRef, never a secret; the password input has no value attribute
    expect(h).toMatch(/id="lpKey"[^>]*type="password"/);
    expect(h).not.toMatch(/id="lpKey"[^>]*value=/);
  });
  test("escapes an injected provider name (no raw HTML)", () => {
    const h = localProvidersCardBody([def({ name: '<img src=x onerror=1>' })], new Set(), true);
    expect(h).not.toContain("<img src=x");
    expect(h).toContain("&lt;img");
  });
});

describe("providerStatus", () => {
  test("open → ok; authed+in-vault → ok; authed+missing → warn", () => {
    expect(providerStatus(def({ authKind: "none", vaultRef: undefined }), new Set()).label).toContain("open");
    expect(providerStatus(def(), new Set(["lpkey_lp_dgx"])).tone).toBe("ok");
    expect(providerStatus(def(), new Set())).toEqual({ label: "needs a key", tone: "warn" });
  });
});

describe("draftFromForm", () => {
  const now = 1_700_000_000_000;
  test("builds a valid def from good input; needsKey reflects auth", () => {
    const r = draftFromForm({ name: "Ollama Box", baseUrl: "http://localhost:11434/v1", auth: "none", models: "llama3.1:8b, qwen2.5:14b" }, now);
    expect(r.errors).toEqual([]);
    expect(r.needsKey).toBe(false);
    expect(r.def!.ompProvider).toBe("ollama_box");
    expect(r.def!.models.map((m) => m.id)).toEqual(["llama3.1:8b", "qwen2.5:14b"]);
    expect(r.def!.api).toBe("openai-completions");
    const authed = draftFromForm({ name: "DGX", baseUrl: "https://10.0.0.1:8000/v1", auth: "bearer", models: "m" }, now);
    expect(authed.needsKey).toBe(true);
  });
  test("the external checkbox drives the zone (default internal)", () => {
    expect(draftFromForm({ name: "x", baseUrl: "http://h/v1", auth: "none", models: "m" }, now).def!.zone).toBe("internal");
    expect(draftFromForm({ name: "x", baseUrl: "https://api.example.com/v1", auth: "none", models: "m", external: true }, now).def!.zone).toBe("external");
  });
  test("fail-closed: a bad base URL or no models surfaces errors and yields no def", () => {
    expect(draftFromForm({ name: "x", baseUrl: "not-a-url", auth: "none", models: "m" }, now).errors.join()).toContain("base URL");
    expect(draftFromForm({ name: "x", baseUrl: "http://h/v1", auth: "none", models: "" }, now).errors.join()).toContain("at least one model");
    expect(draftFromForm({ name: "x", baseUrl: "not-a-url", auth: "none", models: "m" }, now).def).toBeUndefined();
  });
  test("a name that would shadow a built-in vendor is refused (validation)", () => {
    expect(draftFromForm({ name: "OpenAI", baseUrl: "http://h/v1", auth: "none", models: "m" }, now).errors.join()).toContain("reserved");
  });
});

// ── P-LOCAL.6: endpoint discovery ────────────────────────────────────────────────────────────────

describe("enrichModelFromCatalog", () => {
  test("the SERVER wins on context window; the catalog supplies what /models cannot say", () => {
    // The endpoint reported 65536 for a model the catalog seeds at 524288. The server is right:
    // it is the one that loaded the weights, and a too-large window silently truncates at run time.
    const m = enrichModelFromCatalog({ id: "zai-org/GLM-5.3-Flash-FP8", contextWindow: 65536 });
    expect(m.contextWindow).toBe(65536);
    expect(m.reasoning).toBe(true);
    expect(m.compat?.thinkingFormat).toBe("qwen-chat-template");
    expect(m.id).toBe("zai-org/GLM-5.3-Flash-FP8"); // the WIRE id is never rewritten
  });

  test("falls back to the catalog's window only when the server reported none", () => {
    // 524288 since P-LOCAL.7, which replaced P-LOCAL.5's editorial 131072 with the value read
    // authenticated off the live head (`max_model_len=524288`). The fallback exists precisely for
    // the case that blocked that measurement for a whole increment: a keyed endpoint whose
    // unauthenticated /v1/models answers 401, so the server reports no window at all.
    expect(enrichModelFromCatalog({ id: "glm-5.3-flash" }).contextWindow).toBe(524288);
  });

  test("an id matching no preset gets only its own facts", () => {
    expect(enrichModelFromCatalog({ id: "bespoke-merge-v9", contextWindow: 4096 }))
      .toEqual({ id: "bespoke-merge-v9", name: "bespoke-merge-v9", contextWindow: 4096 });
    expect(enrichModelFromCatalog({ id: "bespoke-merge-v9" }).reasoning).toBeUndefined();
  });
});

describe("providerWithDiscovered", () => {
  const now = 1_800_000_000_000;

  test("replaces the saved list with what the endpoint serves, reporting both directions", () => {
    const r = providerWithDiscovered(def(), [{ id: "glm-5.3-flash", contextWindow: 131072 }, { id: "gemma-4" }], now);
    expect(r.def.models.map((m) => m.id)).toEqual(["glm-5.3-flash", "gemma-4"]);
    expect(r.added).toEqual(["glm-5.3-flash", "gemma-4"]);
    expect(r.removed).toEqual(["llama-3.1-70b"]); // the endpoint no longer serves it
    expect(r.def.updatedAt).toBe(now);
  });

  test("enriches each discovered model on the way in, so compat reaches the saved def", () => {
    const r = providerWithDiscovered(def(), [{ id: "glm-5.3-flash", contextWindow: 65536 }], now);
    expect(r.def.models[0]!.compat?.reasoningContentField).toBe("reasoning");
    expect(r.def.models[0]!.contextWindow).toBe(65536);
  });

  test("an empty answer leaves the provider EXACTLY as it was, never wiping it", () => {
    const original = def();
    const r = providerWithDiscovered(original, [], now);
    expect(r.def).toBe(original); // same object: nothing to save, nothing to lose
    expect(r.added).toEqual([]);
    expect(r.removed).toEqual([]);
  });

  test("re-discovering an unchanged endpoint reports no additions or removals", () => {
    const r = providerWithDiscovered(def(), [{ id: "llama-3.1-70b" }], now);
    expect(r.added).toEqual([]);
    expect(r.removed).toEqual([]);
  });
});

test("modelsFieldValue writes the ids back in the form's own format", () => {
  expect(modelsFieldValue([{ id: "a" }, { id: "b", contextWindow: 9 }])).toBe("a, b");
  expect(modelsFieldValue([])).toBe("");
});

test("the card offers discovery in the add form and on every saved row", () => {
  const h = localProvidersCardBody([def()], new Set(["lpkey_lp_dgx"]), true);
  expect(h).toContain("data-lp-discover-form");
  expect(h).toContain("data-lp-discover");
  expect(localProvidersCardBody([], new Set(), true)).toContain("data-lp-discover-form");
});
