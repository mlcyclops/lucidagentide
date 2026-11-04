// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/oauth_migration.ts - P-VAULT-KEYS.2 (ADR-0480): move omp's credential rows out of
// ~/.omp/agent/agent.db into the engine vault, without a re-login.
//
// Order (each step only after the previous one held):
//   1. read every `auth_credentials` row (OAuth and login API keys alike: once the broker serves omp, omp
//      never reads agent.db for credentials again, so a row left behind would be a lost login);
//   2. merge them into the vault store (VaultAuthCredentialStore.importRows: same tokens, same ids where
//      free, newer-wins per identity) and seal them, one verified vault write;
//   3. read the vault back and check every source row is held there;
//   4. only then delete the rows from agent.db (each one only if omp did not rewrite it meanwhile), with
//      SQLite's secure_delete on, then checkpoint the WAL and VACUUM so no plaintext page survives.
// A failure before step 4 completes undoes step 2 and leaves agent.db exactly as it was. Idempotent: a run
// after a crash between 2 and 4 finds the rows already sealed (same data), verifies and deletes.

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { readVault } from "./engine_vault.ts";
import { openRow, ROW_COLUMNS, type CredentialRow, type VaultAuthCredentialStore } from "./oauth_vault_store.ts";

export interface OauthMigrationResult {
  /** Rows now sealed in the vault and deleted from agent.db. */
  moved: number;
  /** Rows still in agent.db: rewritten by a running omp during the move (the next boot moves them), or
   *  every row when the move was refused. */
  left: number;
  /** Why nothing was moved. agent.db and the vault are as they were. */
  refused?: string;
  /** The rows are deleted, but freed pages could not be scrubbed (another process held agent.db). */
  scrubWarning?: string;
}

const REQUIRED_COLUMNS = ["id", "provider", "credential_type", "data", "disabled_cause", "identity_key", "created_at", "updated_at"];
const short = (e: unknown): string => String((e as Error)?.message ?? e).slice(0, 200);

/** Move every credential row of `agentDbPath` into `store` (and so into its vault). Never throws. */
export function migrateAgentDbOauth(store: VaultAuthCredentialStore, agentDbPath: string): OauthMigrationResult {
  if (!existsSync(agentDbPath)) return { moved: 0, left: 0 };
  let source: CredentialRow[];
  try {
    // Read-write (it exists: checked above) because a read-only open of a WAL database needs its -shm file.
    const db = new Database(agentDbPath);
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      const cols = db.query<{ name: string }, []>("PRAGMA table_info(auth_credentials)").all().map((c) => c.name);
      if (cols.length === 0) return { moved: 0, left: 0 };
      const missing = REQUIRED_COLUMNS.filter((c) => !cols.includes(c));
      if (missing.length) return { moved: 0, left: 0, refused: `agent.db's credential table predates omp's identity keys (no ${missing.join(", ")}); run omp once, then restart LUCID` };
      source = db.query<CredentialRow, []>(`SELECT ${ROW_COLUMNS} FROM auth_credentials ORDER BY id`).all();
    } finally { db.close(); }
  } catch (e) {
    return { moved: 0, left: 0, refused: `agent.db could not be read (${short(e)})` };
  }
  if (source.length === 0) return { moved: 0, left: 0 };

  const before = store.rows();
  let placed: Map<number, string>;
  try { placed = store.importRows(source); } catch (e) {
    return { moved: 0, left: source.length, refused: `the vault did not take the rows (${short(e)})` };
  }

  // Read back: every source row must be held at its ref, as the same token or a newer one for its identity.
  const read = readVault(store.vaultDir);
  const unverified = source.filter((src) => {
    const ref = placed.get(src.id);
    const value = ref ? read.entries[ref]?.value : undefined;
    const row = value ? openRow(value) : null;
    return !row || row.provider !== src.provider || (row.data !== src.data && row.updated_at < src.updated_at);
  });
  if (read.problem || unverified.length) {
    return undo(store, before, source.length, read.problem ? `the vault could not be read back (${read.problem.slice(0, 160)})` : `${unverified.length} row(s) did not read back from the vault`);
  }

  let deleted: number;
  try { deleted = deleteRows(agentDbPath, source); } catch (e) {
    return undo(store, before, source.length, `agent.db rows could not be removed (${short(e)})`);
  }
  const scrubWarning = scrubPlaintext(agentDbPath);
  return { moved: deleted, left: source.length - deleted, ...(scrubWarning ? { scrubWarning } : {}) };
}

/** Put the vault back to what it held before the import; agent.db was never written. */
function undo(store: VaultAuthCredentialStore, before: CredentialRow[], rows: number, why: string): OauthMigrationResult {
  try { store.restoreRows(before); } catch (e) {
    // The vault keeps sealed copies the next run recognizes (same data): it verifies and finishes then.
    return { moved: 0, left: rows, refused: `${why}; the vault also kept its copies (${short(e)})` };
  }
  return { moved: 0, left: rows, refused: why };
}

/** Delete the moved rows, each only while it still holds the data that was sealed. */
function deleteRows(agentDbPath: string, rows: readonly CredentialRow[]): number {
  const db = new Database(agentDbPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA secure_delete = ON"); // overwrite the deleted rows' bytes, not just unlink them
    const del = db.query("DELETE FROM auth_credentials WHERE id = ? AND data = ?");
    // SQL changes(), not the statement's `changes`: bun counts the rows omp's revision triggers touch too.
    const changed = db.query<{ n: number }, []>("SELECT changes() AS n");
    let n = 0;
    db.transaction(() => { for (const r of rows) { del.run(r.id, r.data); n += changed.get()?.n ?? 0; } })();
    return n;
  } finally { db.close(); }
}

/** Fold the WAL back and rebuild the file so no freed page or WAL frame keeps a token. Best-effort: a
 *  process holding agent.db open (an omp outside LUCID) can block it; the warning names that. */
function scrubPlaintext(agentDbPath: string): string | undefined {
  try {
    const db = new Database(agentDbPath);
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      const first = db.query<{ busy: number }, []>("PRAGMA wal_checkpoint(TRUNCATE)").get();
      db.exec("VACUUM");
      const last = db.query<{ busy: number }, []>("PRAGMA wal_checkpoint(TRUNCATE)").get();
      if (first?.busy || last?.busy) return "another process held agent.db, so its write-ahead log could not be folded back yet";
      return undefined;
    } finally { db.close(); }
  } catch (e) {
    return `agent.db could not be compacted (${short(e)})`;
  }
}
