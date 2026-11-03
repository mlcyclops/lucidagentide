// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-VAULT-KEYS.1 (ADR-0472): settings_store.ts keeps its GuiSettings contract while the secret fields
// move into the engine OS vault: migration of a plaintext lucid-gui.json (and its .bak / .corrupt-*
// copies), removal, the file-wins merge, the unreadable-vault rules, and the byte-compatible fallback
// when no OS vault exists. The OS backend is an in-memory fake injected through _setVaultBackendForTest.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _setVaultBackendForTest, openSealed, readVault, sealSecrets, SECRETS_FILE, type OsKeyStore } from "./engine_vault.ts";
import {
  _setSettingsIoForTest, addKeyAccount, applyEnv, collabP2PConfig, keyVaultStatus, listMcpServers, load, providerAccounts, save,
  setCollabP2P, setDeveloperMode, setKey, upsertMcpServer, type GuiSettings,
} from "./settings_store.ts";

const ENV_KEYS = ["LUCID_GUI_SETTINGS_FILE", "LUCID_ENGINE_VAULT_DIR", "LUCID_VAULT_TEST_KEY", "LUCID_VAULT_TEST_KEY_2", "LUCID_VAULT_TEST_REGION"] as const;
const ENV_BEFORE = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const dirs: string[] = [];
function scratch(): { file: string; vault: string } {
  const dir = mkdtempSync(join(tmpdir(), "lucid-keyvault-"));
  dirs.push(dir);
  const file = join(dir, "lucid-gui.json");
  process.env.LUCID_GUI_SETTINGS_FILE = file;
  delete process.env.LUCID_ENGINE_VAULT_DIR;
  return { file, vault: join(dir, "lucid-engine-vault") };
}
afterEach(() => { _setVaultBackendForTest(null); _setSettingsIoForTest(null); });
afterAll(() => {
  for (const k of ENV_KEYS) { const v = ENV_BEFORE[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const quiet = <T>(fn: () => T): T => {
  const orig = console.error; console.error = () => {};
  try { return fn(); } finally { console.error = orig; }
};
/** An in-memory OS key store holding one master key (created on first use unless given). */
function useFakeStore(key: Buffer | null = null): OsKeyStore {
  let held = key ? Buffer.from(key) : null;
  const store: OsKeyStore = {
    kind: "dpapi",
    read: () => (held ? Buffer.from(held) : { missing: "absent" }),
    create: (k) => { held = Buffer.from(k); return true; },
  };
  _setVaultBackendForTest(() => store);
  return store;
}
/** Engine B: another process sharing the directory, writing the vault with its own (complete) map. */
function otherEngineWrites(vault: string, store: OsKeyStore, secrets: Record<string, string>): void {
  if (!Buffer.isBuffer(store.read())) store.create(randomBytes(32));
  mkdirSync(vault, { recursive: true });
  writeFileSync(join(vault, SECRETS_FILE), JSON.stringify(sealSecrets(store.read() as Buffer, secrets), null, 2));
}
/** The vault's content as on disk right now (no module memo involved). */
const onDisk = (vault: string, store: OsKeyStore): Record<string, string> =>
  openSealed(store.read() as Buffer, JSON.parse(readFileSync(join(vault, SECRETS_FILE), "utf8")));

const SECRET = { key: "sk-live-MIGRATE-0001", acct: "sk-acct-MIGRATE-0002", mcp: "mcp-bearer-MIGRATE-0003", turn: "turn-cred-MIGRATE-0004" };
const LEGACY: GuiSettings = {
  username: "Nick",
  keys: { LUCID_VAULT_TEST_KEY: SECRET.key, LUCID_VAULT_TEST_REGION: "us-east-1" }, // a non-secret config value rides the same slot
  accounts: { openai: [
    { id: "key:acct-1", name: "Work", kind: "key", key: SECRET.acct, createdAt: 1 },
    { id: "oauth:me@example.com", name: "Personal", kind: "oauth", identityKey: "me@example.com", createdAt: 2 },
  ] },
  mcpServers: [{ id: "mcp-1", name: "Docs", transport: "http", url: "https://mcp.example.com", token: SECRET.mcp, enabled: true }],
  collabTurnUsername: "turnuser",
  collabTurnCredential: SECRET.turn,
};

describe("migration of a plaintext lucid-gui.json", () => {
  test("keys, account key, MCP token and TURN credential move into the vault with no re-entry", () => {
    const { file, vault } = scratch();
    useFakeStore();
    writeFileSync(file, JSON.stringify(LEGACY, null, 2));
    writeFileSync(`${file}.bak`, JSON.stringify(LEGACY)); // an older generation, also plaintext
    writeFileSync(`${file}.corrupt-1700000000000`, JSON.stringify(LEGACY)); // a parseable forensic copy

    expect(quiet(() => load())).toEqual(LEGACY); // the first load migrates and returns the same settings
    for (const path of [file, `${file}.bak`, `${file}.corrupt-1700000000000`]) {
      const text = readFileSync(path, "utf8");
      for (const v of Object.values(SECRET)) expect(text).not.toContain(v);
      expect(JSON.parse(text).username).toBe("Nick");
    }
    expect(readVault(vault).secrets).toEqual({
      "key:LUCID_VAULT_TEST_KEY": SECRET.key, "key:LUCID_VAULT_TEST_REGION": "us-east-1", "account:key:acct-1": SECRET.acct,
      "mcp:mcp-1": SECRET.mcp, "turn:credential": SECRET.turn,
    });
    expect(load()).toEqual(LEGACY); // now hydrated from the vault alone
    expect(keyVaultStatus()).toEqual({ custody: "dpapi", state: "ok" });

    delete process.env.LUCID_VAULT_TEST_KEY;
    applyEnv();
    expect(process.env.LUCID_VAULT_TEST_KEY).toBe(SECRET.key);

    const settled = readFileSync(file); // idempotent: a later load rewrites nothing
    load();
    expect(readFileSync(file).equals(settled)).toBe(true);
  });

  test("a secret in both places: the file value wins and the next save moves it", () => {
    const { file, vault } = scratch();
    useFakeStore();
    setKey("LUCID_VAULT_TEST_KEY", "sk-vault-OLD-1111");
    // An older build (or a crash between the two writes) left a newer value in the file itself.
    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    onDisk.keys = { LUCID_VAULT_TEST_KEY: "sk-file-NEW-2222" };
    writeFileSync(file, JSON.stringify(onDisk, null, 2));
    expect(quiet(() => load()).keys?.LUCID_VAULT_TEST_KEY).toBe("sk-file-NEW-2222");
    expect(readVault(vault).secrets["key:LUCID_VAULT_TEST_KEY"]).toBe("sk-file-NEW-2222");
    expect(readFileSync(file, "utf8")).not.toContain("sk-file-NEW-2222");
  });
});

describe("saving through the vault", () => {
  test("removing a key removes it from the vault", () => {
    const { file, vault } = scratch();
    useFakeStore();
    setKey("LUCID_VAULT_TEST_KEY", "sk-one-1111");
    setKey("LUCID_VAULT_TEST_KEY_2", "sk-two-2222");
    expect(readVault(vault).secrets).toEqual({ "key:LUCID_VAULT_TEST_KEY": "sk-one-1111", "key:LUCID_VAULT_TEST_KEY_2": "sk-two-2222" });
    setKey("LUCID_VAULT_TEST_KEY_2", "");
    expect(readVault(vault).secrets).toEqual({ "key:LUCID_VAULT_TEST_KEY": "sk-one-1111" });
    expect(load().keys).toEqual({ LUCID_VAULT_TEST_KEY: "sk-one-1111" });
    expect(readFileSync(file, "utf8")).not.toContain("sk-one-1111");
  });

  test("account keys, MCP tokens and the TURN credential round-trip through their setters", () => {
    const { file } = scratch();
    useFakeStore();
    const acct = addKeyAccount("openai", "Work", "sk-acct-SETTER-5555")!;
    const mcp = upsertMcpServer({ name: "Docs", url: "https://mcp.example.com", token: "tok-SETTER-6666" });
    setCollabP2P({ turnCredential: "turn-SETTER-7777" });
    const raw = readFileSync(file, "utf8");
    for (const v of ["sk-acct-SETTER-5555", "tok-SETTER-6666", "turn-SETTER-7777"]) expect(raw).not.toContain(v);
    expect(providerAccounts("openai").find((a) => a.id === acct.id)?.key).toBe("sk-acct-SETTER-5555");
    expect(listMcpServers().find((e) => e.id === mcp.id)?.token).toBe("tok-SETTER-6666");
    expect(collabP2PConfig().turnCredential).toBe("turn-SETTER-7777");
  });

  test("no OS vault: today's plaintext file, byte for byte, and no vault directory", () => {
    const { file, vault } = scratch();
    _setVaultBackendForTest(() => null);
    setKey("LUCID_VAULT_TEST_KEY", "sk-plain-8888");
    expect(readFileSync(file, "utf8")).toBe(JSON.stringify({ keys: { LUCID_VAULT_TEST_KEY: "sk-plain-8888" } }, null, 2));
    const profile = structuredClone(LEGACY);
    save(profile);
    expect(readFileSync(file, "utf8")).toBe(JSON.stringify(profile, null, 2));
    expect(load()).toEqual(profile);
    expect(existsSync(vault)).toBe(false);
    expect(keyVaultStatus()).toMatchObject({ custody: "plaintext-file", state: "unavailable" });
  });
});

describe("an unreadable vault", () => {
  test("is served as is and left untouched; a re-entered key sets it aside and starts fresh", () => {
    const { file, vault } = scratch();
    useFakeStore(randomBytes(32));
    setKey("LUCID_VAULT_TEST_KEY", "sk-sealed-3333");
    const sealed = join(vault, SECRETS_FILE);
    const sealedBefore = readFileSync(sealed);
    const fileBefore = readFileSync(file);

    useFakeStore(randomBytes(32)); // e.g. the profile copied to another Windows account
    expect(quiet(() => load()).keys?.LUCID_VAULT_TEST_KEY).toBeUndefined();
    expect(keyVaultStatus().state).toBe("unreadable");
    expect(readFileSync(file).equals(fileBefore)).toBe(true);
    expect(readFileSync(sealed).equals(sealedBefore)).toBe(true);

    quiet(() => setDeveloperMode(true)); // a save with no secret leaves the vault alone
    expect(readFileSync(sealed).equals(sealedBefore)).toBe(true);

    quiet(() => setKey("LUCID_VAULT_TEST_KEY", "sk-reentered-4444"));
    const aside = readdirSync(vault).filter((f) => f.startsWith(`${SECRETS_FILE}.unreadable-`));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(vault, aside[0]!)).equals(sealedBefore)).toBe(true);
    expect(load().keys?.LUCID_VAULT_TEST_KEY).toBe("sk-reentered-4444");
    expect(keyVaultStatus().state).toBe("ok");
    expect(readFileSync(file, "utf8")).not.toContain("sk-reentered-4444");
  });
});

// Engine A is this module; engine B is another process sharing the directory (simulated by writing the
// sealed vault directly, so none of A's caches see it coming).
describe("several engines sharing one vault", () => {
  test("A cached 'no master key yet'; B creates the vault with K; A then saves J: the vault holds K and J", () => {
    const { vault } = scratch();
    const store = useFakeStore();
    expect(keyVaultStatus().state).toBe("ok"); // A has now seen (and cached) the absent master key
    const a = load();
    otherEngineWrites(vault, store, { "key:LUCID_VAULT_TEST_KEY": "sk-B-K-1111" });
    a.keys = { ...(a.keys ?? {}), LUCID_VAULT_TEST_KEY_2: "sk-A-J-2222" };
    save(a);
    expect(onDisk(vault, store)).toEqual({ "key:LUCID_VAULT_TEST_KEY": "sk-B-K-1111", "key:LUCID_VAULT_TEST_KEY_2": "sk-A-J-2222" });
    expect(readdirSync(vault).some((f) => f.includes(".unreadable-"))).toBe(false); // B's vault was not set aside
    expect(load().keys).toEqual({ LUCID_VAULT_TEST_KEY: "sk-B-K-1111", LUCID_VAULT_TEST_KEY_2: "sk-A-J-2222" });
  });

  test("A loaded K; B deletes K; A saves an unrelated setting: K stays deleted", () => {
    const { vault } = scratch();
    const store = useFakeStore();
    setKey("LUCID_VAULT_TEST_KEY", "sk-K-3333");
    const a = load();
    expect(a.keys?.LUCID_VAULT_TEST_KEY).toBe("sk-K-3333");
    otherEngineWrites(vault, store, {});
    a.developerMode = true;
    save(a);
    expect(onDisk(vault, store)).toEqual({});
    expect(load().keys?.LUCID_VAULT_TEST_KEY).toBeUndefined();
  });

  test("A loads; B adds K; A sets J: both are kept", () => {
    const { vault } = scratch();
    const store = useFakeStore();
    setKey("LUCID_VAULT_TEST_REGION", "us-east-1");
    const a = load();
    otherEngineWrites(vault, store, { "key:LUCID_VAULT_TEST_REGION": "us-east-1", "key:LUCID_VAULT_TEST_KEY": "sk-B-K-4444" });
    a.keys = { ...(a.keys ?? {}), LUCID_VAULT_TEST_KEY_2: "sk-A-J-5555" };
    save(a);
    expect(onDisk(vault, store)).toEqual({
      "key:LUCID_VAULT_TEST_REGION": "us-east-1", "key:LUCID_VAULT_TEST_KEY": "sk-B-K-4444", "key:LUCID_VAULT_TEST_KEY_2": "sk-A-J-5555",
    });
  });
});

describe("a vault write that fails", () => {
  test("throws from setKey and never puts the key in lucid-gui.json", () => {
    const { file, vault } = scratch();
    _setVaultBackendForTest(() => ({ kind: "dpapi", read: () => ({ missing: "absent" }), create: () => false }));
    save({ username: "Nick" });
    const before = readFileSync(file);
    expect(() => setKey("LUCID_VAULT_TEST_KEY", "sk-NOPE-6666")).toThrow(/master key/);
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(process.env.LUCID_VAULT_TEST_KEY).not.toBe("sk-NOPE-6666");
    expect(existsSync(join(vault, SECRETS_FILE))).toBe(false);
    setDeveloperMode(true); // a save with no secret change never touches the vault, so it cannot fail on it
    expect(readFileSync(file, "utf8")).not.toContain("sk-NOPE-6666");
  });
});

describe("plaintext copies after a migration", () => {
  test("a backup the scrub cannot rewrite leaves scrub.pending, and a later load finishes it", () => {
    const { file, vault } = scratch();
    useFakeStore();
    writeFileSync(file, JSON.stringify(LEGACY, null, 2));
    writeFileSync(`${file}.bak`, JSON.stringify(LEGACY, null, 2));
    const eio = Object.assign(new Error("EIO: simulated, rename"), { code: "EIO" });
    _setSettingsIoForTest({ renameSync: ((from: string, to: string) => { if (String(to).endsWith(".bak")) throw eio; renameSync(from, to); }) as unknown as typeof renameSync });
    quiet(() => load());
    const marker = join(vault, "scrub.pending");
    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(`${file}.bak`, "utf8")).toContain(SECRET.key);
    expect(readFileSync(file, "utf8")).not.toContain(SECRET.key);
    _setSettingsIoForTest(null);
    load();
    expect(existsSync(marker)).toBe(false);
    const bak = readFileSync(`${file}.bak`, "utf8");
    for (const v of Object.values(SECRET)) expect(bak).not.toContain(v);
  });

  test("an unparseable .corrupt-* copy has each moved secret value redacted, every other byte kept", () => {
    const { file } = scratch();
    useFakeStore();
    writeFileSync(file, JSON.stringify(LEGACY, null, 2));
    const corrupt = `${file}.corrupt-1700000000001`;
    const torn = `{"username":"Nick","keys": {"LUCID_VAULT_TEST_KEY": "${SECRET.key}"}, "mcpServers": [{"id":"mcp-1","token": "${SECRET.mcp}"`;
    writeFileSync(corrupt, torn);
    quiet(() => load());
    expect(readFileSync(corrupt, "utf8")).toBe(torn.replace(SECRET.key, "[moved to OS vault]").replace(SECRET.mcp, "[moved to OS vault]"));
  });
});
