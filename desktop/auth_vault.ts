// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/auth_vault.ts - a narrow, read-before-write helper over omp's credential table
// (`auth_credentials`): the engine vault's store when the OAuth vault is on (P-VAULT-KEYS.2, ADR-0480,
// through oauth_rows_target.ts), else ~/.omp/agent/agent.db. Same SQL either way: the vault store keeps
// omp's own schema, so park/unpark, disconnect, re-enable and the login fingerprint behave identically, and
// a write on the vault path is sealed before it counts (a refused vault write changes nothing and reports
// the reason, the same "0 changed" shape as any other failure here).
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
// db, schema drift in a future omp, a refused vault write) is swallowed and reported as "0 cleared", never
// thrown. It is a convenience repair, NOT the security gate (invariant #3 is about the scanner, not this).

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { LUCID_INACTIVE_CAUSE, type OauthRowLite } from "./account_policy.ts"; // P-ACCT.1 (ADR-0375)
import { oauthRowsTarget } from "./oauth_rows_target.ts"; // P-VAULT-KEYS.2 (ADR-0480)

/** Default profile vault, or an explicit path (tests / overrides). */
export function vaultPath(explicit?: string): string {
  return explicit ?? join(homedir(), ".omp", "agent", "agent.db");
}

/** The credential table one call works on. An explicit `dbPath` (tests, tools) is always that file;
 *  otherwise the engine vault's table when it is registered, else omp's agent.db. Null = no table. */
interface Table { db: Database; write<T>(fn: () => T): T; done(): void }
function openTable(dbPath: string | undefined, readonly: boolean): Table | null {
  const target = dbPath === undefined ? oauthRowsTarget() : null;
  if (target) return { db: target.db, write: (fn) => target.write(() => fn()), done: () => {} };
  const p = vaultPath(dbPath);
  if (!existsSync(p)) return null;
  const db = readonly ? new Database(p, { readonly: true }) : new Database(p); // read-write
  if (!readonly) db.exec("PRAGMA busy_timeout = 2000"); // tolerate the running app holding a brief lock
  return { db, write: (fn) => fn(), done: () => db.close() };
}

/** Rows the last INSERT/UPDATE/DELETE on `db` changed, via SQL changes(): bun's statement `changes` also
 *  counts the rows omp's schema triggers touch (auth_change_revision), which would inflate every count. */
function changedRows(db: Database): number {
  return db.query<{ n: number }, []>("select changes() as n").get()?.n ?? 0;
}

export interface ReenableResult { cleared: number; identity?: string; reason?: string }

/** Clear a stale `disabled_cause` for `provider` so a valid-but-flagged credential is honored again.
 *  Returns the number of rows re-enabled (0 = nothing was disabled, or any failure). Read-before-write:
 *  it only writes when a disabled row actually exists, and only the one column. */
export function clearDisabledCredential(provider: string, dbPath?: string): ReenableResult {
  if (!provider) return { cleared: 0, reason: "no provider" };
  try {
    const t = openTable(dbPath, false);
    if (!t) return { cleared: 0, reason: "vault not found" };
    try {
      const row = t.db.query("select identity_key, disabled_cause from auth_credentials where provider = ?")
        .get(provider) as { identity_key: string | null; disabled_cause: string | null } | null;
      if (!row) return { cleared: 0, reason: "no credential for provider" };
      if (!row.disabled_cause) return { cleared: 0, identity: row.identity_key ?? undefined, reason: "already active" };
      const cleared = t.write(() => { t.db.query("update auth_credentials set disabled_cause = null where provider = ? and disabled_cause is not null").run(provider); return changedRows(t.db); });
      return { cleared, identity: row.identity_key ?? undefined };
    } finally { t.done(); }
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
 *  `credential_type='oauth'` so API-key rows are never touched. On the vault path the sealed entry goes
 *  too. Best-effort: failures return { removed: 0 }. */
export function disconnectCredential(provider: string, dbPath?: string): DisconnectResult {
  if (!provider) return { removed: 0, reason: "no provider" };
  try {
    const t = openTable(dbPath, false);
    if (!t) return { removed: 0, reason: "vault not found" };
    try {
      const removed = t.write(() => { t.db.query("delete from auth_credentials where provider = ? and credential_type = 'oauth'").run(provider); return changedRows(t.db); });
      return { removed };
    } finally { t.done(); }
  } catch (e) {
    return { removed: 0, reason: String((e as Error)?.message ?? e) };
  }
}

/** Clear EVERY OAuth login at once — the "sign out of all providers" reset. Deletes all
 *  `credential_type='oauth'` rows, INCLUDING orphans the per-provider Disconnect can't reach: a login whose
 *  omp broker id has no matching Settings descriptor (e.g. `google-antigravity`), or a provider surfaced as
 *  key-only (`canOauth:false`, e.g. a `perplexity` oauth). Never touches API-key credentials. Best-effort. */
export function clearAllOauthCredentials(dbPath?: string): DisconnectResult {
  try {
    const t = openTable(dbPath, false);
    if (!t) return { removed: 0, reason: "vault not found" };
    try {
      const removed = t.write(() => { t.db.query("delete from auth_credentials where credential_type = 'oauth'").run(); return changedRows(t.db); });
      return { removed };
    } finally { t.done(); }
  } catch (e) {
    return { removed: 0, reason: String((e as Error)?.message ?? e) };
  }
}

// ── P-ACCT.1 (ADR-0375): named multi-account switching over omp's own soft-disable column. ──────────
// omp's active-credential selection is `WHERE disabled_cause IS NULL`, its token refresh touches only
// active rows, and nothing in omp ever CLEARS the column (its own delete SETS it). So parking a row
// under LUCID's cause is stable, reversible, and invisible to omp's other bookkeeping. These helpers
// only ever move rows between NULL and LUCID_INACTIVE_CAUSE: a row omp disabled for its own reason
// (logout, rotation) is never resurrected here, that is clearDisabledCredential's explicit-repair job.
// On the vault path a parked row is left out of the broker's snapshot exactly as omp leaves it out of
// its own selection, so every omp child stops using it on the broker's next push.

/** One OAuth row for account derivation: active rows plus LUCID-parked rows only. */
export function listOauthRows(provider: string, dbPath?: string): OauthRowLite[] {
  if (!provider) return [];
  try {
    const t = openTable(dbPath, true);
    if (!t) return [];
    try {
      return t.db.query(
        "select identity_key as identityKey, disabled_cause as disabledCause from auth_credentials where provider = ? and credential_type = 'oauth' and (disabled_cause is null or disabled_cause = ?) order by id asc",
      ).all(provider, LUCID_INACTIVE_CAUSE) as OauthRowLite[];
    } finally { t.done(); }
  } catch { return []; }
}

export interface AccountApplyResult { parked: number; unparked: number; reason?: string }

/** Make ONE OAuth identity the provider's active credential: unpark its rows (only LUCID's cause),
 *  park every OTHER active oauth row. One transaction (and on the vault path one sealed write), so a crash
 *  or a refused write never leaves zero active rows for a provider that had one. `identityKey` null
 *  targets the legacy no-identity row. */
export function activateOauthIdentity(provider: string, identityKey: string | null, dbPath?: string): AccountApplyResult {
  if (!provider) return { parked: 0, unparked: 0, reason: "no provider" };
  try {
    const t = openTable(dbPath, false);
    if (!t) return { parked: 0, unparked: 0, reason: "vault not found" };
    const db = t.db;
    try {
      return t.write(() => {
        db.exec("BEGIN IMMEDIATE");
        try {
          if (identityKey === null) db.query("update auth_credentials set disabled_cause = null where provider = ? and credential_type = 'oauth' and identity_key is null and disabled_cause = ?").run(provider, LUCID_INACTIVE_CAUSE);
          else db.query("update auth_credentials set disabled_cause = null where provider = ? and credential_type = 'oauth' and identity_key = ? and disabled_cause = ?").run(provider, identityKey, LUCID_INACTIVE_CAUSE);
          const unparked = changedRows(db);
          if (identityKey === null) db.query("update auth_credentials set disabled_cause = ? where provider = ? and credential_type = 'oauth' and identity_key is not null and disabled_cause is null").run(LUCID_INACTIVE_CAUSE, provider);
          else db.query("update auth_credentials set disabled_cause = ? where provider = ? and credential_type = 'oauth' and (identity_key is null or identity_key != ?) and disabled_cause is null").run(LUCID_INACTIVE_CAUSE, provider, identityKey);
          const parked = changedRows(db);
          db.exec("COMMIT");
          return { parked, unparked };
        } catch (e) { db.exec("ROLLBACK"); throw e; }
      });
    } finally { t.done(); }
  } catch (e) {
    return { parked: 0, unparked: 0, reason: String((e as Error)?.message ?? e) };
  }
}

/** Park EVERY active oauth row for `provider` under LUCID's cause, so an env API key (which stored
 *  OAuth would otherwise outrank) becomes the credential omp resolves. Reversed by activateOauthIdentity. */
export function parkAllOauth(provider: string, dbPath?: string): AccountApplyResult {
  if (!provider) return { parked: 0, unparked: 0, reason: "no provider" };
  try {
    const t = openTable(dbPath, false);
    if (!t) return { parked: 0, unparked: 0, reason: "vault not found" };
    try {
      const parked = t.write(() => { t.db.query("update auth_credentials set disabled_cause = ? where provider = ? and credential_type = 'oauth' and disabled_cause is null").run(LUCID_INACTIVE_CAUSE, provider); return changedRows(t.db); });
      return { parked, unparked: 0 };
    } finally { t.done(); }
  } catch (e) {
    return { parked: 0, unparked: 0, reason: String((e as Error)?.message ?? e) };
  }
}

/** Disconnect ONE identity (DELETE its rows, token blob included), leaving the provider's other
 *  accounts alone; the multi-account sibling of disconnectCredential. `identityKey` null targets the
 *  legacy no-identity row. */
export function disconnectOauthIdentity(provider: string, identityKey: string | null, dbPath?: string): DisconnectResult {
  if (!provider) return { removed: 0, reason: "no provider" };
  try {
    const t = openTable(dbPath, false);
    if (!t) return { removed: 0, reason: "vault not found" };
    try {
      const removed = t.write(() => {
        if (identityKey === null) t.db.query("delete from auth_credentials where provider = ? and credential_type = 'oauth' and identity_key is null").run(provider);
        else t.db.query("delete from auth_credentials where provider = ? and credential_type = 'oauth' and identity_key = ?").run(provider, identityKey);
        return changedRows(t.db);
      });
      return { removed };
    } finally { t.done(); }
  } catch (e) {
    return { removed: 0, reason: String((e as Error)?.message ?? e) };
  }
}

/** A cheap, READ-ONLY snapshot of a provider's OAuth credential row - just enough to tell whether a
 *  later write actually landed a *fresh* token. `dataHash` is a non-cryptographic hash of the token blob
 *  (change detection only; it is never logged and never used as a secret). Scoped to
 *  `credential_type='oauth'` so a coexisting API-key row can't be mistaken for a login. Absent row, or
 *  any failure, reports `{ present: false }` - consistent with the best-effort contract above. */
export interface CredentialSnapshot { present: boolean; id?: number; updatedAt?: number; dataHash?: string; disabled?: boolean }

export function credentialSnapshot(provider: string, dbPath?: string): CredentialSnapshot {
  if (!provider) return { present: false };
  try {
    const t = openTable(dbPath, true);
    if (!t) return { present: false };
    try {
      const row = t.db.query("select id, data, disabled_cause, updated_at from auth_credentials where provider = ? and credential_type = 'oauth'")
        .get(provider) as { id: number; data: string | null; disabled_cause: string | null; updated_at: number } | null;
      if (!row) return { present: false };
      return {
        present: true,
        id: Number(row.id),
        updatedAt: Number(row.updated_at ?? 0),
        dataHash: String(Bun.hash(row.data ?? "")),
        disabled: !!row.disabled_cause,
      };
    } finally { t.done(); }
  } catch { return { present: false }; }
}

/** True when `after` shows a genuinely NEW token versus `before`: a first row, a replaced row, a rewritten
 *  blob, or a bumped `updated_at`. This is how a caller decides omp must be respawned after a login attempt
 *  WITHOUT trusting the broker's exit code, and without resurrecting a credential the user logged out of
 *  (a failed login leaves the snapshot identical, so it returns false). */
export function landedFreshCredential(before: CredentialSnapshot, after: CredentialSnapshot): boolean {
  if (!after.present) return false;
  if (!before.present) return true;
  if (after.id !== before.id) return true;
  if (after.dataHash !== before.dataHash) return true;
  return (after.updatedAt ?? 0) > (before.updatedAt ?? 0);
}
