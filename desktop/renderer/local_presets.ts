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

import { LOCAL_AUTH_KINDS, type LocalAuthKind } from "../local_providers.ts";
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
  note: string;
}

// Curated, EDITORIAL defaults. The three the user named come first; the rest are well-known open-weight
// models that fit an M3 Ultra / DGX Spark. Ids/specs are starting points - edit them to your served ids.
export const LOCAL_MODEL_PRESETS: LocalModelPreset[] = [
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
    return `<button type="button" class="lp-preset-chip" data-lp-preset="${esc(p.id)}" title="${esc(p.name)} \u2014 ${esc(tags)}. ${esc(p.note)}">${esc(p.family)} \u00b7 ${esc(p.name)}</button>`;
  }).join("");
  return `<div class="lp-presets"><div class="lp-presets-lbl">${icon("bolt", 11)} Quick-add a model (click several to serve them behind one endpoint):</div><div class="lp-preset-chips">${chips}</div></div>`;
}
