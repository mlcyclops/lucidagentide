// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/viz_prefs_store.ts - P-VIZ.PREFS1 (ADR-0697): Visualize's preferences, kept by the engine.
//
// A launch that rolls to a new port (ADR-0458) serves the renderer from a new origin, whose localStorage is empty, so
// every Visualize choice (view, style and world options, Motion, cast, panel size...) used to reset. The engine
// settings are the source of truth now (/api/viz/prefs, settings_store vizPrefs); localStorage stays as a MIRROR so the
// first paint has them synchronously, the same arrangement as the theme (app.ts THEME_KEY). The store has the
// localStorage shape (getItem/setItem/removeItem), so the existing loaders (loadOptions, loadCastPrefs, loadPanelSize)
// take it unchanged.
//
//   - reads come from memory, seeded from the mirror;
//   - a write goes to memory, the mirror and the engine (one key per call; a failed save keeps the mirror);
//   - `ready` asks the engine once: what it keeps wins over the mirror, except keys written here since (the user's
//     newer choice); keys only the mirror has (an install from before this existed) are handed to the engine once.
//     It resolves true when anything changed, so the view reloads its preferences.

import { isVizPrefKey, isVizPrefValue, VIZ_PREF_KEYS, type VizPrefKey } from "./viz_pref_keys.ts";

type Mirror = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface VizPrefsRemote {
  /** Every preference the engine keeps, or null when it did not answer. */
  load(): Promise<Record<string, string> | null>;
  /** Keep one preference (null removes it). */
  save(key: VizPrefKey, value: string | null): Promise<unknown>;
}

export interface VizPrefsStore extends Mirror {
  /** Settles once the engine answered (or did not): true when its values changed what this store reads. */
  ready: Promise<boolean>;
}

export function createVizPrefs(mirror: Mirror | null, remote: VizPrefsRemote): VizPrefsStore {
  const mem = new Map<VizPrefKey, string>();
  const written = new Set<VizPrefKey>(); // keys this window set since it started: newer than what the engine answers
  const fromMirror = (k: string): string | null => { try { return mirror?.getItem(k) ?? null; } catch { return null; } };
  const toMirror = (k: string, v: string | null): void => {
    try { if (v === null) mirror?.removeItem(k); else mirror?.setItem(k, v); } catch { /* storage off: memory and the engine still hold it */ }
  };
  for (const k of VIZ_PREF_KEYS) {
    const v = fromMirror(k);
    if (isVizPrefValue(v)) mem.set(k, v);
  }
  const put = (k: string, v: string | null): void => {
    if (!isVizPrefKey(k)) { toMirror(k, v); return; } // not a Visualize preference: the mirror only, as before
    if (v === null) mem.delete(k); else mem.set(k, v);
    written.add(k);
    toMirror(k, v);
    void remote.save(k, v).catch(() => { /* the mirror keeps it; the next save or launch hands it over */ });
  };
  const ready = remote.load().then((kept) => {
    if (!kept) return false;
    let changed = false;
    for (const k of VIZ_PREF_KEYS) {
      if (written.has(k)) continue;
      const theirs = kept[k];
      const ours = mem.get(k);
      if (isVizPrefValue(theirs)) {
        if (theirs !== ours) { mem.set(k, theirs); toMirror(k, theirs); changed = true; }
      } else if (ours !== undefined) {
        void remote.save(k, ours).catch(() => { /* handed over on the next launch */ });
      }
    }
    return changed;
  }, () => false);
  return {
    getItem: (k) => (isVizPrefKey(k) ? (mem.get(k) ?? null) : fromMirror(k)),
    setItem: (k, v) => put(k, String(v)),
    removeItem: (k) => put(k, null),
    ready,
  };
}
