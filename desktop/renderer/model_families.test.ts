// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/model_families.test.ts
//
// P-IDE.1 (ADR-0029): the model-picker family classification. The regex ORDER (o-series before
// GPT) and the gateway-prefix robustness are the easy things to break, so they're pinned here.

import { describe, expect, it } from "bun:test";
import { ASKSAGE_FAMILY_ORDER, cmpModelsNewestFirst, familyOf, filterModels, groupByFamily, gptVersion, isAuxiliaryModel, isChinaModel, isDeprecatedModel, isGovModel, MODEL_FAMILIES, sortGovFirstNewest, type ModelOption } from "./model_families.ts";

describe("familyOf", () => {
  it("classifies direct Anthropic models (incl. fable) as Claude", () => {
    expect(familyOf("claude-opus-4-8").id).toBe("claude");
    expect(familyOf("claude-fable-5").id).toBe("claude");
    expect(familyOf("claude-haiku-4-5").id).toBe("claude");
  });
  it("o-series wins over the general GPT bucket (order matters)", () => {
    expect(familyOf("gpt-o3").id).toBe("gpt-o");
    expect(familyOf("gpt-o4-mini").id).toBe("gpt-o");
    expect(familyOf("gpt-5.2").id).toBe("gpt");
    expect(familyOf("gpt-4.1").id).toBe("gpt");
  });
  it("classifies Gemini and RAG", () => {
    expect(familyOf("google-gemini-3.1-pro-com").id).toBe("gemini");
    expect(familyOf("rag").id).toBe("rag");
  });
  it("is robust to AskSage provider prefixes", () => {
    expect(familyOf("asksage-openai/gpt-5.2").id).toBe("gpt");
    expect(familyOf("asksage-openai/gpt-o3").id).toBe("gpt-o");
    expect(familyOf("asksage-google/google-claude-45-opus").id).toBe("claude");
    expect(familyOf("aws-bedrock-claude-45-sonnet-gov").id).toBe("claude");
    expect(familyOf("asksage-google/google-gemini-2.5-pro").id).toBe("gemini");
  });
  it("falls back to 'other' for unknown providers", () => {
    expect(familyOf("mistral-large").id).toBe("other");
    expect(familyOf("llama-3-70b").id).toBe("other");
  });
});

describe("groupByFamily", () => {
  const models: ModelOption[] = [
    { value: "claude-opus-4-8", name: "Claude Opus 4.8" },
    { value: "gpt-5.2", name: "GPT-5.2" },
    { value: "gpt-o3", name: "o3" },
    { value: "google-gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    { value: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
    { value: "mistral-large", name: "Mistral Large" },
  ];
  it("orders families per MODEL_FAMILIES, OTHER last, drops empties", () => {
    const groups = groupByFamily(models);
    expect(groups.map((g) => g.fam.id)).toEqual(["claude", "gpt-o", "gpt", "gemini", "other"]);
  });
  it("buckets multiple models into the same family, preserving input order", () => {
    const claude = groupByFamily(models).find((g) => g.fam.id === "claude")!;
    expect(claude.models.map((m) => m.value)).toEqual(["claude-opus-4-8", "claude-haiku-4-5"]);
  });
  it("an empty input produces no groups", () => {
    expect(groupByFamily([])).toEqual([]);
  });
  it("honors an explicit family order (AskSage gov-first), omitted families fall to default position", () => {
    const groups = groupByFamily(models, ASKSAGE_FAMILY_ORDER);
    // ASKSAGE_FAMILY_ORDER = gpt-o, gpt, gemini, claude, rag, other → claude drops below gpt/gemini
    expect(groups.map((g) => g.fam.id)).toEqual(["gpt-o", "gpt", "gemini", "claude", "other"]);
  });
  it("a partial order keeps unlisted families after the ordered ones", () => {
    const groups = groupByFamily(models, ["gemini"]); // only gemini promoted
    expect(groups[0]!.fam.id).toBe("gemini");
    // the rest follow in default MODEL_FAMILIES order
    expect(groups.map((g) => g.fam.id)).toEqual(["gemini", "claude", "gpt-o", "gpt", "other"]);
  });
  it("every family in the fixture except none is present (no phantom empties)", () => {
    const ids = new Set(groupByFamily(models).map((g) => g.fam.id));
    expect(ids.has("rag")).toBe(false); // no rag model in the fixture → family omitted
  });
});

describe("filterModels", () => {
  const models: ModelOption[] = [
    { value: "claude-opus-4-8", name: "Claude Opus 4.8" },
    { value: "gpt-5.2", name: "GPT-5.2" },
    { value: "google-gemini-2.5-pro", name: "Gemini 2.5 Pro" },
  ];
  it("empty query returns all", () => expect(filterModels(models, "")).toHaveLength(3));
  it("matches on display name (case-insensitive)", () => {
    expect(filterModels(models, "opus").map((m) => m.value)).toEqual(["claude-opus-4-8"]);
  });
  it("matches on model id", () => {
    expect(filterModels(models, "gemini").map((m) => m.value)).toEqual(["google-gemini-2.5-pro"]);
  });
  it("no match returns empty", () => expect(filterModels(models, "zzz")).toHaveLength(0));
});

describe("P-IDE.1c curation - isDeprecatedModel (moderate policy)", () => {
  it("drops dated snapshots and -latest aliases", () => {
    expect(isDeprecatedModel("anthropic/claude-3-5-sonnet-20241022")).toBe(true);
    expect(isDeprecatedModel("anthropic/claude-opus-4-1-20250805")).toBe(true);
    expect(isDeprecatedModel("anthropic/claude-3-5-haiku-latest")).toBe(true);
  });
  it("drops legacy Claude (3.x, 4.0, 4.1) but keeps 4.5+", () => {
    expect(isDeprecatedModel("anthropic/claude-3-opus-20240229")).toBe(true);
    expect(isDeprecatedModel("anthropic/claude-opus-4-0")).toBe(true);
    expect(isDeprecatedModel("anthropic/claude-opus-4-1")).toBe(true);
    expect(isDeprecatedModel("anthropic/claude-opus-4-5")).toBe(false);
    expect(isDeprecatedModel("anthropic/claude-opus-4-8")).toBe(false);
    expect(isDeprecatedModel("anthropic/claude-sonnet-4-6")).toBe(false);
    expect(isDeprecatedModel("anthropic/claude-fable-5")).toBe(false);
  });
  it("drops Gemini 2.0 but keeps 2.5+ / 3.x", () => {
    expect(isDeprecatedModel("google-gemini-cli/gemini-2.0-flash")).toBe(true);
    expect(isDeprecatedModel("google-antigravity/gemini-2.5-pro")).toBe(false);
    expect(isDeprecatedModel("google-antigravity/gemini-3-pro")).toBe(false);
  });
  it("drops GPT below 5.4 everywhere (gov + direct); keeps 5.4+; o-series & gpt-oss exempt", () => {
    expect(isDeprecatedModel("openai-codex/gpt-5")).toBe(true);
    expect(isDeprecatedModel("openai-codex/gpt-5.1-codex-max")).toBe(true);
    expect(isDeprecatedModel("asksage-openai/gpt-5.2")).toBe(true);
    expect(isDeprecatedModel("asksage-openai/gpt-4.1")).toBe(true);
    expect(isDeprecatedModel("openai-codex/gpt-5.4")).toBe(false);
    expect(isDeprecatedModel("openai-codex/gpt-5.4-mini")).toBe(false);
    expect(isDeprecatedModel("asksage-openai/gpt-5.5")).toBe(false);
    expect(isDeprecatedModel("asksage-openai/gpt-o3")).toBe(false); // o-series not a GPT-5.x
    expect(isDeprecatedModel("google-antigravity/gpt-oss-120b")).toBe(false); // open-source, version-less
  });
  it("gptVersion parses the numeric version, null for non-versioned", () => {
    expect(gptVersion("openai-codex/gpt-5.4")).toBe(5.4);
    expect(gptVersion("asksage-openai/gpt-4.1")).toBe(4.1);
    expect(gptVersion("asksage-openai/gpt-o3")).toBeNull();
    expect(gptVersion("google-antigravity/gpt-oss-120b")).toBeNull();
  });
});

describe("P-IDE.1c - gov / auxiliary / china detection", () => {
  it("isGovModel matches AskSage", () => {
    expect(isGovModel("asksage-openai/gpt-5.5")).toBe(true);
    expect(isGovModel("openai-codex/gpt-5.5")).toBe(false);
  });
  it("isAuxiliaryModel matches omp's non-chat helpers", () => {
    expect(isAuxiliaryModel("google-antigravity/tab_flash_lite_preview")).toBe(true);
    expect(isAuxiliaryModel("google-antigravity/tab_jump_flash_lite_preview")).toBe(true);
    expect(isAuxiliaryModel("openai-codex/codex-auto-review")).toBe(true);
    expect(isAuxiliaryModel("openai-codex/gpt-5.4")).toBe(false);
  });
  it("isChinaModel matches flagged providers, not Western ones", () => {
    for (const c of ["deepseek/deepseek-v3", "moonshot/kimi-k2", "minimax/abab", "zhipu/glm-4.6", "openrouter/glm-4", "qwen/qwen-max"]) expect(isChinaModel(c)).toBe(true);
    for (const w of ["anthropic/claude-opus-4-8", "openai-codex/gpt-5.4", "google-antigravity/gemini-3-pro", "asksage-google/google-gemini-2.5-pro"]) expect(isChinaModel(w)).toBe(false);
  });
});

describe("P-IDE.1c - sortGovFirstNewest", () => {
  it("gov models first, each group newest→oldest", () => {
    const models: ModelOption[] = [
      { value: "openai-codex/gpt-5.4", name: "5.4" },
      { value: "asksage-openai/gpt-5.5", name: "gov 5.5" },
      { value: "openai-codex/gpt-5.5", name: "5.5" },
      { value: "asksage-openai/gpt-5.4", name: "gov 5.4" },
    ];
    expect(sortGovFirstNewest(models).map((m) => m.value)).toEqual([
      "asksage-openai/gpt-5.5", "asksage-openai/gpt-5.4", // gov, newest first
      "openai-codex/gpt-5.5", "openai-codex/gpt-5.4",     // then direct, newest first
    ]);
  });
  it("cmpModelsNewestFirst orders versions descending", () => {
    expect(cmpModelsNewestFirst("x/gpt-5.5", "x/gpt-5.4")).toBeLessThan(0);
    expect(cmpModelsNewestFirst("a/claude-opus-4-6", "a/claude-opus-4-8")).toBeGreaterThan(0);
  });
});

describe("MODEL_FAMILIES integrity", () => {
  it("every family has a known icon name", () => {
    const known = new Set(["chat","shield","brain","runs","graph","sliders","search","send","plus","chevron","spark","bolt","close","minus","square","collapse","expand","user","sidebar","folder","git","command","eye","check","info","layout","refresh","copy","download"]);
    for (const f of MODEL_FAMILIES) expect(known.has(f.icon)).toBe(true);
  });
  it("family ids are unique", () => {
    const ids = MODEL_FAMILIES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
