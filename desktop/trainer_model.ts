// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/trainer_model.ts - P-TRAINER (ADR-0252): which of the user's CONFIGURED models runs the
// trainer's distillation and question generation.
//
// The trainer must work with WHATEVER the user has configured - a flagship, a workhorse, a flash-class
// model, a local Ollama build, or the AskSage gov gateway - never with a hardcoded id. This PURE module
// is the resolver (the ADR-0250 resolveStartupModel / ADR-0251 resolveConversationModel pattern, same
// inputs, same "matched against the ACCESSIBLE picker options" rule):
//   1. If the CURRENT model is trainer-capable, keep it - never force a switch that gains nothing.
//   2. Else pick the best capable candidate: distillation wants structured-output reliability, so the
//      ranking is capability-tier first (flagship > workhorse > fast/small), direct route over the gov
//      gateway on ties, then newest.
//   3. Tiny/fast models are still ELIGIBLE (they may be all an air-gapped user has) - they rank last,
//      they are never excluded. Only non-chat routes are excluded: auxiliary (tab/jump/review), RAG,
//      embedding/audio/image routes, deprecated ids, and sovereignty-gated China-origin models (those
//      stay a deliberate manual pick, mirroring ADR-0250).
// The distiller side holds the other half of the guarantee: lenient-but-validated parsing plus one
// corrective retry, so a weaker model's prose-wrapped JSON still lands (harness/trainer/distiller.ts).

import { cmpModelsNewestFirst, isAuxiliaryModel, isChinaModel, isDeprecatedModel, isGovModel } from "./renderer/model_families.ts";
import type { ModelOption } from "./checker_model.ts";

/** Non-chat routes the trainer can never run on (no structured chat completion). */
export function isNonChatRoute(value: string): boolean {
  return /(^|\/)rag$/i.test(value) || /embed|whisper|-tts|audio|image|vision-only/i.test(value);
}

/** Capability tier for distillation: 3 flagship, 2 workhorse (default), 1 fast/small. Mirrors the
 *  ADR-0250 ranking (`\bmini` so "gemini" never reads as a mini). */
export function trainerTier(value: string): number {
  const s = value.toLowerCase();
  if (/\bmini|nano|lite|flash|haiku|oss|spark|-8b|-7b/.test(s)) return 1;
  if (/opus|fable|mythos|ultra|-max\b|\bpro\b|-pro\b|gpt-5|gpt-o|grok/.test(s)) return 3;
  return 2;
}

/** A model the trainer can run on at all (any tier). */
export function isTrainerCapable(value: string): boolean {
  return !isNonChatRoute(value) && !isAuxiliaryModel(value) && !isDeprecatedModel(value) && !isChinaModel(value);
}

export interface TrainerModelPick {
  value: string;
  tier: number;
  source: "current" | "best-configured";
}

/**
 * Resolve the model a trainer session should run on. Null = nothing accessible qualifies (the caller
 * surfaces the provider checklist instead of starting a session that cannot distill).
 * `isConfigured` mirrors ADR-0250: unknown providers return true - they only exist because the user
 * configured them (a local Ollama build is exactly as legitimate as a cloud flagship here).
 */
export function resolveTrainerModel(
  options: readonly ModelOption[],
  current: string,
  isConfigured: (value: string) => boolean = () => true,
): TrainerModelPick | null {
  if (current && isTrainerCapable(current) && options.some((o) => o.value === current) && isConfigured(current)) {
    return { value: current, tier: trainerTier(current), source: "current" };
  }
  const candidates = options.filter((o) => isTrainerCapable(o.value) && isConfigured(o.value));
  if (!candidates.length) return null;
  const sorted = [...candidates].sort(
    (a, b) =>
      trainerTier(b.value) - trainerTier(a.value) ||
      Number(isGovModel(a.value)) - Number(isGovModel(b.value)) ||
      cmpModelsNewestFirst(a.value, b.value),
  );
  const best = sorted[0]!;
  return { value: best.value, tier: trainerTier(best.value), source: "best-configured" };
}
