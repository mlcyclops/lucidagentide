// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-SESS-SEARCH.1 (ADR-0515): search snippets are transcript text painted as HTML. Marking must never let
// that text become markup, and must mark every term the engine matched on.

import { expect, test } from "bun:test";
import { markTerms } from "./session_search.ts";

test("transcript text is escaped around and inside the marks", () => {
  expect(markTerms(`<img src=x onerror=alert(1)> Janelle & "co"`, "janelle"))
    .toBe(`&lt;img src=x onerror=alert(1)&gt; <mark>Janelle</mark> &amp; &quot;co&quot;`);
  // A term that spells part of an entity marks the raw character, never the escaped entity.
  expect(markTerms("a & b", "amp")).toBe("a &amp; b");
  expect(markTerms("<b>", "")).toBe("&lt;b&gt;");
});

test("every term is marked, case-insensitive, the longest overlapping term whole", () => {
  expect(markTerms("Session search: the SESSIONS list", "search sess session")).toBe("<mark>Session</mark> <mark>search</mark>: the <mark>SESSION</mark>S list");
  expect(markTerms("cost (a+b)", "(a+b)")).toBe("cost <mark>(a+b)</mark>");
});
