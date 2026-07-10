// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/kb/batch_ingest.ts — P-KGPACK.3 (ADR-0205): seed ONE named KG from many source documents.
//
// The picker (P-KGPACK.2) makes a KG selectable; this makes a KG SEEDABLE — from a folder of AI-vendor
// conversations (ChatGPT/Claude/Gemini) or Obsidian markdown, each source becomes one document compiled into
// the TARGET KG's page graph. It is a thin, faithful loop over `ingestDocument`: every security guarantee is
// inherited unchanged — each source is scan-gated fail-closed BEFORE compilation, every derived page is
// re-scanned, a flagged source/page is quarantined and NEVER stored (keystone #2), and a dead scanner blocks
// (invariant #3). This module adds only batching concerns: a bounded count (never silent), per-document
// progress, and cancellation at a document boundary (a cancelled run keeps what already compiled — fail-safe).

import type { ScannerClient } from "../security/scanner_client.ts";
import type { GatePolicy } from "../security/gate.ts";
import { ingestDocument, type KbBlocked } from "./ingest.ts";
import type { Classification, KbGraphStore } from "./store.ts";

/** One source to compile into the KG (a conversation transcript, a markdown note, …). */
export interface KbSourceDoc { sourcePath: string; title: string; text: string }

export interface KbBatchProgress {
  documents: number;          // documents finished so far
  totalDocuments: number;     // documents that WILL be processed (after the cap)
  pagesCompiled: number;
  pagesQuarantined: number;
  documentsQuarantined: number;
  errored: number;
}

export interface KbBatchResult {
  documents: number;          // documents actually processed
  totalDocuments: number;     // documents that WILL be processed (after the cap)
  available: number;          // documents found in the source (before the cap)
  skipped: number;            // documents NOT processed because the cap was hit (never silent)
  pagesCompiled: number;
  pagesQuarantined: number;
  documentsQuarantined: number; // SECURITY: source/all-pages blocked by the scanner (fail-closed)
  errored: number;              // a doc whose compile threw (e.g. model/backend outage) — NOT admitted, not a scan block
  links: number;
  cancelled: boolean;
}

export interface KbBatchArgs {
  store: KbGraphStore;
  scanner: ScannerClient;
  /** The model call (backend.complete), injected so the pipeline is model-agnostic + testable. */
  complete: (system: string, user: string) => Promise<string>;
  docs: KbSourceDoc[];
  classification?: Classification;
  policy?: GatePolicy;
  /** Bound the model cost; documents beyond the cap are `skipped` (counted, never dropped silently). */
  maxDocuments?: number;
  onProgress?: (p: KbBatchProgress) => void;
  signal?: AbortSignal;
  /** Audit hook for a blocked source/page (desktop wiring passes recordBlock). Never used to store. */
  onBlock?: (b: KbBlocked & { sourcePath: string; documentId: string }) => void;
}

/**
 * Compile a list of source documents into the target KG store, one at a time. Fail-closed per document
 * (inherited from `ingestDocument`); a poisoned document quarantines without stopping the batch, a dead
 * scanner quarantines every document, and cancellation stops at the next document boundary keeping what
 * already compiled.
 */
export async function ingestSourcesIntoKg(args: KbBatchArgs): Promise<KbBatchResult> {
  const cap = args.maxDocuments ?? Infinity;
  const available = args.docs.length;
  const totalDocuments = Math.min(available, cap === Infinity ? available : cap);
  let documents = 0, pagesCompiled = 0, pagesQuarantined = 0, documentsQuarantined = 0, errored = 0, links = 0, cancelled = false;

  const tick = () => args.onProgress?.({ documents, totalDocuments, pagesCompiled, pagesQuarantined, documentsQuarantined, errored });
  tick(); // emit 0/total so a UI can render a countdown immediately

  for (const doc of args.docs) {
    if (args.signal?.aborted) { cancelled = true; break; }   // cancel at a document boundary — fail-safe
    if (documents >= cap) break;                              // the remainder becomes `skipped` below
    documents++;
    try {
      const r = await ingestDocument({
        store: args.store, scanner: args.scanner, complete: args.complete,
        sourcePath: doc.sourcePath, title: doc.title, text: doc.text,
        classification: args.classification, policy: args.policy, onBlock: args.onBlock,
      });
      if (r.status === "quarantined") documentsQuarantined++;
      pagesCompiled += r.pagesCompiled;
      pagesQuarantined += r.pagesQuarantined;
      links += r.links;
    } catch {
      // A compile/store throw (e.g. model/backend outage) must not abort the whole batch or admit the doc;
      // count it and move on. This is NOT a security bypass — the scanner path already fails CLOSED inside
      // ingestDocument (a dead scanner returns a quarantine decision, it does not throw here).
      errored++;
    }
    tick();
  }

  // Anything not processed is `skipped`, never dropped silently: on a cancel that's the unreached tail;
  // otherwise it's the over-cap remainder.
  const skipped = cancelled ? available - documents : Math.max(0, available - totalDocuments);
  return {
    documents, totalDocuments, available, skipped,
    pagesCompiled, pagesQuarantined, documentsQuarantined, errored, links, cancelled,
  };
}
