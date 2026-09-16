// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Increment P-LOCAL.5 - GLM-5.3-Flash on a self-hosted vLLM box, and the preset attributes that never
// arrived. Proves, against the REAL pure layer, that clicking a preset chip now produces an omp model
// entry carrying the CURATED metadata (context window, reasoning, vision) plus, for a reasoning model
// served off a LAN address, the `compat` wire shape omp cannot infer from the hostname.
//
// Before this increment draftFromForm reduced every model to `{ id, name: id }`, so Laguna's curated
// 262144-token window silently became omp's 8192 default and no preset could ever be a reasoning model.
//
// Run: bun run desktop/scripts/demo_p_local_5.ts

import { draftFromForm } from "../renderer/local_providers_ui.ts";
import { LOCAL_MODEL_PRESETS, localPresetChipsHtml, presetById, presetsForPlatform, unifiedEndpointForm } from "../renderer/local_presets.ts";
import { sanitizeModelCompat, toOmpProviderEntry, toOmpRuntimeOverlay } from "../local_providers.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? "  ok " : "FAIL "} ${label}`);
  if (!ok) failures++;
}

console.log("== P-LOCAL.5 - GLM-5.3-Flash on vLLM, with the preset metadata that used to be dropped ==");

// The user's rig: GLM-5.3-Flash served by vLLM on the 2x DGX Spark, reached over the LAN.
const SPARK = "http://10.0.0.21:8000/v1";

// (1) the preset exists and is sized for the box it runs on.
const glm = presetById("glm-5.3-flash");
check("GLM-5.3-Flash preset present", !!glm);
check("GLM fits the DGX Spark", !!glm && glm.fits.includes("dgx-spark"));
check("GLM is offered when filtering to the DGX Spark", presetsForPlatform("dgx-spark").some((p) => p.id === "glm-5.3-flash"));
check("GLM has a quick-add chip in the add form", localPresetChipsHtml().includes('data-lp-preset="glm-5.3-flash"'));

// (2) the whole chain: chip -> add form -> validate -> the omp provider entry LUCID writes to models.yml.
const form = unifiedEndpointForm({ name: "DGX Spark", baseUrl: SPARK, modelIds: ["glm-5.3-flash", "laguna-2.1-poolside", "gemma-4", "my-private-finetune"] });
const { def, errors, needsKey } = draftFromForm(form, Date.now());
check("the form validates into one multi-model provider", errors.length === 0 && !!def);
check("bearer auth requires a token (the box answers 401 without one; the token lives in the vault)", needsKey === true);

const entry = toOmpProviderEntry(def!, "vault-token");
const model = (id: string) => entry.models.find((m) => m.id === id)!;

// (3) THE REGRESSION THIS INCREMENT FIXES: curated attributes reach omp instead of its defaults.
const laguna = model("laguna-2.1-poolside");
check("Laguna keeps its curated 262144 context window (was 8192 before P-LOCAL.5)", laguna.contextWindow === 262144);
check("Laguna is marked a reasoning model (was false before P-LOCAL.5)", laguna.reasoning === true);
check("Laguna gets its display name, not its raw id", laguna.name === "Laguna 2.1 (Poolside)");
check("Gemma's vision becomes image input", JSON.stringify(model("gemma-4").input) === '["text","image"]');

// (4) a hand-typed id is left exactly as typed - the catalog never invents metadata for it.
const custom = model("my-private-finetune");
check("a hand-typed model id keeps the conservative defaults", custom.contextWindow === 8192 && custom.reasoning === false);
check("a hand-typed model id gets no compat", custom.compat === undefined);

// (5) GLM's wire shape. omp derives these from the base URL, and a 10.x address matches no vendor,
//     so without an explicit compat the thinking request is malformed and the trace is dropped.
const glmEntry = model("glm-5.3-flash");
check("GLM is a reasoning model", glmEntry.reasoning === true);
check("GLM thinking goes through the chat template", glmEntry.compat?.thinkingFormat === "qwen-chat-template");
check("GLM's trace is read off the `reasoning` field", glmEntry.compat?.reasoningContentField === "reasoning");
check("GLM does not advertise a reasoning_effort param (vLLM rejects it)", glmEntry.compat?.supportsReasoningEffort === false);
check("a preset with no wire quirks emits no compat key at all", !("compat" in model("gemma-4")));

// (5b) THE ID THE BOX ACTUALLY SERVES. The catalog's ids are editorial and this file tells the user to
//      edit them to match their server, so an exact-string lookup made following that instruction the
//      one thing that lost the metadata again: vLLM serves the HuggingFace repo id, Ollama serves a tag.
const servedIds = ["zai-org/GLM-5.3-Flash-FP8", "Qwen/Qwen3-Coder-30B-A3B-Instruct", "llama-3.3-70b", "gemma-4:latest", "totally-bespoke-merge-v9"];
const servedDraft = draftFromForm(unifiedEndpointForm({ name: "Spark served ids", baseUrl: SPARK, modelIds: servedIds }), Date.now());
const servedEntry = toOmpProviderEntry(servedDraft.def!, "vault-token");
const served = (id: string) => servedEntry.models.find((m) => m.id === id)!;
check("the repo-id spelling is kept EXACTLY as the wire id", !!served("zai-org/GLM-5.3-Flash-FP8"));
check("a quantized repo id still picks up GLM's compat", served("zai-org/GLM-5.3-Flash-FP8").compat?.thinkingFormat === "qwen-chat-template");
check("an MoE variant suffix still finds the Qwen3 Coder preset", served("Qwen/Qwen3-Coder-30B-A3B-Instruct").contextWindow === 262144);
check("a TRUNCATED id (no -Instruct) still finds Llama 3.3 70B", served("llama-3.3-70b").contextWindow === 131072);
check("an Ollama :latest tag still finds Gemma's vision", JSON.stringify(served("gemma-4:latest").input) === '["text","image"]');
check("a genuinely unknown id borrows nothing (guessing a context window is worse than the default)",
  served("totally-bespoke-merge-v9").contextWindow === 8192 && served("totally-bespoke-merge-v9").compat === undefined);

// (6) fail-closed on the emitter: omp drops the ENTIRE models.yml on one bad value, which would take
//     every other local provider down with it, so an out-of-enum value is discarded, never forwarded.
check("an out-of-enum thinkingFormat is dropped", sanitizeModelCompat({ thinkingFormat: "glm-native" } as never) === undefined);
check("a non-boolean supportsReasoningEffort is dropped, valid siblings survive",
  JSON.stringify(sanitizeModelCompat({ supportsReasoningEffort: "yes", reasoningContentField: "reasoning" } as never)) === '{"reasoningContentField":"reasoning"}');
check("an empty compat collapses away rather than emitting `compat: {}`", sanitizeModelCompat({}) === undefined);

// (6b) persistence. `upsertLocalProvider` rebuilds a CLEAN copy field by field so no pasted secret can
//      ride along, which means any declaration field it forgets is lost on save. That is the subtle half
//      of this increment: enriched in the form, right in the preview, and gone after the next restart.
const scratch = mkdtempSync(join(tmpdir(), "lucid-plocal5-"));
process.env.LUCID_GUI_SETTINGS_FILE = join(scratch, "gui.json");
try {
  const store = await import("../settings_store.ts");
  store.upsertLocalProvider({ ...def!, vaultRef: "cred_spark_001", models: [...def!.models, { id: "junk", compat: { thinkingFormat: "glm-native" } as never }] });
  const stored = store.listLocalProviders()[0]!.models;
  const storedGlm = stored.find((m) => m.id === "glm-5.3-flash")!;
  check("compat survives the save/reload round trip", storedGlm.compat?.thinkingFormat === "qwen-chat-template");
  check("the curated context window survives the save too", storedGlm.contextWindow === 131072);
  check("an out-of-enum compat value never reaches disk", stored.find((m) => m.id === "junk")!.compat === undefined);

  // (6c) and the seam this demo originally skipped: models.yml is built from the STORED def by
  //      toOmpRuntimeOverlay at every omp launch, never from the in-memory draft. Asserting the draft
  //      alone is exactly how a green demo can sit on top of a metadata-losing save (ADR-0303).
  const rt = toOmpRuntimeOverlay(store.listLocalProviders(), new Set(["cred_spark_001"]));
  const prov = rt.overlay.providers["dgx_spark"];
  check("the stored provider reaches the runtime overlay", !!prov && rt.included.includes("dgx_spark"));
  check("compat reaches models.yml THROUGH the store, not just the draft",
    prov?.models.find((m) => m.id === "glm-5.3-flash")?.compat?.thinkingFormat === "qwen-chat-template");
  check("the secret is still referenced by env var name, never inlined", prov?.apiKey === "LUCID_LP_DGX_SPARK_KEY");
} finally {
  delete process.env.LUCID_GUI_SETTINGS_FILE;
  rmSync(scratch, { recursive: true, force: true });
}

// (7) AGENTS.md: no em dashes in UI strings, and the chip tooltip is built from every preset's note.
check("no preset text contains an em dash", LOCAL_MODEL_PRESETS.every((p) => !`${p.name}${p.note}${p.params}`.includes("\u2014")));
check("the rendered chip strip contains no em dash", !localPresetChipsHtml().includes("\u2014"));

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
