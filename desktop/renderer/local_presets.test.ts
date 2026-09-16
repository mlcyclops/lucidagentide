// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Local-model presets + the unified-endpoint builder (local_presets.ts). The load-bearing property: a set of
// presets turns into ONE valid multi-model Local Provider that flows through the REAL draftFromForm -> validate
// path (so presets reuse the proven add/vault/upsert flow and add no new secret surface).

import { describe, expect, it } from "bun:test";
import { draftFromForm } from "./local_providers_ui.ts";
import { LOCAL_MODEL_PRESETS, localPresetChipsHtml, normalizeModelId, presetById, presetForServedId, presetsForPlatform, unifiedEndpointForm } from "./local_presets.ts";
import { toOmpProviderEntry } from "../local_providers.ts";

describe("local model presets", () => {
  it("includes the models the user named", () => {
    for (const id of ["laguna-2.1-poolside", "gemma-4", "qwen3.8"]) {
      expect(presetById(id), id).toBeDefined();
    }
  });

  it("every preset has usable metadata", () => {
    for (const p of LOCAL_MODEL_PRESETS) {
      expect(p.id.length).toBeGreaterThan(0);
      expect(p.contextWindow).toBeGreaterThan(0);
      expect(p.fits.length).toBeGreaterThan(0);
    }
  });

  it("filters by platform capacity (the 120B fits the M3 Ultra, not the smaller DGX Spark)", () => {
    const ultra = presetsForPlatform("m3-ultra").map((p) => p.id);
    const spark = presetsForPlatform("dgx-spark").map((p) => p.id);
    expect(ultra).toContain("gpt-oss-120b");
    expect(spark).not.toContain("gpt-oss-120b");
    expect(spark).toContain("qwen3-coder-30b");
  });
});

describe("unifiedEndpointForm", () => {
  it("groups several models behind one endpoint, deduped + order-preserved, bearer by default", () => {
    const f = unifiedEndpointForm({ baseUrl: "https://studio.local:8443/v1", modelIds: ["laguna-2.1-poolside", "gemma-4-moe", "laguna-2.1-poolside", "qwen3.8"] });
    expect(f.auth).toBe("bearer");
    expect(f.models).toBe("laguna-2.1-poolside, gemma-4-moe, qwen3.8"); // dedupe + order
    expect(f.external).toBe(false);
  });

  it("produces a fill that the REAL draftFromForm validates into a multi-model provider", () => {
    const f = unifiedEndpointForm({ name: "Home lab", baseUrl: "https://studio.local:8443/v1", modelIds: ["gemma-4", "qwen3.8"] });
    const { def, errors, needsKey } = draftFromForm(f, 1_700_000_000_000);
    expect(errors).toEqual([]);
    expect(def).toBeDefined();
    expect(def!.models.map((m) => m.id)).toEqual(["gemma-4", "qwen3.8"]);
    expect(def!.baseUrl).toBe("https://studio.local:8443/v1");
    expect(def!.authKind).toBe("bearer");
    expect(needsKey).toBe(true); // bearer => a token is required (goes to the vault)
  });

  it("rejects an invalid base URL fail-closed (through the real validator)", () => {
    const f = unifiedEndpointForm({ baseUrl: "not-a-url", modelIds: ["qwen3.8"] });
    expect(draftFromForm(f, 1).errors.length).toBeGreaterThan(0);
  });
});

describe("localPresetChipsHtml", () => {
  it("emits a clickable chip per preset carrying its model id", () => {
    const html = localPresetChipsHtml();
    expect(html).toContain('data-lp-preset="laguna-2.1-poolside"');
    expect(html).toContain('data-lp-preset="qwen3.8"');
    for (const p of LOCAL_MODEL_PRESETS) expect(html).toContain(`data-lp-preset="${p.id}"`);
  });

  it("scopes to a platform when asked", () => {
    const spark = localPresetChipsHtml("dgx-spark");
    expect(spark).not.toContain('data-lp-preset="gpt-oss-120b"');
    expect(spark).toContain('data-lp-preset="qwen3-coder-30b"');
  });
});

// ── P-LOCAL.5: preset attributes must survive the whole way to models.yml ────────────────────────
// The chip only writes an id into the models field. Everything else the catalog knows has to be
// recovered in draftFromForm, or omp silently substitutes its own defaults (8192 ctx, no reasoning)
// and the curated numbers are decorative. These tests exercise the REAL chain, not the catalog alone.

/** The REAL chain a chip click travels: quick-add fill -> draftFromForm -> validate -> the omp entry. */
const chipsToProvider = (ids: string[]) => {
  const f = unifiedEndpointForm({ name: "Spark", baseUrl: "http://10.0.0.21:8000/v1", modelIds: ids });
  const { def, errors } = draftFromForm(f, 1_700_000_000_000);
  expect(errors).toEqual([]);
  return toOmpProviderEntry(def!, "tok");
};

describe("preset attributes reach the omp overlay", () => {
  it("carries the curated context window instead of omp's 8192 default", () => {
    const [m] = chipsToProvider(["laguna-2.1-poolside"]).models;
    expect(m!.contextWindow).toBe(262144); // regression: this was 8192 before P-LOCAL.5
    expect(m!.reasoning).toBe(true);
    expect(m!.name).toBe("Laguna 2.1 (Poolside)");
  });

  it("carries vision as image input for a multimodal preset", () => {
    expect(chipsToProvider(["gemma-4"]).models[0]!.input).toEqual(["text", "image"]);
  });

  it("leaves a hand-typed id untouched (no preset, no invention)", () => {
    const m = chipsToProvider(["my-private-finetune"]).models[0]!;
    expect(m.contextWindow).toBe(8192);
    expect(m.reasoning).toBe(false);
    expect(m.compat).toBeUndefined();
  });

  it("emits GLM's chat-template wire shape, which omp cannot infer from a LAN address", () => {
    const m = chipsToProvider(["glm-5.3-flash"]).models[0]!;
    expect(m.reasoning).toBe(true);
    expect(m.compat).toEqual({
      thinkingFormat: "qwen-chat-template",
      reasoningContentField: "reasoning",
      supportsReasoningEffort: false,
    });
  });

  it("omits compat entirely for presets that do not need one", () => {
    expect(chipsToProvider(["llama-3.3-70b-instruct"]).models[0]!).not.toHaveProperty("compat");
  });
});

describe("GLM-5.3-Flash preset", () => {
  it("is offered and fits the DGX Spark the user serves it from", () => {
    const p = presetById("glm-5.3-flash");
    expect(p).toBeDefined();
    expect(p!.fits).toContain("dgx-spark");
    expect(presetsForPlatform("dgx-spark").map((x) => x.id)).toContain("glm-5.3-flash");
  });

  it("has a chip in the add form", () => {
    expect(localPresetChipsHtml()).toContain('data-lp-preset="glm-5.3-flash"');
  });
});

// ── P-LOCAL.5: the id the endpoint actually serves ───────────────────────────────────────────────
// The catalog ids are editorial and the module header tells the user to edit them to match their
// server. With an exact-string lookup, DOING THAT was the one action that silently dropped every
// curated attribute back to omp's defaults - no error, no hint. So the metadata is matched on a
// normalized key instead, while the user's typed id stays the wire id.

describe("presetForServedId", () => {
  it("folds the spellings a real server uses onto one key", () => {
    expect(normalizeModelId("zai-org/GLM-5.3-Flash-FP8")).toBe("glm53flash"); // HF repo + precision tag
    expect(normalizeModelId("gemma-4:latest")).toBe("gemma4");                // Ollama tag
    expect(normalizeModelId("Gemma_4")).toBe("gemma4");                       // separator noise
    expect(normalizeModelId("glm-5.3-flash-q4_k_m")).toBe("glm53flash");      // llama.cpp quant tail
    expect(normalizeModelId("")).toBe("");
  });

  it("matches a repo id, a variant suffix, and a truncated id", () => {
    expect(presetForServedId("zai-org/GLM-5.3-Flash-FP8")?.id).toBe("glm-5.3-flash");
    expect(presetForServedId("Qwen/Qwen3-Coder-30B-A3B-Instruct")?.id).toBe("qwen3-coder-30b"); // extends
    expect(presetForServedId("llama-3.3-70b")?.id).toBe("llama-3.3-70b-instruct");              // truncates
    expect(presetForServedId("gemma-4:latest")?.id).toBe("gemma-4");
  });

  it("refuses to guess: an unrelated id and a too-short family fragment match nothing", () => {
    expect(presetForServedId("totally-bespoke-merge-v9")).toBeUndefined();
    expect(presetForServedId("qwen")).toBeUndefined(); // 4 chars: must not claim every Qwen build
    expect(presetForServedId("")).toBeUndefined();
  });

  it("gives the longest match, so a family key never shadows a specific preset", () => {
    // both "qwen3.8" and "qwen3-coder-30b" are Qwen presets; the coder id is the longer overlap.
    expect(presetForServedId("qwen3-coder-30b-instruct")?.id).toBe("qwen3-coder-30b");
  });

  it("keeps the served id as the WIRE id while borrowing only metadata", () => {
    const m = chipsToProvider(["zai-org/GLM-5.3-Flash-FP8"]).models[0]!;
    expect(m.id).toBe("zai-org/GLM-5.3-Flash-FP8"); // what the request must say
    expect(m.contextWindow).toBe(131072);
    expect(m.compat?.thinkingFormat).toBe("qwen-chat-template");
  });
});

// AGENTS.md forbids the em dash in UI strings. The chip tooltip is a UI string built from every
// preset's note, so the catalog and its renderer are both checked rather than trusted.
it("no preset text or rendered chip contains an em dash", () => {
  for (const p of LOCAL_MODEL_PRESETS) {
    expect(`${p.name} ${p.note} ${p.params}`, p.id).not.toContain("\u2014");
  }
  expect(localPresetChipsHtml()).not.toContain("\u2014");
});
