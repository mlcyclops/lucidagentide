// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/per_call_model.ts - P-MODEL.11 (ADR-0602): whether a subagent call may pick its own model.
//
// omp 18.18 gates the task tool's per-item `model` (and eval's agent()/workpool() model) behind
// `task.perCallModel` (off | eval | on, default off), and reads it only from the operator's layers: the global
// config.yml, `--config` overlays and runtime flags, never a project layer, because repository files are
// writable by the agent. So the agent cannot turn it on, by design, and LUCID had no control that did. This
// module is the policy for the one LUCID writes: the user's stored choice, clamped to off under AskSage
// lockdown and under any managed model restriction. Pure (types only from managed_config), so the renderer
// may import its types; the engine writes the overlay through writePerCallModelOverlay.

import { closeSync, openSync, writeFileSync } from "node:fs";
import type { ManagedModels } from "./managed_config.ts";

export type PerCallModelSetting = "off" | "eval" | "on";
export const PER_CALL_MODEL_SETTINGS: readonly PerCallModelSetting[] = ["off", "eval", "on"];

/** Why the effective value is off although the stored one is not. */
export type PerCallModelClamp = "asksage-lockdown" | "org-model-policy";

export interface PerCallModelView {
  /** The user's choice, kept when a clamp applies so lifting it restores the choice. */
  stored: PerCallModelSetting;
  /** What omp is told at the next spawn. */
  effective: PerCallModelSetting;
  clamp: PerCallModelClamp | null;
}

/** Anything unrecognized reads as "off" (the safe value and omp's own default). */
export function parsePerCallModelSetting(v: unknown): PerCallModelSetting {
  return v === "eval" || v === "on" ? v : "off";
}

/** Whether a managed model policy restricts routing. Its allow and deny entries are id SUBSTRINGS, which omp's
 *  exact-id `task.perCallModelAllow` cannot express, so any restriction turns per-call choice off rather than
 *  risk a subagent reaching a model the policy forbids. */
export function orgRestrictsModels(models: ManagedModels | undefined): boolean {
  if (!models) return false;
  const listed = (l: string[] | undefined) => (l ?? []).some((e) => typeof e === "string" && e.trim() !== "");
  return models.lock === true || models.asksageOnly === true || listed(models.allowed) || listed(models.denied);
}

/** The effective value: the stored choice unless AskSage lockdown or a managed model restriction applies. */
export function resolvePerCallModel(stored: PerCallModelSetting, ctx: { asksageLocked: boolean; models: ManagedModels | undefined }): PerCallModelView {
  if (stored === "off") return { stored, effective: "off", clamp: null };
  if (ctx.asksageLocked) return { stored, effective: "off", clamp: "asksage-lockdown" };
  if (orgRestrictsModels(ctx.models)) return { stored, effective: "off", clamp: "org-model-policy" };
  return { stored, effective: stored, clamp: null };
}

/** The omp `--config` overlay body. The value is always written, off included, so a `task.perCallModel: on` in
 *  the user's global config.yml never reopens what LUCID (or a clamp) closed. */
export function perCallModelOverlayYaml(effective: PerCallModelSetting): string {
  return `# Written by LUCID at every omp spawn (P-MODEL.11). Do not edit: Settings > Subagents owns this value.\ntask:\n  perCallModel: ${effective}\n`;
}

/** Write the overlay through ONE descriptor (open-then-write, never exists-then-write). Throws on failure. */
export function writePerCallModelOverlay(path: string, effective: PerCallModelSetting): void {
  const fd = openSync(path, "w");
  try { writeFileSync(fd, perCallModelOverlayYaml(effective), "utf8"); } finally { closeSync(fd); }
}
