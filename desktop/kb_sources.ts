// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/kb_sources.ts — P-KGPACK.3 (ADR-0205): turn a folder into KB source documents.
//
// Two shapes seed a named KG: an AI-vendor chat export (ChatGPT/Claude/Gemini) or an Obsidian-style markdown
// vault. This reader normalises both to `KbSourceDoc[]` (sourcePath/title/text) for the fail-closed batch
// compiler — it does NOT scan or trust anything (that is the pipeline's job). Vendor parsing reuses the
// existing TOCTOU-safe `loadExportData` + `parseExport`; markdown reading walks the folder ONCE per
// directory and reads files directly (no `existsSync`-then-read), bounded in file count + depth so a huge or
// hostile tree can't wedge the app.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, basename, sep } from "node:path";
import { loadExportData } from "./personal.ts";
import { parseExport, type ImportVendor } from "../harness/personal/import_adapters.ts";
import type { KbSourceDoc } from "../harness/kb/batch_ingest.ts";

export interface KbSourceScan {
  kind: "chat" | "obsidian";
  vendor?: ImportVendor;      // set when kind === "chat"
  docs: KbSourceDoc[];
}

const MAX_MD_FILES = 2000;    // a KG pack is curated, not a whole disk; cap the walk (never silent — see skipped)
const MAX_DEPTH = 8;
const SKIP_DIRS = new Set([".obsidian", ".git", ".trash", "node_modules", ".venv", "__pycache__"]);

/** Flatten one parsed conversation into a single markdown-ish document (both sides — a KB learns from the
 *  whole transcript, unlike the personal graph which only distils the user's own words). */
function conversationToDoc(convo: { title: string; messages: { role: "user" | "assistant"; text: string }[] }, vendor: ImportVendor, i: number): KbSourceDoc {
  const title = convo.title.trim() || `Conversation ${i + 1}`;
  const body = convo.messages
    .filter((m) => m.text.trim())
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text.trim()}`)
    .join("\n\n");
  return { sourcePath: `chat:${vendor}#${i}`, title, text: `# ${title}\n\n${body}` };
}

/** Recursively collect `.md`/`.markdown` files under `root`, bounded. Reads each listing once; a file that
 *  can't be read is skipped, not fatal. Returns docs in a stable (sorted) order. */
function readMarkdownVault(root: string): KbSourceDoc[] {
  const docs: KbSourceDoc[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH || docs.length >= MAX_MD_FILES) return;
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (docs.length >= MAX_MD_FILES) return;
      if (e.name.startsWith(".")) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(full, depth + 1); continue; }
      if (!/\.(md|markdown)$/i.test(e.name)) continue;
      let text: string;
      try { text = readFileSync(full, "utf8"); } catch { continue; }
      if (!text.trim()) continue;
      const rel = relative(root, full).split(sep).join("/");
      docs.push({ sourcePath: `obsidian:${rel}`, title: basename(e.name).replace(/\.(md|markdown)$/i, ""), text });
    }
  };
  walk(root, 0);
  return docs;
}

/** Resolve a folder into KB source documents: a chat export first (it is the more specific shape), then a
 *  markdown vault. Returns a friendly error when neither is present. */
export function readKbSources(path: string): { ok: true; scan: KbSourceScan } | { ok: false; error: string } {
  const p = path.trim();
  if (!p) return { ok: false, error: "No folder was chosen." };

  // 1) AI-vendor chat export (reuses the shard-aware, TOCTOU-safe loader + parser).
  const data = loadExportData(p);
  if (data.ok) {
    try {
      const parsed = parseExport(data.data);
      const docs = parsed.conversations.map((c, i) => conversationToDoc(c, parsed.vendor, i)).filter((d) => d.text.trim());
      if (docs.length) return { ok: true, scan: { kind: "chat", vendor: parsed.vendor, docs } };
    } catch { /* not a recognisable export → fall through to markdown */ }
  }

  // 2) Obsidian-style markdown vault.
  const md = readMarkdownVault(p);
  if (md.length) return { ok: true, scan: { kind: "obsidian", docs: md } };

  return { ok: false, error: "No chat export (ChatGPT/Claude/Gemini) or markdown (.md) files found in that folder." };
}
