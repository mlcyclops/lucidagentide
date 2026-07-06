// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/kb/sync.ts
//
// P-KB.2 (ADR-0100): the "kept in sync" generator. Re-ingesting a source re-runs the P-KB.1 GATED
// pipeline (scan → compile → re-scan → store) and keeps the substrate auditable:
//   • IDEMPOTENT on an unchanged sha256 — a re-sync of the same bytes is a no-op (no duplicate compile).
//   • On a CHANGED source, re-compile, and any page whose slug already existed with a DIFFERENT body is
//     flagged as a CONTRADICTION in kb_changelog for review — the prior page is RETAINED, never silently
//     overwritten (the OpenKB "sync" rule; a conflicting fact surfaces, it doesn't clobber).
//
// SECURITY: sync writes ONLY through ingestDocument (the fail-closed gated path) — a changed-but-poisoned
// source is still quarantined, and derived pages are still re-scanned. This module adds no new trust path.

import { ingestDocument, type KbIngestArgs, type KbIngestResult } from "./ingest.ts";
import { sha256Hex } from "./store.ts";

export interface SyncResult {
  changed: boolean;
  reason: string;
  documentId?: string;
  ingest?: KbIngestResult;
  contradictions: { slug: string }[];
}

/**
 * Re-ingest a source, keeping the compiled KB in sync. No-op when the source's sha256 matches the last
 * ingested version (idempotent). On a change, re-compiles through the gate and flags any slug whose body
 * differs from a prior page as a contradiction (recorded, prior page retained). Same args as ingest.
 */
export async function syncDocument(args: KbIngestArgs): Promise<SyncResult> {
  const { store, sourcePath, text } = args;
  const sha = sha256Hex(text);

  const existing = await store.getDocumentBySourcePath(sourcePath);
  if (existing && existing.sha256 === sha) {
    return { changed: false, reason: "unchanged (sha256 match)", documentId: existing.document_id, contradictions: [] };
  }

  // Snapshot the current page bodies by slug BEFORE re-compiling, so we can flag a changed slug.
  const before = new Map<string, string>();
  for (const p of await store.listPages()) before.set(p.slug, p.body_md);

  const ingest = await ingestDocument(args);

  const contradictions: { slug: string }[] = [];
  if (ingest.status === "compiled") {
    const newlyStored = new Set(ingest.pageIds);
    for (const p of await store.listPages()) {
      if (!newlyStored.has(p.page_id)) continue;
      const prior = before.get(p.slug);
      if (prior !== undefined && prior !== p.body_md) {
        contradictions.push({ slug: p.slug });
        await store.appendChangelog({ documentId: ingest.documentId, action: "contradiction", detail: `page ${p.slug} changed on re-sync — flagged for review (prior page retained)` });
      }
    }
    await store.appendChangelog({ documentId: ingest.documentId, action: "resynced", detail: `re-compiled ${sourcePath}: ${ingest.pagesCompiled} page(s), ${contradictions.length} contradiction(s)` });
  }

  return { changed: true, reason: existing ? "source changed" : "new source", documentId: ingest.documentId, ingest, contradictions };
}
