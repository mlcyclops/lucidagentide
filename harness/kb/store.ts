// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/kb/store.ts
//
// P-KB.1 (ADR-0099): the compiled knowledge-graph store. Wraps a SEPARATE kb_graph.duckdb (its own frozen
// migration set, 0011) — a SIBLING to the vector store (harness/knowledge) and independent of
// agent_obs.duckdb, so a workspace may use the compiled KB, the vector KB, or both (ADR-0100 routes).
//
// This is a plain typed CRUD layer over the page graph (documents · pages · links · sources · changelog).
// The SECURITY invariants live in ingest.ts (scan the source + re-scan every derived page fail-closed);
// this store only persists what ingest decided to keep. A stored derived page is written `untrusted`,
// never auto-`trusted` (keystone #2) — the caller passes that label; the store never invents trust.

import { join } from "node:path";
import { createHash } from "node:crypto";
import { Snowflake } from "@oh-my-pi/pi-utils";
import type { TrustLabel } from "../contracts.ts";
import { Db } from "../memory/db.ts";

export const KB_MIGRATIONS_DIR = join(import.meta.dir, "migrations");

export type Classification = "U" | "CUI";
export type DocumentStatus = "compiled" | "quarantined" | "stale";
export type PageKind = "summary" | "concept" | "entity" | "source";

export interface KbDocument {
  document_id: string;
  source_path: string;
  title: string;
  sha256: string;
  classification: Classification;
  trust_label: string;
  status: DocumentStatus;
  ingested_at: string;
}

export interface KbPage {
  page_id: string;
  kind: PageKind;
  slug: string;
  title: string;
  body_md: string;
  trust_label: string;
  classification: Classification;
  created_at: string;
  updated_at: string;
}

export interface KbLink {
  link_id: string;
  from_page_id: string;
  to_page_id: string;
  relation: string;
  created_at: string;
}

/** sha256 hex of a source's text — the document's version identity (idempotent re-ingest). */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export class KbGraphStore {
  private constructor(private readonly db: Db) {}

  /** Open (or create) kb_graph.duckdb at `path` and apply the compiled-KB migration set. */
  static async open(path: string): Promise<KbGraphStore> {
    return new KbGraphStore(await Db.open(path, KB_MIGRATIONS_DIR));
  }

  close(): void { this.db.close(); }

  async addDocument(d: { sourcePath: string; title: string; sha256: string; classification: Classification; trustLabel: string; status: DocumentStatus }): Promise<string> {
    const document_id = Snowflake.next();
    await this.db.run(
      "INSERT INTO kb_documents VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [document_id, d.sourcePath, d.title, d.sha256, d.classification, d.trustLabel, d.status, new Date().toISOString()],
    );
    return document_id;
  }

  async setDocumentStatus(documentId: string, status: DocumentStatus): Promise<void> {
    await this.db.run("UPDATE kb_documents SET status = $2 WHERE document_id = $1", [documentId, status]);
  }

  async getDocument(id: string): Promise<KbDocument | undefined> {
    return (await this.db.get("SELECT * FROM kb_documents WHERE document_id = $1", [id])) as KbDocument | undefined;
  }

  /** The most-recently-ingested document for a source path (used by sync for sha256 idempotency). */
  async getDocumentBySourcePath(sourcePath: string): Promise<KbDocument | undefined> {
    return (await this.db.get("SELECT * FROM kb_documents WHERE source_path = $1 ORDER BY ingested_at DESC LIMIT 1", [sourcePath])) as KbDocument | undefined;
  }

  /** Insert one already-re-scanned page and mint its id. `trustLabel` is the caller's decision — for a
   *  fresh derived page it is `untrusted` (keystone #2), never `trusted`. */
  async addPage(p: { kind: PageKind; slug: string; title: string; bodyMd: string; trustLabel: TrustLabel; classification: Classification }): Promise<string> {
    const page_id = Snowflake.next();
    const now = new Date().toISOString();
    await this.db.run(
      "INSERT INTO kb_pages VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [page_id, p.kind, p.slug, p.title, p.bodyMd, p.trustLabel, p.classification, now, now],
    );
    return page_id;
  }

  async addLink(l: { fromPageId: string; toPageId: string; relation?: string }): Promise<string> {
    const link_id = Snowflake.next();
    await this.db.run(
      "INSERT INTO kb_links VALUES ($1,$2,$3,$4,$5)",
      [link_id, l.fromPageId, l.toPageId, l.relation || "related", new Date().toISOString()],
    );
    return link_id;
  }

  async addPageSource(s: { pageId: string; documentId: string; ordinal: number; quote?: string }): Promise<string> {
    const source_id = Snowflake.next();
    await this.db.run(
      "INSERT INTO kb_page_sources VALUES ($1,$2,$3,$4,$5)",
      [source_id, s.pageId, s.documentId, Math.max(0, Math.floor(s.ordinal)), s.quote ?? null],
    );
    return source_id;
  }

  async appendChangelog(c: { documentId?: string | null; action: string; detail: string }): Promise<void> {
    await this.db.run(
      "INSERT INTO kb_changelog VALUES ($1,$2,$3,$4,$5)",
      [Snowflake.next(), c.documentId ?? null, c.action, c.detail, new Date().toISOString()],
    );
  }

  async listPages(kind?: PageKind): Promise<KbPage[]> {
    return (kind
      ? await this.db.all("SELECT * FROM kb_pages WHERE kind = $1 ORDER BY created_at", [kind])
      : await this.db.all("SELECT * FROM kb_pages ORDER BY created_at")) as unknown as KbPage[];
  }

  async listLinks(): Promise<KbLink[]> {
    return (await this.db.all("SELECT * FROM kb_links ORDER BY created_at")) as unknown as KbLink[];
  }

  async pageCount(): Promise<number> {
    const r = await this.db.get("SELECT count(*) AS n FROM kb_pages");
    return Number(r?.n ?? 0);
  }

  async changelog(documentId?: string): Promise<{ action: string; detail: string; created_at: string }[]> {
    const rows = documentId
      ? await this.db.all("SELECT action, detail, created_at FROM kb_changelog WHERE document_id = $1 ORDER BY created_at", [documentId])
      : await this.db.all("SELECT action, detail, created_at FROM kb_changelog ORDER BY created_at");
    return rows.map((r) => ({ action: String(r.action), detail: String(r.detail), created_at: String(r.created_at) }));
  }
}
