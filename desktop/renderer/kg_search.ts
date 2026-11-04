// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/kg_search.ts - P-KG-ORBIT.1 (ADR-0470): the ranked results behind the Knowledge
// view's "Find a node" dropdown. Pure and DOM-free so the ranking is unit-tested.
//
// The hub palette's fuzzyScore (harness/launcher/hub_palette.ts) is not reused: that module imports the
// terminal hub (pi-tui, node:path), which must never enter the browser bundle. The existing highlight
// (kg_ops.matchNodes, a name substring) is unchanged; this ranks a broader candidate set for the list:
//
//   1000 exact name          800 name prefix          600 word start in the name (incl. camelCase)
//    400 name substring      300 id path segment      200 id substring      100+ name subsequence
//
// Inside a tier an earlier match position wins, then the shorter name, then the busier node (count),
// then the id, so the order is total and stable.

export interface RankInput { id: string; name: string; kind: string; count: number }
export interface RankedNode { id: string; name: string; kind: string; score: number }

const isAlnum = (ch: string): boolean => /[a-z0-9]/i.test(ch);

/** True when position i of `s` starts a word: the first char, after a non-alphanumeric, or a camelCase
 *  hump (lower -> Upper in the ORIGINAL casing). */
function wordStart(s: string, i: number): boolean {
  if (i === 0) return true;
  const prev = s[i - 1]!, cur = s[i]!;
  if (!isAlnum(prev)) return true;
  return prev === prev.toLowerCase() && prev !== prev.toUpperCase() && cur === cur.toUpperCase() && cur !== cur.toLowerCase();
}

/** Score one candidate, or null when nothing matches. `q` is the lowercased, trimmed query. */
export function scoreNode(name: string, id: string, q: string): number | null {
  if (!q) return null;
  const ln = name.toLowerCase();
  if (ln === q) return 1000;
  if (ln.startsWith(q)) return 800;
  let first = -1;
  for (let at = ln.indexOf(q); at !== -1; at = ln.indexOf(q, at + 1)) {
    if (first === -1) first = at;
    if (wordStart(name, at)) return 600 - Math.min(99, at);
  }
  if (first !== -1) return 400 - Math.min(99, first);
  const li = id.toLowerCase();
  const idAt = li.indexOf(q);
  if (idAt !== -1) {
    for (let at = idAt; at !== -1; at = li.indexOf(q, at + 1)) {
      if (at === 0 || "/#.\\_-".includes(li[at - 1]!)) return 300 - Math.min(99, at);
    }
    return 200 - Math.min(99, idAt);
  }
  // Subsequence over the name: tighter spans score higher (100..150).
  let qi = 0, start = -1, end = -1;
  for (let i = 0; i < ln.length && qi < q.length; i++) {
    if (ln[i] === q[qi]) { if (start === -1) start = i; end = i; qi++; }
  }
  if (qi < q.length) return null;
  const slack = end - start + 1 - q.length;
  return 100 + Math.max(0, 50 - slack);
}

/** Rank `nodes` against `query`; at most `limit` results, best first. Empty query -> []. */
export function rankNodes(nodes: ReadonlyArray<RankInput>, query: string, limit = 12): RankedNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: Array<RankedNode & { count: number }> = [];
  for (const n of nodes) {
    const score = scoreNode(n.name, n.id, q);
    if (score !== null) hits.push({ id: n.id, name: n.name, kind: n.kind, score, count: n.count });
  }
  hits.sort((a, b) => b.score - a.score || a.name.length - b.name.length || b.count - a.count || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return hits.slice(0, Math.max(1, limit)).map(({ id, name, kind, score }) => ({ id, name, kind, score }));
}
