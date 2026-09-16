// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/local_presets.ts - P-LOCAL.4: curated local-model presets + the unified-endpoint helper.
//
// The user self-hosts open-weight models on their own hardware (a Mac Studio M3 Ultra, an NVIDIA DGX Spark)
// and fronts several of them behind ONE secured NGINX port. On LUCID's side that whole rig is a SINGLE Local
// Provider (P-LOCAL.1/.3): one base URL (the NGINX endpoint), bearer/API-key auth in the OS-encrypted vault,
// and MANY models - the OpenAI-compatible `model` field selects which backend NGINX routes to. This module is
// PURE (no DOM/IO): the curated model catalog + the "turn N presets into ONE add-form fill" builder are
// unit-testable and produce values that flow straight through the EXISTING draftFromForm -> validate -> vault
// -> upsert path, so presets add ZERO new secret surface.
//
// Model ids + specs here are EDITORIAL DEFAULTS the user edits to match what their server actually exposes
// (LUCID cannot know your served ids); they exist so a novice gets a working starting point in one click.

import { LOCAL_AUTH_KINDS, type LocalAuthKind, type LocalModelCompat, type LocalModelDef } from "../local_providers.ts";
import type { LpFormInput } from "./local_providers_ui.ts";
import { esc } from "./format.ts";
import { icon } from "./icons.ts";

/** The self-hosting targets the presets are sized against (see docs/LOCAL-MODELS-UNIFIED-ENDPOINT.md). */
export type LocalPlatform = "m3-ultra" | "dgx-spark";
export interface LocalPlatformInfo { id: LocalPlatform; name: string; memoryNote: string }
export const LOCAL_PLATFORMS: LocalPlatformInfo[] = [
  { id: "m3-ultra", name: "Mac Studio M3 Ultra", memoryNote: "up to 512GB unified memory (MLX / GGUF)" },
  { id: "dgx-spark", name: "NVIDIA DGX Spark", memoryNote: "128GB unified (GB10) - CUDA / vLLM / TensorRT-LLM" },
];

export interface LocalModelPreset {
  /** The model id the endpoint serves. EDIT to match your server's id. */
  id: string;
  name: string;
  family: string;
  contextWindow: number;
  reasoning?: boolean;
  vision?: boolean;
  /** Rough size label (editorial), e.g. "~120B MoE". */
  params: string;
  /** Which of the user's boxes this comfortably fits (editorial guidance, quantized). */
  fits: LocalPlatform[];
  /** Wire-shape overrides omp cannot auto-detect from a LAN base URL (see LocalModelCompat). */
  compat?: LocalModelCompat;
  note: string;
}

// Curated, EDITORIAL defaults. The ones the user named come first; the rest are well-known open-weight
// models that fit an M3 Ultra / DGX Spark. Ids/specs are starting points - edit them to your served ids.
export const LOCAL_MODEL_PRESETS: LocalModelPreset[] = [
  {
    id: "glm-5.3-flash", name: "GLM-5.3-Flash", family: "GLM", contextWindow: 131072, reasoning: true,
    params: "flash MoE", fits: ["dgx-spark", "m3-ultra"],
    // vLLM exposes GLM's thinking through the chat template, not a `reasoning_effort` param, and it
    // returns the trace on `reasoning`. omp guesses those from the vendor hostname, which a LAN box
    // never matches, so the preset states them outright or the reasoning stream is dropped.
    compat: { thinkingFormat: "qwen-chat-template", reasoningContentField: "reasoning", supportsReasoningEffort: false },
    note: "Zhipu GLM served by vLLM. Carries the chat-template thinking wire format that a LAN endpoint cannot advertise.",
  },
  { id: "laguna-2.1-poolside", name: "Laguna 2.1 (Poolside)", family: "Poolside", contextWindow: 262144, reasoning: true, params: "large coder", fits: ["m3-ultra", "dgx-spark"], note: "Poolside's coding model - point at your self-hosted Laguna endpoint." },
  { id: "gemma-4", name: "Gemma 4", family: "Gemma", contextWindow: 131072, vision: true, params: "multimodal", fits: ["m3-ultra", "dgx-spark"], note: "Google Gemma - multimodal, efficient, strong open weights." },
  { id: "qwen3.8", name: "Qwen 3.8", family: "Qwen", contextWindow: 262144, reasoning: true, params: "large", fits: ["m3-ultra", "dgx-spark"], note: "Alibaba Qwen - strong multilingual + tool use." },
  { id: "gpt-oss-120b", name: "gpt-oss 120B", family: "gpt-oss", contextWindow: 131072, reasoning: true, params: "~120B MoE", fits: ["m3-ultra"], note: "OpenAI open-weight 120B - needs the M3 Ultra's large unified memory." },
  { id: "deepseek-v3.2", name: "DeepSeek V3.2", family: "DeepSeek", contextWindow: 131072, reasoning: true, params: "~671B MoE", fits: ["m3-ultra"], note: "Large MoE - run a quant that fits your memory budget." },
  { id: "qwen3-coder-30b", name: "Qwen3 Coder 30B", family: "Qwen", contextWindow: 262144, params: "~30B", fits: ["m3-ultra", "dgx-spark"], note: "Compact coder - comfortable on the DGX Spark." },
  { id: "llama-3.3-70b-instruct", name: "Llama 3.3 70B", family: "Llama", contextWindow: 131072, params: "~70B", fits: ["m3-ultra", "dgx-spark"], note: "Meta Llama - solid general-purpose baseline." },
];

/** The presets that comfortably fit a given platform (drives the platform filter in the picker). */
export function presetsForPlatform(platform: LocalPlatform): LocalModelPreset[] {
  return LOCAL_MODEL_PRESETS.filter((p) => p.fits.includes(platform));
}

/** Look up a preset by its (default) model id. */
export function presetById(id: string): LocalModelPreset | undefined {
  return LOCAL_MODEL_PRESETS.find((p) => p.id === id);
}

// A served model id is almost never the editorial id above. vLLM and TGI serve the HuggingFace repo id
// (`zai-org/GLM-5.3-Flash-FP8`), Ollama serves a tagged id (`qwen3-coder:30b`), and the header of this
// file tells the user to EDIT the ids to match their server - at which point an exact-string lookup
// found nothing, the model fell back to omp's 8192-token non-reasoning defaults, and nothing said so.
// So normalize both sides to one key: fold case, drop the `org/` repo prefix, drop a trailing
// quantization/precision/format marker, and erase separators.
const ID_NOISE_TOKENS: readonly string[] = ["latest", "fp8", "fp16", "fp32", "bf16", "int4", "int8", "awq", "gptq", "gguf", "mlx", "4bit", "8bit"];

/** Fold every spelling of one served model onto a single comparison key. */
export function normalizeModelId(id: string): string {
  const base = ((id || "").toLowerCase().split("/").pop() ?? "")
    .replace(/[-_.:]q\d+(?:[-_][a-z0-9]+)*$/, ""); // llama.cpp quant tails: -q4_k_m, :q8_0
  const tokens = base.split(/[^a-z0-9]+/).filter(Boolean);
  while (tokens.length > 1 && ID_NOISE_TOKENS.includes(tokens[tokens.length - 1]!)) tokens.pop();
  return tokens.join("");
}

// A normalized key shorter than this never matches by PREFIX - "qwen" must not claim every Qwen build.
const MIN_PREFIX_KEY = 6;

/** Find the preset whose curated metadata applies to an id the user's endpoint actually serves. Exact
 *  id, then the normalized key, then the longest prefix relationship in EITHER direction, because a
 *  served id both extends the editorial one (`Qwen3-Coder-30B-A3B-Instruct`) and truncates it
 *  (`Llama-3.3-70B`, no `-Instruct`). Longest overlap wins, so a short family key never shadows a more
 *  specific preset. The caller keeps the user's typed id as the WIRE id; only metadata is borrowed.
 *  A served id that resembles nothing here still gets no metadata - by design, since guessing a context
 *  window is worse than omp's conservative default, and the provider row says how many models are on it. */
export function presetForServedId(id: string): LocalModelPreset | undefined {
  const exact = presetById(id);
  if (exact) return exact;
  const key = normalizeModelId(id);
  if (!key) return undefined;
  let best: LocalModelPreset | undefined;
  let bestOverlap = 0;
  for (const p of LOCAL_MODEL_PRESETS) {
    const k = normalizeModelId(p.id);
    if (!k) continue;
    if (k === key) return p;
    const overlap = Math.min(k.length, key.length);
    if (overlap < MIN_PREFIX_KEY || overlap <= bestOverlap) continue;
    if (key.startsWith(k) || k.startsWith(key)) { best = p; bestOverlap = overlap; }
  }
  return best;
}

/** Apply the catalog's curated metadata to a model the user typed OR the endpoint reported. The SERVER
 *  wins on `contextWindow`, because it knows its own window and the catalog only ever guessed; the
 *  catalog supplies what a `/models` list cannot say at all: the display name, reasoning, vision, and
 *  the `compat` wire shape. An id resembling no preset comes back with only its own facts, never
 *  invented ones. ONE function, so the add form and endpoint discovery cannot drift apart. */
export function enrichModelFromCatalog(m: LocalModelDef): LocalModelDef {
  const p = presetForServedId(m.id);
  if (!p) return { ...m, name: m.name?.trim() || m.id };
  const out: LocalModelDef = { ...m, name: m.name?.trim() || p.name, contextWindow: m.contextWindow ?? p.contextWindow };
  if (p.reasoning) out.reasoning = true;
  if (p.vision) out.vision = true;
  if (p.compat) out.compat = p.compat;
  return out;
}

export interface UnifiedEndpointInput {
  name?: string;
  baseUrl: string;
  auth?: LocalAuthKind;
  /** Model ids to serve behind the one endpoint (deduped, order preserved). */
  modelIds: string[];
}

/**
 * Build the add-form fill for ONE Local Provider that fronts several models behind a single (NGINX) base URL.
 * Defaults to bearer auth (the secure default for a shared gateway); the token is entered in the add form and
 * lands in the vault, never here. The result flows through the existing draftFromForm -> validate path.
 */
export function unifiedEndpointForm(inp: UnifiedEndpointInput): LpFormInput {
  const models: string[] = [];
  for (const raw of inp.modelIds) {
    const id = raw.trim();
    if (id && !models.includes(id)) models.push(id);
  }
  const auth: LocalAuthKind = inp.auth && (LOCAL_AUTH_KINDS as string[]).includes(inp.auth) ? inp.auth : "bearer";
  return { name: (inp.name ?? "Unified LLM gateway").trim(), baseUrl: (inp.baseUrl ?? "").trim(), auth, models: models.join(", "), external: false };
}

/** Quick-add preset chips for the Local Providers add form. Clicking a chip appends its model id to the
 *  models field (click several to build one unified endpoint). `platform` filters to what a box can run. */
export function localPresetChipsHtml(platform?: LocalPlatform): string {
  const list = platform ? presetsForPlatform(platform) : LOCAL_MODEL_PRESETS;
  const chips = list.map((p) => {
    const tags = [p.params, p.reasoning ? "reasoning" : "", p.vision ? "vision" : "", `${Math.round(p.contextWindow / 1024)}K ctx`].filter(Boolean).join(" \u00b7 ");
    return `<button type="button" class="lp-preset-chip" data-lp-preset="${esc(p.id)}" title="${esc(p.name)} \u00b7 ${esc(tags)}. ${esc(p.note)}">${esc(p.family)} \u00b7 ${esc(p.name)}</button>`;
  }).join("");
  return `<div class="lp-presets"><div class="lp-presets-lbl">${icon("bolt", 11)} Quick-add a model (click several to serve them behind one endpoint):</div><div class="lp-preset-chips">${chips}</div></div>`;
}
