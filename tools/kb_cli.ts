// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// tools/kb_cli.ts
//
// P-NVIM.6 (issue: view the knowledge graph from Neovim): the read-only `lucid kb` data CLI that backs
// the Neovim KG viewer (and is useful bare in any terminal). It mirrors `lucid stats`/tools/session_metrics:
// a pure read + format layer the launcher shells out to. It reuses the SAME KG registry + per-KG DuckDB
// stores the desktop GUI uses (desktop/kb_store.ts, defaulting to ~/.omp/kg_registry.json + kb_graph.duckdb),
// so a terminal `lucid kb` and the GUI show the identical graphs. Read-only: it never ingests, scans, or
// mutates — no scanner sidecar, no preflight (invariant #3 governs scan results, not a data read).

import { activeKgId, kbStore, listKgs } from "../desktop/kb_store.ts";

export interface KbKgInfo {
  kg_id: string;
  name: string;
  active: boolean;
  read_only: boolean;
  source_kind: string;
  pages: number;
}

export interface KbPageInfo {
  page_id: string;
  kind: string;
  slug: string;
  title: string;
}

export interface KbHit extends KbPageInfo {
  snippet: string;
}

export interface KbPageFull extends KbPageInfo {
  body_md: string;
  trust_label: string;
  classification: string;
}

// ── reads (over the shared ~/.omp KG registry + per-KG DuckDB) ───────────────────────────────────────

/** Every registered KG with its page count and which one is active — the KG picker's data. */
export async function kbList(): Promise<KbKgInfo[]> {
  const active = activeKgId();
  const out: KbKgInfo[] = [];
  for (const k of listKgs()) {
    let pages = 0;
    try {
      pages = await (await kbStore(k.kg_id)).pageCount();
    } catch {
      pages = 0; // a KG whose file is missing/locked still lists — just with an unknown count
    }
    out.push({
      kg_id: k.kg_id,
      name: k.name,
      active: k.kg_id === active,
      read_only: k.read_only,
      source_kind: k.source_kind,
      pages,
    });
  }
  return out;
}

/** The pages of a KG (default: the active KG) — id/kind/slug/title, in creation order. */
export async function kbPages(kgId?: string): Promise<KbPageInfo[]> {
  const pages = await (await kbStore(kgId)).listPages();
  return pages.map((p) => ({ page_id: p.page_id, kind: p.kind, slug: p.slug, title: p.title }));
}

/** One page (by page_id or slug) with its full body, or undefined when not found. */
export async function kbShow(idOrSlug: string, kgId?: string): Promise<KbPageFull | undefined> {
  const pages = await (await kbStore(kgId)).listPages();
  const p = pages.find((x) => x.page_id === idOrSlug || x.slug === idOrSlug);
  if (!p) return undefined;
  // DuckDB returns TIMESTAMP columns (created_at/updated_at) as BigInt — not JSON-serialisable, and the
  // viewer doesn't need them; return only the JSON-safe, string-coerced fields the KG viewer renders.
  return {
    page_id: String(p.page_id),
    kind: String(p.kind),
    slug: String(p.slug),
    title: String(p.title),
    body_md: String(p.body_md),
    trust_label: String(p.trust_label),
    classification: String(p.classification),
  };
}

/** A short body excerpt centred on the first match of `q` (already lower-cased). */
export function snippetAround(body: string, q: string, radius = 60): string {
  const flat = body.replace(/\s+/g, " ").trim();
  const at = flat.toLowerCase().indexOf(q);
  if (at < 0) return flat.slice(0, radius * 2);
  const start = Math.max(0, at - radius);
  const end = Math.min(flat.length, at + q.length + radius);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

/** Lexical search over page titles + bodies (case-insensitive substring), title matches ranked first.
 *  Deliberately dependency-free (no embedder) — the in-chat `knowledge_search` tool does semantic RAG. */
export async function kbSearch(query: string, kgId?: string): Promise<KbHit[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const pages = await (await kbStore(kgId)).listPages();
  const hits: KbHit[] = [];
  for (const p of pages) {
    if (`${p.title}\n${p.body_md}`.toLowerCase().includes(q)) {
      hits.push({ page_id: p.page_id, kind: p.kind, slug: p.slug, title: p.title, snippet: snippetAround(p.body_md, q) });
    }
  }
  hits.sort((a, b) => Number(b.title.toLowerCase().includes(q)) - Number(a.title.toLowerCase().includes(q)));
  return hits;
}

// ── human-readable formatting (bare `lucid kb` in a terminal; --json feeds Neovim) ───────────────────

function formatKgList(kgs: KbKgInfo[]): string {
  if (kgs.length === 0) return "No knowledge graphs yet. Seed one in the app (Role KG Packs) or import a .lkgpack.";
  return kgs
    .map((k) => `${k.active ? "*" : " "} ${k.name}  (${k.pages} page${k.pages === 1 ? "" : "s"}${k.read_only ? ", read-only" : ""})  [${k.kg_id}]`)
    .join("\n");
}

function formatPages(pages: KbPageInfo[]): string {
  if (pages.length === 0) return "This knowledge graph has no pages yet.";
  return pages.map((p) => `[${p.kind}] ${p.title}  ·  ${p.slug}  [${p.page_id}]`).join("\n");
}

function formatPage(page: KbPageFull): string {
  return `# ${page.title}\n(${page.kind} · ${page.slug} · ${page.trust_label})\n\n${page.body_md}`;
}

function formatHits(hits: KbHit[]): string {
  if (hits.length === 0) return "No matches.";
  return hits.map((h) => `[${h.kind}] ${h.title}  ·  ${h.slug}\n    ${h.snippet}`).join("\n");
}

// ── dispatch (the launcher's `lucid kb …` handler) ───────────────────────────────────────────────────

/** Run `lucid kb <action> …`. Actions: list | pages | show <id|slug> | search <query…>. `--json` emits
 *  machine output (Neovim); otherwise human-readable text. `--kg <id>` targets a specific KG (default:
 *  active). Returns an exit code + the text to print — the launcher does the I/O. */
export async function runKb(argv: string[]): Promise<{ code: number; out: string }> {
  const json = argv.includes("--json");
  const kgIdx = argv.indexOf("--kg");
  const kgId = kgIdx >= 0 ? argv[kgIdx + 1] : undefined;
  const kgValIdx = kgIdx >= 0 ? kgIdx + 1 : -1;
  const positional = argv.filter((a, i) => !a.startsWith("--") && i !== kgValIdx);
  const action = positional[0] ?? "pages";
  const emit = (data: unknown, text: string): { code: number; out: string } => ({
    code: 0,
    out: json ? JSON.stringify(data) : text,
  });

  switch (action) {
    case "list": {
      const kgs = await kbList();
      return emit(kgs, formatKgList(kgs));
    }
    case "pages": {
      const pages = await kbPages(kgId);
      return emit(pages, formatPages(pages));
    }
    case "show": {
      const id = positional[1];
      if (!id) return { code: 2, out: json ? JSON.stringify({ error: "usage: lucid kb show <page-id-or-slug>" }) : "usage: lucid kb show <page-id-or-slug>" };
      const page = await kbShow(id, kgId);
      if (!page) return { code: 1, out: json ? JSON.stringify({ error: `page not found: ${id}` }) : `page not found: ${id}` };
      return emit(page, formatPage(page));
    }
    case "search": {
      const query = positional.slice(1).join(" ");
      if (!query) return { code: 2, out: json ? JSON.stringify({ error: "usage: lucid kb search <query>" }) : "usage: lucid kb search <query>" };
      const hits = await kbSearch(query, kgId);
      return emit(hits, formatHits(hits));
    }
    default:
      return { code: 2, out: json ? JSON.stringify({ error: `unknown action: ${action}` }) : `unknown action: ${action} (use: list | pages | show | search)` };
  }
}

// Direct-run entry: the COMPILED `lucid` binary can't import this file in-process (its bundled runtime
// doesn't walk the repo's node_modules for bare specifiers, and DuckDB's native bindings must stay out
// of the bundle), so the launcher's `kb` subcommand spawns `bun tools/kb_cli.ts …` and relays the output.
if (import.meta.main) {
  const { code, out } = await runKb(process.argv.slice(2));
  process.stdout.write(out.endsWith("\n") ? out : `${out}\n`);
  process.exit(code);
}
