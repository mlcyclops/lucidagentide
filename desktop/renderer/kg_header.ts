// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/kg_header.ts — P-KGUI.1 (ADR-0184): the consolidated KG-header views dropdown (pure).
//
// The KG flyout header carried a vertical three-button stack (Relate / Code graph / Compiled KB) that
// made the header thick. It is now ONE dropdown button whose label names the graph you're viewing;
// the menu explains each option inline, and the button's hover tip says it's a dropdown and lists the
// options. Pure builders only (no DOM) - app.ts owns the popover wiring; everything here is static
// first-party copy, no external strings. The ONE exception is the KG picker (P-KGPACK.2), whose rows carry
// user-authored KG NAMES - those are `esc`'d (invariant #5: user content is data, never markup).

import { esc } from "./format.ts";
import { icon } from "./icons.ts";

/** Which graph modes are active. Relate is a tool on the personal graph; code/kb are views. `kbName` is the
 *  active KG's name (P-KGPACK.2) so the button can read "Backend Engineer" instead of the generic label. */
export interface KgViewState { relateOn: boolean; codeMode: boolean; kbMode: boolean; kbName?: string }

/** The dropdown button's label - names the graph currently on the canvas. */
export function kgViewLabel(s: KgViewState): string {
  return s.codeMode ? "Code graph" : s.kbMode ? (s.kbName?.trim() || "Compiled KB") : "Personal";
}

/** True when the button should carry the active (.on) look - any non-default mode. */
export function kgViewActive(s: KgViewState): boolean {
  return s.relateOn || s.codeMode || s.kbMode;
}

const item = (view: string, title: string, desc: string, on: boolean, attr = "data-kgview", cls = ""): string =>
  `<button class="kgv-item${on ? " on" : ""}${cls ? ` ${cls}` : ""}" ${attr}="${view}">
    <span class="kgv-t">${title}${on ? " ✓" : ""}</span>
    <span class="kgv-d">${desc}</span>
  </button>`;

/** The dropdown menu (rendered inside the shared popover). Each option self-describes, and the
 *  active one carries a check - the menu is the documentation the old stacked buttons kept in
 *  three separate hover tips. */
export function kgViewsMenuHtml(s: KgViewState): string {
  return `<div class="kgv-menu">
    ${item("relate", "Relate nodes", "Drag one node onto another - or click several, then Relate - to author your own relationships.", s.relateOn)}
    ${item("code", "Code graph", "This workspace as a graph: files or symbols as nodes, imports and references as edges.", s.codeMode)}
    ${item("kb", "Compiled KB", "Your knowledge graphs - pick, rename, or create one; each is its own page graph you read as data.", s.kbMode)}
  </div>`;
}

// ───────────── P-KGPACK.2 (ADR-0205): the named-KG picker ─────────────
//
// The "Compiled KB" is no longer ONE combined graph but a SET of named KGs (file-per-KG, ADR-0205). This is
// the filter-as-you-type dropdown the "Compiled KB" row opens - same pattern as the plugin marketplace: a
// search box, one row per KG (the active one checked, a rename affordance, a source/read-only badge), and a
// "New KG" action. Pure builders; app.ts owns the popover + bridge wiring. `kg_id` is an opaque handle;
// `name` is user-authored and therefore `esc`'d everywhere it is rendered.

/** A KG as the picker sees it (a renderer-facing subset of the registry's KgEntry). */
export interface KgListItem { kg_id: string; name: string; active: boolean; read_only: boolean; source_kind: string }

/** Case-insensitive substring filter over KG name. Empty query → everything. Pure. */
export function filterKgList(items: KgListItem[], query: string): KgListItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((k) => k.name.toLowerCase().includes(q));
}

/** A small origin badge (chat / Obsidian / pack); `manual` KGs carry none. Pure. */
function kgSourceBadge(item: KgListItem): string {
  const label = item.source_kind === "pack" ? "Pack"
    : item.source_kind === "chat" ? "Chat"
    : item.source_kind === "obsidian" ? "Obsidian" : "";
  return label ? `<span class="kgp-src">${label}</span>` : "";
}

/** One KG row. `data-kgpick` lives ONLY on the select button and `data-kgrename` ONLY on the rename button,
 *  so a delegated handler can tell the two apart with no ancestor ambiguity. */
function kgRow(item: KgListItem): string {
  return `<div class="kgp-row${item.active ? " on" : ""}">
    <button class="kgp-pick" data-kgpick="${esc(item.kg_id)}" title="Show this knowledge graph">
      <span class="kgp-name">${esc(item.name)}${item.active ? " ✓" : ""}</span>
      ${kgSourceBadge(item)}${item.read_only ? `<span class="kgp-ro" title="Read-only pack">${icon("lock", 11)}</span>` : ""}
    </button>
    <button class="kgp-rowbtn" data-kgexport="${esc(item.kg_id)}" title="Export this KG as a .lkgpack pack" aria-label="Export pack">${icon("download", 12)}</button>
    <button class="kgp-rowbtn" data-kgrename="${esc(item.kg_id)}" title="Rename this KG" aria-label="Rename">${icon("editor", 12)}</button>
  </div>`;
}

/** Just the rows (filtered) - app.ts re-renders #kgPickList with this on every search keystroke. Pure. */
export function kgPickerRowsHtml(items: KgListItem[], query: string): string {
  const shown = filterKgList(items, query);
  if (!shown.length) return `<div class="kgp-empty">No knowledge graph matches "${esc(query.trim())}"</div>`;
  return shown.map(kgRow).join("");
}

/** The whole picker menu (header + search + list + "New KG"), rendered inside the shared popover. Pure. */
export function kgPickerHtml(items: KgListItem[], query: string): string {
  return `<div class="kgp-menu">
    <div class="kgp-h">Knowledge graphs<span class="kgp-count">${items.length}</span></div>
    <input id="kgPickSearch" class="kgp-search" type="text" placeholder="Filter graphs…" autocomplete="off" spellcheck="false">
    <div id="kgPickList" class="kgp-list">${kgPickerRowsHtml(items, query)}</div>
    <div class="kgp-foot">
      <button class="kgp-new" data-kgnew title="Create a new, empty knowledge graph">${icon("plus", 12)} New KG</button>
      <button class="kgp-new" data-kgimport title="Seed a new KG from a ChatGPT/Claude/Gemini export or an Obsidian markdown folder">${icon("market", 12)} Import files</button>
      <button class="kgp-new" data-kgpackcatalog title="Browse curated Role KG Packs, or import a .lkgpack you own (verified + re-scanned, installed read-only)">${icon("package", 12)} KG Packs</button>
    </div>
  </div>`;
}

/** P-KGUI.2 (ADR-0185): the Data dropdown - Import history / Export vault / CUI archive, folded from
 *  three header buttons into the same menu pattern as the views dropdown. `aiOn` renders the
 *  AI-extraction toggle (a menu row, not an action - toggling it never closes the menu). The CUI row
 *  keeps its danger look; its own confirm toast still guards the export. */
export function kgDataMenuHtml(aiOn: boolean): string {
  return `<div class="kgv-menu">
    ${item("import", "Import chat history", "Bring in a ChatGPT, Claude, or Gemini export - every message is scanned by the security gate before anything is learned.", false, "data-kgdata")}
    <label class="kgv-item kgv-check">
      <span class="kgv-t"><input type="checkbox" id="kgImportAI"${aiOn ? " checked" : ""}/> AI extraction on import</span>
      <span class="kgv-d">Use the model to pull richer facts + real relationships from each message. Slower, uses model quota (capped at 500 messages); off = the free, instant pass.</span>
    </label>
    ${item("export", "Export Obsidian vault", "Decrypt your Personal + Work knowledge into a portable vault - notes + wikilinks, CUI excluded by design, audited.", false, "data-kgdata")}
    ${item("cui", "CUI archive", "Export ONLY the CUI compartment as a CUI-marked, records-managed package with a SHA-256 manifest (32 CFR 2002 · NARA). Audited.", false, "data-kgdata", "kgv-danger")}
  </div>`;
}
