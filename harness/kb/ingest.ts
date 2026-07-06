// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/kb/ingest.ts
//
// P-KB.1 (ADR-0099): the security-load-bearing compile pipeline. This is the rule that separates a
// COMPILED KB from a poisoned one:
//   (1) SCAN the source fail-closed BEFORE any compilation — blocked ⇒ the document is `quarantined`,
//       recorded, and NEVER compiled (invariant #3, #5).
//   (2) COMPILE with the injected model (backend.complete) into candidate pages + links.
//   (3) RE-SCAN every model-generated page body fail-closed — a flagged page is quarantined and NEVER
//       stored (keystone #2: derived content never auto-promotes). Clean pages are stored `untrusted`
//       (never auto-`trusted`), and links are kept only between pages that actually survived.
// A dead scanner at either gate blocks (fail-closed by construction). `onBlock` is the audit hook (the
// desktop layer passes recordBlock) so this harness module never imports the desktop security log.

import type { ScannerClient } from "../security/scanner_client.ts";
import { DEFAULT_POLICY, type GateDecision, type GatePolicy, scanAndDecide } from "../security/gate.ts";
import { compileDocument } from "./compiler.ts";
import { type Classification, type KbGraphStore, sha256Hex } from "./store.ts";

export interface KbBlocked {
  stage: "source" | "page";
  slug?: string;
  reason: string;
  trustLabel: string;
  findings: number;
}

export interface KbIngestResult {
  documentId: string;
  status: "compiled" | "quarantined";
  pagesCompiled: number;
  pagesQuarantined: number;
  links: number;
  pageIds: string[];
  blocked: KbBlocked[];
}

export interface KbIngestArgs {
  store: KbGraphStore;
  scanner: ScannerClient;
  /** The model call (backend.complete), injected so the pipeline is model-agnostic + testable. */
  complete: (system: string, user: string) => Promise<string>;
  sourcePath: string;
  title: string;
  text: string;
  classification?: Classification;
  policy?: GatePolicy;
  /** Audit hook for a blocked source/page — desktop wiring passes recordBlock(). Never used to store. */
  onBlock?: (b: KbBlocked & { sourcePath: string; documentId: string }) => void;
}

/** scanAndDecide with a construction-throw guard: a scanner that throws (dead sidecar) fails CLOSED to a
 *  quarantine decision, never a pass (mirrors knowledge/ingest.ts). */
async function scan(scanner: ScannerClient, text: string, policy: GatePolicy): Promise<GateDecision> {
  try {
    return await scanAndDecide(scanner, text, policy);
  } catch (e) {
    return { block: true, reason: `scan threw: ${String((e as Error)?.message ?? e)}`, trustLabel: "quarantined", findings: [], failClosed: true };
  }
}

/**
 * Ingest + compile one document into the page graph, gating fail-closed at both the source and every
 * derived page. Returns a per-document summary; a quarantined source is recorded and never compiled, and
 * a flagged page is recorded and never stored (both audited via onBlock).
 */
export async function ingestDocument(args: KbIngestArgs): Promise<KbIngestResult> {
  const { store, scanner, complete, sourcePath, title, text } = args;
  const classification = args.classification ?? "U";
  const policy = args.policy ?? DEFAULT_POLICY;
  const blocked: KbBlocked[] = [];

  // (1) source gate — fail-closed BEFORE any compilation.
  const src = await scan(scanner, text, policy);
  if (src.block) {
    const documentId = await store.addDocument({ sourcePath, title, sha256: sha256Hex(text), classification, trustLabel: src.trustLabel, status: "quarantined" });
    await store.appendChangelog({ documentId, action: "quarantined", detail: `source blocked: ${src.reason}` });
    const b: KbBlocked = { stage: "source", reason: src.reason, trustLabel: src.trustLabel, findings: src.findings.length };
    blocked.push(b);
    args.onBlock?.({ ...b, sourcePath, documentId });
    return { documentId, status: "quarantined", pagesCompiled: 0, pagesQuarantined: 0, links: 0, pageIds: [], blocked };
  }

  const documentId = await store.addDocument({ sourcePath, title, sha256: sha256Hex(text), classification, trustLabel: src.trustLabel, status: "compiled" });
  await store.appendChangelog({ documentId, action: "ingested", detail: `source scanned ${src.trustLabel}` });

  // (2) compile (injected model).
  const compiled = await compileDocument(text, complete);
  await store.appendChangelog({ documentId, action: "compiled", detail: `model proposed ${compiled.pages.length} page(s), ${compiled.links.length} link(s)` });

  // (3) re-scan each derived page fail-closed; store ONLY the clean ones, as UNTRUSTED (keystone #2).
  const slugToId = new Map<string, string>();
  const pageIds: string[] = [];
  let pagesQuarantined = 0;
  let ordinal = 0;
  for (const page of compiled.pages) {
    const dec = await scan(scanner, page.body_md, policy);
    if (dec.block) {
      pagesQuarantined++;
      const b: KbBlocked = { stage: "page", slug: page.slug, reason: dec.reason, trustLabel: dec.trustLabel, findings: dec.findings.length };
      blocked.push(b);
      args.onBlock?.({ ...b, sourcePath, documentId });
      await store.appendChangelog({ documentId, action: "page_flagged", detail: `${page.slug}: ${dec.reason}` });
      continue; // NEVER store a flagged derived page
    }
    const pageId = await store.addPage({ kind: page.kind, slug: page.slug, title: page.title, bodyMd: page.body_md, trustLabel: "untrusted", classification });
    slugToId.set(page.slug, pageId);
    pageIds.push(pageId);
    await store.addPageSource({ pageId, documentId, ordinal: ordinal++ });
    await store.appendChangelog({ documentId, action: "page_added", detail: `${page.kind}:${page.slug}` });
  }

  // (4) links only between pages that BOTH survived the re-scan (a link to a quarantined page is dropped).
  let links = 0;
  for (const l of compiled.links) {
    const from = slugToId.get(l.from);
    const to = slugToId.get(l.to);
    if (!from || !to) continue;
    await store.addLink({ fromPageId: from, toPageId: to, relation: l.relation });
    links++;
  }

  return { documentId, status: "compiled", pagesCompiled: pageIds.length, pagesQuarantined, links, pageIds, blocked };
}
