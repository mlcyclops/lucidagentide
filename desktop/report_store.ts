// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/report_store.ts
//
// P-REPORT.1 (ADR-0116): a durable store for generated Engineering Update BRIEFS, so the Reports panel can
// list past briefs alongside the per-workspace loop After-Action Reports (which are already files under
// `<workspace>/.omp/loops/`). Briefs are repo-wide (built from the app repo's DECISIONS/PROGRESS), so they
// live in a GLOBAL store at `~/.omp/lucid-briefs/`, keyed by mint time + role.
//
// Best-effort + confined (pathWithin): a failed write never breaks generation; a traversal rel is rejected.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathWithin } from "./path_guard.ts";

const BRIEF_ROOT = join(homedir(), ".omp", "lucid-briefs");
const BRIEF_ARCHIVE = join(BRIEF_ROOT, "archived"); // P-REPORT.2: soft-deleted briefs move here

export interface BriefRecord { id: string; role: string; title: string; updatedAt: number; rel: string }

function slug(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "brief";
}

/** Save a generated brief's markdown. `id`/`role` come from the caller (dev.ts mints the id via Date.now).
 *  Returns the store-relative filename on success, else null. */
export function saveBrief(id: string, role: string, markdown: string): string | null {
  const file = `${id}-${slug(role)}.md`;
  const target = pathWithin(BRIEF_ROOT, join(BRIEF_ROOT, file));
  if (!target) return null;
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, markdown, "utf8");
    return file;
  } catch { return null; }
}

/** List saved briefs (most-recent first). `archived` reads the archive folder instead of the active one.
 *  Title = the first `# ` heading; role is parsed from the filename. */
export function listBriefs(limit = 50, archived = false): BriefRecord[] {
  const base = archived ? BRIEF_ARCHIVE : BRIEF_ROOT;
  if (!existsSync(base)) return [];
  let files: string[];
  try { files = readdirSync(base); } catch { return []; }
  const out: BriefRecord[] = [];
  for (const f of files) {
    if (!f.endsWith(".md")) continue; // the `archived/` subdir is a dir, not a .md — naturally skipped in active
    const target = pathWithin(base, join(base, f));
    if (!target) continue;
    try {
      const md = readFileSync(target, "utf8");
      const title = /^#\s+(.+)$/m.exec(md)?.[1]?.trim() ?? "Engineering Update";
      const m = /^([a-z0-9]+)-(.+)\.md$/i.exec(f);
      out.push({ id: m?.[1] ?? f, role: m?.[2] ?? "", title: title.slice(0, 120), updatedAt: statSync(target).mtimeMs, rel: f });
    } catch { /* skip unreadable */ }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out.slice(0, Math.max(0, limit));
}

/** Read one saved brief's markdown (active or archived; confined + traversal-rejected). Null if missing. */
export function readBrief(rel: string, archived = false): string | null {
  const base = archived ? BRIEF_ARCHIVE : BRIEF_ROOT;
  const target = pathWithin(base, join(base, rel));
  if (!target) return null;
  try { return readFileSync(target, "utf8"); } catch { return null; }
}

// P-REPORT.2 (ADR-0117): two-stage lifecycle - archive (soft) then permanent delete (only from archive).
function moveBrief(rel: string, fromBase: string, toBase: string): boolean {
  const src = pathWithin(fromBase, join(fromBase, rel));
  const dst = pathWithin(toBase, join(toBase, rel));
  if (!src || !dst) return false;
  try { mkdirSync(dirname(dst), { recursive: true }); renameSync(src, dst); return true; } catch { return false; }
}
/** Soft-delete: move an active brief into the archive. */
export function archiveBrief(rel: string): boolean { return moveBrief(rel, BRIEF_ROOT, BRIEF_ARCHIVE); }
/** Restore an archived brief back to active. */
export function restoreBrief(rel: string): boolean { return moveBrief(rel, BRIEF_ARCHIVE, BRIEF_ROOT); }
/** Permanent delete - ONLY from the archive (the second "delete"). Never touches an active brief. */
export function deleteBrief(rel: string): boolean {
  const target = pathWithin(BRIEF_ARCHIVE, join(BRIEF_ARCHIVE, rel));
  if (!target) return false;
  try { rmSync(target); return true; } catch { return false; } // NO force: a missing (i.e. not-archived) file → false
}
