// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/marketplace.ts — P-MARKET.1 (ADR-0158): the Plugin Marketplace popup.
//
// Pure builders (no DOM, no fetch) so the catalog + the modal HTML are unit-testable; app.ts owns the
// scrim/Escape/backdrop wiring (same conventions as the About + /goal modals). The catalog is a CURATED,
// static registry — nothing is fetched or executed from it; every row's only live action is opening the
// project's GitHub repo in the system browser. Install mechanics (BRAT-style "add from URL", gated through
// the scanner like agent-template import) are deliberately a later increment (P-MARKET.2, see ADR-0158).
//
// Ordering: Excalidraw is PINNED first (featured, the ADR-0158 product requirement), then the Obsidian
// "3rd Party Integrations" survivors by community downloads (obsidianstats.com, 2026-07), then curated
// LUCID-fit additions (security, diagrams, documents). ADR-0181 curated the ADR-0158 catalog for FIT:
// entries that compete with LUCID's core (Copilot = the gated chat + Local Providers; BRAT = the
// P-MARKET.2 install path itself) or that are Obsidian-editor niceties off this product's audience
// (Paste URL into selection, Readwise) were REMOVED; their ids are retired, never reused (invariant 9).

import { esc } from "./format.ts";
import { icon } from "./icons.ts";

/** Closed set. featured = pinned to the top; built-in = LUCID already ships the capability;
 *  planned = on the integration roadmap (ADR-0158). */
export type MarketStatus = "featured" | "built-in" | "planned";

export interface MarketPlugin {
  id: string;            // stable id — never regenerated (AGENTS.md invariant 9)
  name: string;
  desc: string;          // one-liner: what it does
  repo: string;          // https://github.com/… project repository (the row's only action)
  category: string;
  /** Obsidian community downloads where verified (popularity signal shown as a badge); null = unverified. */
  downloads: number | null;
  /** Canonical sort order: 1 = Excalidraw (pinned), then Obsidian integrations-category rank,
   *  then the curated LUCID-fit additions (ADR-0181). */
  rank: number;
  status: MarketStatus;
  /** How this maps into LUCID — the roadmap one-liner rendered under the description. */
  lucidPlan: string;
}

/** The curated registry, in canonical order (rank asc). Excalidraw first — product requirement. */
export const MARKET_PLUGINS: MarketPlugin[] = [
  {
    id: "excalidraw", name: "Excalidraw", rank: 1, status: "featured",
    desc: "Virtual whiteboard for sketching hand-drawn-like diagrams.",
    repo: "https://github.com/excalidraw/excalidraw",
    category: "Whiteboard", downloads: 6_487_654,
    lucidPlan: "Embed the whiteboard in the sandboxed Preview panel; sketches feed the agent as design context.",
  },
  {
    id: "git", name: "Git", rank: 2, status: "planned",
    desc: "Back up and version your workspace with git (Obsidian's #1 integration).",
    repo: "https://github.com/Vinzent03/obsidian-git",
    category: "Version control", downloads: 2_765_510,
    lucidPlan: "Dedicated git panel - staged diff, commit, branch - on top of the agent's existing gated git tooling.",
  },
  {
    id: "remotely-save", name: "Remotely Save", rank: 3, status: "planned",
    desc: "Sync notes and settings to S3, WebDAV, Dropbox or OneDrive.",
    repo: "https://github.com/remotely-save/remotely-save",
    category: "Sync", downloads: 2_008_001,
    lucidPlan: "Encrypted sync of sessions + semantic memory to user-owned storage (S3/WebDAV), vault-held keys.",
  },
  {
    id: "importer", name: "Importer", rank: 4, status: "planned",
    desc: "Import notes from Notion, Evernote, Roam, Apple Notes and more.",
    repo: "https://github.com/obsidianmd/obsidian-importer",
    category: "Import", downloads: null,
    lucidPlan: "Import external notes/docs into the knowledge graph - through the scanner gate, labeled untrusted.",
  },
  {
    id: "advanced-uri", name: "Advanced URI", rank: 5, status: "planned",
    desc: "Deep links to control the app from outside (open, search, write).",
    repo: "https://github.com/Vinzent03/obsidian-advanced-uri",
    category: "Automation", downloads: null,
    lucidPlan: "lucid:// deep links to open a session, run a slash command, or launch a saved agent.",
  },
  {
    id: "zotero", name: "Zotero Integration", rank: 6, status: "planned",
    desc: "Insert citations, notes and annotations from Zotero.",
    repo: "https://github.com/mgmeyers/obsidian-zotero-integration",
    category: "Research", downloads: null,
    lucidPlan: "Pull citations/annotations into chat + knowledge graph for research-heavy workflows.",
  },
  {
    id: "languagetool", name: "LanguageTool", rank: 7, status: "planned",
    desc: "Grammar and style checking for your prose.",
    repo: "https://github.com/Clemens-E/obsidian-languagetool-plugin",
    category: "Writing", downloads: null,
    lucidPlan: "Grammar pass over drafted docs/briefs via a self-hosted LanguageTool endpoint (no cloud by default).",
  },
  {
    id: "mermaid", name: "Mermaid", rank: 8, status: "planned",
    desc: "Diagrams as code: flowcharts, sequence and architecture diagrams from plain text.",
    repo: "https://github.com/mermaid-js/mermaid",
    category: "Diagrams", downloads: null,
    lucidPlan: "Render agent-emitted mermaid blocks inline in chat and the sandboxed Preview panel - offline, no execution.",
  },
  {
    id: "gitleaks", name: "Gitleaks", rank: 9, status: "planned",
    desc: "Scan repos and commits for hardcoded secrets and credentials.",
    repo: "https://github.com/gitleaks/gitleaks",
    category: "Security", downloads: null,
    lucidPlan: "Pre-commit secret sweep wired into the exec gate; findings land as security events beside the vault.",
  },
  {
    id: "semgrep", name: "Semgrep", rank: 10, status: "planned",
    desc: "Fast static analysis with community security rules.",
    repo: "https://github.com/semgrep/semgrep",
    category: "Security", downloads: null,
    lucidPlan: "Static-analysis pass over agent-written code; findings surface in the security feed before anything ships.",
  },
  {
    id: "trivy", name: "Trivy", rank: 11, status: "planned",
    desc: "Vulnerability and misconfiguration scanner for dependencies, containers and IaC.",
    repo: "https://github.com/aquasecurity/trivy",
    category: "Security", downloads: null,
    lucidPlan: "On-demand dependency/SBOM scan; evidence exports beside the OCSF audit trail for CMMC/RMF packages.",
  },
  {
    id: "pandoc", name: "Pandoc", rank: 12, status: "planned",
    desc: "Universal document converter: markdown to DOCX, PDF, HTML and more.",
    repo: "https://github.com/jgm/pandoc",
    category: "Documents", downloads: null,
    lucidPlan: "Export briefs, ADRs and reports to DOCX/PDF fully offline - air-gap friendly deliverables.",
  },
];

/** Canonical order: featured pinned first, then rank asc (registry order), name as tiebreak. Pure. */
export function sortMarket(list: MarketPlugin[]): MarketPlugin[] {
  return [...list].sort((a, b) =>
    Number(b.status === "featured") - Number(a.status === "featured")
    || a.rank - b.rank
    || a.name.localeCompare(b.name));
}

/** Case-insensitive substring filter over name/desc/category/plan. Empty query → everything. Pure. */
export function filterMarket(list: MarketPlugin[], query: string): MarketPlugin[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter((p) =>
    p.name.toLowerCase().includes(q) || p.desc.toLowerCase().includes(q)
    || p.category.toLowerCase().includes(q) || p.lucidPlan.toLowerCase().includes(q));
}

/** 6_487_654 → "6.5M", 412_000 → "412K", null → "". Pure. */
export function fmtDownloads(n: number | null): string {
  if (n == null || n <= 0) return "";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return Math.round(n / 1_000) + "K";
  return String(n);
}

function statusChip(s: MarketStatus): string {
  return s === "featured" ? `<span class="mkt-chip mkt-featured">Featured</span>`
    : s === "built-in" ? `<span class="mkt-chip mkt-builtin">Built-in</span>`
    : `<span class="mkt-chip mkt-planned">Planned</span>`;
}

function row(p: MarketPlugin): string {
  const dl = fmtDownloads(p.downloads);
  return `<div class="mkt-row" data-mkt-id="${esc(p.id)}">
    <div class="mkt-main">
      <div class="mkt-name">${esc(p.name)}${statusChip(p.status)}<span class="mkt-cat">${esc(p.category)}</span>${dl ? `<span class="mkt-dl" title="Obsidian community downloads">${icon("download", 12)}${esc(dl)}</span>` : ""}</div>
      <div class="mkt-desc">${esc(p.desc)}</div>
      <div class="mkt-plan">${icon("bulb", 12)}${esc(p.lucidPlan)}</div>
    </div>
    <button class="mkt-repo" data-mkt-repo="${esc(p.repo)}" title="${esc(p.repo)}">View repo</button>
  </div>`;
}

/** Just the rows (sorted + filtered) — app.ts re-renders #mktList with this on every search keystroke. */
export function marketRowsHtml(list: MarketPlugin[], query: string): string {
  const shown = filterMarket(sortMarket(list), query);
  if (!shown.length) return `<div class="mkt-empty">No plugins match "${esc(query.trim())}"</div>`;
  return shown.map(row).join("");
}

/** The whole modal (header + search + list + footnote), rendered inside the scrim by app.ts. */
export function marketplaceHtml(list: MarketPlugin[], query: string): string {
  return `<div class="mkt-modal" role="dialog" aria-label="Plugin Marketplace">
    <div class="mkt-h">${icon("market", 18)}<span>Plugin Marketplace</span>
      <button class="mkt-close" data-mkt-close title="Close">${icon("close", 14)}</button></div>
    <div class="mkt-sub">Curated integrations: community favorites plus security, diagram and document tooling picked to fit LUCID. "View repo" opens the project on GitHub; installs land in a later increment - gated, like everything else.</div>
    <input id="mktSearch" class="mkt-search" type="text" placeholder="Search plugins…" autocomplete="off" spellcheck="false">
    <div id="mktList" class="mkt-list">${marketRowsHtml(list, query)}</div>
  </div>`;
}
