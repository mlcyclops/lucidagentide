// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/oauth_rows_target.ts - P-VAULT-KEYS.2 (ADR-0480): which credential table LUCID's account
// features (auth_vault.ts, auth_status.ts) read and write.
//
// With the OAuth vault on, omp's credential rows live in the engine's VaultAuthCredentialStore
// (oauth_vault_store.ts): an in-memory table with omp's own `auth_credentials` schema, sealed row by row
// into the engine vault. This module only holds the handle to that table, so the helpers that used to
// open ~/.omp/agent/agent.db run the same SQL against it without importing the store (and pi-ai) itself.
// No target registered = the old path (agent.db): the kill switch, a refused vault, tests and tools.

import type { Database } from "bun:sqlite";

export interface OauthRowsTarget {
  /** The live credential table, omp's `auth_credentials` schema. Read through it directly. */
  readonly db: Database;
  /** Run a write against `db` and seal the result into the vault. Throws, with the table restored to what
   *  it held before, when the vault refuses the write (fail-closed: nothing is kept that is not sealed). */
  write<T>(fn: (db: Database) => T): T;
}

let target: OauthRowsTarget | null = null;

/** Register (or clear, with null) the vault-backed credential table. */
export function setOauthRowsTarget(t: OauthRowsTarget | null): void {
  target = t;
}

/** The vault-backed credential table, or null when credentials are on the agent.db path. */
export function oauthRowsTarget(): OauthRowsTarget | null {
  return target;
}
