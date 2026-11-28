// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_pref_keys.ts - P-VIZ.PREFS1 (ADR-0697): which Visualize preferences the engine keeps, and
// what a stored one may look like.
//
// The engine (settings_store vizPrefs, /api/viz/prefs) and the renderer (viz_prefs_store.ts) both load this file, so
// it imports nothing (ADR-0695: a renderer module the engine imports must reach no DOM-typed file). Each value is the
// string the renderer would have put in localStorage under that key; the engine only bounds it, the renderer's own
// loaders parse and validate it, exactly as they did from localStorage.

/** The Visualize preference keys: the view (2D/3D, layout, style, reactions, motion), the last backdrop, the cast,
 *  Fly to approvals, the ledger's place, the node panel's size, the auto camera, and world and built-in style options. */
export const VIZ_PREF_KEYS = [
  "lucid.viz.v1",
  "lucid.viz.backdrop.v1",
  "lucid.viz.cast.v1",
  "lucid.viz.flyToApprovals.v1",
  "lucid.viz.ledger.v1",
  "lucid.viz.panelSize.v1",
  "lucid.viz.autoCamera",
  "lucid.worlds.options.v1",
] as const;
export type VizPrefKey = (typeof VIZ_PREF_KEYS)[number];

/** The longest value kept, in characters (the options and cast maps are the large ones, a few KB at most). */
export const VIZ_PREF_MAX = 64 * 1024;

const KEYS: ReadonlySet<string> = new Set(VIZ_PREF_KEYS);
export const isVizPrefKey = (k: unknown): k is VizPrefKey => typeof k === "string" && KEYS.has(k);

/** A stored value: a string no longer than VIZ_PREF_MAX. */
export const isVizPrefValue = (v: unknown): v is string => typeof v === "string" && v.length <= VIZ_PREF_MAX;

/** Only known keys with well-formed values; anything else reads as absent. */
export function sanitizeVizPrefs(raw: unknown): Partial<Record<VizPrefKey, string>> {
  const out: Partial<Record<VizPrefKey, string>> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const k of VIZ_PREF_KEYS) {
    const v: unknown = (raw as Record<string, unknown>)[k];
    if (isVizPrefValue(v)) out[k] = v;
  }
  return out;
}
