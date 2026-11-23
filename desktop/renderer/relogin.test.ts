// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-AUTH.RELOGIN1 (ADR-0640): what the re-login notice and the picker's Login row offer, in what order.

import { describe, expect, test } from "bun:test";
import type { AuthStatus, ProviderAuth } from "./bridge.ts";
import { humanModelId, loginChoices, reloginCopy, reloginTargets } from "./relogin.ts";

const p = (name: string, oauthId: string, extra: Partial<ProviderAuth> = {}): ProviderAuth =>
  ({ id: oauthId, name, env: "", oauthId, canOauth: true, oauthActive: false, keySet: false, ...extra });
const claudeLost = p("Anthropic \u00b7 Claude", "anthropic", { relogin: { reason: "expired" }, restoreModel: "anthropic/claude-opus-5-5" });
const auth = (majors: ProviderAuth[], others: ProviderAuth[] = []): AuthStatus => ({ gateway: [], majors, others });

describe("re-login notice", () => {
  test("names the provider, the update, and the model the user gets back", () => {
    const c = reloginCopy([claudeLost], "2.5.4-beta.7", () => "Claude Opus 5.5");
    expect(c.title).toBe("Log in to Claude again");
    expect(c.body).toContain("Claude ended your saved sign-in");
    expect(c.body).toContain("LUCID was on 2.5.4-beta.7");
    expect(c.body).toContain("get back to Claude Opus 5.5");
  });
  test("lists several providers and says nothing about an update that did not happen", () => {
    const c = reloginCopy([claudeLost, p("OpenAI \u00b7 ChatGPT", "openai-codex", { relogin: { reason: "missing" } })], undefined, () => undefined);
    expect(c.title).toBe("Log in to Claude and ChatGPT again");
    expect(c.body).not.toContain("update");
  });
  test("Not now hides a provider for the launch; a signed-in provider is never a target", () => {
    const a = auth([claudeLost, p("OpenAI \u00b7 ChatGPT", "openai-codex", { relogin: { reason: "missing" }, oauthActive: true })]);
    expect(reloginTargets(a, new Set()).map((x) => x.oauthId)).toEqual(["anthropic"]);
    expect(reloginTargets(a, new Set(["anthropic"]))).toEqual([]);
  });
});

test("a model the picker cannot list right now still reads as a name, not an id", () => {
  expect(humanModelId("anthropic/claude-opus-5-5")).toBe("Claude Opus 5.5");
  expect(humanModelId("openai-codex/gpt-6.1-terra")).toBe("GPT 6.1 Terra");
  expect(humanModelId("google-gemini-cli/gemini-3-pro")).toBe("Gemini 3 Pro");
});

describe("picker Login row", () => {
  test("lost sign-ins lead, then not signed in, then signed in; key-only providers are not offered", () => {
    const a = auth(
      [p("OpenAI \u00b7 ChatGPT", "openai-codex", { oauthActive: true }), p("Google \u00b7 Gemini", "google-gemini-cli"), claudeLost, p("Azure \u00b7 OpenAI", "", { canOauth: false })],
      [p("OpenRouter", "openrouter"), p("Alibaba \u00b7 Qwen", "qwen-portal", { relogin: { reason: "missing" } })],
    );
    expect(loginChoices(a).map((c) => `${c.provider.oauthId}:${c.state}`)).toEqual([
      "anthropic:relogin", "qwen-portal:relogin", "google-gemini-cli:signed-out", "openai-codex:signed-in",
    ]);
  });
});
