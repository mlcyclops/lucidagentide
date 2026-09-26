// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/spoke_prefs.test.ts - P-SCROLL.1 (ADR-0405): a new spoke opens on the model the last
// spoke ran, never on a model the picker no longer offers.

import { describe, expect, test } from "bun:test";
import { spawnModelDefault } from "./spoke_prefs.ts";

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
});
