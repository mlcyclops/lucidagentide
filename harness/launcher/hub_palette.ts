// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-TUI.6 (ADR-0435) - the hub's fuzzy PALETTE core: a pure scorer and pure row builders.
//
// Operator direction (2026-10-04): "there must be fuzzy finding for spaces and agents like herdr
// has, behind a nice keybind." The palette (ctrl+k, or `:palette`) lists, in ONE fused list:
// spaces (switch), tabs (focus, shown as "space > tab"), agents (attach into the focused pane),
// and decks (rebind the focused pane). Everything here is pure and unit-tested: the scorer sees
// two strings, the builder sees projections of the Spaces model and the same /api/fleet/status
// lanes the decks render. The stateful overlay (keys, drawing, dispatch) lives in hub_tui.ts.
//
// The scorer is a SUBSEQUENCE matcher ranked lexicographically:
//   1. longest consecutive-run length in the alignment (higher first),
//   2. word-boundary hits (a matched char at the start or after a non-alphanumeric; higher first),
//   3. shorter target first.
// Case-insensitive. A query that is not a subsequence of the target is null, never a low score.

import type { Spaces } from "./hub_spaces.ts";
import { DECKS, type DeckId } from "./hub_tui.ts";

/** A match's rank parts, compared lexicographically by compareScore. */
export interface FuzzyScore { run: number; bounds: number; len: number }

/** Orders two scores: longest consecutive run, then boundary hits, then the shorter target.
 *  Negative = `a` ranks first. */
export function compareScore(a: FuzzyScore, b: FuzzyScore): number {
  return b.run - a.run || b.bounds - a.bounds || a.len - b.len;
}

/** Score `query` against `target`, or null when it is not a subsequence. The alignment is chosen
 *  by a small DP (not greedy first-match): "ab" in "axab" scores run 2, because the scorer must
 *  find the adjacent pair a greedy left-to-right walk would miss. */
export function fuzzyScore(query: string, target: string): FuzzyScore | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (q.length === 0) return { run: 0, bounds: 0, len: t.length };
  if (q.length > t.length) return null;
  // A word boundary: the first char, or any char after a non-alphanumeric (space, -, _, :, >, ...).
  const bound: boolean[] = [];
  for (let i = 0; i < t.length; i++) bound.push(i === 0 || !/[a-z0-9]/.test(t[i - 1]!));
  const QL = q.length;
  const TL = t.length;
  // memo[(qi, ti, run)] = the best (max run, boundary hits) completing q[qi..] inside t[ti..],
  // given a consecutive streak of `run` already running into ti. Short strings, tiny state space.
  const memo = new Map<number, { mr: number; b: number } | null>();
  const rec = (qi: number, ti: number, run: number): { mr: number; b: number } | null => {
    if (qi === QL) return { mr: run, b: 0 };
    if (TL - ti < QL - qi) return null;
    const key = (qi * (TL + 1) + ti) * (QL + 1) + run;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    let best: { mr: number; b: number } | null = null;
    if (q[qi] === t[ti]) {
      const m = rec(qi + 1, ti + 1, run + 1);
      if (m) best = { mr: m.mr, b: m.b + (bound[ti] ? 1 : 0) };
    }
    const s = rec(qi, ti + 1, 0);
    if (s) {
      const cand = { mr: Math.max(run, s.mr), b: s.b };
      if (!best || cand.mr > best.mr || (cand.mr === best.mr && cand.b > best.b)) best = cand;
    }
    memo.set(key, best);
    return best;
  };
  const r = rec(0, 0, 0);
  return r ? { run: r.mr, bounds: r.b, len: t.length } : null;
}

/** One palette row. `label` is what the scorer sees and the list shows; `hint` is the dim
 *  right-hand cell naming what Enter does; `icon` is the LUCID glyph family, not a bullet. */
export interface PaletteItem {
  kind: "space" | "tab" | "agent" | "deck";
  id: string;
  label: string;
  hint: string;
  icon: string;
}

const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

/** The fused list, in stable source order (ties keep it): every space, each space's tabs as
 *  "space › tab", every fleet lane (status verbatim in the hint), every deck. Pure. */
export function buildPaletteItems(spaces: Spaces, lanes: readonly Record<string, unknown>[]): PaletteItem[] {
  const items: PaletteItem[] = [];
  for (const s of spaces.spaces) {
    items.push({ kind: "space", id: s.id, label: s.name, hint: `space · ${s.tabs.length} tab${s.tabs.length === 1 ? "" : "s"}`, icon: "▦" });
    for (const t of s.tabs) items.push({ kind: "tab", id: t.id, label: `${s.name} › ${t.name}`, hint: "tab", icon: "▸" });
  }
  for (const l of lanes) {
    const id = str(l.id);
    if (id) items.push({ kind: "agent", id, label: str(l.name) || id, hint: `agent · ${str(l.status) || "?"}`, icon: "◎" });
  }
  for (const d of DECKS) items.push({ kind: "deck", id: d.id satisfies DeckId, label: d.title, hint: "deck", icon: d.icon });
  return items;
}

/** The visible rows under the query: scored, ranked (compareScore), stable on full ties. */
export function filterPalette(items: readonly PaletteItem[], query: string): PaletteItem[] {
  const scored: { item: PaletteItem; s: FuzzyScore; i: number }[] = [];
  for (const [i, item] of items.entries()) {
    const s = fuzzyScore(query, item.label);
    if (s) scored.push({ item, s, i });
  }
  scored.sort((a, b) => compareScore(a.s, b.s) || a.i - b.i);
  return scored.map((x) => x.item);
}
