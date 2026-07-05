// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/model_favorites.ts — P-FAV.1 (ADR-0165): model-picker favorite stars.
//
// The curated picker (P-IDE.1, ADR-0029) orders models by family/gov/version — correct, but a user
// who flips between the same two or three models still scrolls family sections every time. A star
// on each row pins the model into a "Favorites" section at the TOP of the picker; the model also
// stays in its family section, so family muscle memory is never broken.
//
// Pure + DOM-free (marketplace.ts convention): parsing, toggling, and selection are unit-tested
// here; app.ts owns localStorage, the star button, and the pseudo-section render. Favorites are a
// LOCAL UI preference (same tier as the persisted family-collapse state) — never synced, never a
// security surface.

/** localStorage key (renderer-local, like the family-collapse state). */
export const FAVS_KEY = "lucid.model-favs";

/** Soft cap — a "favorites" list longer than this stops being one. Oldest beyond the cap drop. */
export const MAX_FAVS = 24;

/** Defensive parse of the persisted list: accepts only a JSON array of strings; dedupes;
 *  caps at MAX_FAVS. Garbage (bad JSON, non-array, mixed types) → empty list, never a throw. */
export function parseFavs(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    const out: string[] = [];
    for (const x of v) {
      if (typeof x === "string" && x && !out.includes(x)) out.push(x);
      if (out.length >= MAX_FAVS) break;
    }
    return out;
  } catch {
    return [];
  }
}

/** Toggle `value` in the favorites list. Returns a NEW array (never mutates); adding beyond
 *  MAX_FAVS drops the OLDEST favorite so the newest star always sticks. */
export function toggleFav(favs: string[], value: string): string[] {
  if (favs.includes(value)) return favs.filter((f) => f !== value);
  const next = [...favs, value];
  return next.length > MAX_FAVS ? next.slice(next.length - MAX_FAVS) : next;
}

/** The starred subset of `models`, in the MODELS' curated order (stable — the favorites section
 *  inherits the same gov-first/newest-first order as the families below it). Stale favorites
 *  (model no longer in the catalog) are simply not shown — they are NOT pruned from storage,
 *  so a temporarily hidden provider's stars survive reconnecting it. */
export function starredOf<T extends { value: string }>(models: T[], favs: string[]): T[] {
  if (favs.length === 0) return [];
  const set = new Set(favs);
  return models.filter((m) => set.has(m.value));
}
