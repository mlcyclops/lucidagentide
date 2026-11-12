// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// The fresh-session model default (startup_model.ts, P-MODEL.1 / ADR-0250): the picker must never sit on
// omp's hardcoded Opus default - it opens on the LAST-USED model, else the BEST model the user's
// CONFIGURED providers expose, else (nothing configured) leaves omp's default alone.

import { describe, expect, it } from "bun:test";
import { resolveStartupModel } from "./startup_model.ts";
import { isLocalModel } from "./renderer/model_families.ts";

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
  it("drops a remembered EMBEDDING model (fresh v2.5.1 install pinned ollama/nomic-embed-text) for the best cloud model", () => {
    const opts = [...OPTIONS, opt("ollama/nomic-embed-text:latest"), opt("anthropic/claude-opus-5-5")];
    // Unknown (local) providers count as configured, which is exactly how the embedding model won before.
    const isConfigured = (v: string) => v.startsWith("ollama/") || v.startsWith("anthropic/") || v.startsWith("openai-codex/");
    const r = resolveStartupModel({ lastUsed: "ollama/nomic-embed-text:latest", current: "ollama/nomic-embed-text:latest", options: opts, isConfigured });
    expect(r).toEqual({ value: "anthropic/claude-opus-5-5", source: "best-configured" });
  });
  it("never opens on an embedding model when it is the only configured option", () => {
    const r = resolveStartupModel({ lastUsed: "", current: "", options: [opt("ollama/nomic-embed-text:latest")], isConfigured: () => true });
    expect(r).toBeNull();
  });
});

describe("resolveStartupModel - cloud-only default, local strictly opt-in", () => {
  const isLocal = (v: string) => isLocalModel(v, new Set(["dgx-spark"]));
  const LOCAL = ["ollama/llama3.1:8b", "ollama/nomic-embed-text:latest", "ollama/qwen2.5:7b-instruct"].map(opt);
  // Before any OAuth: only local providers hold anything usable (they need no credential).
  const preOauth = (v: string) => isLocal(v);
  const postOauth = (v: string) => isLocal(v) || v.startsWith("anthropic/") || v.startsWith("openai-codex/");

  it("fresh install with ONLY local models present: no auto-default (null), so the picker waits", () => {
    const r = resolveStartupModel({ lastUsed: "", current: "ollama/llama3.1:8b", options: LOCAL, isConfigured: () => true, isLocal });
    expect(r).toBeNull();
  });
  it("same install, cloud catalog present but not signed in yet: still no local fallback", () => {
    const r = resolveStartupModel({ lastUsed: "", current: "", options: [...LOCAL, ...OPTIONS], isConfigured: preOauth, isLocal });
    expect(r).toBeNull();
  });
  it("after OAuth the cloud model appears and is chosen", () => {
    const r = resolveStartupModel({ lastUsed: "", current: "ollama/llama3.1:8b", options: [...LOCAL, ...OPTIONS, opt("anthropic/claude-opus-5-5")], isConfigured: postOauth, isLocal });
    expect(r).toEqual({ value: "anthropic/claude-opus-5-5", source: "best-configured" });
  });
  it("a local model the user EXPLICITLY picked is remembered and honored over every cloud model", () => {
    const r = resolveStartupModel({ chosen: "ollama/llama3.1:8b", lastUsed: "", current: "anthropic/claude-opus-5-5", options: [...LOCAL, ...OPTIONS, opt("anthropic/claude-opus-5-5")], isConfigured: postOauth, isLocal });
    expect(r).toEqual({ value: "ollama/llama3.1:8b", source: "chosen" });
  });
  it("an explicitly picked configured Local Provider model is honored", () => {
    const r = resolveStartupModel({ chosen: "dgx-spark/glm-5.3-flash", lastUsed: "", current: "", options: [opt("dgx-spark/glm-5.3-flash"), opt("anthropic/claude-opus-5-5")], isConfigured: () => true, isLocal });
    expect(r!.value).toBe("dgx-spark/glm-5.3-flash");
  });
  it("an AUTO-assigned local last-used value is NOT honored after upgrade (cloud wins, or nothing)", () => {
    const withCloud = resolveStartupModel({ lastUsed: "ollama/llama3.1:8b", current: "ollama/llama3.1:8b", options: [...LOCAL, opt("anthropic/claude-opus-5-5")], isConfigured: postOauth, isLocal });
    expect(withCloud).toEqual({ value: "anthropic/claude-opus-5-5", source: "best-configured" });
    const noCloud = resolveStartupModel({ lastUsed: "ollama/llama3.1:8b", current: "ollama/llama3.1:8b", options: LOCAL, isConfigured: () => true, isLocal });
    expect(noCloud).toBeNull();
  });
  it("a configured Local Provider is never the auto-default either", () => {
    const r = resolveStartupModel({ lastUsed: "", current: "", options: [opt("dgx-spark/glm-5.3-flash")], isConfigured: () => true, isLocal });
    expect(r).toBeNull();
  });
  it("a CLOUD last-used model is still restored (P-MODEL.2 behaviour kept)", () => {
    const r = resolveStartupModel({ lastUsed: "openai-codex/gpt-5.5", current: "", options: [...LOCAL, ...OPTIONS], isConfigured: postOauth, isLocal });
    expect(r).toEqual({ value: "openai-codex/gpt-5.5", source: "last-used" });
  });
  it("an explicit choice that is an embedding model is still refused", () => {
    const r = resolveStartupModel({ chosen: "ollama/nomic-embed-text:latest", lastUsed: "", current: "", options: [opt("ollama/nomic-embed-text:latest"), opt("anthropic/claude-opus-5-5")], isConfigured: () => true, isLocal });
    expect(r).toEqual({ value: "anthropic/claude-opus-5-5", source: "best-configured" });
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
  it("a catalog carrying Opus 5.5 (2026-09-22) opens on it - entry #1, above Opus 5", () => {
    const r = resolveStartupModel({ lastUsed: "", current: "anthropic/claude-opus-4-8", options: [...FRESH, opt("anthropic/claude-opus-5-5")], isConfigured: configuredBy("anthropic/", "openai-codex/") });
    expect(r).toEqual({ value: "anthropic/claude-opus-5-5", source: "best-configured" });
  });
  it("P-MODEL.6: omp 18.4.4's catalog (Opus 5.5 + Sonnet 5.5) still opens on Opus 5.5; Sonnet 5.5 is not a flagship", () => {
    const r = resolveStartupModel({ lastUsed: "", current: "", options: [...FRESH, opt("anthropic/claude-opus-5-5"), opt("anthropic/claude-sonnet-5-5")], isConfigured: configuredBy("anthropic/") });
    expect(r).toEqual({ value: "anthropic/claude-opus-5-5", source: "best-configured" });
  });
  it("P-MODEL.6: a StepFun-only configuration never auto-picks StepFun (China-origin gate), direct or resold", () => {
    const step = [...OPTIONS, opt("stepfun/step-5-preview"), opt("stepfun/step-3.7-flash"), opt("openrouter/stepfun/step-3.7-flash")];
    expect(resolveStartupModel({ lastUsed: "", current: "", options: step, isConfigured: configuredBy("stepfun/") })).toBeNull();
    const r = resolveStartupModel({ lastUsed: "", current: "", options: step, isConfigured: configuredBy("stepfun/", "openrouter/") });
    expect(r).toBeNull(); // openrouter here carries only the StepFun resale
  });
});
