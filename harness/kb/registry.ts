// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/kb/registry.ts — P-KGPACK.1 (ADR-0205): the named-KG registry.
//
// File-per-KG: each named knowledge graph is its OWN kb_graph.duckdb (the frozen 0011 migration set reused
// verbatim). This JSON registry is the ONLY new persisted structure and the ONLY place that maps a stable
// kg_id + a user-renamable name to that file. It is DATA, not a DuckDB table, so the frozen-schema invariant
// (#10) does not apply to it. The registry never scans, promotes, or trusts anything — all fail-closed
// security stays in the ingest pipeline (scan source + re-scan every derived page). kg_id is minted once via
// Snowflake and NEVER regenerated (invariant #9); `name` is the mutable, user-facing label.
//
// Robustness (not a security boundary): a MISSING registry file opens empty; a CORRUPT one throws rather
// than silently clobbering the user's KG list. We never `existsSync`-then-read (TOCTOU); we read and branch
// on the error code instead.

import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { Snowflake } from "@oh-my-pi/pi-utils";

/** How a KG was seeded. `manual` = created empty in-app; `pack` = imported from a signed .lkgpack. */
export type KgSourceKind = "chat" | "obsidian" | "pack" | "manual";

export interface KgEntry {
  kg_id: string;          // stable, minted once, never regenerated (#9)
  name: string;           // user-facing, renamable label
  db_path: string;        // absolute path to THIS KG's kb_graph.duckdb
  source_kind: KgSourceKind;
  read_only: boolean;     // packs import read-only; user KGs are writable
  provenance: string;     // free-text origin ("default", "ChatGPT export 2026-07", pack author, …)
  created_at: string;
  updated_at: string;
}

interface RegistryFile {
  version: 1;
  active_kg_id: string | null;
  entries: KgEntry[];
}

function nowIso(): string { return new Date().toISOString(); }

/** Coerce arbitrary parsed JSON into a well-formed RegistryFile (tolerant of older/edited shapes). */
function normalize(raw: unknown): RegistryFile {
  const o = (raw ?? {}) as Partial<RegistryFile>;
  const entries = Array.isArray(o.entries) ? (o.entries as KgEntry[]) : [];
  const active = typeof o.active_kg_id === "string" ? o.active_kg_id : null;
  // active must reference a real entry; otherwise fall back to the first (or null when empty)
  const activeValid = active && entries.some((e) => e.kg_id === active) ? active : (entries[0]?.kg_id ?? null);
  return { version: 1, active_kg_id: activeValid, entries };
}

export class KgRegistry {
  private constructor(private readonly path: string, private data: RegistryFile) {}

  /** Open the registry at `path`. A missing file starts empty; a corrupt file THROWS (never wipes). */
  static open(path: string): KgRegistry {
    let data: RegistryFile;
    try {
      data = normalize(JSON.parse(readFileSync(path, "utf8")));
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
        data = { version: 1, active_kg_id: null, entries: [] };
      } else {
        throw new Error(`KG registry at ${path} is unreadable/corrupt: ${(e as Error).message}`);
      }
    }
    return new KgRegistry(path, data);
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
    renameSync(tmp, this.path); // atomic swap over the live registry
  }

  /** All KGs, newest-created last (registry order). Returns copies — callers can't mutate internal state. */
  list(): KgEntry[] { return this.data.entries.map((e) => ({ ...e })); }

  get(kgId: string): KgEntry | undefined {
    const e = this.data.entries.find((x) => x.kg_id === kgId);
    return e ? { ...e } : undefined;
  }

  activeId(): string | null { return this.data.active_kg_id; }

  active(): KgEntry | undefined {
    return this.data.active_kg_id ? this.get(this.data.active_kg_id) : undefined;
  }

  /** Create a KG. Supply either an explicit `dbPath` (a pack's existing file) or a `dbPathFor` factory that
   *  derives the file from the freshly-minted kg_id (a new empty KG). The first KG created becomes active. */
  create(input: {
    name: string;
    dbPath?: string;
    dbPathFor?: (kgId: string) => string;
    sourceKind?: KgSourceKind;
    provenance?: string;
    readOnly?: boolean;
  }): KgEntry {
    const name = input.name.trim();
    if (!name) throw new Error("KG name must not be empty");
    const kg_id = Snowflake.next();
    const db_path = input.dbPath ?? input.dbPathFor?.(kg_id);
    if (!db_path) throw new Error("create: dbPath or dbPathFor is required");
    const now = nowIso();
    const entry: KgEntry = {
      kg_id, name, db_path,
      source_kind: input.sourceKind ?? "manual",
      read_only: input.readOnly ?? false,
      provenance: input.provenance ?? "",
      created_at: now, updated_at: now,
    };
    this.data.entries.push(entry);
    if (!this.data.active_kg_id) this.data.active_kg_id = kg_id;
    this.persist();
    return { ...entry };
  }

  /** Idempotent seed for the default KG: if ANY entry already points at `dbPath`, return it unchanged;
   *  otherwise create it. This is how today's single combined kb_graph.duckdb becomes the first named KG
   *  with zero data loss. */
  ensureDefault(input: { name: string; dbPath: string; provenance?: string }): KgEntry {
    const existing = this.data.entries.find((e) => e.db_path === input.dbPath);
    if (existing) return { ...existing };
    return this.create({ name: input.name, dbPath: input.dbPath, sourceKind: "manual", provenance: input.provenance ?? "default" });
  }

  /** Rename a KG (its kg_id and db_path are untouched — invariant #9). */
  rename(kgId: string, name: string): KgEntry {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("KG name must not be empty");
    const e = this.data.entries.find((x) => x.kg_id === kgId);
    if (!e) throw new Error(`unknown KG: ${kgId}`);
    e.name = trimmed;
    e.updated_at = nowIso();
    this.persist();
    return { ...e };
  }

  /** Set the active KG (the one a no-arg store lookup resolves to). */
  setActive(kgId: string): void {
    if (!this.data.entries.some((x) => x.kg_id === kgId)) throw new Error(`unknown KG: ${kgId}`);
    this.data.active_kg_id = kgId;
    this.persist();
  }
}
