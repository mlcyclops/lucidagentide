// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/kg_header.ts — P-KGUI.1 (ADR-0184): the consolidated KG-header views dropdown (pure).
//
// The KG flyout header carried a vertical three-button stack (Relate / Code graph / Compiled KB) that
// made the header thick. It is now ONE dropdown button whose label names the graph you're viewing;
// the menu explains each option inline, and the button's hover tip says it's a dropdown and lists the
// options. Pure builders only (no DOM) - app.ts owns the popover wiring; everything here is static
// first-party copy, no external strings.

/** Which graph modes are active. Relate is a tool on the personal graph; code/kb are views. */
export interface KgViewState { relateOn: boolean; codeMode: boolean; kbMode: boolean }

/** The dropdown button's label - names the graph currently on the canvas. */
export function kgViewLabel(s: KgViewState): string {
  return s.codeMode ? "Code graph" : s.kbMode ? "Compiled KB" : "Personal";
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
    ${item("kb", "Compiled KB", "The compiled knowledge base as a page graph - click a page to read it as data.", s.kbMode)}
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
