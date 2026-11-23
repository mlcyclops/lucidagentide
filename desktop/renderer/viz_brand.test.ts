// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-VIZ.7 (ADR-0641): which sponsor a figure wears, how big it stands, and that the variant is stable.

import { describe, expect, test } from "bun:test";
import { sizeClassOf, vizBrandFor } from "./viz_brand.ts";

describe("vizBrandFor", () => {
  test("the provider route picks the sponsor; OAuth and API routes of one lab agree", () => {
    expect(vizBrandFor("anthropic/claude-opus-5-5")?.key).toBe("anthropic");
    expect(vizBrandFor("openai-codex/gpt-6.1-terra")?.key).toBe("openai");
    expect(vizBrandFor("openai/gpt-5.2")?.key).toBe("openai");
    expect(vizBrandFor("google-gemini-cli/gemini-3-pro")?.key).toBe("google");
    expect(vizBrandFor("xai-oauth/grok-4.7")?.key).toBe("xai");
  });
  test("a gateway or Copilot route wears the lab of the model it carries", () => {
    expect(vizBrandFor("openrouter/anthropic/claude-sonnet-4.6")?.key).toBe("anthropic");
    expect(vizBrandFor("amazon-bedrock/anthropic.claude-haiku-5-5")?.key).toBe("anthropic");
    expect(vizBrandFor("github-copilot/gpt-5.2")?.key).toBe("openai");
    expect(vizBrandFor("github-copilot/some-new-model")?.key).toBe("github");
    expect(vizBrandFor("asksage-openai/gpt-5.6-luna")?.key).toBe("openai");
  });
  test("local engines and self-hosted endpoints are private and wear TL187, even running an open lab's weights", () => {
    for (const m of ["dgx-spark/llama-4-70b", "ollama/qwen3:32b", "lm-studio/mistral-small", "my-gateway/whatever"]) {
      const b = vizBrandFor(m)!;
      expect(b.key).toBe("tl187");
      expect(b.private).toBe(true);
      expect(b.word).toBe("TL187");
    }
    expect(vizBrandFor("anthropic/claude-opus-5-5")!.private).toBe(false);
  });
  test("no model yet means no sponsor rather than a guessed one", () => {
    expect(vizBrandFor("")).toBeNull();
    expect(vizBrandFor("   ")).toBeNull();
  });
  test("the variant is stable per model and spread across models", () => {
    expect(vizBrandFor("anthropic/claude-opus-5-5")!.variant).toBe(vizBrandFor("anthropic/claude-opus-5-5")!.variant);
    const seen = new Set(["a/m1", "a/m2", "a/m3", "a/m4", "a/m5", "a/m6", "a/m7", "a/m8", "a/m9", "a/m10"].map((m) => vizBrandFor(m)!.variant));
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe("sizeClassOf", () => {
  test("flagships stand taller than workhorses, and small fast models shorter", () => {
    expect(sizeClassOf("anthropic/claude-opus-5-5")).toBe("large");
    expect(sizeClassOf("google/gemini-3-pro")).toBe("large");
    expect(sizeClassOf("dgx-spark/llama-4-70b")).toBe("large");
    expect(sizeClassOf("anthropic/claude-sonnet-4.6")).toBe("mid");
    expect(sizeClassOf("openai/gpt-5.2")).toBe("mid");
    expect(sizeClassOf("anthropic/claude-haiku-4.5")).toBe("small");
    expect(sizeClassOf("openai/gpt-5-mini")).toBe("small");
    expect(sizeClassOf("google/gemini-3-flash")).toBe("small");
    expect(sizeClassOf("ollama/qwen3-8b")).toBe("small");
    const [l, m, s] = ["anthropic/claude-opus-5-5", "openai/gpt-5.2", "anthropic/claude-haiku-4.5"].map((x) => vizBrandFor(x)!.scale);
    expect(l! > m! && m! > s!).toBe(true);
  });
});
