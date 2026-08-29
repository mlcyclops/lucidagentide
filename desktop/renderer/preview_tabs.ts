// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/preview_tabs.ts - P-PREVIEW.10: the pure registry behind the Preview panel's dynamic
// per-lane tabs. "yours" and "agent" stay fixed in app.ts; this module owns only the DYNAMIC lane tabs:
//   - upsert-by-lane: a lane rewriting its file refreshes the tab's path/label IN PLACE (the strip never
//     jumps around under the user), never duplicates;
//   - a cap of 8 lane tabs with the OLDEST evicted (insertion order; the tab just upserted is never the
//     victim), so a chatty fleet cannot grow the strip without bound;
//   - the previewable-path test the fleet stream sink uses to decide a lane write belongs here at all,
//     tolerant of the quoted / padded paths tool details tend to carry.
// Pure data in, new array out - no DOM, no I/O - so it is unit-testable without a renderer.

export interface PreviewTab { id: string; label: string; path: string; kind: "yours" | "agent" | "lane" }

/** At most this many DYNAMIC lane tabs; past it the oldest lane tab is evicted. */
export const LANE_TAB_CAP = 8;

/** The tab id a fleet lane's tab lives under ("lane:" + laneId - never collides with "yours"/"agent"). */
export const laneTabId = (laneId: string): string => `lane:${laneId}`;

/** Add or refresh a lane's tab. Returns a NEW array (the input is never mutated): an existing tab keeps
 *  its position with path + label replaced; a new tab appends; over the cap, the oldest lane tab(s) are
 *  evicted (never the one just upserted, and never a non-lane tab). */
export function upsertLaneTab(tabs: PreviewTab[], laneId: string, laneName: string, path: string): PreviewTab[] {
  const id = laneTabId(laneId);
  const label = (laneName || laneId).trim() || laneId;
  const at = tabs.findIndex((t) => t.id === id);
  const next: PreviewTab[] = at >= 0
    ? tabs.map((t, i) => (i === at ? { ...t, label, path } : t))
    : [...tabs, { id, label, path, kind: "lane" }];
  let lanes = next.filter((t) => t.kind === "lane").length;
  if (lanes <= LANE_TAB_CAP) return next;
  return next.filter((t) => {
    if (t.kind !== "lane" || lanes <= LANE_TAB_CAP || t.id === id) return true;
    lanes--;
    return false;
  });
}

/** Drop a lane's tab (no-op when absent). Returns a NEW array. */
export function removeLaneTab(tabs: PreviewTab[], laneId: string): PreviewTab[] {
  const id = laneTabId(laneId);
  return tabs.filter((t) => t.id !== id);
}

/** Does this path belong in the Preview panel? Case-insensitive .html / .htm / .svg, tolerant of the
 *  padding and quote pairs ("p", 'p', `p`) that tool-detail strings tend to wrap paths in. Paths with
 *  interior spaces are fine - only the OUTER padding and matched quote pairs are stripped. */
export function isPreviewablePath(p: string | null | undefined): boolean {
  if (!p) return false;
  let s = String(p).trim();
  while (
    s.length >= 2 &&
    ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")) || (s.startsWith("`") && s.endsWith("`")))
  ) s = s.slice(1, -1).trim();
  return /\.(html?|svg)$/i.test(s);
}
