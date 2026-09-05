// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// The fresh-session model default (startup_model.ts, P-MODEL.1 / ADR-0250): the picker must never sit on
// omp's hardcoded Opus default - it opens on the LAST-USED model, else the BEST model the user's
// CONFIGURED providers expose, else (nothing configured) leaves omp's default alone.

import { describe, expect, it } from "bun:test";
import { resolveStartupModel } from "./startup_model.ts";

const opt = (value: string) => ({ value });

// A realistic accessible list: omp bundles the whole catalog even for unconfigured providers.
const OPTIONS = [
  "anthropic/claude-opus-4-8", "anthropic/claude-fable-5", "anthropic/claude-sonnet-4-6", "anthropic/claude-haiku-4-5",
  "openai-codex/gpt-5.5", "openai-codex/gpt-5.4-mini", "openai-codex/codex-auto-review",
  "google-antigravity/gemini-3.1-pro", "google-antigravity/gemini-2.5-flash",
  "asksage-openai/gpt-5.6-luna", "asksage-query/rag",
  "deepseek/deepseek-v3",
].map(opt);

/** Configured-provider predicate keyed on the value's provider prefix. */
const configuredBy = (...prefixes: string[]) => (value: string) => prefixes.some((p) => value.startsWith(p));

describe("resolveStartupModel - last used wins", () => {
  it("returns the last-used model when still offered and its provider is configured", () => {
    const r = resolveStartupModel({ lastUsed: "anthropic/claude-sonnet-4-6", current: "anthropic/claude-opus-4-8", options: OPTIONS, isConfigured: configuredBy("anthropic/") });
    expect(r).toEqual({ value: "anthropic/claude-sonnet-4-6", source: "last-used" });
  });
  it("honors a last-used pick even when a 'better' model exists (an explicit choice is not re-litigated)", () => {
    const r = resolveStartupModel({ lastUsed: "anthropic/claude-haiku-4-5", current: "anthropic/claude-opus-4-8", options: OPTIONS, isConfigured: () => true });
    expect(r!.value).toBe("anthropic/claude-haiku-4-5");
  });
  it("skips a last-used model that vanished from the picker", () => {
    const r = resolveStartupModel({ lastUsed: "anthropic/removed-model", current: "anthropic/claude-opus-4-8", options: OPTIONS, isConfigured: configuredBy("anthropic/") });
    expect(r!.source).toBe("best-configured");
  });
  it("skips a last-used model whose provider lost its credential", () => {
    const r = resolveStartupModel({ lastUsed: "openai-codex/gpt-5.5", current: "anthropic/claude-opus-4-8", options: OPTIONS, isConfigured: configuredBy("anthropic/") });
    expect(r!.source).toBe("best-configured");
    expect(r!.value.startsWith("anthropic/")).toBe(true);
  });
});

describe("resolveStartupModel - best configured", () => {
  it("picks the most capable, newest model of the configured provider (fable 5 over opus 4.8)", () => {
    const r = resolveStartupModel({ lastUsed: "", current: "anthropic/claude-opus-4-8", options: OPTIONS, isConfigured: configuredBy("anthropic/") });
    expect(r).toEqual({ value: "anthropic/claude-fable-5", source: "best-configured" });
  });
  it("only considers CONFIGURED providers (openai key only -> a GPT flagship, never the Opus default)", () => {
    const r = resolveStartupModel({ lastUsed: "", current: "anthropic/claude-opus-4-8", options: OPTIONS, isConfigured: configuredBy("openai-codex/") });
    expect(r!.value).toBe("openai-codex/gpt-5.5"); // flagship beats 5.4-mini; auto-review is auxiliary
  });
  it("prefers a direct route over the gov gateway when both are configured", () => {
    const r = resolveStartupModel({ lastUsed: "", current: "", options: OPTIONS, isConfigured: configuredBy("openai-codex/", "asksage-") });
    expect(r!.value).toBe("openai-codex/gpt-5.5");
  });
  it("a gov-gateway-only user lands on a gov model, never the unusable RAG route", () => {
    const r = resolveStartupModel({ lastUsed: "", current: "", options: OPTIONS, isConfigured: configuredBy("asksage-") });
    expect(r!.value).toBe("asksage-openai/gpt-5.6-luna");
  });
  it("never auto-picks a sovereignty-gated China-origin model", () => {
    const r = resolveStartupModel({ lastUsed: "", current: "", options: OPTIONS, isConfigured: configuredBy("deepseek/") });
    expect(r).toBeNull();
  });
  it("small tiers rank below balanced ones (mini regex never eats 'gemini')", () => {
    const r = resolveStartupModel({
      lastUsed: "", current: "",
      options: ["google-antigravity/gemini-2.5-flash", "google-antigravity/gemini-3.1-pro"].map(opt),
      isConfigured: () => true,
    });
    expect(r!.value).toBe("google-antigravity/gemini-3.1-pro");
  });
});

describe("resolveStartupModel - no better signal", () => {
  it("nothing configured -> null (omp's default stands; there is nothing smarter to say)", () => {
    expect(resolveStartupModel({ lastUsed: "", current: "anthropic/claude-opus-4-8", options: OPTIONS, isConfigured: () => false })).toBeNull();
  });
  it("no options reported yet -> null", () => {
    expect(resolveStartupModel({ lastUsed: "x", current: "", options: [], isConfigured: () => true })).toBeNull();
  });
  it("an unknown/local provider counts as configured via the caller's predicate (true passthrough)", () => {
    const r = resolveStartupModel({ lastUsed: "", current: "", options: [opt("myserver/llama-3.3-70b")], isConfigured: () => true });
    expect(r!.value).toBe("myserver/llama-3.3-70b");
  });
});

describe("resolveStartupModel - P-MODEL.2 curated default", () => {
  // A 2026 fresh install: omp's catalog now carries BOTH new flagships.
  const FRESH = [...OPTIONS, opt("anthropic/claude-opus-5"), opt("openai-codex/gpt-6-astra")];

  it("both 2026 flagships configured -> Opus 5, decided by the curated list and not by the bigger digit", () => {
    // The old cross-family sort ranked on raw version digits, so gpt-6-astra [6] beat claude-opus-5 [5]
    // purely because 6 > 5. DEFAULT_MODEL_PREFERENCE makes this a decision: Opus 5 is entry #1.
    const r = resolveStartupModel({ lastUsed: "", current: "anthropic/claude-opus-4-8", options: FRESH, isConfigured: configuredBy("anthropic/", "openai-codex/") });
    expect(r).toEqual({ value: "anthropic/claude-opus-5", source: "best-configured" });
  });
  it("OpenAI-only fresh install -> gpt-6-astra (the new flagship is tier 2, no longer mis-ranked)", () => {
    const r = resolveStartupModel({ lastUsed: "", current: "", options: FRESH, isConfigured: configuredBy("openai-codex/") });
    expect(r).toEqual({ value: "openai-codex/gpt-6-astra", source: "best-configured" });
  });
  it("an explicit last-used pick still beats the curated default", () => {
    const r = resolveStartupModel({ lastUsed: "openai-codex/gpt-5.5", current: "", options: FRESH, isConfigured: () => true });
    expect(r).toEqual({ value: "openai-codex/gpt-5.5", source: "last-used" });
  });
});
