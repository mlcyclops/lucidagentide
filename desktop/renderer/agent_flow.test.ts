// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// The LUCID Agent enter flow (agent_flow.ts, P-AVATAR.4 / ADR-0251): fast-model resolution in the
// user's stated preference order, the one-gap-at-a-time readiness checklist (vault = offer, never a
// gate), and exit-time model restoration.

import { describe, expect, it } from "bun:test";
import { nextGap, readinessChecklist, resolveConversationModel, restoreModel } from "./agent_flow.ts";

const OPTIONS = [
  "anthropic/claude-opus-4-8", "anthropic/claude-sonnet-4-6", "anthropic/claude-haiku-4-5",
  "openai-codex/gpt-5.6-terra", "openai-codex/gpt-5.6-luna", "openai-codex/gpt-5.5",
  "google-antigravity/gemini-3.5-flash", "asksage-anthropic/google-claude-sonnet-5",
].map((value) => ({ value }));

describe("resolveConversationModel - the user's stated order", () => {
  it("Terra first, whatever else is available", () => {
    expect(resolveConversationModel(OPTIONS, "anthropic/claude-opus-4-8")).toBe("openai-codex/gpt-5.6-terra");
  });
  it("Sonnet 5 (incl. the gov id) when Terra is absent", () => {
    const noTerra = OPTIONS.filter((o) => !o.value.includes("terra"));
    expect(resolveConversationModel(noTerra, "anthropic/claude-opus-4-8")).toBe("asksage-anthropic/google-claude-sonnet-5");
  });
  it("Gemini Flash third; family fallbacks after that", () => {
    const slim = OPTIONS.filter((o) => !/terra|sonnet-5/.test(o.value));
    expect(resolveConversationModel(slim, "anthropic/claude-opus-4-8")).toBe("google-antigravity/gemini-3.5-flash");
    const slimmer = [{ value: "anthropic/claude-sonnet-4-6" }];
    expect(resolveConversationModel(slimmer, "x/slow-model")).toBe("anthropic/claude-sonnet-4-6");
  });
  it("keeps the current model when it already qualifies, or when nothing qualifies", () => {
    expect(resolveConversationModel(OPTIONS, "openai-codex/gpt-5.6-terra")).toBeNull();
    expect(resolveConversationModel(OPTIONS, "google-gemini-3.6-flash")).toBeNull();
    expect(resolveConversationModel([{ value: "x/slow" }], "x/other-slow")).toBeNull();
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
