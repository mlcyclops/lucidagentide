// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/spoke_prefs.test.ts - P-SCROLL.1 (ADR-0405): a new spoke opens on the model the last
// spoke ran, never on a model the picker no longer offers.

import { describe, expect, test } from "bun:test";
import { fleetModelOptions, spawnModelDefault } from "./spoke_prefs.ts";

const OPTIONS = [{ value: "anthropic/claude-opus-5-5" }, { value: "anthropic/claude-sonnet-5" }, { value: "openai/gpt-6" }];

describe("spawnModelDefault", () => {
  test("the last spoke model wins over the master's", () => {
    expect(spawnModelDefault(OPTIONS, "anthropic/claude-sonnet-5", "anthropic/claude-opus-5-5")).toBe("anthropic/claude-sonnet-5");
  });

  test("a remembered model the picker no longer offers falls back to the master's", () => {
    expect(spawnModelDefault(OPTIONS, "retired/model", "openai/gpt-6")).toBe("openai/gpt-6");
  });

  test("nothing remembered and no master model: the first offered model, never an unselected form", () => {
    expect(spawnModelDefault(OPTIONS, "", "")).toBe("anthropic/claude-opus-5-5");
    expect(spawnModelDefault([], "", "")).toBe("");
  });

  test("a remembered API-key twin of the master's model loses to Main's provider", () => {
    const grok = [
      { value: "xai/grok-4.7", label: "Grok 4.7" },
      { value: "xai-oauth/grok-4.7", label: "Grok 4.7" },
    ];
    expect(spawnModelDefault(grok, "xai/grok-4.7", "xai-oauth/grok-4.7")).toBe("xai-oauth/grok-4.7");
    expect(spawnModelDefault(grok, "xai-oauth/grok-4.7", "xai-oauth/grok-4.7")).toBe("xai-oauth/grok-4.7");
  });
});

describe("fleetModelOptions", () => {
  test("a shared display name gains the provider route; a unique name does not", () => {
    const labeled = fleetModelOptions([
      { value: "xai/grok-4.7", label: "Grok 4.7" },
      { value: "xai-oauth/grok-4.7", label: "Grok 4.7" },
      { value: "anthropic/claude-opus-5-5", label: "Claude Opus 5.5" },
    ]);
    expect(labeled.map((o) => o.label)).toEqual([
      "API key: Grok 4.7",
      "X sign-in: Grok 4.7",
      "Claude Opus 5.5",
    ]);
    expect(labeled.map((o) => o.value)).toEqual([
      "xai/grok-4.7",
      "xai-oauth/grok-4.7",
      "anthropic/claude-opus-5-5",
    ]);
  });
});
