// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/local_providers_ui.test.ts — P-LOCAL.3 (ADR-0135): the Settings → Local Providers card.

import { test, expect, describe } from "bun:test";
import { localProvidersCardBody, providerStatus, draftFromForm } from "./local_providers_ui.ts";
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
    // the add form is its own accordion (collapsed by default — no `open` class on .lp-add)
    expect(h).toContain("data-lp-addtoggle");
    expect(h).toContain("lp-add-body");
    expect(h).not.toContain('class="lp-add open"');
  });
  test("lists a provider with its endpoint, a delete button, and a per-row id", () => {
    const h = localProvidersCardBody([def()], new Set(["lpkey_lp_dgx"]), true);
    expect(h).toContain('data-lp-id="lp_dgx"');
    expect(h).toContain("DGX Vienna");
    expect(h).toContain("10.20.30.40:8000/v1");
    expect(h).toContain("data-lp-del");
    expect(h).toContain("data-lp-toggle");
    expect(h).toContain("key in vault"); // ref present in the vault set
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
  test("fail-closed: a bad base URL or no models surfaces errors and yields no def", () => {
    expect(draftFromForm({ name: "x", baseUrl: "not-a-url", auth: "none", models: "m" }, now).errors.join()).toContain("base URL");
    expect(draftFromForm({ name: "x", baseUrl: "http://h/v1", auth: "none", models: "" }, now).errors.join()).toContain("at least one model");
    expect(draftFromForm({ name: "x", baseUrl: "not-a-url", auth: "none", models: "m" }, now).def).toBeUndefined();
  });
  test("a name that would shadow a built-in vendor is refused (validation)", () => {
    expect(draftFromForm({ name: "OpenAI", baseUrl: "http://h/v1", auth: "none", models: "m" }, now).errors.join()).toContain("reserved");
  });
});
