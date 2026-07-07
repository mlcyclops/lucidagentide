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

const item = (view: string, title: string, desc: string, on: boolean): string =>
  `<button class="kgv-item${on ? " on" : ""}" data-kgview="${view}">
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
