// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/docs_links.test.ts - P-DOCS.2 (ADR-0681): docs.lucid-agents.com links, single-sourced.

import { describe, expect, test } from "bun:test";
import { DOCS_BASE_URL, DOCS_PAGES, docsLinkHtml, docsUrl } from "./docs_links.ts";
import { TOUR_STEPS, coachHtml } from "./tour.ts";

describe("docs_links", () => {
  test("every page resolves under the one https base", () => {
    expect(DOCS_BASE_URL).toBe("https://docs.lucid-agents.com/");
    expect(docsUrl()).toBe(DOCS_BASE_URL);
    expect(docsUrl("getStarted")).toBe("https://docs.lucid-agents.com/get-started/");
    expect(docsUrl("connect")).toBe("https://docs.lucid-agents.com/connect/");
    for (const page of Object.keys(DOCS_PAGES) as (keyof typeof DOCS_PAGES)[]) {
      expect(docsUrl(page).startsWith(DOCS_BASE_URL)).toBe(true);
      expect(docsUrl(page)).toMatch(/\/$/);
    }
  });

  test("docsLinkHtml is a safe external anchor with escaped text", () => {
    const a = docsLinkHtml("connect", 'Connect <"x">', "modal-docs", "tip & more");
    expect(a).toContain('href="https://docs.lucid-agents.com/connect/"');
    expect(a).toContain('target="_blank"');
    expect(a).toContain('rel="noopener noreferrer"');
    expect(a).toContain('data-tip="tip &amp; more"');
    expect(a).toContain("Connect &lt;&quot;x&quot;&gt;");
    expect(a).not.toContain("<\"x\">");
  });

  test("the tour closer card links the Get started guide; other steps carry no link", () => {
    expect(coachHtml(TOUR_STEPS.closer!, 6, 7)).toContain('class="coach-link" href="https://docs.lucid-agents.com/get-started/"');
    expect(coachHtml(TOUR_STEPS.composer!, 0, 7)).not.toContain("coach-link");
  });
});
