// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-VAULT-KEYS.2 (ADR-0480): the vault-backed AuthCredentialStore. A row round-trips through the sealed
// vault (and through a fresh store, as after an engine restart), a token refresh writes the new grant back
// to the vault, another writer's change is adopted, and a vault that is missing or refuses never yields a
// stored or served credential, nor a plaintext copy anywhere. The OS backend is an in-memory fake
// (_setVaultBackendForTest); every path is a temp dir.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage, type OAuthCredential } from "@oh-my-pi/pi-ai";
import { _setVaultBackendForTest, readVault, type OsKeyStore } from "./engine_vault.ts";
import { OAUTH_REF_PREFIX, OauthVaultUnavailableError, openRow, rowRefs, VaultAuthCredentialStore, type CredentialRow } from "./oauth_vault_store.ts";
import { vaultPut } from "./vault_store.ts";

const ENV_KEYS = ["LUCID_GUI_SETTINGS_FILE", "LUCID_ENGINE_VAULT_DIR"] as const;
const ENV_BEFORE = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const dirs: string[] = [];
const open: VaultAuthCredentialStore[] = [];
function scratch(): { root: string; vault: string } {
  const root = mkdtempSync(join(tmpdir(), "lucid-oauth-store-"));
  dirs.push(root);
  process.env.LUCID_GUI_SETTINGS_FILE = join(root, "lucid-gui.json");
  const vault = join(root, "lucid-engine-vault");
  process.env.LUCID_ENGINE_VAULT_DIR = vault;
  return { root, vault };
}
function fakeBackend(key: Buffer = randomBytes(32)): void {
  let held: Buffer | null = Buffer.from(key);
  const store: OsKeyStore = {
    kind: "dpapi",
    read: () => (held ? Buffer.from(held) : { missing: "absent" }),
    create: (k: Buffer) => { held = Buffer.from(k); return true; },
  };
  _setVaultBackendForTest(() => store);
}
/** A backend whose master key cannot be read: every vault read and write refuses. */
function brokenBackend(): void {
  _setVaultBackendForTest(() => ({ kind: "dpapi", read: () => ({ missing: "unavailable", detail: "test: backend down" }), create: () => false }));
}
function openStore(vault: string): VaultAuthCredentialStore {
  const s = VaultAuthCredentialStore.open({ vaultDir: vault });
  open.push(s);
  return s;
}
/** Every file under `dir` as latin1 text (a plaintext token anywhere on disk shows up here). */
function allBytes(dir: string): string {
  if (!existsSync(dir)) return "";
  let out = "";
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    out += e.isDirectory() ? allBytes(p) : readFileSync(p).toString("latin1");
  }
  return out;
}
const quiet = async <T>(fn: () => T | Promise<T>): Promise<T> => {
  const warn = console.warn; console.warn = () => {};
  try { return await fn(); } finally { console.warn = warn; }
};
const oauth = (tag: string, email: string, expires = Date.now() + 86_400_000): OAuthCredential => ({
  type: "oauth", access: `sk-ant-oat01-ACCESS-${tag}-0000000000`, refresh: `sk-ant-ort01-REFRESH-${tag}-0000000000`, expires, email,
});
const oauthRefs = (vault: string): string[] => Object.keys(readVault(vault).entries).filter((r) => r.startsWith(OAUTH_REF_PREFIX)).sort();

afterEach(() => {
  for (const s of open.splice(0)) s.close();
  _setVaultBackendForTest(null);
});
afterAll(() => {
  for (const k of ENV_KEYS) { const v = ENV_BEFORE[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("round trip", () => {
  test("an upsert is sealed as oauth:<provider>:<identity>, never on disk in the clear, and a fresh store serves it", async () => {
    const { root, vault } = scratch();
    fakeBackend();
    const a = openStore(vault);
    const rows = await a.upsertAuthCredential("anthropic", oauth("A1", "alice@work.com"));
    expect(rows).toHaveLength(1);
    expect(oauthRefs(vault)).toEqual(["oauth:anthropic:email:alice@work.com"]);
    const meta = readVault(vault).entries["oauth:anthropic:email:alice@work.com"]!;
    expect(meta).toMatchObject({ kind: "oauth", source: "oauth-login" });
    expect(meta.label).toContain("alice@work.com");
    expect(allBytes(root)).not.toContain("ACCESS-A1");
    expect(allBytes(root)).not.toContain("REFRESH-A1");

    const b = openStore(vault); // an engine restart: nothing but the sealed vault carries the row
    const listed = b.listAuthCredentials("anthropic");
    expect(listed).toHaveLength(1);
    expect(listed[0]!.id).toBe(rows[0]!.id);
    expect(listed[0]!.credential).toMatchObject({ type: "oauth", access: "sk-ant-oat01-ACCESS-A1-0000000000", refresh: "sk-ant-ort01-REFRESH-A1-0000000000" });
  });

  test("omp's own semantics hold: a same-identity login replaces in place, logout soft-disables, a re-login purges the tombstone", async () => {
    const { vault } = scratch();
    fakeBackend();
    const s = openStore(vault);
    const [first] = await s.upsertAuthCredential("anthropic", oauth("A1", "alice@work.com"));
    const [second] = await s.upsertAuthCredential("anthropic", oauth("A2", "alice@work.com"));
    expect(second!.id).toBe(first!.id);
    expect(oauthRefs(vault)).toEqual(["oauth:anthropic:email:alice@work.com"]);
    await s.deleteAuthCredentials("anthropic", "logged out by user");
    expect(s.listAuthCredentials("anthropic")).toHaveLength(0);
    const sealed = openRow(readVault(vault).entries["oauth:anthropic:email:alice@work.com"]!.value)!;
    expect(sealed.disabled_cause).toBe("logged out by user");
    await s.upsertAuthCredential("anthropic", oauth("A3", "alice@work.com"));
    expect(s.rows().map((r) => r.disabled_cause)).toEqual([null]);
    expect(oauthRefs(vault)).toEqual(["oauth:anthropic:email:alice@work.com"]);
  });

  test("refs stay in the vault's charset for identity-less rows, MCP server URLs and org-scoped keys", () => {
    const base = { credential_type: "oauth", data: "{}", disabled_cause: null, created_at: 1, updated_at: 1 };
    const rows: CredentialRow[] = [
      { ...base, id: 1, provider: "openrouter", credential_type: "api_key", identity_key: null },
      { ...base, id: 2, provider: "mcp_oauth:https://mcp.example.com/sse?x=1", identity_key: "email:a@b.c" },
      { ...base, id: 3, provider: "anthropic", identity_key: "email:a@b.c|org:1234" },
      { ...base, id: 4, provider: "anthropic", identity_key: "email:a@b.c|org:1234", disabled_cause: "old" },
    ];
    const refs = rowRefs(rows);
    for (const ref of refs.values()) expect(ref).toMatch(/^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,199}$/);
    expect(refs.get(1)).toBe("oauth:openrouter:row-1");
    expect(new Set(refs.values()).size).toBe(4);
    expect(refs.get(4)).toBe(`${refs.get(3)}:r4`); // the active row keeps the plain ref
  });
});

describe("rate-limit blocks", () => {
  test("a block survives an engine restart through the non-secret blocks file; a deleted one is gone", async () => {
    const { root, vault } = scratch();
    fakeBackend();
    const a = openStore(vault);
    const [row] = await a.upsertAuthCredential("anthropic", oauth("BLK", "alice@work.com"));
    const until = Date.now() + 3_600_000;
    a.upsertCredentialBlock({ credentialId: row!.id, providerKey: "anthropic:oauth", blockScope: "", blockedUntilMs: until });
    const b = openStore(vault);
    expect(b.getCredentialBlock(row!.id, "anthropic:oauth", "")).toBe(until);
    expect(readFileSync(join(vault, "oauth-blocks.json"), "utf8")).not.toContain("ACCESS-BLK");
    a.deleteCredentialBlocks(row!.id);
    expect(openStore(vault).getCredentialBlock(row!.id, "anthropic:oauth", "")).toBeUndefined();
    expect(allBytes(root)).not.toContain("REFRESH-BLK");
  });
});

describe("refresh write-back", () => {
  test("a refresh through AuthStorage lands the new grant in the vault; a fresh store serves the new refresh token", async () => {
    const { root, vault } = scratch();
    fakeBackend();
    const s = openStore(vault);
    const [row] = await s.upsertAuthCredential("anthropic", oauth("OLD", "alice@work.com", Date.now() - 1000));
    const storage = new AuthStorage(s, {
      refreshOAuthCredential: async (_provider, _id, credential) => ({ ...credential, access: "sk-ant-oat01-ACCESS-NEW-0000000000", refresh: "sk-ant-ort01-REFRESH-NEW-0000000000", expires: Date.now() + 3_600_000 }),
      refreshOAuthCredentialMints: true,
    });
    await storage.credentials.reload();
    const entry = await storage.oauth.refresh(row!.id);
    expect(entry.credential).toMatchObject({ access: "sk-ant-oat01-ACCESS-NEW-0000000000", refresh: "__remote__" });
    const sealed = openRow(readVault(vault).entries["oauth:anthropic:email:alice@work.com"]!.value)!;
    expect(sealed.data).toContain("REFRESH-NEW");
    expect(sealed.data).not.toContain("REFRESH-OLD");
    const fresh = openStore(vault);
    expect(fresh.listAuthCredentials("anthropic")[0]!.credential).toMatchObject({ refresh: "sk-ant-ort01-REFRESH-NEW-0000000000" });
    expect(allBytes(root)).not.toContain("REFRESH-NEW");
  });
});

describe("fail-closed", () => {
  test("a vault with no usable backend refuses to open: nothing to serve, nothing written", () => {
    const { root, vault } = scratch();
    brokenBackend();
    expect(() => VaultAuthCredentialStore.open({ vaultDir: vault })).toThrow(OauthVaultUnavailableError);
    expect(existsSync(join(vault, "secrets.v1.json"))).toBe(false);
    expect(allBytes(root)).toBe("");
  });

  test("a login the vault refuses is rejected, not kept in memory, and leaves no plaintext anywhere", async () => {
    const { root, vault } = scratch();
    fakeBackend();
    const s = openStore(vault);
    await s.upsertAuthCredential("anthropic", oauth("KEEP", "alice@work.com"));
    const before = readFileSync(join(vault, "secrets.v1.json"));
    brokenBackend();
    await quiet(async () => {
      await expect(s.upsertAuthCredential("openai-codex", oauth("REFUSED", "bob@home.com"))).rejects.toBeInstanceOf(OauthVaultUnavailableError);
    });
    expect(s.listAuthCredentials("openai-codex")).toHaveLength(0);
    expect(s.listAuthCredentials("anthropic")).toHaveLength(1);
    expect(readFileSync(join(vault, "secrets.v1.json")).equals(before)).toBe(true);
    expect(allBytes(root)).not.toContain("REFUSED");
  });

  test("a refresh the vault refuses fails the refresh and keeps the old grant (memory and vault agree)", async () => {
    const { vault } = scratch();
    fakeBackend();
    const s = openStore(vault);
    const [row] = await s.upsertAuthCredential("anthropic", oauth("OLD", "alice@work.com", Date.now() - 1000));
    const storage = new AuthStorage(s, {
      refreshOAuthCredential: async (_provider, _id, credential) => ({ ...credential, access: "sk-ant-oat01-ACCESS-LOST-0000000000", refresh: "sk-ant-ort01-REFRESH-LOST-0000000000", expires: Date.now() + 3_600_000 }),
      refreshOAuthCredentialMints: true,
    });
    await storage.credentials.reload();
    brokenBackend();
    const sealedBefore = readFileSync(join(vault, "secrets.v1.json"));
    await quiet(async () => { await expect(storage.oauth.refresh(row!.id)).rejects.toThrow(); });
    const held = JSON.stringify(s.rows());
    expect(held).not.toContain("REFRESH-LOST");
    expect(held).toContain("REFRESH-OLD");
    expect(readFileSync(join(vault, "secrets.v1.json")).equals(sealedBefore)).toBe(true);
  });
});

describe("other writers", () => {
  test("a change another engine seals is adopted on the next poll; a removal there is a removal here", async () => {
    const { vault } = scratch();
    fakeBackend();
    const a = openStore(vault);
    const b = openStore(vault);
    await b.upsertAuthCredential("openai-codex", oauth("B1", "bob@home.com"));
    expect(a.pollExternalChanges()).toBe(true);
    expect(a.listAuthCredentials("openai-codex")).toHaveLength(1);
    expect(a.pollExternalChanges()).toBe(false);
    b.write((db) => db.run("delete from auth_credentials where provider = 'openai-codex'"));
    expect(oauthRefs(vault)).toEqual([]);
    expect(a.pollExternalChanges()).toBe(true);
    expect(a.listAuthCredentials("openai-codex")).toHaveLength(0);
  });

  test("an entry under oauth: that is not a row is skipped, never served and never deleted", async () => {
    const { vault } = scratch();
    fakeBackend();
    const a = openStore(vault);
    await a.upsertAuthCredential("anthropic", oauth("A1", "alice@work.com"));
    vaultPut({ ref: "oauth:foreign:thing", value: "not-a-row-value-000000", kind: "oauth", source: "typed" });
    await quiet(() => { a.pollExternalChanges(); });
    expect(a.rows()).toHaveLength(1);
    await a.upsertAuthCredential("anthropic", oauth("A2", "alice@work.com"));
    expect(oauthRefs(vault)).toEqual(["oauth:anthropic:email:alice@work.com", "oauth:foreign:thing"]);
  });
});
