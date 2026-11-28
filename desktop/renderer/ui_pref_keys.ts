// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/ui_pref_keys.ts - P-VIZ.PREFS1 (ADR-0697), P-FIRSTRUN.1 (ADR-0698): which renderer preferences the
// engine keeps, and what a stored one may look like.
//
// The engine (settings_store uiPrefs, /api/ui/prefs) and the renderer (ui_prefs_store.ts) both load this file, so it
// imports nothing (ADR-0695: a renderer module the engine imports must reach no DOM-typed file). Each value is the
// string the renderer would have put in localStorage under that key; the engine only bounds it, the renderer's own
// loaders parse and validate it, exactly as they did from localStorage.

/** The renderer preferences the engine keeps, so a launch on a new port (an empty localStorage) keeps them too. */
export const UI_PREF_KEYS = [
  // Visualize (ADR-0697): the view (2D/3D, layout, style, reactions, motion), the last backdrop, the cast, Fly to
  // approvals, the ledger's place, the node panel's size, the auto camera, and world and built-in style options.
  "lucid.viz.v1",
  "lucid.viz.backdrop.v1",
  "lucid.viz.cast.v1",
  "lucid.viz.flyToApprovals.v1",
  "lucid.viz.ledger.v1",
  "lucid.viz.panelSize.v1",
  "lucid.viz.autoCamera",
  "lucid.worlds.options.v1",
  // First-run and suggestion memory (ADR-0698): the "Make LucidAgent yours" nudge was shown; Lucid's suggestions
  // (on or off, the holidays already asked about, the What's new notes seen, the holiday theme he pinned).
  "lucid.personalNudged",
  "lucid.suggest.enabled",
  "lucid.suggest.holiday",
  "lucid.suggest.news",
  "lucid.suggest.pin",
  // Special themes (ADR-0698): follow the calendar, the pinned season, its scene and where it shows. The holiday pin
  // above is checked against the pinned season, so the two live together.
  "lucid.season.auto",
  "lucid.season.pick",
  "lucid.season.scene",
  "lucid.season.where",
] as const;
export type UiPrefKey = (typeof UI_PREF_KEYS)[number];

/** The longest value kept, in characters (the options and cast maps are the large ones, a few KB at most). */
export const UI_PREF_MAX = 64 * 1024;

const KEYS: ReadonlySet<string> = new Set(UI_PREF_KEYS);
export const isUiPrefKey = (k: unknown): k is UiPrefKey => typeof k === "string" && KEYS.has(k);

/** A stored value: a string no longer than UI_PREF_MAX. */
export const isUiPrefValue = (v: unknown): v is string => typeof v === "string" && v.length <= UI_PREF_MAX;

/** Only known keys with well-formed values; anything else reads as absent. */
export function sanitizeUiPrefs(raw: unknown): Partial<Record<UiPrefKey, string>> {
  const out: Partial<Record<UiPrefKey, string>> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const k of UI_PREF_KEYS) {
    const v: unknown = (raw as Record<string, unknown>)[k];
    if (isUiPrefValue(v)) out[k] = v;
  }
  return out;
}
