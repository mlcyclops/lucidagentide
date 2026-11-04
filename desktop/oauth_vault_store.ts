// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/oauth_vault_store.ts - P-VAULT-KEYS.2 (ADR-0480): omp's credential rows, sealed in the engine
// vault instead of sitting in plaintext in ~/.omp/agent/agent.db.
//
// omp's AuthStorage consumes any AuthCredentialStore (pi-ai `auth/store.ts`). This one keeps omp's OWN
// semantics by delegating every operation to omp's SqliteAuthCredentialStore over an IN-MEMORY SQLite
// database (identity keys, replacement matching, superseded-row purge, CAS refresh write-back, blocks,
// cache: all omp's code, unchanged), and makes the vault the only place a credential row is persisted:
//   - every row of `auth_credentials` is one vault entry, ref `oauth:<provider>:<identityKey>` (Contract B),
//     its value the row exactly as omp's schema holds it (tokens included, so the value is a secret);
//   - every mutation is followed by a write of the rows it changed (one locked, verified vault write);
//     a refused write restores the table to what it held before and throws: fail-closed, the process
//     never keeps or serves a credential the vault did not take, and nothing is written in plaintext;
//   - another engine's (or the vault UI's) change to an `oauth:` entry is adopted before every mutation
//     and on every poll (the auth broker polls `pollExternalChanges` every 250 ms), newer-wins per row.
// Not stored here: refresh leases (omitted, the remote-store shape the study recommends; the broker is the
// single refresher), usage history (delegated to omp's own agent.db tables, non-secret, so the budget
// reader keeps working), the usage cache (memory). Rate-limit blocks are durable in a small non-secret file.

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SqliteAuthCredentialStore,
  type AuthCredential,
  type AuthCredentialStore,
  type ClientUsageReport,
  type ClientUsageSummary,
  type CredentialRefreshLeaseFence,
  type DisabledCredentialSummary,
  type StoredAuthCredential,
  type StoredCredentialBlock,
  type UsageHistoryEntry,
  type UsageHistoryQuery,
} from "@oh-my-pi/pi-ai";
import { sha256 } from "../harness/crypto/fips_crypto.ts"; // P-FIPS.1 (ADR-0473)
import { writeAtomic } from "./atomic_file.ts";
import { mutateVault, readVault, vaultStatus, type VaultEntries, type VaultMetaPatch, type VaultSource } from "./engine_vault.ts";
import { managedConfig } from "./managed_config.ts";
import { setOauthRowsTarget } from "./oauth_rows_target.ts";
import { keyVaultDir } from "./settings_store.ts";

export const OAUTH_REF_PREFIX = "oauth:";
const BLOCKS_FILE = "oauth-blocks.json";
/** Non-secret marker beside the sealed file: the vault holds (or once held) omp's credentials, so an
 *  unusable vault later means "refuse", never a silent fall back to the (now empty) agent.db. */
export const OAUTH_VAULT_MARKER = "oauth-vault.json";

/** Why the old agent.db path is forced, or null. `LUCID_OAUTH_VAULT=0|off|false|no` or managed
 *  `security.oauthVault: false`: the switch the release can ship dark behind. */
export function oauthVaultKillSwitch(): string | null {
  const env = (process.env.LUCID_OAUTH_VAULT ?? "").trim().toLowerCase();
  if (["0", "off", "false", "no"].includes(env)) return `LUCID_OAUTH_VAULT=${env}`;
  if (managedConfig().config?.security?.oauthVault === false) return "managed policy security.oauthVault = false";
  return null;
}

/** One row of omp's `auth_credentials` table (schema v8, pi-ai sqlite-credential-store.ts). */
export interface CredentialRow {
  id: number;
  provider: string;
  credential_type: string;
  data: string;
  disabled_cause: string | null;
  identity_key: string | null;
  created_at: number;
  updated_at: number;
}
export const ROW_COLUMNS = "id, provider, credential_type, data, disabled_cause, identity_key, created_at, updated_at";

/** Where usage history goes: omp's own agent.db tables (non-secret), so the budget reader is unchanged. */
export type UsageLedger = Pick<SqliteAuthCredentialStore, "recordUsageSnapshots" | "listUsageHistory" | "recordClientUsage" | "getClientUsageSummary" | "close">;

/** The vault is absent, unreadable or refused a write. Nothing was kept and nothing was written in plaintext. */
export class OauthVaultUnavailableError extends Error {
  override name = "OauthVaultUnavailableError";
}

/** The sealed value of one row. `updatedAt` comes last: the vault derives the UI's last-4 from a value's
 *  tail, which must be a non-secret field. */
export function sealRow(r: CredentialRow): string {
  return JSON.stringify({
    v: 1, id: r.id, provider: r.provider, credentialType: r.credential_type, data: r.data,
    disabledCause: r.disabled_cause, identityKey: r.identity_key, createdAt: r.created_at, updatedAt: r.updated_at,
  });
}

/** A sealed row back, or null for anything that is not one (a hand-edited or foreign `oauth:` entry). */
export function openRow(value: string): CredentialRow | null {
  let o: unknown;
  try { o = JSON.parse(value); } catch { return null; }
  if (!o || typeof o !== "object") return null;
  const r: Record<string, unknown> = { ...o };
  const strOrNull = (x: unknown): x is string | null => x === null || typeof x === "string";
  if (r.v !== 1 || !Number.isSafeInteger(r.id) || typeof r.provider !== "string" || !r.provider || typeof r.credentialType !== "string"
    || typeof r.data !== "string" || !strOrNull(r.disabledCause) || !strOrNull(r.identityKey)
    || typeof r.createdAt !== "number" || typeof r.updatedAt !== "number" || typeof r.id !== "number") return null;
  return {
    id: r.id, provider: r.provider, credential_type: r.credentialType, data: r.data, disabled_cause: r.disabledCause,
    identity_key: r.identityKey, created_at: r.createdAt, updated_at: r.updatedAt,
  };
}

/** A ref segment in the vault's ref charset. Anything that does not fit as-is (an MCP server URL as the
 *  provider, an org-scoped identity key with `|`, an over-long value) keeps a readable prefix plus 16 hex
 *  of its sha256, so two different inputs never share a segment. */
function refSegment(s: string): string {
  const clean = s.replace(/[^A-Za-z0-9_.:@+-]/g, "_");
  if (clean === s && s.length > 0 && s.length <= 80) return s;
  return `${clean.slice(0, 40)}.h${sha256(Buffer.from(s, "utf8")).toString("hex").slice(0, 16)}`;
}

/** The vault ref of every row: `oauth:<provider>:<identityKey>`, `oauth:<provider>:row-<id>` for a row
 *  without an identity (API-key logins, legacy rows). When two rows share an identity (an omp tombstone
 *  next to its live replacement) the active one, then the oldest, keeps the plain ref; the others get
 *  `:r<id>`. */
export function rowRefs(rows: readonly CredentialRow[]): Map<number, string> {
  const ordered = [...rows].sort((a, b) => Number(a.disabled_cause !== null) - Number(b.disabled_cause !== null) || a.id - b.id);
  const taken = new Set<string>();
  const out = new Map<number, string>();
  for (const r of ordered) {
    const base = `${OAUTH_REF_PREFIX}${refSegment(r.provider)}:${r.identity_key ? refSegment(r.identity_key) : `row-${r.id}`}`;
    const ref = taken.has(base) ? `${base}:r${r.id}` : base;
    taken.add(ref);
    out.set(r.id, ref);
  }
  return out;
}

/** Vault metadata for a row: kind and a label naming the provider and account (never a token). */
function rowMeta(r: CredentialRow): VaultMetaPatch {
  const oauth = r.credential_type === "oauth";
  const who = r.identity_key ? ` (${r.identity_key.replace(/^(email|account):/, "")})` : "";
  return { kind: oauth ? "oauth" : "apikey", label: `${r.provider} ${oauth ? "sign-in" : "login key"}${who}`.slice(0, 160) };
}

export interface VaultStoreOptions {
  /** Vault directory (default: the engine vault of the current settings file, keyVaultDir()). */
  vaultDir?: string;
  /** Usage-history sink (default: the in-memory table, lost on exit). */
  ledger?: UsageLedger;
  /** Durable rate-limit blocks (non-secret: row id, provider key, scope, until). null keeps them in memory.
   *  Default `<vaultDir>/oauth-blocks.json`. */
  blocksFile?: string | null;
}

/** The AuthCredentialStore the engine's auth broker serves (ADR-0480). Open with `VaultAuthCredentialStore.open`. */
export class VaultAuthCredentialStore implements AuthCredentialStore {
  /** The live credential table (omp's schema), for LUCID's account features through `write`. */
  readonly db: Database;
  readonly vaultDir: string;
  readonly #inner: SqliteAuthCredentialStore;
  #ledger: UsageLedger | undefined;
  readonly #blocksFile: string | null;
  /** ref -> sealed value, as the vault held it at our last read or write: the base of every delta. */
  #synced = new Map<string, string>();
  /** The vault entries object last reconciled (readVault memoizes it on the file's mtime + size). */
  #seen: VaultEntries | null = null;
  /** Rows changed outside omp's own calls (LUCID account features, another engine): the pool must reload. */
  #dirty = false;
  /** The source a NEW vault entry is stamped with (existing entries keep theirs). */
  #source: VaultSource = "oauth-login";
  #closed = false;
  #warnedUnreadable = false;

  private constructor(vaultDir: string, opts: VaultStoreOptions) {
    this.vaultDir = vaultDir;
    this.#ledger = opts.ledger;
    this.#blocksFile = opts.blocksFile === undefined ? join(vaultDir, BLOCKS_FILE) : opts.blocksFile;
    this.db = new Database(":memory:");
    this.#inner = new SqliteAuthCredentialStore(this.db);
  }

  /** Open over the vault, loading every `oauth:` entry. Throws OauthVaultUnavailableError when the vault is
   *  not usable (no OS backend, an unreadable master key or file, a FIPS refusal): the caller refuses. */
  static open(opts: VaultStoreOptions = {}): VaultAuthCredentialStore {
    const dir = opts.vaultDir ?? keyVaultDir();
    const status = vaultStatus(dir);
    if (status.state !== "ok") throw new OauthVaultUnavailableError(`the credential vault is ${status.state}${status.detail ? ` (${status.detail})` : ""}`);
    const read = readVault(dir);
    if (read.problem) throw new OauthVaultUnavailableError(`the credential vault is unreadable (${read.problem})`);
    const store = new VaultAuthCredentialStore(dir, opts);
    store.#adopt(read.entries);
    store.#loadBlocks();
    return store;
  }

  // ── rows ────────────────────────────────────────────────────────────────────────────────────────

  /** Every row, disabled ones included, by id. Engine-internal (rows carry tokens). */
  rows(): CredentialRow[] {
    return this.db.query<CredentialRow, []>(`SELECT ${ROW_COLUMNS} FROM auth_credentials ORDER BY id`).all();
  }

  #replaceRows(rows: readonly CredentialRow[]): void {
    const ins = this.db.query(`INSERT INTO auth_credentials (${ROW_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    this.db.transaction(() => {
      this.db.run("DELETE FROM auth_credentials");
      for (const r of rows) ins.run(r.id, r.provider, r.credential_type, r.data, r.disabled_cause, r.identity_key, r.created_at, r.updated_at);
    })();
  }

  /** Load the vault's `oauth:` entries as the table. An id this engine already serves a ref under is
   *  kept (blocks, sticky sessions and the children's snapshots are keyed by it); otherwise the stored id,
   *  or a fresh one when two engines minted the same id. An entry that is not a row is skipped, never deleted. */
  #adopt(entries: VaultEntries): void {
    const current = this.rows();
    const currentRefs = rowRefs(current);
    const localId = new Map<string, number>();
    for (const r of current) { const ref = currentRefs.get(r.id); if (ref) localId.set(ref, r.id); }
    const synced = new Map<string, string>();
    const parsed: Array<{ ref: string; row: CredentialRow }> = [];
    for (const [ref, e] of Object.entries(entries)) {
      if (!ref.startsWith(OAUTH_REF_PREFIX)) continue;
      const row = openRow(e.value);
      if (!row) { console.warn(`[oauth-vault] ${ref} does not hold a credential row: left in the vault, not served`); continue; }
      synced.set(ref, e.value);
      parsed.push({ ref, row });
    }
    let next = Math.max(0, ...parsed.map((p) => p.row.id), ...current.map((r) => r.id)) + 1;
    const used = new Set<number>();
    const rows: CredentialRow[] = [];
    const rest: CredentialRow[] = [];
    for (const { ref, row } of parsed) {
      const id = localId.get(ref);
      if (id !== undefined && !used.has(id)) { used.add(id); rows.push({ ...row, id }); } else rest.push(row);
    }
    for (const row of rest) {
      const id = used.has(row.id) ? next++ : row.id;
      used.add(id);
      rows.push({ ...row, id });
    }
    this.#replaceRows(rows);
    this.#synced = synced;
    this.#seen = entries;
  }

  /** Adopt another writer's change to the vault's `oauth:` entries. True when the table changed. */
  #reconcile(): boolean {
    const read = readVault(this.vaultDir);
    if (read.problem) {
      if (!this.#warnedUnreadable) console.warn(`[oauth-vault] the vault became unreadable; serving the credentials already loaded (${read.problem.slice(0, 160)})`);
      this.#warnedUnreadable = true;
      return false;
    }
    this.#warnedUnreadable = false;
    if (read.entries === this.#seen) return false;
    const refs = Object.keys(read.entries).filter((ref) => ref.startsWith(OAUTH_REF_PREFIX));
    if (refs.length === this.#synced.size && refs.every((ref) => this.#synced.get(ref) === read.entries[ref]?.value)) {
      this.#seen = read.entries;
      return false;
    }
    const before = JSON.stringify(this.rows());
    this.#adopt(read.entries);
    return JSON.stringify(this.rows()) !== before;
  }

  /** Seal what changed since the last sync: one locked, verified vault write. Refs this engine never
   *  synced are left alone (another engine's). A ref another writer changed since our sync is overwritten
   *  only when our row is at least as new (updated_at); otherwise theirs stays and is adopted. */
  #persist(): void {
    const rows = this.rows();
    const refs = rowRefs(rows);
    const set: Record<string, string> = {};
    const meta: Record<string, VaultMetaPatch> = {};
    const want = new Set<string>();
    for (const r of rows) {
      const ref = refs.get(r.id);
      if (!ref) continue;
      want.add(ref);
      const value = sealRow(r);
      if (this.#synced.get(ref) !== value) { set[ref] = value; meta[ref] = rowMeta(r); }
    }
    const del = [...this.#synced.keys()].filter((ref) => !want.has(ref));
    if (Object.keys(set).length === 0 && del.length === 0) return;
    // Never let a write set an unreadable vault aside (mutateVault would start a fresh one): refuse instead.
    const read = readVault(this.vaultDir);
    if (read.problem) throw new OauthVaultUnavailableError(`the credential vault is unreadable (${read.problem})`);
    const kept = new Set<string>();
    const written = mutateVault(this.vaultDir, (current) => {
      const apply: Record<string, string> = {};
      kept.clear();
      for (const [ref, value] of Object.entries(set)) {
        const theirs = current[ref]?.value;
        if (theirs !== undefined && theirs !== this.#synced.get(ref)) {
          const other = openRow(theirs);
          const mine = openRow(value);
          if (other && mine && other.updated_at > mine.updated_at) { kept.add(ref); continue; }
        }
        apply[ref] = value;
      }
      return { set: apply, del, meta, source: this.#source };
    });
    for (const [ref, value] of Object.entries(set)) {
      if (!kept.has(ref) && written[ref]?.value !== value) throw new OauthVaultUnavailableError("the credential vault did not keep an OAuth row");
    }
    if (del.some((ref) => written[ref] !== undefined)) throw new OauthVaultUnavailableError("the credential vault did not remove an OAuth row");
    const before = JSON.stringify(rows);
    this.#adopt(written);
    if (JSON.stringify(this.rows()) !== before) this.#dirty = true;
  }

  /** Run one mutation of the table and seal it. On a refused write the table is restored and the refusal
   *  thrown. `fn` must be synchronous in effect (omp's store methods are: their async ones never await). */
  #mutate<T>(fn: () => T): T {
    if (this.#closed) throw new OauthVaultUnavailableError("the OAuth credential store is closed");
    if (this.#reconcile()) this.#dirty = true;
    const before = this.rows();
    const result = fn();
    try {
      this.#persist();
    } catch (e) {
      this.#replaceRows(before);
      if (e instanceof OauthVaultUnavailableError) throw e;
      throw new OauthVaultUnavailableError(`the credential vault refused the write (${String((e as Error)?.message ?? e).slice(0, 200)})`);
    }
    return result;
  }

  /** LUCID's account features (oauth_rows_target.ts): a direct SQL write on the table, sealed like any
   *  other mutation; the broker's next poll reloads omp's pool and pushes the change to every omp child. */
  write<T>(fn: (db: Database) => T): T {
    const result = this.#mutate(() => fn(this.db));
    this.#dirty = true;
    return result;
  }

  /** Migration (oauth_migration.ts): merge rows read from omp's agent.db. A row whose identity the store
   *  already holds keeps the newer of the two (updated_at); any other row is added under its own id when
   *  free. New entries are stamped `migrated-agentdb`. Returns, per source row id, the ref holding it.
   *  Throws (table unchanged) when the vault refuses. */
  importRows(source: readonly CredentialRow[]): Map<number, string> {
    const placed = new Map<number, number>();
    this.#source = "migrated-agentdb";
    try {
      this.write((db) => {
        const rows = this.rows();
        const used = new Set(rows.map((r) => r.id));
        let next = Math.max(0, ...rows.map((r) => r.id), ...source.map((r) => r.id)) + 1;
        const upd = db.query("UPDATE auth_credentials SET data = ?, disabled_cause = ?, created_at = ?, updated_at = ? WHERE id = ?");
        const ins = db.query(`INSERT INTO auth_credentials (${ROW_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const src of source) {
          const same = rows.find((r) => r.provider === src.provider && r.credential_type === src.credential_type
            && (src.identity_key !== null ? r.identity_key === src.identity_key : r.identity_key === null && r.data === src.data));
          if (same) {
            if (src.updated_at > same.updated_at) {
              upd.run(src.data, src.disabled_cause, src.created_at, src.updated_at, same.id);
              Object.assign(same, { data: src.data, disabled_cause: src.disabled_cause, created_at: src.created_at, updated_at: src.updated_at });
            }
            placed.set(src.id, same.id);
            continue;
          }
          const id = used.has(src.id) ? next++ : src.id;
          used.add(id);
          ins.run(id, src.provider, src.credential_type, src.data, src.disabled_cause, src.identity_key, src.created_at, src.updated_at);
          rows.push({ ...src, id });
          placed.set(src.id, id);
        }
      });
    } finally {
      this.#source = "oauth-login";
    }
    const refs = rowRefs(this.rows());
    return new Map([...placed].map(([srcId, id]) => [srcId, refs.get(id) ?? ""]));
  }

  /** Send usage history to `ledger` from now on (the broker attaches omp's agent.db tables once the
   *  migration is done with that file). */
  setUsageLedger(ledger: UsageLedger): void {
    this.#ledger?.close();
    this.#ledger = ledger;
  }

  /** Put the table back to `rows` and seal that (the migration's undo). Throws when the vault refuses. */
  restoreRows(rows: readonly CredentialRow[]): void {
    this.write(() => this.#replaceRows(rows));
  }

  // ── CredentialRowStore ──────────────────────────────────────────────────────────────────────────

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#inner.close();
    this.#ledger?.close();
  }

  /** The broker polls this every 250 ms: another writer's vault change, or a LUCID account write, makes
   *  omp's pool reload and the broker push the new snapshot to every omp child. */
  pollExternalChanges(): boolean {
    if (this.#closed) return false;
    const changed = this.#reconcile();
    const dirty = this.#dirty || changed;
    this.#dirty = false;
    return dirty;
  }

  acknowledgeLocalChanges(): void {
    this.#inner.acknowledgeLocalChanges();
  }

  listAuthCredentials(provider?: string): StoredAuthCredential[] {
    return this.#inner.listAuthCredentials(provider);
  }

  listDisabledCredentials(provider?: string): Promise<DisabledCredentialSummary[]> {
    return this.#inner.listDisabledCredentials(provider);
  }

  updateAuthCredential(id: number, credential: AuthCredential): void {
    this.#mutate(() => this.#inner.updateAuthCredential(id, credential));
  }

  // The Promise-returning mutations are `async` so a refusal reaches the caller as a rejection; the work
  // itself still runs synchronously at call time (omp's store never awaits inside them).
  async deleteAuthCredential(id: number, disabledCause: string): Promise<boolean> {
    return this.#mutate(() => this.#inner.deleteAuthCredential(id, disabledCause));
  }

  tryDisableAuthCredentialIfMatches(id: number, expectedData: string, disabledCause: string, lease?: CredentialRefreshLeaseFence): boolean {
    return this.#mutate(() => this.#inner.tryDisableAuthCredentialIfMatches(id, expectedData, disabledCause, lease));
  }

  tryUpdateAuthCredentialIfMatches(id: number, expectedData: string, credential: AuthCredential, lease?: CredentialRefreshLeaseFence): boolean {
    return this.#mutate(() => this.#inner.tryUpdateAuthCredentialIfMatches(id, expectedData, credential, lease));
  }

  async replaceAuthCredentials(provider: string, credentials: AuthCredential[]): Promise<StoredAuthCredential[]> {
    return this.#mutate(() => this.#inner.replaceAuthCredentials(provider, credentials));
  }

  async upsertAuthCredential(provider: string, credential: AuthCredential): Promise<StoredAuthCredential[]> {
    return this.#mutate(() => this.#inner.upsertAuthCredential(provider, credential));
  }

  async deleteAuthCredentials(provider: string, disabledCause: string): Promise<void> {
    return this.#mutate(() => this.#inner.deleteAuthCredentials(provider, disabledCause));
  }

  // ── CredentialCacheStore (memory: usage-report and session-sticky cache, rebuilt after a restart) ──

  getCache(key: string, options?: { includeExpired?: boolean }): string | null {
    return this.#inner.getCache(key, options);
  }

  setCache(key: string, value: string, expiresAtSec: number): void {
    this.#inner.setCache(key, value, expiresAtSec);
  }

  deleteCachePrefix(prefix: string): void {
    this.#inner.deleteCachePrefix(prefix);
  }

  cleanExpiredCache(): void {
    this.#inner.cleanExpiredCache();
  }

  // ── CredentialBlockStore (durable through the non-secret blocks file) ──────────────────────────────

  getCredentialBlock(credentialId: number, providerKey: string, blockScope: string): number | undefined {
    return this.#inner.getCredentialBlock(credentialId, providerKey, blockScope);
  }

  getCredentialBlockScopes(credentialId: number, providerKey: string): ReadonlyMap<string, number> {
    return this.#inner.getCredentialBlockScopes(credentialId, providerKey);
  }

  getCredentialBlockReconcileAfter(credentialId: number, providerKey: string, blockScope: string): number | undefined {
    return this.#inner.getCredentialBlockReconcileAfter(credentialId, providerKey, blockScope);
  }

  upsertCredentialBlock(block: StoredCredentialBlock): void {
    this.#inner.upsertCredentialBlock(block);
    this.#saveBlocks();
  }

  deleteCredentialBlock(credentialId: number, providerKey: string, blockScope: string): void {
    this.#inner.deleteCredentialBlock(credentialId, providerKey, blockScope);
    this.#saveBlocks();
  }

  deleteCredentialBlocks(credentialId: number): void {
    this.#inner.deleteCredentialBlocks(credentialId);
    this.#saveBlocks();
  }

  cleanExpiredCredentialBlocks(nowMs: number): void {
    this.#inner.cleanExpiredCredentialBlocks(nowMs);
    this.#saveBlocks();
  }

  listCredentialBlocks(credentialIds: readonly number[]): StoredCredentialBlock[] {
    return this.#inner.listCredentialBlocks(credentialIds);
  }

  #saveBlocks(): void {
    if (!this.#blocksFile || this.#closed) return;
    try {
      mkdirSync(this.vaultDir, { recursive: true, mode: 0o700 });
      writeAtomic(this.#blocksFile, JSON.stringify(this.#inner.listCredentialBlocks(this.rows().map((r) => r.id))));
    } catch (e) {
      console.warn(`[oauth-vault] rate-limit blocks not saved (${String((e as Error)?.message ?? e).slice(0, 120)}); they stay in memory`);
    }
  }

  #loadBlocks(): void {
    if (!this.#blocksFile || !existsSync(this.#blocksFile)) return;
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(this.#blocksFile, "utf8")); } catch { return; }
    if (!Array.isArray(parsed)) return;
    const ids = new Set(this.rows().map((r) => r.id));
    const now = Date.now();
    for (const b of parsed) {
      if (!b || typeof b !== "object") continue;
      const { credentialId, providerKey, blockScope, blockedUntilMs } = b;
      if (typeof credentialId !== "number" || !ids.has(credentialId) || typeof providerKey !== "string" || typeof blockScope !== "string"
        || typeof blockedUntilMs !== "number" || blockedUntilMs <= now) continue;
      this.#inner.upsertCredentialBlock({ credentialId, providerKey, blockScope, blockedUntilMs });
    }
  }

  // ── UsageLedgerStore (broker host side; recordObservedUsage is a client hook and stays omitted) ─────

  recordUsageSnapshots(entries: UsageHistoryEntry[]): void {
    (this.#ledger ?? this.#inner).recordUsageSnapshots(entries);
  }

  listUsageHistory(query?: UsageHistoryQuery): UsageHistoryEntry[] {
    return (this.#ledger ?? this.#inner).listUsageHistory(query);
  }

  recordClientUsage(report: ClientUsageReport): void {
    (this.#ledger ?? this.#inner).recordClientUsage(report);
  }

  getClientUsageSummary(sinceMs: number): ClientUsageSummary {
    return (this.#ledger ?? this.#inner).getClientUsageSummary(sinceMs);
  }
}

/** Tools without a running engine (tools/omp_auth_*.ts): open the vault-backed table for one command and
 *  register it as the rows target (a write is sealed; a running engine adopts it on its next poll). Null on
 *  the agent.db path: kill switch, no marker (nothing moved yet) or an unusable vault. */
export function openOfflineOauthRows(): { close(): void } | null {
  if (oauthVaultKillSwitch() || !existsSync(join(keyVaultDir(), OAUTH_VAULT_MARKER))) return null;
  let store: VaultAuthCredentialStore;
  try { store = VaultAuthCredentialStore.open({ blocksFile: null }); } catch { return null; }
  setOauthRowsTarget({ db: store.db, write: (fn) => store.write(fn) });
  return { close: () => { setOauthRowsTarget(null); store.close(); } };
}
