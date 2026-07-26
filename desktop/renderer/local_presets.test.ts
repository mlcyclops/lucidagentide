// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Local-model presets + the unified-endpoint builder (local_presets.ts). The load-bearing property: a set of
// presets turns into ONE valid multi-model Local Provider that flows through the REAL draftFromForm -> validate
// path (so presets reuse the proven add/vault/upsert flow and add no new secret surface).

import { describe, expect, it } from "bun:test";
import { draftFromForm } from "./local_providers_ui.ts";
import { LOCAL_MODEL_PRESETS, localPresetChipsHtml, presetById, presetsForPlatform, unifiedEndpointForm } from "./local_presets.ts";

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
