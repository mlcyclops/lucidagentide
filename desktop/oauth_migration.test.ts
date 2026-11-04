// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-VAULT-KEYS.2 (ADR-0480): moving omp's credential rows out of a SCRATCH agent.db (omp's real schema,
// written by omp's own SqliteAuthCredentialStore) into the vault. No re-login (same tokens, same ids, same
// active/disabled state), the plaintext is gone from agent.db and its WAL, a second run is a no-op, a run
// after a crash between seal and delete finishes cleanly, and any failure leaves agent.db exactly as it was
// with nothing added to the vault. The OS backend is an in-memory fake; nothing touches ~/.omp.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteAuthCredentialStore, type AuthCredential } from "@oh-my-pi/pi-ai";
import { _setVaultBackendForTest, readVault, type OsKeyStore } from "./engine_vault.ts";
import { migrateAgentDbOauth } from "./oauth_migration.ts";
import { OAUTH_REF_PREFIX, openRow, ROW_COLUMNS, VaultAuthCredentialStore, type CredentialRow } from "./oauth_vault_store.ts";

const ENV_KEYS = ["LUCID_GUI_SETTINGS_FILE", "LUCID_ENGINE_VAULT_DIR"] as const;
const ENV_BEFORE = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const dirs: string[] = [];
const stores: VaultAuthCredentialStore[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); _setVaultBackendForTest(null); });
afterAll(() => {
  for (const k of ENV_KEYS) { const v = ENV_BEFORE[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* windows sqlite handle lag */ } }
});

const TOKENS = ["ACCESS-ALICE-1111", "REFRESH-ALICE-1111", "ACCESS-BOB-2222", "REFRESH-BOB-2222", "ACCESS-OLD-3333", "LOGINKEY-4444"];
const CREDS: Array<{ provider: string; credential: AuthCredential }> = [
  { provider: "anthropic", credential: { type: "oauth", access: "sk-ant-oat01-ACCESS-ALICE-1111", refresh: "sk-ant-ort01-REFRESH-ALICE-1111", expires: Date.now() + 9e8, email: "alice@work.com" } },
  { provider: "openai-codex", credential: { type: "oauth", access: "ACCESS-BOB-2222", refresh: "REFRESH-BOB-2222", expires: Date.now() + 9e8, accountId: "acct-bob" } },
  { provider: "openai-codex", credential: { type: "oauth", access: "ACCESS-OLD-3333", refresh: "REFRESH-OLD-3333", expires: Date.now() + 9e8, accountId: "acct-old" } },
  { provider: "openrouter", credential: { type: "api_key", key: "sk-or-LOGINKEY-4444", source: "login" } },
];

function fakeBackend(): void {
  let held: Buffer | null = randomBytes(32);
  const store: OsKeyStore = { kind: "dpapi", read: () => (held ? Buffer.from(held) : { missing: "absent" }), create: (k) => { held = Buffer.from(k); return true; } };
  _setVaultBackendForTest(() => store);
}
function brokenBackend(): void {
  _setVaultBackendForTest(() => ({ kind: "dpapi", read: () => ({ missing: "unavailable", detail: "test: backend down" }), create: () => false }));
}

/** A scratch agent.db written by omp's own store (real schema v8), one row logged out by omp. */
async function seed(): Promise<{ root: string; vault: string; db: string }> {
  const root = mkdtempSync(join(tmpdir(), "lucid-oauth-mig-"));
  dirs.push(root);
  process.env.LUCID_GUI_SETTINGS_FILE = join(root, "lucid-gui.json");
  const vault = join(root, "lucid-engine-vault");
  process.env.LUCID_ENGINE_VAULT_DIR = vault;
  const db = join(root, "agent", "agent.db");
  const omp = await SqliteAuthCredentialStore.open(db);
  for (const c of CREDS) await omp.upsertAuthCredential(c.provider, c.credential);
  const old = omp.listAuthCredentials("openai-codex").find((r) => r.credential.type === "oauth" && r.credential.accountId === "acct-old");
  await omp.deleteAuthCredential(old!.id, "logged out by user");
  omp.close();
  return { root, vault, db };
}
function sourceRows(db: string): CredentialRow[] {
  const d = new Database(db); // read-write: a read-only open of a WAL database needs its -shm file
  try { return d.query<CredentialRow, []>(`SELECT ${ROW_COLUMNS} FROM auth_credentials ORDER BY id`).all(); } finally { d.close(); }
}
function agentDbBytes(db: string): string {
  return ["", "-wal", "-shm"].map((s) => (existsSync(db + s) ? readFileSync(db + s).toString("latin1") : "")).join("");
}
const oauthEntries = (vault: string) => Object.entries(readVault(vault).entries).filter(([ref]) => ref.startsWith(OAUTH_REF_PREFIX));
function openStore(vault: string): VaultAuthCredentialStore {
  const s = VaultAuthCredentialStore.open({ vaultDir: vault });
  stores.push(s);
  return s;
}
const quiet = async <T>(fn: () => T | Promise<T>): Promise<T> => {
  const warn = console.warn; console.warn = () => {};
  try { return await fn(); } finally { console.warn = warn; }
};

describe("migration from omp's agent.db", () => {
  test("every row moves with its tokens, id and state; agent.db keeps no row and no plaintext", async () => {
    const { vault, db } = await seed();
    fakeBackend();
    const before = sourceRows(db);
    expect(before).toHaveLength(4);
    const store = openStore(vault);
    const r = migrateAgentDbOauth(store, db);
    expect(r).toMatchObject({ moved: 4, left: 0 });
    expect(r.refused).toBeUndefined();
    expect(sourceRows(db)).toHaveLength(0);
    for (const t of TOKENS) expect(agentDbBytes(db)).not.toContain(t);

    // No re-login: a fresh store over the vault holds the same rows, byte for byte.
    const fresh = openStore(vault);
    expect(fresh.rows()).toEqual(before);
    expect(fresh.listAuthCredentials("anthropic")[0]!.credential).toMatchObject({ access: "sk-ant-oat01-ACCESS-ALICE-1111", refresh: "sk-ant-ort01-REFRESH-ALICE-1111" });
    expect(fresh.listAuthCredentials("openai-codex")).toHaveLength(1); // the logged-out row stays disabled
    expect((await fresh.listDisabledCredentials("openai-codex"))[0]).toMatchObject({ cause: "logged out by user", accountId: "acct-old" });
    expect(fresh.listAuthCredentials("openrouter")[0]!.credential).toEqual({ type: "api_key", key: "sk-or-LOGINKEY-4444", source: "login" });
    const metas = Object.fromEntries(oauthEntries(vault));
    expect(Object.keys(metas).sort()).toEqual(["oauth:anthropic:email:alice@work.com", "oauth:openai-codex:account:acct-bob", "oauth:openai-codex:account:acct-old", "oauth:openrouter:row-4"].sort());
    for (const e of Object.values(metas)) expect(e.source).toBe("migrated-agentdb");
    expect(metas["oauth:openrouter:row-4"]!.kind).toBe("apikey");
  });

  test("idempotent: a second run moves nothing and rewrites nothing", async () => {
    const { vault, db } = await seed();
    fakeBackend();
    const store = openStore(vault);
    migrateAgentDbOauth(store, db);
    const sealed = readFileSync(join(vault, "secrets.v1.json"));
    expect(migrateAgentDbOauth(store, db)).toEqual({ moved: 0, left: 0 });
    expect(readFileSync(join(vault, "secrets.v1.json")).equals(sealed)).toBe(true);
  });

  test("a crash after sealing but before the delete: the next run verifies the sealed copies and finishes, no duplicates", async () => {
    const { vault, db } = await seed();
    fakeBackend();
    const store = openStore(vault);
    store.importRows(sourceRows(db)); // step 2 done, then the process died
    const refs = oauthEntries(vault).map(([ref]) => ref).sort();
    const r = migrateAgentDbOauth(openStore(vault), db);
    expect(r).toMatchObject({ moved: 4, left: 0 });
    expect(oauthEntries(vault).map(([ref]) => ref).sort()).toEqual(refs);
    expect(sourceRows(db)).toHaveLength(0);
  });

  test("a vault that refuses the rows leaves agent.db byte-identical in content and adds nothing", async () => {
    const { vault, db } = await seed();
    fakeBackend();
    const store = openStore(vault);
    const before = sourceRows(db);
    brokenBackend();
    const r = await quiet(() => migrateAgentDbOauth(store, db));
    expect(r.moved).toBe(0);
    expect(r.refused).toContain("vault");
    expect(sourceRows(db)).toEqual(before);
    expect(store.rows()).toEqual([]);
    expect(existsSync(join(vault, "secrets.v1.json"))).toBe(false);
  });

  test("agent.db rows that cannot be removed (locked by another writer) undo the vault side; agent.db keeps them", async () => {
    const { vault, db } = await seed();
    fakeBackend();
    const store = openStore(vault);
    const before = sourceRows(db);
    const holder = new Database(db);
    holder.exec("BEGIN IMMEDIATE"); // another process holds the write lock for longer than the busy timeout
    try {
      const r = migrateAgentDbOauth(store, db);
      expect(r.moved).toBe(0);
      expect(r.refused).toContain("could not be removed");
    } finally { holder.exec("ROLLBACK"); holder.close(); }
    expect(sourceRows(db)).toEqual(before);
    expect(oauthEntries(vault)).toEqual([]);
    expect(store.rows()).toEqual([]);
  }, 30_000);

  test("a row omp refreshed after an interrupted run: the newer agent.db copy wins, is sealed, then removed", async () => {
    const { vault, db } = await seed();
    fakeBackend();
    const store = openStore(vault);
    // An interrupted run sealed everything; then an omp outside LUCID refreshed Alice's row in agent.db.
    store.importRows(sourceRows(db));
    const w = new Database(db);
    w.query("update auth_credentials set data = replace(data, 'ACCESS-ALICE-1111', 'ACCESS-ALICE-9999'), updated_at = updated_at + 10 where provider = 'anthropic'").run();
    w.close();
    const r = migrateAgentDbOauth(store, db);
    expect(r).toMatchObject({ moved: 4, left: 0 }); // newer agent.db row wins, is sealed, then deleted
    const alice = openRow(Object.fromEntries(oauthEntries(vault))["oauth:anthropic:email:alice@work.com"]!.value)!;
    expect(alice.data).toContain("ACCESS-ALICE-9999");
  });
});
