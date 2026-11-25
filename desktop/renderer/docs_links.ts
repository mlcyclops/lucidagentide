// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/docs_links.ts - P-DOCS.2 (ADR-0681): the one place the app names docs.lucid-agents.com.
//
// Pure data + string builders (no DOM), so About, onboarding, the tour and the command palette all link the
// same pages and a test can pin them. Anchors open with target=_blank; desktop/navigation_policy.ts routes
// them to the system browser. Programmatic opens (the palette) go through app.ts openAuthUrl, which prefers
// bridge.openExternal and falls back to window.open.

export const DOCS_BASE_URL = "https://docs.lucid-agents.com/";

/** The live pages of the documentation site (ADR-0660). "home" is the site root. */
export const DOCS_PAGES = {
  home: "",
  getStarted: "get-started/",
  connect: "connect/",
  agents: "agents/",
  worlds: "worlds/",
  glossary: "glossary/",
} as const;

export type DocsPage = keyof typeof DOCS_PAGES;

/** Absolute URL of one documentation page. */
export function docsUrl(page: DocsPage = "home"): string {
  return DOCS_BASE_URL + DOCS_PAGES[page];
}

const e = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A safe external anchor to a docs page: new browsing context, no opener, no referrer. */
export function docsLinkHtml(page: DocsPage, label: string, cls: string, tip: string): string {
  return `<a class="${e(cls)}" href="${e(docsUrl(page))}" target="_blank" rel="noopener noreferrer" data-tip="${e(tip)}">${e(label)}</a>`;
}
