// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/model_families.test.ts
//
// P-IDE.1 (ADR-0029): the model-picker family classification. The regex ORDER (o-series before
// GPT) and the gateway-prefix robustness are the easy things to break, so they're pinned here.

import { describe, expect, it } from "bun:test";
import { ASKSAGE_FAMILY_ORDER, capabilityTier, cmpModelsByLevel, cmpModelsNewestFirst, DEFAULT_MODEL_PREFERENCE, familyOf, filterModels, groupByFamily, gptVersion, isApiOnlyModel, isAuxiliaryModel, isChinaModel, isDeprecatedModel, isGovModel, MODEL_FAMILIES, preferredDefaultModel, providerLabelOf, recommendFallbacks, sortGovFirstByLevel, topModel, type ModelOption } from "./model_families.ts";

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
    // A brand-new flagship (e.g. Opus 5, released same-day) must NOT be curated out - it surfaces the
    // moment omp's catalog carries it. It is Claude family, not China-origin, and sorts ahead of 4.8.
    expect(isDeprecatedModel("anthropic/claude-opus-5")).toBe(false);
    expect(familyOf("claude-opus-5").id).toBe("claude");
    expect(isChinaModel("anthropic/claude-opus-5")).toBe(false);
    expect(cmpModelsNewestFirst("anthropic/claude-opus-5", "anthropic/claude-opus-4-8")).toBeLessThan(0);
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

describe("sortGovFirstByLevel", () => {
  it("gov models first, each group newest→oldest", () => {
    const models: ModelOption[] = [
      { value: "openai-codex/gpt-5.4", name: "5.4" },
      { value: "asksage-openai/gpt-5.5", name: "gov 5.5" },
      { value: "openai-codex/gpt-5.5", name: "5.5" },
      { value: "asksage-openai/gpt-5.4", name: "gov 5.4" },
    ];
    expect(sortGovFirstByLevel(models).map((m) => m.value)).toEqual([
      "asksage-openai/gpt-5.5", "asksage-openai/gpt-5.4", // gov, newest first
      "openai-codex/gpt-5.5", "openai-codex/gpt-5.4",     // then direct, newest first
    ]);
  });
  it("ranks capability BEFORE version - an older Pro outranks a newer Flash", () => {
    const gem: ModelOption[] = [
      { value: "google-antigravity/gemini-3.5-flash", name: "flash" },
      { value: "google-antigravity/gemini-3.1-pro", name: "pro" },
    ];
    expect(sortGovFirstByLevel(gem).map((m) => m.value)).toEqual([
      "google-antigravity/gemini-3.1-pro", "google-antigravity/gemini-3.5-flash",
    ]);
  });
  it("cmpModelsNewestFirst orders versions descending", () => {
    expect(cmpModelsNewestFirst("x/gpt-5.5", "x/gpt-5.4")).toBeLessThan(0);
    expect(cmpModelsNewestFirst("a/claude-opus-4-6", "a/claude-opus-4-8")).toBeGreaterThan(0);
  });
});

describe("capabilityTier / cmpModelsByLevel / topModel (level ranking)", () => {
  it("flagship=2, balanced=1, small=0; 'gemini' is not mis-read as small", () => {
    expect(capabilityTier("anthropic/claude-fable-5")).toBe(2);
    expect(capabilityTier("anthropic/claude-opus-4-8")).toBe(2);
    expect(capabilityTier("asksage-openai/gpt-5.6-luna")).toBe(2);
    expect(capabilityTier("google-antigravity/gemini-3.1-pro")).toBe(2);
    expect(capabilityTier("anthropic/claude-haiku-4-5")).toBe(0);
    expect(capabilityTier("google-antigravity/gemini-3.5-flash")).toBe(0);
    expect(capabilityTier("asksage-openai/gpt-5-mini")).toBe(0);
  });
  it("cmpModelsByLevel: capability beats version, then newest within a tier", () => {
    expect(cmpModelsByLevel("x/gemini-3.1-pro", "x/gemini-3.5-flash")).toBeLessThan(0); // Pro over newer Flash
    expect(cmpModelsByLevel("x/gpt-5.6-luna", "x/gpt-5.5")).toBeLessThan(0);
    expect(cmpModelsByLevel("a/claude-fable-5", "a/claude-opus-4-8")).toBeLessThan(0);
  });
  it("topModel: highest level within the pool; excludes auxiliary; honors an accept predicate", () => {
    const claude: ModelOption[] = [
      { value: "anthropic/claude-opus-4-8", name: "opus48" },
      { value: "anthropic/claude-fable-5", name: "fable" },
      { value: "anthropic/claude-haiku-4-5", name: "haiku" },
    ];
    expect(topModel(claude)?.value).toBe("anthropic/claude-fable-5");
    const mixed: ModelOption[] = [
      { value: "openai-codex/gpt-5.5", name: "5.5" },
      { value: "asksage-openai/gpt-5.6-luna", name: "gov luna" },
      { value: "openai-codex/codex-auto-review", name: "aux" },
    ];
    expect(topModel(mixed, isGovModel)?.value).toBe("asksage-openai/gpt-5.6-luna");
    expect(topModel([{ value: "openai-codex/codex-auto-review", name: "aux" }])).toBeNull();
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

describe("providerLabelOf", () => {
  it("names AskSage for any gov-routed model", () => {
    expect(providerLabelOf("asksage-openai/gpt-5.6-luna")).toBe("AskSage (gov gateway)");
    expect(providerLabelOf("asksage-anthropic/google-claude-48-opus")).toBe("AskSage (gov gateway)");
  });
  it("names the direct provider for non-gov models", () => {
    expect(providerLabelOf("claude-opus-4-8")).toBe("Anthropic");
    expect(providerLabelOf("gpt-5.5")).toBe("OpenAI");
    expect(providerLabelOf("gemini-2.5-pro")).toBe("Google");
  });
});

describe("recommendFallbacks (P-NORESP.1)", () => {
  // A realistic gov picker + one commercial model that must NEVER be recommended for a gov failure.
  const models: ModelOption[] = [
    { value: "asksage-openai/gpt-5.6-luna", name: "GPT-5.6 Luna · Gov" },
    { value: "asksage-openai/gpt-5.6-sol", name: "GPT-5.6 Sol · Gov" },
    { value: "asksage-openai/gpt-5.5", name: "GPT-5.5 · Gov" },
    { value: "asksage-openai/gpt-5.4", name: "GPT-5.4 · Gov" },
    { value: "asksage-anthropic/google-claude-48-opus", name: "Claude 4.8 Opus · Gov" },
    { value: "asksage-google/google-gemini-3.1-pro-com", name: "Gemini 3.1 Pro · Gov" },
    { value: "claude-opus-4-8", name: "Claude 4.8 Opus (commercial)" },
  ];

  it("recommends the HIGHEST-LEVEL sibling (another 5.6 tier, not 5.5) + a cross-provider equivalent (Claude)", () => {
    const r = recommendFallbacks("asksage-openai/gpt-5.6-luna", models);
    expect(r.sameFamily?.value).toBe("asksage-openai/gpt-5.6-sol");        // keep the 5.6 ceiling, don't drop to 5.5
    expect(r.otherProvider?.value).toBe("asksage-anthropic/google-claude-48-opus"); // Claude = different pool
  });

  it("recommends Claude 4.8 Opus (gov) when Fable 5 (gov) fails — the '48' id outranks the '5' siblings", () => {
    const r = recommendFallbacks("asksage-anthropic/google-claude-fable-5", models);
    expect(r.sameFamily?.value).toBe("asksage-anthropic/google-claude-48-opus"); // drop to 4.8 Opus, same family
    expect(r.otherProvider?.value).toBe("asksage-openai/gpt-5.6-luna");           // GPT = another provider
  });

  it("stays gov-routed — never crosses to a commercial model for a gov failure (lockdown-safe)", () => {
    const r = recommendFallbacks("asksage-openai/gpt-5.6-luna", models);
    expect(isGovModel(r.sameFamily!.value)).toBe(true);
    expect(isGovModel(r.otherProvider!.value)).toBe(true);
    expect(r.otherProvider?.value).not.toBe("claude-opus-4-8");
  });

  it("falls back to a same-family sibling when no lower version exists", () => {
    // Only 5.6 tiers present → no lower version → the other 5.6 tier is offered.
    const r = recommendFallbacks("asksage-openai/gpt-5.6-luna", [
      { value: "asksage-openai/gpt-5.6-luna", name: "luna" },
      { value: "asksage-openai/gpt-5.6-sol", name: "sol" },
    ]);
    expect(r.sameFamily?.value).toBe("asksage-openai/gpt-5.6-sol");
    expect(r.otherProvider).toBeNull(); // no other family available
  });

  it("returns nulls when nothing suitable is accessible", () => {
    const r = recommendFallbacks("gpt-5.6", [{ value: "gpt-5.6", name: "only me" }]);
    expect(r.sameFamily).toBeNull();
    expect(r.otherProvider).toBeNull();
  });
});

// ── P-MODEL.2: version-aware tiering + the curated fresh-install default ─────────────────────

describe("P-MODEL.2 - capabilityTier is version-aware for GPT", () => {
  it("ranks a brand-new GPT flagship by VERSION, not by a hardcoded `gpt-5` substring", () => {
    expect(capabilityTier("openai-codex/gpt-6-astra")).toBe(2); // the bug: this used to score 1 (balanced)
    expect(capabilityTier("openai-codex/gpt-7")).toBe(2);       // and the next one needs no edit here
    expect(capabilityTier("asksage-openai/gpt-5.6-luna")).toBe(2);
    expect(capabilityTier("asksage-openai/gpt-4.1")).toBe(1);   // below 5 stays balanced
  });
  it("keeps the small-model test FIRST, so the mini/nano tier of a new flagship is still 0", () => {
    expect(capabilityTier("openai-codex/gpt-6-mini")).toBe(0);
    expect(capabilityTier("openai-codex/gpt-6-nano")).toBe(0);
    expect(capabilityTier("google-antigravity/gemini-3.1-pro")).toBe(2); // `\bmini` never eats "ge·mini"
  });
  it("absorbs the tokens startup_model's deleted private copy knew: grok flagship, spark small", () => {
    expect(capabilityTier("xai/grok-4")).toBe(2);
    expect(capabilityTier("iflytek/spark-4-ultra")).toBe(0); // small test runs first, ultra does not rescue it
  });
});

describe("P-MODEL.2 - the 2026 flagships survive curation", () => {
  it("gpt-6 / opus-5 / fable-5.1 / mythos-5.1 are NOT deprecated", () => {
    for (const v of ["openai-codex/gpt-6-astra", "anthropic/claude-opus-5", "anthropic/claude-fable-5-1", "anthropic/claude-mythos-5-1"]) {
      expect(isDeprecatedModel(v)).toBe(false);
    }
  });
  it("fable-5-1 is not caught by the legacy claude-*-4-[01] rule (the family names differ)", () => {
    expect(isDeprecatedModel("anthropic/claude-fable-5-1")).toBe(false);
    expect(isDeprecatedModel("anthropic/claude-opus-4-1")).toBe(true); // the rule still bites where it should
  });
  it("gpt-6 lands in the GPT family, never o-series (`gpt-o\\d` must not capture `gpt-6`)", () => {
    expect(familyOf("gpt-6-astra").id).toBe("gpt");
    expect(familyOf("openai-codex/gpt-6-astra").id).toBe("gpt");
    expect(familyOf("gpt-o4-mini").id).toBe("gpt-o"); // the o-series bucket still wins where it should
  });
});

describe("P-MODEL.2 - isApiOnlyModel (billed as credits, not plan-included)", () => {
  it("true for the Fable and Mythos families", () => {
    expect(isApiOnlyModel("anthropic/claude-fable-5-1")).toBe(true);
    expect(isApiOnlyModel("anthropic/claude-mythos-5-1")).toBe(true);
    expect(isApiOnlyModel("claude-fable-5")).toBe(true);
    // A pure id test: the gov copy matches too, so billing UI pairs it with !isGovModel.
    expect(isApiOnlyModel("asksage-anthropic/google-claude-fable-5")).toBe(true);
  });
  it("false for plan-included models", () => {
    for (const v of ["anthropic/claude-opus-5", "anthropic/claude-opus-4-8", "anthropic/claude-sonnet-4-6",
                     "openai-codex/gpt-6-astra", "google-antigravity/gemini-3.1-pro"]) {
      expect(isApiOnlyModel(v)).toBe(false);
    }
  });
});

describe("P-MODEL.2 - preferredDefaultModel (the curated fresh-install default)", () => {
  const mk = (...values: string[]): ModelOption[] => values.map((value) => ({ value, name: value }));

  it("picks Opus 5 out of a mixed Anthropic list", () => {
    const got = preferredDefaultModel(mk("anthropic/claude-opus-4-8", "anthropic/claude-sonnet-4-6", "anthropic/claude-opus-5"));
    expect(got?.value).toBe("anthropic/claude-opus-5");
  });
  it("a bigger version digit does not win across families: Opus 5 beats gpt-6-astra by LIST ORDER", () => {
    expect(preferredDefaultModel(mk("openai-codex/gpt-6-astra", "anthropic/claude-opus-5"))?.value).toBe("anthropic/claude-opus-5");
    expect(preferredDefaultModel(mk("anthropic/claude-opus-5", "openai-codex/gpt-6-astra"))?.value).toBe("anthropic/claude-opus-5"); // input order is irrelevant
  });
  it("returns gpt-6-astra when no Claude is offered", () => {
    const got = preferredDefaultModel(mk("openai-codex/gpt-6-astra", "openai-codex/gpt-5.5", "google-antigravity/gemini-3.1-pro"));
    expect(got?.value).toBe("openai-codex/gpt-6-astra");
  });
  it("respects the accept predicate (an unconfigured provider is invisible)", () => {
    const got = preferredDefaultModel(mk("anthropic/claude-opus-5", "openai-codex/gpt-6-astra"), (v) => v.startsWith("openai-codex/"));
    expect(got?.value).toBe("openai-codex/gpt-6-astra");
  });
  it("skips deprecated, China-origin, RAG and auxiliary entries", () => {
    const got = preferredDefaultModel(mk(
      "openai-codex/gpt-5.1-codex-max", "deepseek/deepseek-v3", "asksage-query/rag",
      "openai-codex/codex-auto-review", "anthropic/claude-fable-5"));
    expect(got?.value).toBe("anthropic/claude-fable-5");
  });
  it("prefers the direct route over a gov copy of the SAME curated entry", () => {
    const got = preferredDefaultModel(mk("asksage-anthropic/google-claude-fable-5", "anthropic/claude-fable-5"));
    expect(got?.value).toBe("anthropic/claude-fable-5");
  });
  it("falls back to the highest-LEVEL survivor when nothing curated is on offer", () => {
    expect(preferredDefaultModel(mk("myserver/llama-3.3-70b", "myserver/llama-3.3-8b"))?.value).toBe("myserver/llama-3.3-70b");
  });
  it("returns null on an empty list and when every option is filtered out", () => {
    expect(preferredDefaultModel([])).toBeNull();
    expect(preferredDefaultModel(mk("deepseek/deepseek-v3", "asksage-query/rag"))).toBeNull();
  });
  it("no curated entry can ever select a small/fast model", () => {
    for (const pat of DEFAULT_MODEL_PREFERENCE) {
      for (const small of ["claude-opus-5-mini", "gpt-6-mini", "gpt-6-nano", "gpt-5.6-mini", "gemini-3.1-pro-lite", "claude-fable-5-lite"]) {
        expect(pat.test(small)).toBe(false);
      }
    }
    expect(preferredDefaultModel(mk("openai-codex/gpt-6-mini", "openai-codex/gpt-6-astra"))?.value).toBe("openai-codex/gpt-6-astra");
  });
});
