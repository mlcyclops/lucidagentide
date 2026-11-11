// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/session_search.ts
//
// P-SESS-SEARCH.1 (ADR-0552): the sidebar search's display half. The engine matches (desktop/sessions.ts
// searchSessions: every whitespace-separated term, case-insensitive); this marks those terms in a title or
// a snippet. Snippets are transcript text, so every byte outside a <mark> is escaped, and the marks are
// placed on the RAW text before escaping so a term can never split an entity like "&amp;".

import { esc } from "./format.ts";

/** `text` as HTML with every occurrence of any term of `query` wrapped in <mark>. No terms = escaped text. */
export function markTerms(text: string, query: string): string {
  const terms = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))];
  if (!terms.length) return esc(text);
  // Longest first: with terms "sess" and "session", "session" is marked whole instead of only its "sess".
  const re = new RegExp(terms.sort((a, b) => b.length - a.length).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gi");
  let out = "";
  let last = 0;
  for (const m of text.matchAll(re)) {
    out += `${esc(text.slice(last, m.index))}<mark>${esc(m[0])}</mark>`;
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}
