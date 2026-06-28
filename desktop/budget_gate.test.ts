// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/budget_gate.test.ts - the OAuth-vs-API-key gate for the status-bar budget pill.

import { describe, expect, test } from "bun:test";
import { providerForModel, providerHasApiKey, providerKeywords } from "./renderer/budget_gate.ts";
import type { AuthStatus, ProviderAuth } from "./renderer/bridge.ts";

const p = (id: string, keySet: boolean, oauthActive = !keySet): ProviderAuth =>
  ({ id, name: id, env: id.toUpperCase() + "_API_KEY", oauthId: id, canOauth: true, oauthActive, keySet });

const AUTH: AuthStatus = {
  gateway: [p("asksage", true, false)],
  majors: [p("openai", false), p("google", false), p("anthropic", false), p("xai", false, false), p("perplexity", false)],
  others: [p("openrouter", false, false), p("deepseek", false, false)],
};

describe("providerKeywords maps a model to its provider", () => {
  test("the major families resolve", () => {
    expect(providerKeywords("claude-opus-4-8")).toContain("anthropic");
    expect(providerKeywords("google-antigravity/gemini-3.1-pro")).toContain("google");
    expect(providerKeywords("openai-codex/gpt-5.2")).toContain("openai");
    expect(providerKeywords("xai/grok-4")).toContain("xai");
  });
});

describe("providerForModel finds the governing provider across all groups", () => {
  test("a Claude model resolves to anthropic", () => {
    expect(providerForModel(AUTH, "claude-opus-4-8")?.id).toBe("anthropic");
  });
  test("a Gemini model resolves to google", () => {
    expect(providerForModel(AUTH, "google-antigravity/gemini-3.1-pro")?.id).toBe("google");
  });
});

describe("providerHasApiKey - hide the budget pill for OAuth-only, show it for API keys", () => {
  test("OAuth-only provider (Anthropic via OAuth, no key) → false (hide the inaccurate 5-hour pill)", () => {
    expect(providerHasApiKey(AUTH, "claude-opus-4-8")).toBe(false);
  });

  test("same provider WITH an API key → true (show it; the figure is header-accurate)", () => {
    const keyed: AuthStatus = { ...AUTH, majors: AUTH.majors.map((m) => m.id === "anthropic" ? p("anthropic", true) : m) };
    expect(providerHasApiKey(keyed, "claude-opus-4-8")).toBe(true);
  });

  test("a gov-routed model follows its underlying family provider (gov usage has its own chip)", () => {
    // "asksage-anthropic/claude-..." carries "claude", so it resolves to anthropic (OAuth here → hidden),
    // not the AskSage gateway. The pill defers to the family; gov usage shows on the separate Gov chip.
    expect(providerHasApiKey(AUTH, "asksage-anthropic/claude-opus-4")).toBe(false);
  });

  test("unknown provider → true (never hide on a guess)", () => {
    expect(providerHasApiKey(AUTH, "some-unmapped-model")).toBe(true);
  });

  test("auth not loaded yet (null) → true (no hide before we know)", () => {
    expect(providerHasApiKey(null, "claude-opus-4-8")).toBe(true);
  });

  test("OpenAI / Google / Perplexity via OAuth → all hidden", () => {
    expect(providerHasApiKey(AUTH, "openai-codex/gpt-5.2")).toBe(false);
    expect(providerHasApiKey(AUTH, "google-gemini-cli/gemini-3-pro")).toBe(false);
    expect(providerHasApiKey(AUTH, "perplexity/sonar")).toBe(false);
  });
});
