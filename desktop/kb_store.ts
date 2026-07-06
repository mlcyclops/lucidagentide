// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/kb_store.ts — P-KB.2b (ADR-0099/0100 desktop plumbing): the desktop's handle to the compiled
// knowledge base. Opens ONE kb_graph.duckdb (single writer for this process) lazily and hands the
// dev-server routes a shared KbGraphStore + a shared scanner for the gated ingest pipeline.
//
// The compiled KB is a SEPARATE DuckDB file (harness/kb migrations), a sibling to the vector store and to
// agent_obs.duckdb — no write-lock contention. Path is overridable (LUCID_KB_DB_PATH) for demos/tests.
// SECURITY: this module only OPENS the store + the scanner; the fail-closed gating lives in the harness
// ingest pipeline (scan source + re-scan every derived page). A single lazy scanner mirrors skills_import.

import { join } from "node:path";
import { homedir } from "node:os";
import { KbGraphStore } from "../harness/kb/store.ts";
import { ScannerClient } from "../harness/security/scanner_client.ts";

const DEFAULT_KB_DB = join(homedir(), ".omp", "kb_graph.duckdb");

let storeP: Promise<KbGraphStore> | null = null;
/** The process-wide compiled-KB store (opened + migrated once). */
export function kbStore(): Promise<KbGraphStore> {
  if (!storeP) storeP = KbGraphStore.open(process.env.LUCID_KB_DB_PATH || DEFAULT_KB_DB);
  return storeP;
}

let scanner: ScannerClient | null = null;
/** The shared scanner sidecar for KB ingest (fail-closed: a dead scanner quarantines in the pipeline). */
export function kbScanner(): ScannerClient {
  if (!scanner) { scanner = new ScannerClient(); scanner.start(); }
  return scanner;
}

/** Tear down the scanner + close the store (demo/test teardown). */
export async function stopKb(): Promise<void> {
  try { scanner?.stop(); } catch { /* ignore */ }
  scanner = null;
  if (storeP) { try { (await storeP).close(); } catch { /* ignore */ } storeP = null; }
}

/** Test-only: point at a fresh DB path without reusing the cached open. */
export function _resetKbStoreForTest(): void { storeP = null; }
