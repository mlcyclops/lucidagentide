// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/trainer_model.test.ts - P-TRAINER (ADR-0252): the trainer runs on whatever the user
// actually configured - flagship, workhorse, flash-class, local, or gov-routed - never a hardcoded id.

import { describe, expect, test } from "bun:test";
import { isTrainerCapable, resolveTrainerModel, trainerTier } from "./trainer_model.ts";
import type { ModelOption } from "./checker_model.ts";

const opt = (value: string): ModelOption => ({ value });

const FULL_CATALOG: ModelOption[] = [
  opt("openai/gpt-5.6-terra"),
  opt("anthropic/claude-sonnet-4-6"),
  opt("google/gemini-3.5-flash"),
  opt("asksage-openai/gpt-5.6-luna"),
  opt("ollama/llama-3.3-8b"),
  opt("openai/tab_flash"), // auxiliary - never a trainer model
  opt("asksage/rag"), // RAG route - never a trainer model
  opt("openai/text-embed-4"), // embedding route - never a trainer model
];

describe("capability + tiers", () => {
  test("non-chat routes are never trainer-capable; chat models of every tier are", () => {
    expect(isTrainerCapable("openai/tab_flash")).toBe(false);
    expect(isTrainerCapable("asksage/rag")).toBe(false);
    expect(isTrainerCapable("openai/text-embed-4")).toBe(false);
    expect(isTrainerCapable("openai/gpt-5.6-terra")).toBe(true);
    expect(isTrainerCapable("google/gemini-3.5-flash")).toBe(true); // fast tier stays ELIGIBLE
    expect(isTrainerCapable("ollama/llama-3.3-8b")).toBe(true); // local stays ELIGIBLE
  });

  test("tiers: flagship > workhorse > fast/small, and gemini is not a mini", () => {
    expect(trainerTier("openai/gpt-5.6-terra")).toBe(3);
    expect(trainerTier("anthropic/claude-sonnet-4-6")).toBe(2);
    expect(trainerTier("google/gemini-3.5-flash")).toBe(1);
    expect(trainerTier("google/gemini-3.5")).toBe(2);
    expect(trainerTier("ollama/llama-3.3-8b")).toBe(1);
  });
});

describe("resolveTrainerModel", () => {
  test("keeps the current model when it is capable and configured (never a pointless switch)", () => {
    const pick = resolveTrainerModel(FULL_CATALOG, "anthropic/claude-sonnet-4-6");
    expect(pick).toEqual({ value: "anthropic/claude-sonnet-4-6", tier: 2, source: "current" });
  });

  test("switches off a non-chat current model to the best configured candidate", () => {
    const pick = resolveTrainerModel(FULL_CATALOG, "asksage/rag");
    expect(pick?.source).toBe("best-configured");
    expect(pick?.value).toBe("openai/gpt-5.6-terra"); // flagship tier, direct route
  });

  test("direct route beats the gov gateway on tier ties", () => {
    const pick = resolveTrainerModel([opt("asksage-openai/gpt-5.6-luna"), opt("openai/gpt-5.6-terra")], "");
    expect(pick?.value).toBe("openai/gpt-5.6-terra");
  });

  test("a flash-only or local-only install still resolves (any capable model, not just flagships)", () => {
    expect(resolveTrainerModel([opt("google/gemini-3.5-flash")], "")?.value).toBe("google/gemini-3.5-flash");
    expect(resolveTrainerModel([opt("ollama/llama-3.3-8b")], "")?.value).toBe("ollama/llama-3.3-8b");
  });

  test("unconfigured providers are skipped; nothing usable resolves to null (caller shows the checklist)", () => {
    const onlyLocal = resolveTrainerModel(FULL_CATALOG, "", (v) => v.startsWith("ollama/"));
    expect(onlyLocal?.value).toBe("ollama/llama-3.3-8b");
    expect(resolveTrainerModel([opt("asksage/rag"), opt("openai/tab_flash")], "")).toBeNull();
    expect(resolveTrainerModel([], "")).toBeNull();
  });

  test("a current model that is capable but no longer offered or configured is replaced", () => {
    const gone = resolveTrainerModel(FULL_CATALOG, "anthropic/claude-opus-3");
    expect(gone?.source).toBe("best-configured");
    const unconfigured = resolveTrainerModel(FULL_CATALOG, "anthropic/claude-sonnet-4-6", (v) => !v.startsWith("anthropic/"));
    expect(unconfigured?.source).toBe("best-configured");
    expect(unconfigured?.value).toBe("openai/gpt-5.6-terra");
  });
});
