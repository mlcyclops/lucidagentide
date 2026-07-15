// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/auth_vault.ts - a narrow, read-before-write helper over omp's credential vault
// (~/.omp/agent/agent.db, table `auth_credentials`).
//
// Why this exists: omp's `auth-broker login` writes a fresh OAuth token but does NOT clear a stale
// `disabled_cause` left by a prior `auth-broker logout` ("logged out by user"). omp only counts a
// credential as active when that column is null, so a valid, just-fetched token stays ignored - and
// because `logout` disables (rather than deletes) the row, re-clicking "Connect via OAuth" can never
// escape it. We compensate by clearing ONLY that flag after a successful login (see dev.ts), and via a
// one-shot CLI (tools/omp_auth_reenable.ts).
//
// This NEVER touches the token blob, identity, or any other column - it only nulls `disabled_cause`,
// which is exactly what a successful login should have done. Best-effort: any failure (missing/locked
// db, schema drift in a future omp) is swallowed and reported as "0 cleared", never thrown. It is a
// convenience repair, NOT the security gate (invariant #3 is about the scanner, not this).

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";

/** Default profile vault, or an explicit path (tests / overrides). */
export function vaultPath(explicit?: string): string {
  return explicit ?? join(homedir(), ".omp", "agent", "agent.db");
}

export interface ReenableResult { cleared: number; identity?: string; reason?: string }

/** Clear a stale `disabled_cause` for `provider` so a valid-but-flagged credential is honored again.
 *  Returns the number of rows re-enabled (0 = nothing was disabled, or any failure). Read-before-write:
 *  it only writes when a disabled row actually exists, and only the one column. */
export function clearDisabledCredential(provider: string, dbPath?: string): ReenableResult {
  const p = vaultPath(dbPath);
  if (!provider) return { cleared: 0, reason: "no provider" };
  if (!existsSync(p)) return { cleared: 0, reason: "vault not found" };
  try {
    const db = new Database(p); // read-write
    try {
      db.exec("PRAGMA busy_timeout = 2000"); // tolerate the running app holding a brief lock
      const row = db.query("select identity_key, disabled_cause from auth_credentials where provider = ?")
        .get(provider) as { identity_key: string | null; disabled_cause: string | null } | null;
      if (!row) return { cleared: 0, reason: "no credential for provider" };
      if (!row.disabled_cause) return { cleared: 0, identity: row.identity_key ?? undefined, reason: "already active" };
      const res = db.query("update auth_credentials set disabled_cause = null where provider = ? and disabled_cause is not null").run(provider);
      return { cleared: Number(res.changes ?? 0), identity: row.identity_key ?? undefined };
    } finally { db.close(); }
  } catch (e) {
    return { cleared: 0, reason: String((e as Error)?.message ?? e) };
  }
}

export interface DisconnectResult { removed: number; reason?: string }

/** Authoritatively DISCONNECT an OAuth login: DELETE the credential row(s) for `provider`. omp's own
 *  `auth-broker logout` only sets `disabled_cause` (a soft-disable that leaves the token blob in `data`),
 *  and on a cold/reinstalled machine that spawn can even time out — so the Settings list keeps showing the
 *  provider "connected". Deleting the row is the real clear: the token (in the `data` column) is gone and
 *  `providerAuth()` — which reads this same table — reflects it immediately, regardless of omp's state. A
 *  later "Connect via OAuth" re-creates a fresh row (and never inherits a stale `disabled_cause`). Scoped to
 *  `credential_type='oauth'` so API-key rows are never touched. Best-effort: failures return { removed: 0 }. */
export function disconnectCredential(provider: string, dbPath?: string): DisconnectResult {
  const p = vaultPath(dbPath);
  if (!provider) return { removed: 0, reason: "no provider" };
  if (!existsSync(p)) return { removed: 0, reason: "vault not found" };
  try {
    const db = new Database(p); // read-write
    try {
      db.exec("PRAGMA busy_timeout = 2000"); // tolerate the running app holding a brief lock
      const res = db.query("delete from auth_credentials where provider = ? and credential_type = 'oauth'").run(provider);
      return { removed: Number(res.changes ?? 0) };
    } finally { db.close(); }
  } catch (e) {
    return { removed: 0, reason: String((e as Error)?.message ?? e) };
  }
}

/** Clear EVERY OAuth login at once — the "sign out of all providers" reset. Deletes all
 *  `credential_type='oauth'` rows, INCLUDING orphans the per-provider Disconnect can't reach: a login whose
 *  omp broker id has no matching Settings descriptor (e.g. `google-antigravity`), or a provider surfaced as
 *  key-only (`canOauth:false`, e.g. a `perplexity` oauth). Never touches API-key credentials. Best-effort. */
export function clearAllOauthCredentials(dbPath?: string): DisconnectResult {
  const p = vaultPath(dbPath);
  if (!existsSync(p)) return { removed: 0, reason: "vault not found" };
  try {
    const db = new Database(p); // read-write
    try {
      db.exec("PRAGMA busy_timeout = 2000");
      const res = db.query("delete from auth_credentials where credential_type = 'oauth'").run();
      return { removed: Number(res.changes ?? 0) };
    } finally { db.close(); }
  } catch (e) {
    return { removed: 0, reason: String((e as Error)?.message ?? e) };
  }
}
