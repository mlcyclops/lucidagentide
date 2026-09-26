// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// The LUCID Agent enter flow (agent_flow.ts, P-AVATAR.4 / ADR-0251): provider-isolated Regular/Max
// tier resolution, the one-gap-at-a-time readiness checklist (vault = offer, never a
// gate), and exit-time model restoration.

import { describe, expect, it } from "bun:test";
import { nextGap, readinessChecklist, resolveAgentTierModel, restoreModel } from "./agent_flow.ts";

const OPTIONS = [
  "anthropic/claude-opus-4-8", "anthropic/claude-sonnet-4-6", "anthropic/claude-haiku-4-5",
  "openai-codex/gpt-5.6-terra", "openai-codex/gpt-5.6-luna", "openai-codex/gpt-5.5",
  "google-antigravity/gemini-3.5-flash", "asksage-anthropic/google-claude-sonnet-5",
].map((value) => ({ value }));

const models = (...values: string[]) => values.map((value) => ({ value }));

describe("resolveAgentTierModel - accessible provider-isolated tiers", () => {
  it("Regular prefers Opus or Luna over the provider's Max family", () => {
    const anthropic = models("anthropic/claude-fable-5.1", "anthropic/claude-opus-4-8", "anthropic/claude-opus-5");
    expect(resolveAgentTierModel(anthropic, anthropic[0]!.value, "regular")).toBe("anthropic/claude-opus-5");
    const codex = models("openai-codex/gpt-6-astra", "openai-codex/gpt-5.6-luna", "openai-codex/gpt-5.6-terra");
    expect(resolveAgentTierModel(codex, codex[0]!.value, "regular")).toBe("openai-codex/gpt-5.6-luna");
    // Opus 5.5 (2026-09-22): the hyphenated-minor spelling parses as [5,5] and outranks Opus 5's [5].
    const opus55 = models("anthropic/claude-opus-5", "anthropic/claude-opus-5-5", "anthropic/claude-fable-5.1");
    expect(resolveAgentTierModel(opus55, opus55[2]!.value, "regular")).toBe("anthropic/claude-opus-5-5");
  });

  it("Max prefers accessible Fable 5+ and Astra 6+", () => {
    const options = models("anthropic/claude-opus-5", "anthropic/claude-fable-5", "anthropic/claude-fable-5.1",
      "openai-codex/gpt-5.6-luna", "openai-codex/gpt-6-astra");
    expect(resolveAgentTierModel(options, options[0]!.value, "max")).toBe("anthropic/claude-fable-5.1");
    expect(resolveAgentTierModel(options, "openai-codex/gpt-5.6-luna", "max")).toBe("openai-codex/gpt-6-astra");
    expect(resolveAgentTierModel(models("anthropic/claude-fable-4", "anthropic/claude-opus-5"), "anthropic/claude-fable-4", "max")).toBe("anthropic/claude-opus-5");
    expect(resolveAgentTierModel(models("openai/gpt-5-astra", "openai/gpt-6"), "openai/gpt-5-astra", "max")).toBe("openai/gpt-6");
  });

  it("GPT-6 tiers: Regular lands on Luna 6 over Luna 5.6, Sol steps down to Luna, and Max climbs Sol or Luna to Astra", () => {
    const six = models("openai-codex/gpt-6-astra", "openai-codex/gpt-6-sol", "openai-codex/gpt-6-luna", "openai-codex/gpt-5.6-luna");
    expect(resolveAgentTierModel(six, "openai-codex/gpt-6-astra", "regular")).toBe("openai-codex/gpt-6-luna");
    expect(resolveAgentTierModel(six, "openai-codex/gpt-6-sol", "regular")).toBe("openai-codex/gpt-6-luna");
    expect(resolveAgentTierModel(six, "openai-codex/gpt-6-luna", "max")).toBe("openai-codex/gpt-6-astra");
    expect(resolveAgentTierModel(six, "openai-codex/gpt-6-sol", "max")).toBe("openai-codex/gpt-6-astra");
  });
  it("never crosses API, OAuth or accredited gateway routes", () => {
    const options = models("openai-codex/gpt-5.6-luna", "openai/gpt-6-astra", "asksage-openai/gpt-6-astra", "anthropic/claude-fable-5");
    expect(resolveAgentTierModel(options, options[0]!.value, "max")).toBeNull();
    expect(resolveAgentTierModel(options, "asksage-openai/gpt-5.6-luna", "max")).toBe("asksage-openai/gpt-6-astra");
    expect(resolveAgentTierModel(models("openai/gpt-6-astra"), "openai-codex/gpt-5.6-luna", "max")).toBeNull();
  });

  it("keeps gateway model families separate rather than comparing unrelated versions", () => {
    const options = models("openrouter/anthropic/claude-opus-5", "openrouter/anthropic/claude-fable-5.1", "openrouter/openai/gpt-10-astra");
    expect(resolveAgentTierModel(options, options[0]!.value, "max")).toBe(options[1]!.value);
    const gov = models("asksage-google/google-claude-sonnet-5", "asksage-google/google-claude-opus-5", "asksage-google/google-gemini-10-pro");
    expect(resolveAgentTierModel(gov, gov[0]!.value, "regular")).toBe(gov[1]!.value);
  });

  it("compares numeric major and minor versions rather than lexical order", () => {
    const majors = models("anthropic/claude-fable-9", "anthropic/claude-fable-10");
    expect(resolveAgentTierModel(majors, majors[0]!.value, "max")).toBe(majors[1]!.value);
    const minors = models("anthropic/claude-fable-5.9", "anthropic/claude-fable-5.10");
    expect(resolveAgentTierModel(minors, minors[0]!.value, "max")).toBe(minors[1]!.value);
    const hyphens = models("anthropic/claude-opus-4-8", "anthropic/claude-opus-4-10");
    expect(resolveAgentTierModel(hyphens, hyphens[0]!.value, "regular")).toBe(hyphens[1]!.value);
  });

  it("does not let snapshot dates count as a newer version or force a tied switch", () => {
    const options = models("anthropic/claude-fable-5-2026-09-20", "anthropic/claude-fable-5-20260920", "anthropic/claude-fable-5");
    expect(resolveAgentTierModel(options, options[2]!.value, "max")).toBeNull();
    expect(resolveAgentTierModel(options, options[0]!.value, "max")).toBeNull();
    expect(resolveAgentTierModel([...options, { value: "anthropic/claude-fable-5.1" }], options[0]!.value, "max")).toBe("anthropic/claude-fable-5.1");
  });

  it("fallback chooses a flagship instead of a newer mini, haiku, flash or fast variant", () => {
    const google = models("google/gemini-4-pro", "google/gemini-10-flash", "google/gemini-3-pro");
    expect(resolveAgentTierModel(google, google[1]!.value, "max")).toBe(google[0]!.value);
    const openai = models("openai/gpt-6", "openai/gpt-10-mini", "openai/gpt-11-fast", "openai/gpt-5.6-luna");
    expect(resolveAgentTierModel(openai, openai[3]!.value, "max")).toBe(openai[0]!.value);
    const anthropic = models("anthropic/claude-opus-5", "anthropic/claude-haiku-10", "anthropic/claude-sonnet-5");
    expect(resolveAgentTierModel(anthropic, anthropic[2]!.value, "max")).toBe(anthropic[0]!.value);
  });

  it("uses provider metadata for bare IDs but never lets it override a concrete route", () => {
    const options = [
      { value: "gpt-5.6-luna", provider: "openai-codex" },
      { value: "gpt-6-astra", provider: "openai" },
      { value: "gpt-7-astra", provider: "openai-codex" },
    ];
    expect(resolveAgentTierModel(options, options[0]!.value, "max")).toBe(options[2]!.value);
    expect(resolveAgentTierModel([
      { value: "openai-codex/gpt-5.6-luna", provider: "openai" },
      { value: "openai/gpt-6-astra", provider: "openai" },
    ], "openai-codex/gpt-5.6-luna", "max")).toBeNull();
    expect(resolveAgentTierModel(models("claude-opus-5", "claude-fable-5.1"), "claude-opus-5", "max")).toBe("claude-fable-5.1");
  });

  it("keeps usable unknown/local providers and Regular models without a preferred family", () => {
    for (const tier of ["regular", "max"] as const) {
      expect(resolveAgentTierModel(models("local/claude-opus-5", "local/claude-fable-6"), "local/claude-opus-5", tier)).toBeNull();
      expect(resolveAgentTierModel(models("custom/model-9", "custom/model-10"), "custom/model-9", tier)).toBeNull();
    }
    expect(resolveAgentTierModel(models("google/gemini-3-flash", "google/gemini-4-pro"), "google/gemini-3-flash", "regular")).toBeNull();
  });

  it("never invents unavailable preferred models and returns null for empty or ineligible pools", () => {
    const accessible = models("anthropic/claude-opus-5", "anthropic/claude-sonnet-5");
    expect(resolveAgentTierModel(accessible, "anthropic/claude-sonnet-5", "max")).toBe("anthropic/claude-opus-5");
    expect(resolveAgentTierModel(accessible, "anthropic/claude-opus-5", "max")).toBeNull();
    expect(resolveAgentTierModel([], "anthropic/claude-opus-5", "max")).toBeNull();
    expect(resolveAgentTierModel(models("openai/codex-auto-review", "openai/gpt-10-mini"), "openai/gpt-5", "max")).toBeNull();
  });
});

describe("readinessChecklist + nextGap - one gap at a time, vault never gates", () => {
  const good = { providers: 1, ttsReady: true, sttReady: true, vaultConfigured: true, vaultUnlocked: true };
  it("provider gap outranks everything", () => {
    const gap = nextGap(readinessChecklist({ ...good, providers: 0, ttsReady: false, sttReady: false }), false);
    expect(gap?.id).toBe("provider");
    expect(gap?.action).toBe("hub");
  });
  it("voice output before voice input", () => {
    expect(nextGap(readinessChecklist({ ...good, ttsReady: false, sttReady: false }), false)?.id).toBe("tts");
    expect(nextGap(readinessChecklist({ ...good, sttReady: false }), false)?.id).toBe("stt");
  });
  it("all required green + locked vault = the OFFER, exactly once", () => {
    const items = readinessChecklist({ ...good, vaultUnlocked: false });
    const offer = nextGap(items, false);
    expect(offer?.id).toBe("vault");
    expect(offer?.required).toBe(false);
    expect(offer?.actionLabel).toBe("Unlock");
    expect(nextGap(items, true)).toBeNull(); // asked already - never nag twice
  });
  it("an unconfigured vault offers SETUP wording", () => {
    const items = readinessChecklist({ ...good, vaultConfigured: false, vaultUnlocked: false });
    expect(nextGap(items, false)?.actionLabel).toBe("Set it up");
  });
  it("everything green = null (go hands-free)", () => {
    expect(nextGap(readinessChecklist(good), false)).toBeNull();
  });
});

describe("restoreModel - leaving the role restores the user's world", () => {
  const prior = { model: "anthropic/claude-opus-4-8", uiMode: "ask" as const, autoSpeak: false, conversation: false };
  it("restores the prior model when it is still accessible", () => {
    expect(restoreModel(prior, "openai-codex/gpt-5.6-terra", OPTIONS)).toBe("anthropic/claude-opus-4-8");
  });
  it("no-op when unchanged, or when the prior model vanished from the picker", () => {
    expect(restoreModel(prior, "anthropic/claude-opus-4-8", OPTIONS)).toBeNull();
    expect(restoreModel({ ...prior, model: "gone/model" }, "openai-codex/gpt-5.6-terra", OPTIONS)).toBeNull();
  });
});
