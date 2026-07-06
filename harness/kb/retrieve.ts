// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/kb/retrieve.ts
//
// P-KB.2 (ADR-0100): the hybrid retrieval router over the two SIBLING stores — the vector KB
// (kb_chunks, ADR-0058) and the compiled KB (kb_pages, ADR-0099). One entry point answers from either
// or both:
//   • vector   — the existing cosine retrieval, unchanged.
//   • compiled — VECTORLESS structural retrieval over the page graph: keyword relevance over page
//     title+body, then link-neighbor expansion (a hit's linked concept/entity pages are surfaced too).
//   • hybrid   — run both, normalize each store's scores, merge + dedupe by citation, and return one
//     ranked set wrapped in the trust-boundary delimiters (each item labelled with its store + citation).
//
// SECURITY (#5/#6, keystone #2): this is PURE READ — it stores nothing and mints no trust. Every hit
// carries the store's own trust_label, and the wrapped output is delimited UNTRUSTED data destined for
// the user-turn tail (never the frozen prefix). The stores + query embedder are injected (testable).

import { UNTRUSTED_END, UNTRUSTED_START } from "../prompt/assembler.ts";
import type { Embedder } from "../knowledge/embedder.ts";
import type { KnowledgeStore } from "../knowledge/store.ts";
import type { KbGraphStore, KbLink, KbPage } from "./store.ts";

export type RetrieveMode = "vector" | "compiled" | "hybrid";

export interface RetrievedItem {
  store: "vector" | "compiled";
  citation: string; // `source_path#ordinal` (vector) | `page:slug` (compiled)
  title: string;
  text: string;
  score: number;
  trustLabel: string;
}

export interface RetrieveArgs {
  query: string;
  mode?: RetrieveMode;
  k?: number;
  /** Vector store wiring — required for `vector`/`hybrid` (the query is embedded with this embedder). */
  vector?: { store: KnowledgeStore; datasetId: string; embedder: Embedder };
  /** Compiled store wiring — required for `compiled`/`hybrid`. */
  compiled?: { store: KbGraphStore };
}

export interface RetrieveResult {
  mode: RetrieveMode;
  items: RetrievedItem[];
  /** The items wrapped as delimited, cited, untrusted DATA — ready for the user-turn tail (empty if none). */
  wrapped: string;
}

const STOP = new Set(["the", "a", "an", "and", "or", "of", "to", "in", "is", "for", "on", "it", "as", "at", "by"]);
function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 2 && !STOP.has(t));
}

/**
 * Score compiled pages against a query WITHOUT vectors: keyword overlap (title weighted 3×, body 1×), then
 * link expansion — a page linked to/from a keyword hit inherits a fraction of that hit's score, so the
 * relevant concept/entity neighbors surface even when the query words land only on the summary. PURE.
 */
export function scoreCompiledPages(pages: KbPage[], links: KbLink[], query: string, k = 5): RetrievedItem[] {
  const terms = tokenize(query);
  if (!terms.length || !pages.length) return [];

  const base = new Map<string, number>();
  for (const p of pages) {
    const title = tokenize(p.title);
    const body = tokenize(p.body_md);
    let s = 0;
    for (const t of terms) {
      s += 3 * title.filter((x) => x === t).length + body.filter((x) => x === t).length;
    }
    base.set(p.page_id, s);
  }

  const score = new Map(base);
  for (const l of links) {
    const fromS = base.get(l.from_page_id) ?? 0;
    const toS = base.get(l.to_page_id) ?? 0;
    if (fromS > 0) score.set(l.to_page_id, (score.get(l.to_page_id) ?? 0) + 0.4 * fromS);
    if (toS > 0) score.set(l.from_page_id, (score.get(l.from_page_id) ?? 0) + 0.4 * toS);
  }

  const byId = new Map(pages.map((p) => [p.page_id, p]));
  return [...score.entries()]
    .filter(([, s]) => s > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(1, k))
    .map(([id, s]): RetrievedItem => {
      const p = byId.get(id)!;
      return { store: "compiled", citation: `page:${p.slug}`, title: p.title, text: p.body_md, score: s, trustLabel: p.trust_label };
    });
}

/** Min-max normalize an item list's scores into [0,1] so two stores' incomparable scales can be merged
 *  fairly. A single item (or all-equal) maps to 1. PURE; returns a new list. */
export function normalizeScores(items: RetrievedItem[]): RetrievedItem[] {
  if (!items.length) return [];
  const max = Math.max(...items.map((i) => i.score));
  const min = Math.min(...items.map((i) => i.score));
  const span = max - min;
  return items.map((i) => ({ ...i, score: span > 0 ? (i.score - min) / span : 1 }));
}

/** Wrap retrieved items as delimited, numbered, cited untrusted DATA (the wrapRetrieved contract, extended
 *  with the store + citation label so the model knows which substrate each hit came from). Empty ⇒ "". */
export function wrapKnowledge(items: RetrievedItem[]): string {
  if (!items.length) return "";
  const body = items.map((it, i) => `[${i + 1}] (${it.store}:${it.citation}) ${it.title}\n${it.text}`).join("\n\n");
  return `${UNTRUSTED_START}\n${body}\n${UNTRUSTED_END}`;
}

async function retrieveVector(v: NonNullable<RetrieveArgs["vector"]>, query: string, k: number): Promise<RetrievedItem[]> {
  const [qv] = await v.embedder.embed([query]);
  if (!qv) return [];
  const chunks = await v.store.retrieve(v.datasetId, qv, k);
  return chunks.map((c): RetrievedItem => ({
    store: "vector",
    citation: `${c.source_path}#${c.ordinal}`,
    title: c.source_path,
    text: c.text,
    score: 1 - c.distance, // cosine distance → similarity (higher = nearer)
    trustLabel: c.trust_label,
  }));
}

async function retrieveCompiled(store: KbGraphStore, query: string, k: number): Promise<RetrievedItem[]> {
  const [pages, links] = await Promise.all([store.listPages(), store.listLinks()]);
  return scoreCompiledPages(pages, links, query, k);
}

/**
 * Answer a query from the vector store, the compiled store, or both. `hybrid` (default) normalizes each
 * store's scores before merging so neither dominates, dedupes exact-duplicate citations, and returns the
 * top-k ranked + delimited. Single modes keep raw scores (more informative). PURE READ.
 */
export async function retrieveKnowledge(args: RetrieveArgs): Promise<RetrieveResult> {
  const mode = args.mode ?? "hybrid";
  const k = Math.max(1, Math.floor(args.k ?? 5));

  const wantVector = mode === "vector" || mode === "hybrid";
  const wantCompiled = mode === "compiled" || mode === "hybrid";
  const vectorItems = wantVector && args.vector ? await retrieveVector(args.vector, args.query, k) : [];
  const compiledItems = wantCompiled && args.compiled ? await retrieveCompiled(args.compiled.store, args.query, k) : [];

  let items: RetrievedItem[];
  if (mode === "hybrid") {
    items = [...normalizeScores(vectorItems), ...normalizeScores(compiledItems)];
  } else {
    items = mode === "vector" ? vectorItems : compiledItems;
  }

  // dedupe exact-duplicate citations (keep the higher score), then rank + cap.
  const best = new Map<string, RetrievedItem>();
  for (const it of items) {
    const prev = best.get(it.citation);
    if (!prev || it.score > prev.score) best.set(it.citation, it);
  }
  const ranked = [...best.values()].sort((a, b) => b.score - a.score).slice(0, k);
  return { mode, items: ranked, wrapped: wrapKnowledge(ranked) };
}
