// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Increment P-LOCAL.4 - local-model presets + the unified secure endpoint. Proves, against the REAL pure
// layer, that a set of one-click presets becomes ONE Local Provider that fronts many models behind a single
// (NGINX) base URL, flowing through the SAME draftFromForm -> validate path P-LOCAL.3 already ships.
//
// Run: bun run desktop/scripts/demo_p_local_4.ts

import { draftFromForm } from "../renderer/local_providers_ui.ts";
import { LOCAL_MODEL_PRESETS, localPresetChipsHtml, presetById, presetsForPlatform, unifiedEndpointForm } from "../renderer/local_presets.ts";

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? "  ok " : "FAIL "} ${label}`);
  if (!ok) failures++;
}

console.log("== P-LOCAL.4 - local presets + unified secure endpoint ==");

// (1) the models the user named are present, and Gemma carries NO "MoE" term.
check("Laguna 2.1 Poolside preset present", !!presetById("laguna-2.1-poolside"));
check("Qwen 3.8 preset present", !!presetById("qwen3.8"));
const gemma = presetById("gemma-4");
check("Gemma 4 preset present under id gemma-4", !!gemma);
check("Gemma carries NO 'MoE' term (name or params)", !!gemma && !/moe/i.test(gemma.name) && !/moe/i.test(gemma.params));

// (2) platform sizing: the 120B fits the M3 Ultra, not the smaller DGX Spark.
check("gpt-oss-120b fits M3 Ultra", presetsForPlatform("m3-ultra").some((p) => p.id === "gpt-oss-120b"));
check("gpt-oss-120b does NOT fit the DGX Spark", !presetsForPlatform("dgx-spark").some((p) => p.id === "gpt-oss-120b"));

// (3) several presets -> ONE unified provider behind one base URL, bearer by default, deduped.
const form = unifiedEndpointForm({
  name: "Home lab", baseUrl: "https://studio.local:8443/v1",
  modelIds: ["laguna-2.1-poolside", "gemma-4", "qwen3.8", "gemma-4"], // dup on purpose
});
check("unified endpoint defaults to bearer auth (secure shared gateway)", form.auth === "bearer");
check("models deduped + order preserved", form.models === "laguna-2.1-poolside, gemma-4, qwen3.8");

// (4) the fill flows through the REAL P-LOCAL.3 validator into a multi-model provider.
const { def, errors, needsKey } = draftFromForm(form, Date.now());
check("draftFromForm validates the unified provider (no errors)", errors.length === 0 && !!def);
check("ONE provider fronts all three models", !!def && def.models.map((m) => m.id).join(",") === "laguna-2.1-poolside,gemma-4,qwen3.8");
check("bearer auth requires a token (goes to the vault)", needsKey === true);
check("a malformed base URL is rejected fail-closed", draftFromForm(unifiedEndpointForm({ baseUrl: "not-a-url", modelIds: ["qwen3.8"] }), 1).errors.length > 0);

// (5) the add-form quick-fill chips carry each preset's model id.
const chips = localPresetChipsHtml();
check("a quick-add chip exists for every preset", LOCAL_MODEL_PRESETS.every((p) => chips.includes(`data-lp-preset="${p.id}"`)));

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
