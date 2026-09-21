// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-ACCT.1 (ADR-0375): named provider ACCOUNTS - the pure policy layer.
//
// A provider can hold several credentials at once: omp's vault (agent.db, table auth_credentials)
// stores one OAuth row PER IDENTITY (identity_key, e.g. "email:alice@work.com"), and LUCID's settings
// store can hold several named API keys. omp picks among ACTIVE rows automatically (usage-ranked,
// session-sticky) and offers no manual pin, so LUCID switches accounts with omp's own soft-disable
// column: rows parked by LUCID carry disabled_cause = LUCID_INACTIVE_CAUSE, active selection in omp is
// `WHERE disabled_cause IS NULL`, and omp never clears the column itself (its "delete" SETS it). A row
// omp disabled for its own reason (logout, rotation) is NOT ours to resurrect and is never listed.
//
// Precedence fact this module leans on (pi-ai auth-storage.ts): a stored OAuth credential BEATS an env
// var API key. So "use my key account" must park every active OAuth row for that provider, and "use my
// OAuth account" simply re-enables that identity (a lingering env key is then outranked, harmless).
//
// This module is PURE (no fs, no db): derivation and validation only, so tests need no fixtures.
// The side-effectful appliers live in auth_vault.ts (db) and dev.ts (env + restart).

/** The disabled_cause LUCID owns. Rows with any OTHER non-null cause were disabled by omp and stay out. */
export const LUCID_INACTIVE_CAUSE = "lucid:inactive-account";

/** A named account persisted in the settings store. `key` holds the secret for kind "key" (same
 *  0600-file posture as the legacy GuiSettings.keys slot). For kind "oauth" the record exists only to
 *  carry a user rename; the credential itself lives in omp's vault under `identityKey`. */
export interface StoredAccount {
  id: string;               // "key:<uuid>" | "oauth:<identityKey>"
  name: string;
  kind: "key" | "oauth";
  key?: string;
  identityKey?: string;
  createdAt: number;
}

/** What the UI renders. Never carries a secret: keys are last4-masked here. */
export interface AccountView {
  id: string;
  name: string;
  kind: "key" | "oauth";
  active: boolean;
  /** OAuth identity, humanized (e.g. "alice@work.com"). */
  identity?: string;
  keyLast4?: string;
  /** Parked by LUCID (switchable back), as opposed to simply not selected. */
  parked?: boolean;
  removable: boolean;
}

/** One OAuth row as auth_vault reads it from agent.db (already filtered to oauth rows whose
 *  disabled_cause is NULL or LUCID's). */
export interface OauthRowLite {
  identityKey: string | null;
  disabledCause: string | null;
}

export const LEGACY_KEY_ACCOUNT_ID = "key:legacy";

/** Deterministic id for an OAuth identity, so un-renamed identities need no stored record. */
export function oauthAccountId(identityKey: string | null): string {
  return `oauth:${identityKey ?? "unknown"}`;
}

/** "email:alice@work.com" -> "alice@work.com"; "account:uuid" -> "uuid"; null -> "signed-in account". */
export function identityLabel(identityKey: string | null): string {
  if (!identityKey) return "signed-in account";
  const i = identityKey.indexOf(":");
  return i > 0 ? identityKey.slice(i + 1) : identityKey;
}

export interface DeriveArgs {
  /** OAuth rows for this provider's broker id (active + LUCID-parked only). */
  oauthRows: OauthRowLite[];
  /** Stored named accounts for this provider (key accounts + oauth renames). */
  stored: StoredAccount[];
  /** The value currently in the single env slot (GuiSettings.keys[env] / process.env), if any. */
  legacyKey?: string;
  /** The persisted active choice, if any. */
  activeId?: string;
}

/** Merge omp's vault rows with LUCID's stored records into the account list the UI renders.
 *
 *  Rules, in order:
 *  - One OAuth account per identity. An identity with BOTH an active row and a LUCID-parked row (the
 *    user re-logged-in while parked) counts as active: the fresh row is the credential omp uses.
 *  - A stored oauth record contributes only its name; a stored record whose identity no longer has any
 *    row (logged out) is dropped from view.
 *  - Every stored key account is listed, last4-masked. The legacy single-slot key is listed as its own
 *    account ONLY when no stored key account holds the same value (renaming it migrates it).
 *  - Active: the persisted activeId when it still exists; else the first unparked OAuth identity (omp
 *    precedence: stored OAuth beats env); else the key account matching the env slot; else none.
 */
export function deriveAccounts(args: DeriveArgs): AccountView[] {
  const byIdentity = new Map<string, { parked: boolean }>();
  for (const r of args.oauthRows) {
    const k = r.identityKey ?? null;
    const id = oauthAccountId(k);
    const parked = r.disabledCause === LUCID_INACTIVE_CAUSE;
    const prev = byIdentity.get(id);
    // Any active row for the identity wins over a parked sibling.
    byIdentity.set(id, { parked: prev ? prev.parked && parked : parked });
  }
  const names = new Map(args.stored.filter((a) => a.kind === "oauth").map((a) => [a.id, a.name]));
  const views: AccountView[] = [];
  for (const [id, st] of byIdentity) {
    const identityKey = id.slice("oauth:".length);
    views.push({
      id, kind: "oauth", active: false, parked: st.parked, removable: true,
      identity: identityLabel(identityKey === "unknown" ? null : identityKey),
      name: names.get(id) ?? identityLabel(identityKey === "unknown" ? null : identityKey),
    });
  }
  const keyAccounts = args.stored.filter((a) => a.kind === "key");
  for (const a of keyAccounts) {
    views.push({ id: a.id, name: a.name, kind: "key", active: false, keyLast4: a.key ? a.key.slice(-4) : undefined, removable: true });
  }
  if (args.legacyKey && !keyAccounts.some((a) => a.key === args.legacyKey)) {
    views.push({ id: LEGACY_KEY_ACCOUNT_ID, name: "API key", kind: "key", active: false, keyLast4: args.legacyKey.slice(-4), removable: true });
  }
  // Active resolution.
  let activeId = args.activeId && views.some((v) => v.id === args.activeId) ? args.activeId : undefined;
  if (!activeId) activeId = views.find((v) => v.kind === "oauth" && !v.parked)?.id;
  if (!activeId && args.legacyKey) {
    activeId = keyAccounts.find((a) => a.key === args.legacyKey)?.id ?? (views.some((v) => v.id === LEGACY_KEY_ACCOUNT_ID) ? LEGACY_KEY_ACCOUNT_ID : undefined);
  }
  for (const v of views) v.active = v.id === activeId;
  // OAuth first (actives before parked), then key accounts, stable within groups.
  return views.sort((a, b) => (a.kind === b.kind ? Number(a.parked ?? false) - Number(b.parked ?? false) : a.kind === "oauth" ? -1 : 1));
}

/** Validate an add/rename name: short, one line, non-empty. Returns the trimmed name or null. */
export function validAccountName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const t = name.trim().replace(/\s+/g, " ");
  return t.length > 0 && t.length <= 48 && !/[\r\n<>]/.test(t) ? t : null;
}
