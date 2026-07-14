// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/kb_store.ts — P-KB.2b (ADR-0099/0100) + P-KGPACK.1 (ADR-0205): the desktop's handle to the
// compiled knowledge base(s). The compiled KB is no longer a SINGLE combined file — it is now a set of
// named KGs, one kb_graph.duckdb per KG (frozen 0011 reused), indexed by a JSON registry (KgRegistry).
// `kbStore(kgId?)` resolves a KG's file from the registry and returns a per-KG cached KbGraphStore (still
// one writer per file). A default "My Knowledge" KG is auto-registered onto the pre-existing
// ~/.omp/kb_graph.duckdb, so today's combined graph is preserved with zero data loss as the first entry.
//
// Paths are overridable for demos/tests: LUCID_KB_DB_PATH (the default KG's file) and LUCID_KG_REGISTRY_PATH
// (the registry JSON; defaults to a sibling of the default KG file). SECURITY is unchanged: this module only
// OPENS stores + the scanner; the fail-closed gating lives in the harness ingest pipeline.

import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { KbGraphStore } from "../harness/kb/store.ts";
import { KnowledgeStore } from "../harness/knowledge/store.ts"; // ADR-0215: the per-KG VECTOR store (semantic)
import type { Embedder } from "../harness/knowledge/embedder.ts";
import { KgRegistry, type KgEntry, type KgSourceKind } from "../harness/kb/registry.ts";
import { ScannerClient } from "../harness/security/scanner_client.ts";

const DEFAULT_KB_DB = join(homedir(), ".omp", "kb_graph.duckdb");

/** The default KG's file — the pre-existing combined kb_graph.duckdb (env-overridable for demos/tests). */
function defaultKbPath(): string { return process.env.LUCID_KB_DB_PATH || DEFAULT_KB_DB; }
/** The registry JSON — a sibling of the default KG file unless explicitly overridden. */
function registryPath(): string {
  return process.env.LUCID_KG_REGISTRY_PATH || join(dirname(defaultKbPath()), "kg_registry.json");
}

let registry: KgRegistry | null = null;
/** The process-wide KG registry, seeded once with the default "My Knowledge" KG. */
function kgRegistry(): KgRegistry {
  if (!registry) {
    registry = KgRegistry.open(registryPath());
    registry.ensureDefault({ name: "My Knowledge", dbPath: defaultKbPath(), provenance: "default" });
  }
  return registry;
}

const stores = new Map<string, Promise<KbGraphStore>>();
/** The compiled-KB store for a KG (default: the active KG). One writer per KG file, cached by kg_id. */
export function kbStore(kgId?: string): Promise<KbGraphStore> {
  const reg = kgRegistry();
  const id = kgId || reg.activeId();
  if (!id) throw new Error("no active KG (registry seed failed)"); // ensureDefault guarantees one
  const entry = reg.get(id);
  if (!entry) throw new Error(`unknown KG: ${id}`);
  let p = stores.get(id);
  if (!p) { p = KbGraphStore.open(entry.db_path); stores.set(id, p); }
  return p;
}

const vecStores = new Map<string, Promise<KnowledgeStore>>();
/** ADR-0215: the per-KG VECTOR store for SEMANTIC search — a sibling `_vec.duckdb` beside the KG's compiled
 *  graph. Opened lazily + cached (one writer per file); empty until semantic ingest writes to it. */
export function knowledgeVectorStore(kgId?: string): Promise<KnowledgeStore> {
  const reg = kgRegistry();
  const id = kgId || reg.activeId();
  if (!id) throw new Error("no active KG (registry seed failed)");
  const entry = reg.get(id);
  if (!entry) throw new Error(`unknown KG: ${id}`);
  let p = vecStores.get(id);
  if (!p) { p = KnowledgeStore.open(entry.db_path.replace(/\.duckdb$/i, "_vec.duckdb")); vecStores.set(id, p); }
  return p;
}
/** ADR-0215: find-or-create the KG's vector dataset matching the CURRENT embedder's model + dim. A model change
 *  creates a NEW dataset (old vectors stay but aren't queried) so vector spaces never mix at retrieval. */
export async function vectorDatasetFor(store: KnowledgeStore, name: string, embedder: Embedder): Promise<string> {
  const existing = (await store.listDatasets()).find((d) => d.embedding_model === embedder.id && d.dim === embedder.dim);
  if (existing) return existing.dataset_id;
  return (await store.createDataset({ name, classification: "U", source: "local", embeddingModel: embedder.id, dim: embedder.dim })).dataset_id;
}

/** All KGs for the picker (registry order). */
export function listKgs(): KgEntry[] { return kgRegistry().list(); }

/** The active KG's id (what a no-arg `kbStore()` resolves to). */
export function activeKgId(): string | null { return kgRegistry().activeId(); }

/** Create a new, empty KG whose file lives beside the default KG, keyed by its minted kg_id. `readOnly`
 *  marks an imported pack (P-KGPACK.4) so the UI shows the lock and edits are refused. */
export function createKg(input: { name: string; sourceKind?: KgSourceKind; provenance?: string; readOnly?: boolean }): KgEntry {
  const dir = dirname(defaultKbPath());
  return kgRegistry().create({
    name: input.name,
    dbPathFor: (id) => join(dir, `kg_${id}.duckdb`),
    sourceKind: input.sourceKind ?? "manual",
    provenance: input.provenance ?? "",
    readOnly: input.readOnly ?? false,
  });
}

/** The full registry entry for a KG (incl. its server-only db_path). Used by pack export. */
export function kgEntry(kgId: string): KgEntry | undefined { return kgRegistry().get(kgId); }

/** Close + drop a single KG's cached store, flushing its DuckDB file to disk (so pack export reads a
 *  complete file). A later kbStore(kgId) reopens it. */
export async function closeKg(kgId: string): Promise<void> {
  const p = stores.get(kgId);
  if (p) { try { (await p).close(); } catch { /* ignore */ } stores.delete(kgId); }
  const v = vecStores.get(kgId); // ADR-0215: also flush the sibling vector store
  if (v) { try { (await v).close(); } catch { /* ignore */ } vecStores.delete(kgId); }
}

/** Rename a KG (kg_id + file untouched). */
export function renameKg(kgId: string, name: string): KgEntry { return kgRegistry().rename(kgId, name); }

/** Switch the active KG. */
export function setActiveKg(kgId: string): void { kgRegistry().setActive(kgId); }

let scanner: ScannerClient | null = null;
/** The shared scanner sidecar for KB ingest (fail-closed: a dead scanner quarantines in the pipeline). */
export function kbScanner(): ScannerClient {
  if (!scanner) { scanner = new ScannerClient(); scanner.start(); }
  return scanner;
}

/** Tear down the scanner + close every open KG store (demo/test teardown). */
export async function stopKb(): Promise<void> {
  try { scanner?.stop(); } catch { /* ignore */ }
  scanner = null;
  for (const p of stores.values()) { try { (await p).close(); } catch { /* ignore */ } }
  for (const v of vecStores.values()) { try { (await v).close(); } catch { /* ignore */ } } // ADR-0215
  stores.clear();
  vecStores.clear();
  registry = null;
}

/** Test-only: drop the cached stores + registry so the next call re-resolves from the configured paths. */
export function _resetKbStoreForTest(): void { stores.clear(); vecStores.clear(); registry = null; }
