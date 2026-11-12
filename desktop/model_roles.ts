// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/model_roles.ts - P-MODEL.8 (ADR-0448): the heavy omp model roles on a Gemini session.
//
// A session on the Google API-key route opens on Gemini 3.8 Flash (GEMINI_DEFAULT in
// renderer/model_families.ts) and hands the work that needs the flagship to Gemini 4 Argon through omp's
// model roles: `slow` (omp's "Thinking" role, also the reviewer agent's model), `plan` ("Architect": plan
// mode and long design/research passes) and `task` (every `task` subagent). Argon is expensive (about 2x
// the output tokens per task of its peers, at an introductory rate Google says will double), so it is
// NEVER the per-turn default, and these roles are only written when the chat model is itself a direct
// Gemini model: a Claude or GPT session never silently fans subagents out to a second provider's bill.
//
// Written as an omp `--config` overlay at every spawn, like the judgment overlay (judgment_policy.ts), so
// it reflects the chat model omp last reported. omp has no ACP knob to change a role in a running child,
// so a mid-process switch onto (or off) Gemini takes effect at the next spawn.

import { closeSync, openSync, writeFileSync } from "node:fs";

/** omp's id for Gemini 4 Argon on the API-key route. omp's static catalog does not carry it; omp's Gemini
 *  discovery registers it from `GET /v1beta/models` once a GEMINI_API_KEY is saved. */
export const GEMINI_HEAVY_MODEL = "google/gemini-4-argon";
/** The omp roles Argon takes on a Gemini session: Thinking, Architect, Subtask. */
export const GEMINI_HEAVY_ROLES = ["slow", "plan", "task"] as const;

export interface HeavyRoleInput {
  /** The session's chat model as omp reports it (`provider/model`), or "" before omp reported one. */
  chatModel: string;
  /** AskSage lockdown (user or org-managed): every call must route through the gov gateway. */
  locked: boolean;
  /** The org model allow-list (managed_config.modelAllowed). */
  allowed: (model: string) => boolean;
}

/** PURE: the model the heavy roles go to, or null to leave omp's defaults (inherit the session model).
 *  Null under lockdown (a direct Google route is CUI backflow), when the chat model is not a direct
 *  `google/gemini-*` model, and when the org policy forbids Argon. */
export function heavyRoleModel(i: HeavyRoleInput): string | null {
  if (i.locked) return null;
  if (!/^google\/gemini-/i.test(i.chatModel)) return null;
  if (!i.allowed(GEMINI_HEAVY_MODEL)) return null;
  return GEMINI_HEAVY_MODEL;
}

/** The omp `--config` overlay body. Each heavy role falls back to `@default` (the session's own model) so
 *  a key without Argon access, or an Argon outage, degrades to Flash instead of failing the subagent. With
 *  no heavy model the overlay is an empty map, so a role written by an earlier spawn never lingers. */
export function modelRolesOverlayYaml(heavy: string | null): string {
  const head = "# Written by LUCID at every omp spawn (P-MODEL.8). Do not edit: the session's chat model decides it.\n";
  if (!heavy) return `${head}{}\n`;
  const roles = GEMINI_HEAVY_ROLES.map((r) => `  ${r}: ${JSON.stringify(heavy)}\n`).join("");
  const chains = GEMINI_HEAVY_ROLES.map((r) => `    ${r}: ["@default"]\n`).join("");
  return `${head}modelRoles:\n${roles}retry:\n  fallbackChains:\n${chains}`;
}

/** Write the overlay through ONE descriptor (open-then-write, never exists-then-write). */
export function writeModelRolesOverlay(path: string, heavy: string | null): void {
  const fd = openSync(path, "w");
  try { writeFileSync(fd, modelRolesOverlayYaml(heavy), "utf8"); } finally { closeSync(fd); }
}
