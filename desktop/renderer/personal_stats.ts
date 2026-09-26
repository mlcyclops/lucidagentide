// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/personal_stats.ts - P-KGUI.3 (ADR-0336): the Personalization card's stat tiles, rebuilt
// for a user who has MANY knowledge graphs.
//
// What was wrong, from the field report: the card showed exactly three fixed tiles (PERSONAL / WORK / CUI)
// in a `repeat(3,1fr)` grid, and the CUI tile was rendered even when the user had never created a CUI vault,
// reading "- CUI (LOCKED)". That is a stat about a thing that does not exist, which is worse than no stat:
// it advertises a locked door where there is no room behind it. Meanwhile the named KGs, the things the user
// actually accumulates, had no presence in the card at all.
//
// Three rules fall out, and they are the whole module:
//
// 1. A TILE IS EVIDENCE, SO IT ONLY EXISTS WHEN THE THING DOES. No CUI vault means no CUI tile. A vault that
//    exists but is locked DOES get a tile, because "locked" is real information about a real store.
// 2. AN UNKNOWN COUNT IS A DASH, NEVER A ZERO. Per-KG counts arrive after the panel paints (one DuckDB open
//    per KG), and a fabricated 0 would read as "this graph is empty" when it means "not measured yet".
// 3. THE ACTIVE KG COMES FIRST. With many KGs the tile strip scrolls, and the one you are using must be
//    visible without scrolling.
//
// Pure builders only: no DOM, no bridge. app.ts owns the fetches and the two-pass render.

import { esc } from "./format.ts";

/** One stat tile. `value` is already display-ready (a number or a dash), so the renderer makes no decisions. */
export interface StatTile {
  /** Stable id: `scope:personal` / `scope:work` / `scope:cui` / `kg:<kg_id>`. Never regenerated (#9). */
  id: string;
  /** The tile's caption. One line: the CSS ellipsizes it and `title` carries the full text (invariant 11). */
  label: string;
  /** Display-ready value. `"-"` means not known, which is NOT the same as zero. */
  value: string;
  tone: "personal" | "work" | "cui" | "kg";
  /** A short qualifier under the label ("locked", "read only", "active"). */
  note?: string;
}

/** A KG as the tiles see it. `pages` absent = not measured yet. */
export interface StatKg { kg_id: string; name: string; read_only: boolean; active: boolean }

export interface PersonalStatsInput {
  counts: { personal: number; work: number; cui: number } | null;
  /** A CUI store EXISTS on disk. False means the tile is omitted entirely, not shown as locked. */
  cuiConfigured: boolean;
  cuiUnlocked: boolean;
  kgs: StatKg[];
  /** kg_id -> page count. A missing key renders as a dash. */
  kgPages: Record<string, number>;
}

/** The tiles to render, in display order: compartments first, then KGs with the active one leading. */
export function personalStatTiles(i: PersonalStatsInput): StatTile[] {
  const tiles: StatTile[] = [];
  const c = i.counts;
  tiles.push({ id: "scope:personal", label: "Personal", value: c ? String(c.personal) : "-", tone: "personal" });
  tiles.push({ id: "scope:work", label: "Work", value: c ? String(c.work) : "-", tone: "work" });
  // RULE 1. An absent CUI vault gets no tile at all. Locked is a different statement from non-existent.
  if (i.cuiConfigured) {
    tiles.push({
      id: "scope:cui",
      label: "CUI",
      value: i.cuiUnlocked && c ? String(c.cui) : "-",
      tone: "cui",
      note: i.cuiUnlocked ? undefined : "locked",
    });
  }
  // RULE 3. Active first, then registry order. `toSorted` keeps the rest stable rather than reshuffling.
  const kgs = i.kgs.toSorted((a, b) => Number(b.active) - Number(a.active));
  for (const k of kgs) {
    const pages = i.kgPages[k.kg_id];
    tiles.push({
      id: `kg:${k.kg_id}`,
      label: k.name.trim() || "Untitled KG",
      // RULE 2. Only a real, finite measurement becomes a number.
      value: typeof pages === "number" && Number.isFinite(pages) ? String(pages) : "-",
      tone: "kg",
      note: k.active ? "active" : (k.read_only ? "read only" : undefined),
    });
  }
  return tiles;
}

/** The tile strip. Every label is `esc`'d (KG names are user-authored: invariant 5, content is data) and
 *  carries `title` so a name too long for a narrow tile is recoverable on hover rather than lost. */
export function personalStatsHtml(tiles: StatTile[]): string {
  const cells = tiles.map((t) => {
    const label = esc(t.label);
    const note = t.note ? `<i>${esc(t.note)}</i>` : "";
    return `<div class="psc" data-stat="${esc(t.id)}" title="${label}${t.note ? ` (${esc(t.note)})` : ""}">`
      + `<b class="psc-${t.tone}">${esc(t.value)}</b><span>${label}</span>${note}</div>`;
  }).join("");
  return `<div class="pscope-counts" data-stat-count="${tiles.length}">${cells}</div>`;
}
