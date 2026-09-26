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
// P-PREVIEW.12: that test used to be a THIRD copy of `/\.(html?|svg)$/i` (the others were in
// preview_resolve.ts and preview_file.ts), which is how "the model cannot show me what it built" happened in
// three places at once. It now delegates to previewKindOf, the one kind table in preview_resolve.ts. That
// import is safe from the renderer program: renderer/app.ts already imports ../preview_resolve.ts (line 20),
// so the module is in the browser bundle today and this adds no new bundle dependency.
// Pure data in, new array out - no DOM, no I/O - so it is unit-testable without a renderer.

import { previewAutoSurfaces, previewKindOf, type PreviewKind } from "../preview_resolve.ts"; // P-PREVIEW.12: the ONE kind table
export type { PreviewKind };

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

/** Strip the OUTER padding and matched quote pairs ("p", 'p', `p`) that tool-detail strings tend to wrap
 *  paths in. Interior spaces are preserved: only the outside is trimmed. */
function unquote(p: string): string {
  let s = p.trim();
  while (
    s.length >= 2 &&
    ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")) || (s.startsWith("`") && s.endsWith("`")))
  ) s = s.slice(1, -1).trim();
  return s;
}

/** P-PREVIEW.12: which PreviewKind a tab's path renders as, or null when the panel cannot show it. Delegates
 *  to the ONE kind table (preview_resolve.ts) after unwrapping a quoted/padded path. */
export function previewPathKind(p: string | null | undefined): PreviewKind | null {
  return p ? previewKindOf(unquote(String(p))) : null;
}

/** Does this path belong in the Preview panel AT ALL? True for every kind in the table (html/svg, images,
 *  markdown, text-ish data, pdf), tolerant of quoted / padded paths. This is the "can the panel render it"
 *  question, so it stays wide: the Open field, Browse, and the agent's `preview_open` all rely on it. */
export function isPreviewablePath(p: string | null | undefined): boolean {
  return previewPathKind(p) !== null;
}

/** P-PREVIEW.18: may a lane's write OPEN a preview tab by itself? Narrower than isPreviewablePath on
 *  purpose. A fleet lane writing notes.md or a config.json used to earn its own tab in the strip, which is
 *  the same "the panel opens for everything" complaint one level up: with several lanes running, incidental
 *  writes could fill the tab row with files nobody asked to see. Reads the ONE auto-surface table, so the
 *  lane strip and the master panel can never disagree about what is worth interrupting for. */
export function isAutoPreviewPath(p: string | null | undefined): boolean {
  return p ? previewAutoSurfaces(unquote(String(p))) : false;
}

/** P-PREVIEW.12: the icons.ts glyph name for each kind, so a tab strip can SHOW what a tab holds instead of
 *  assuming every tab is a web page. An unknown name degrades to `info` inside icon(), so this can never
 *  break a render. Consumed by app.ts (which owns the strip markup). */
export const PREVIEW_KIND_ICON: Readonly<Record<PreviewKind, string>> = {
  html: "layout",
  svg: "pen",
  image: "eye",
  markdown: "report",
  text: "textT",
  pdf: "print",
};

/** A short human noun for a kind, for a tab tooltip / chip. INVARIANT 11: one word, so a tab label stays on
 *  ONE line and ellipsizes rather than folding. */
export function previewKindLabel(kind: PreviewKind | null): string {
  switch (kind) {
    case "html": return "page";
    case "svg": return "vector";
    case "image": return "image";
    case "markdown": return "markdown";
    case "text": return "text";
    case "pdf": return "PDF";
    default: return "file";
  }
}
