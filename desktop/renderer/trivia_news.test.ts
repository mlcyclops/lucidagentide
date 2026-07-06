// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/trivia_news.test.ts — P-TRIV.3 (ADR-0176): the INTEL WIRE line builder.
// Pins the renderer-side keystone: a hostile headline renders as escaped TEXT (never markup),
// malformed bridge payloads render NOTHING, and the line is structurally unanswerable (no pills).

import { describe, expect, test } from "bun:test";
import { isIntelNewsItem, newsAgeStr, newsLineHtml } from "./trivia_news.ts";

const item = (over: Record<string, unknown> = {}) => ({ title: "Army awards new C2 contract", source: "Breaking Defense", host: "breakingdefense.com", ageMin: 42, ...over });

describe("isIntelNewsItem", () => {
  test("accepts a well-formed item, rejects junk and stubs", () => {
    expect(isIntelNewsItem(item())).toBe(true);
    expect(isIntelNewsItem(item({ ageMin: null }))).toBe(true);
    expect(isIntelNewsItem(null)).toBe(false);
    expect(isIntelNewsItem(item({ title: "short" }))).toBe(false);
    expect(isIntelNewsItem(item({ source: "" }))).toBe(false);
    expect(isIntelNewsItem(item({ ageMin: -5 }))).toBe(false);
    expect(isIntelNewsItem(item({ ageMin: "42" }))).toBe(false);
  });
});

test("newsAgeStr compacts ages for a 30px ticker", () => {
  expect(newsAgeStr(null)).toBe("");
  expect(newsAgeStr(12)).toBe("12m");
  expect(newsAgeStr(180)).toBe("3h");
  expect(newsAgeStr(3 * 24 * 60)).toBe("3d");
});

describe("newsLineHtml", () => {
  test("a hostile headline renders as text, never markup", () => {
    const html = newsLineHtml(item({ title: `<img src=x onerror=alert(1)> "M&A" surge & <script>x</script>`, source: `<b>Evil</b> Feed` }));
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;");
  });
  test("carries the INTEL pill, source and age - and NO answer pills", () => {
    const html = newsLineHtml(item());
    expect(html).toContain(">INTEL</span>");
    expect(html).toContain("Breaking Defense");
    expect(html).toContain(">42m</span>");
    expect(html).not.toContain("data-tch"); // structurally unanswerable
  });
  test("a malformed item renders nothing", () => {
    expect(newsLineHtml(item({ title: "x" }) as never)).toBe("");
  });
});
