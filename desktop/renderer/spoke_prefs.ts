// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/spoke_prefs.ts - P-SCROLL.1 (ADR-0405): the two fleet preferences a spoke switch or a
// spawn reads, shared by the orbit, the grid and the main composer.
//
// 1. The spawn model. Both "new spoke" forms used to preselect the MASTER's model, so a user who runs
//    spokes on a different model re-picked it on every spawn. The default is now the model the last
//    spoke was created or switched to, falling back to the master's while nothing is remembered or the
//    remembered model is no longer offered (provider signed out, model retired).
// 2. Where a spoke switch lands: the newest message (default) or where the reader left off.
//
// Renderer-local view state in localStorage (the `lucid.*` convention). Storage failures (private mode,
// quota) degrade to the defaults and never throw.

export interface ModelOption { value: string; label?: string }

const SPOKE_MODEL_KEY = "lucid.spoke-model";
const SWITCH_SCROLL_KEY = "lucid.spoke-switch-scroll";

function read(key: string): string {
  try { return localStorage.getItem(key) ?? ""; } catch { return ""; }
}
function write(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable: the default stands */ }
}

/** The model a new spoke form preselects. Pure: the remembered spoke model when it is still offered,
 *  else the master's model (the forms list it even when the catalog has not loaded yet), else the first
 *  offered model, else "" (the engine then uses its own default). */
export function spawnModelDefault(options: readonly ModelOption[], remembered: string, master: string): string {
  const r = remembered.trim();
  if (r && options.some((o) => o.value === r)) return r;
  if (master) return master;
  return options[0]?.value ?? "";
}

/** The last model a spoke was created with or switched to ("" when none yet). */
export function rememberedSpokeModel(): string { return read(SPOKE_MODEL_KEY).trim(); }

/** Record a model the user just ran a spoke on. Blank values never clobber a real one. */
export function rememberSpokeModel(model: string): void {
  const m = (model ?? "").trim();
  if (m) write(SPOKE_MODEL_KEY, m);
}

/** Where switching between Main and a spoke (or spoke to spoke) lands the chat. */
export type SpokeSwitchScroll = "latest" | "resume";

export function spokeSwitchScroll(): SpokeSwitchScroll {
  return read(SWITCH_SCROLL_KEY) === "resume" ? "resume" : "latest";
}

export function setSpokeSwitchScroll(v: SpokeSwitchScroll): void {
  write(SWITCH_SCROLL_KEY, v === "resume" ? "resume" : "latest");
}
