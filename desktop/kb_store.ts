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

/** All KGs for the picker (registry order). */
export function listKgs(): KgEntry[] { return kgRegistry().list(); }

/** The active KG's id (what a no-arg `kbStore()` resolves to). */
export function activeKgId(): string | null { return kgRegistry().activeId(); }

/** Create a new, empty KG whose file lives beside the default KG, keyed by its minted kg_id. */
export function createKg(input: { name: string; sourceKind?: KgSourceKind; provenance?: string }): KgEntry {
  const dir = dirname(defaultKbPath());
  return kgRegistry().create({
    name: input.name,
    dbPathFor: (id) => join(dir, `kg_${id}.duckdb`),
    sourceKind: input.sourceKind ?? "manual",
    provenance: input.provenance ?? "",
  });
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
  stores.clear();
  registry = null;
}

/** Test-only: drop the cached stores + registry so the next call re-resolves from the configured paths. */
export function _resetKbStoreForTest(): void { stores.clear(); registry = null; }
