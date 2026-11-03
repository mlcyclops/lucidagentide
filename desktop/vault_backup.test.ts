// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-VAULT-UI.1 (ADR-0475): the encrypted `.lucidvault` backup. A backup restores into a different vault
// (different master key) with every value intact; a wrong passphrase and any tampering refuse before
// anything is written; restore is newer-wins; and neither route ever answers with a plaintext value or the
// passphrase. The OS backend is an in-memory fake; every path is a temp dir. PBKDF2 runs the real 600000
// rounds, so the tests carry a generous timeout.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _setVaultBackendForTest, SECRETS_FILE, type OsKeyStore } from "./engine_vault.ts";
import {
  BACKUP_KDF_ITER, createVaultBackup, openVaultBackup, parseVaultBackup, restoreVaultBackup, sealVaultBackup, VaultBackupError,
  type VaultBackupEnvelope,
} from "./vault_backup.ts";
import { handleVaultBackupRoutes } from "./vault_backup_routes.ts";
import { _resetVaultEnvForTest } from "./vault_env.ts";
import { vaultGet, vaultList, vaultPut, type VaultExportEntry } from "./vault_store.ts";

const SLOW = 120_000;
const ENV_KEYS = ["LUCID_GUI_SETTINGS_FILE", "LUCID_ENGINE_VAULT_DIR", "LUCID_OMP_MODELS_YAML", "LUCID_VB_TEST_KEY"] as const;
const ENV_BEFORE = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const dirs: string[] = [];
function scratch(): { vault: string } {
  const root = mkdtempSync(join(tmpdir(), "lucid-vault-backup-"));
  dirs.push(root);
  process.env.LUCID_GUI_SETTINGS_FILE = join(root, "lucid-gui.json");
  process.env.LUCID_OMP_MODELS_YAML = join(root, "models.yml");
  delete process.env.LUCID_ENGINE_VAULT_DIR;
  return { vault: join(root, "lucid-engine-vault") };
}
afterEach(() => { _setVaultBackendForTest(null); _resetVaultEnvForTest(); });
afterAll(() => {
  for (const k of ENV_KEYS) { const v = ENV_BEFORE[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function useFakeStore(): void {
  let held: Buffer | null = randomBytes(32);
  const store: OsKeyStore = {
    kind: "dpapi",
    read: () => (held ? Buffer.from(held) : { missing: "absent" }),
    create: (k: Buffer) => { held = Buffer.from(k); return true; },
  };
  _setVaultBackendForTest(() => store);
}
const quiet = async <T>(fn: () => T | Promise<T>): Promise<T> => {
  const orig = console.error; console.error = () => {};
  try { return await fn(); } finally { console.error = orig; }
};
const vaultBytes = (vault: string): Buffer | null => (existsSync(join(vault, SECRETS_FILE)) ? readFileSync(join(vault, SECRETS_FILE)) : null);

const PASS = "correct horse battery staple";
const SECRETS = {
  "key:LUCID_VB_TEST_KEY": "sk-BACKUP-SECRET-VALUE-0001",
  figma_pat: "figd-BACKUP-SECRET-VALUE-0002",
  "secret:prod_jwt": "eyJ-BACKUP-SECRET-VALUE-0003",
};
function seed(): void {
  vaultPut({ ref: "key:LUCID_VB_TEST_KEY", value: SECRETS["key:LUCID_VB_TEST_KEY"], kind: "apikey", source: "typed", envName: "LUCID_VB_TEST_KEY", label: "Test key" });
  vaultPut({ ref: "figma_pat", value: SECRETS.figma_pat, kind: "pat", source: "migrated-safestorage", label: "Figma" });
  vaultPut({ ref: "secret:prod_jwt", value: SECRETS["secret:prod_jwt"], kind: "jwt", source: "agent-request", label: "Prod JWT", rotationIntervalDays: 30 });
}
/** A copy of the envelope with one base64 field's first byte flipped. */
function flip(env: VaultBackupEnvelope, field: "ct" | "tag" | "iv"): VaultBackupEnvelope {
  const b = Buffer.from(env[field], "base64");
  b[0] = b[0]! ^ 0x01;
  return { ...env, [field]: b.toString("base64") };
}
const codeOf = (fn: () => unknown): string => {
  try { fn(); } catch (e) { return e instanceof VaultBackupError ? e.code : `other:${e instanceof Error ? e.message : String(e)}`; }
  return "no-throw";
};

describe("backup envelope", () => {
  test("round trip: a backup restores into a different vault with every value and its metadata", () => {
    scratch();
    useFakeStore();
    seed();
    const before = Object.fromEntries(vaultList().map((m) => [m.ref, m]));
    const { envelope, count } = createVaultBackup(PASS);
    expect(count).toBe(3);
    expect(envelope).toMatchObject({ v: 1, kdf: { algo: "PBKDF2-HMAC-SHA256", iter: BACKUP_KDF_ITER }, alg: "A256GCM" });
    expect(BACKUP_KDF_ITER).toBe(600_000);
    expect(Buffer.from(envelope.kdf.salt, "base64").length).toBe(16);
    expect(Buffer.from(envelope.iv, "base64").length).toBe(12);
    expect(Buffer.from(envelope.tag, "base64").length).toBe(16);
    const text = JSON.stringify(envelope);
    for (const v of Object.values(SECRETS)) expect(text).not.toContain(v);
    expect(text).not.toContain("prod_jwt"); // refs and labels are inside the ciphertext too
    expect(text).not.toContain(PASS);

    const { vault } = scratch(); // a fresh install: new settings file, new master key, empty vault
    useFakeStore();
    expect(vaultList()).toEqual([]);
    const r = restoreVaultBackup(text, PASS);
    expect(r).toMatchObject({ added: 3, updated: 0, skipped: 0 });
    for (const [ref, v] of Object.entries(SECRETS)) expect(vaultGet(ref)).toBe(v);
    const after = Object.fromEntries(vaultList().map((m) => [m.ref, m]));
    expect(after["secret:prod_jwt"]).toMatchObject({ kind: "jwt", label: "Prod JWT", rotationIntervalDays: 30, updatedAt: before["secret:prod_jwt"]!.updatedAt });
    expect(after.figma_pat).toMatchObject({ kind: "pat", label: "Figma" });
    expect(readFileSync(join(vault, SECRETS_FILE)).toString("latin1")).not.toContain("BACKUP-SECRET");

    // Restoring the same file again changes nothing: every entry is as new as the vault's.
    expect(restoreVaultBackup(text, PASS)).toMatchObject({ added: 0, updated: 0, skipped: 3 });
  }, SLOW);

  test("a wrong passphrase refuses and writes nothing", () => {
    scratch();
    useFakeStore();
    seed();
    const { envelope } = createVaultBackup(PASS);
    const { vault } = scratch();
    useFakeStore();
    vaultPut({ ref: "other_ref", value: "value-OTHER-original-0001", kind: "token", source: "typed" });
    const bytes = vaultBytes(vault);
    expect(codeOf(() => restoreVaultBackup(envelope, "correct horse battery stapler"))).toBe("auth");
    expect(codeOf(() => restoreVaultBackup(envelope, ""))).toBe("auth");
    expect(vaultBytes(vault)!.equals(bytes!)).toBe(true);
    expect(vaultList().map((m) => m.ref)).toEqual(["other_ref"]);
  }, SLOW);

  test("a tampered file refuses (body, tag, iv, salt, iteration count, structure) and writes nothing", () => {
    scratch();
    useFakeStore();
    seed();
    const { envelope } = createVaultBackup(PASS);
    const { vault } = scratch();
    useFakeStore();
    vaultPut({ ref: "other_ref", value: "value-OTHER-original-0002", kind: "token", source: "typed" });
    const bytes = vaultBytes(vault);

    for (const f of ["ct", "tag", "iv"] as const) expect(codeOf(() => restoreVaultBackup(flip(envelope, f), PASS))).toBe("auth");
    const salt = Buffer.from(envelope.kdf.salt, "base64"); salt[0] = salt[0]! ^ 0x01;
    expect(codeOf(() => restoreVaultBackup({ ...envelope, kdf: { ...envelope.kdf, salt: salt.toString("base64") } }, PASS))).toBe("auth");
    // The header is authenticated: an in-range iteration count that differs refuses too.
    expect(codeOf(() => restoreVaultBackup({ ...envelope, kdf: { ...envelope.kdf, iter: BACKUP_KDF_ITER + 1 } }, PASS))).toBe("auth");
    // Out of range or structurally wrong: refused before any key derivation.
    expect(codeOf(() => restoreVaultBackup({ ...envelope, kdf: { ...envelope.kdf, iter: 1000 } }, PASS))).toBe("not-a-backup");
    expect(codeOf(() => restoreVaultBackup({ ...envelope, kdf: { ...envelope.kdf, iter: 2_000_000_000 } }, PASS))).toBe("not-a-backup");
    expect(codeOf(() => restoreVaultBackup({ ...envelope, v: 2 }, PASS))).toBe("not-a-backup");
    expect(codeOf(() => restoreVaultBackup({ ...envelope, alg: "A128GCM" }, PASS))).toBe("not-a-backup");
    expect(codeOf(() => restoreVaultBackup({ ...envelope, iv: "not base64!" }, PASS))).toBe("not-a-backup");
    expect(codeOf(() => restoreVaultBackup(JSON.stringify(envelope).slice(0, -5), PASS))).toBe("not-a-backup");
    expect(codeOf(() => restoreVaultBackup("[]", PASS))).toBe("not-a-backup");
    expect(codeOf(() => parseVaultBackup(null))).toBe("not-a-backup");
    expect(vaultBytes(vault)!.equals(bytes!)).toBe(true);
    expect(vaultGet("key:LUCID_VB_TEST_KEY")).toBeUndefined();
  }, SLOW);

  test("restore is newer-wins: a newer backup entry replaces, an older one is skipped, a missing one is added", () => {
    scratch();
    useFakeStore();
    const a = vaultPut({ ref: "ref_a", value: "vault-A-is-newer-000001", kind: "token", source: "typed", label: "A" });
    const b = vaultPut({ ref: "ref_b", value: "vault-B-is-older-000002", kind: "token", source: "typed", label: "B" });
    const day = 86_400_000;
    const entry = (ref: string, value: string, updatedAt: number, label: string): VaultExportEntry =>
      ({ ref, value, kind: "token", source: "typed", label, addedAt: updatedAt - day, updatedAt });
    const env = sealVaultBackup([
      entry("ref_a", "backup-A-is-older-00001", a.updatedAt - day, "A (backup)"),
      entry("ref_b", "backup-B-is-newer-00002", b.updatedAt + day, "B (backup)"),
      entry("ref_c", "backup-C-is-absent-0003", b.updatedAt, "C (backup)"),
    ], PASS);
    // Same updatedAt is not newer: it is skipped.
    const tie = sealVaultBackup([entry("ref_a", "backup-A-same-time-0004", a.updatedAt, "A tie")], PASS);

    expect(restoreVaultBackup(env, PASS)).toMatchObject({ added: 1, updated: 1, skipped: 1 });
    expect(vaultGet("ref_a")).toBe("vault-A-is-newer-000001");
    expect(vaultGet("ref_b")).toBe("backup-B-is-newer-00002");
    expect(vaultGet("ref_c")).toBe("backup-C-is-absent-0003");
    const meta = Object.fromEntries(vaultList().map((m) => [m.ref, m]));
    expect(meta.ref_a!.label).toBe("A");
    expect(meta.ref_b).toMatchObject({ label: "B (backup)", updatedAt: b.updatedAt + day });
    expect(restoreVaultBackup(tie, PASS)).toMatchObject({ added: 0, updated: 0, skipped: 1 });
    expect(vaultGet("ref_a")).toBe("vault-A-is-newer-000001");
  }, SLOW);

  test("a new backup refuses a short passphrase; an empty export still seals and opens", () => {
    scratch();
    useFakeStore();
    seed();
    expect(codeOf(() => createVaultBackup("short"))).toBe("weak-passphrase");
    expect(codeOf(() => openVaultBackup(sealVaultBackup([], PASS), PASS))).toBe("no-throw");
  }, SLOW);
});

const UI = "ui-token-0123456789abcdef0123456789abcdef";
const AGENT = "agent-token-0123456789abcdef0123456789ab";
const CTX = { uiToken: UI };
function req(path: string, body: unknown, headers: Record<string, string> = { "x-lucid-token": UI }, method = "POST"): Request {
  return new Request(`http://127.0.0.1:1${path}`, { method, headers: { "content-type": "application/json", ...headers }, ...(method === "GET" ? {} : { body: JSON.stringify(body) }) });
}

describe("routes", () => {
  test("backup answers ciphertext only, restore answers counts only; no value or passphrase in any response", async () => {
    scratch();
    useFakeStore();
    seed();
    const bodies: string[] = [];
    const call = async (path: string, body: unknown) => {
      const res = await handleVaultBackupRoutes(req(path, body), path, CTX);
      const text = await res!.text();
      bodies.push(text);
      return { status: res!.status, json: JSON.parse(text) };
    };
    const weak = await call("/api/vault/backup", { passphrase: "short" });
    expect(weak.status).toBe(400);
    const made = await call("/api/vault/backup", { passphrase: PASS });
    expect(made.status).toBe(200);
    expect(made.json.data.count).toBe(3);
    expect(made.json.data.filename).toMatch(/^lucid-vault-\d{8}-\d{4}\.lucidvault$/);
    const file: string = made.json.data.file;
    expect(parseVaultBackup(file).kdf.iter).toBe(BACKUP_KDF_ITER);

    scratch();
    useFakeStore();
    delete process.env.LUCID_VB_TEST_KEY;
    const wrong = await call("/api/vault/restore", { passphrase: "not the passphrase at all", file });
    expect(wrong.status).toBe(422);
    expect(wrong.json.ok).toBe(false);
    expect(vaultList()).toEqual([]);
    const tampered = await call("/api/vault/restore", { passphrase: PASS, file: file.replace(/"ct": "(.)/, (_m, c: string) => `"ct": "${c === "A" ? "B" : "A"}`) });
    expect(tampered.status).toBe(422);
    expect(vaultList()).toEqual([]);
    const restored = await quiet(() => call("/api/vault/restore", { passphrase: PASS, file }));
    expect(restored.status).toBe(200);
    expect(restored.json.data).toEqual({ added: 3, updated: 0, skipped: 0 });
    expect(process.env.LUCID_VB_TEST_KEY).toBe(SECRETS["key:LUCID_VB_TEST_KEY"]); // live for the next omp spawn
    expect((await call("/api/vault/restore", { passphrase: PASS })).status).toBe(400);

    const all = bodies.join("\n");
    for (const v of Object.values(SECRETS)) expect(all).not.toContain(v);
    expect(all).not.toContain(PASS);
    expect(all).not.toContain("\"value\"");
  }, SLOW);

  test("only the UI header token opens the routes; other paths pass through", async () => {
    scratch();
    useFakeStore();
    seed();
    const agent = await handleVaultBackupRoutes(req("/api/vault/backup", { passphrase: PASS }, { "x-lucid-token": AGENT }), "/api/vault/backup", CTX);
    expect(agent!.status).toBe(403);
    const none = await handleVaultBackupRoutes(req("/api/vault/backup", { passphrase: PASS }, {}), "/api/vault/backup", CTX);
    expect(none!.status).toBe(403);
    const query = await handleVaultBackupRoutes(new Request(`http://127.0.0.1:1/api/vault/backup?t=${UI}`, { method: "POST", body: JSON.stringify({ passphrase: PASS }) }), "/api/vault/backup", CTX);
    expect(query!.status).toBe(403);
    const get = await handleVaultBackupRoutes(req("/api/vault/backup", undefined, { "x-lucid-token": UI }, "GET"), "/api/vault/backup", CTX);
    expect(get!.status).toBe(405);
    expect(await handleVaultBackupRoutes(req("/api/vault/list", {}), "/api/vault/list", CTX)).toBeNull();
    expect(await handleVaultBackupRoutes(req("/api/other", {}), "/api/other", CTX)).toBeNull();
  });

  test("dev.ts chains the routes and never lists them among the agent / query-token routes", () => {
    const src = readFileSync(join(import.meta.dir, "dev.ts"), "utf8");
    const aStart = src.indexOf("const AGENT_ROUTES");
    const lists = src.slice(src.indexOf("const QUERY_TOKEN_ROUTES"), src.indexOf("\n", aStart));
    expect(lists.length).toBeGreaterThan(100);
    expect(lists).not.toContain("/api/vault");
    expect(lists).not.toContain("/api/vault/backup");
    expect(lists).not.toContain("/api/vault/restore");
    expect(src).toContain("handleVaultBackupRoutes(req, p, { uiToken: TOKEN })");
  });
});
