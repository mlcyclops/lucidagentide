// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-VAULT-V2.1 (ADR-0474): the v2 sealed format and the Contract B API (vault_store.ts) plus its HTTP
// surface (vault_routes.ts): a v1 file upgrades on the first real write without losing a value, every
// P-VAULT-KEYS.1 fail-closed rule still holds through the new API, and no route response ever carries a
// secret value. The OS backend is an in-memory fake (_setVaultBackendForTest); every path is a temp dir.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _setVaultBackendForTest, readVault, sealSecrets, SECRETS_FILE, type OsKeyStore } from "./engine_vault.ts";
import { load } from "./settings_store.ts";
import { _resetVaultEnvForTest } from "./vault_env.ts";
import { handleVaultRoutes, VAULT_MAIN_TOKEN_HEADER } from "./vault_routes.ts";
import {
  vaultDelete, vaultExportEntries, vaultGet, vaultImportEntries, vaultList, vaultPut, vaultRotate, vaultStatus, workspaceRef,
} from "./vault_store.ts";

const ENV_KEYS = ["LUCID_GUI_SETTINGS_FILE", "LUCID_ENGINE_VAULT_DIR", "LUCID_OMP_MODELS_YAML", "LUCID_V2_TEST_KEY", "LUCID_V2_ROUTE_KEY"] as const;
const ENV_BEFORE = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const dirs: string[] = [];
function scratch(): { root: string; file: string; vault: string } {
  const root = mkdtempSync(join(tmpdir(), "lucid-vault-v2-"));
  dirs.push(root);
  const file = join(root, "lucid-gui.json");
  process.env.LUCID_GUI_SETTINGS_FILE = file;
  process.env.LUCID_OMP_MODELS_YAML = join(root, "models.yml");
  delete process.env.LUCID_ENGINE_VAULT_DIR;
  return { root, file, vault: join(root, "lucid-engine-vault") };
}
afterEach(() => { _setVaultBackendForTest(null); _resetVaultEnvForTest(); });
afterAll(() => {
  for (const k of ENV_KEYS) { const v = ENV_BEFORE[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const quiet = async <T>(fn: () => T | Promise<T>): Promise<T> => {
  const orig = console.error; console.error = () => {};
  try { return await fn(); } finally { console.error = orig; }
};
function useFakeStore(key: Buffer | null = null): OsKeyStore & { key(): Buffer | null } {
  let held = key ? Buffer.from(key) : null;
  const store = {
    kind: "dpapi" as const,
    read: () => (held ? Buffer.from(held) : { missing: "absent" as const }),
    create: (k: Buffer) => { held = Buffer.from(k); return true; },
    key: () => held,
  };
  _setVaultBackendForTest(() => store);
  return store;
}
/** Every file under `dir` (recursively) as latin1 text, to prove a value is not on disk in the clear. */
function allBytes(dir: string): string {
  if (!existsSync(dir)) return "";
  let out = "";
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    out += name.isDirectory() ? allBytes(p) : readFileSync(p).toString("latin1");
  }
  return out;
}

const V1 = { "key:LUCID_V2_TEST_KEY": "sk-v1-UPGRADE-000000001", "mcp:docs": "tok-v1-UPGRADE-0002", "turn:credential": "short1" };

describe("v1 -> v2 upgrade", () => {
  test("a v1 vault is read with synthesized metadata and becomes v2 on the first real write, losing nothing", () => {
    const { vault } = scratch();
    const store = useFakeStore(randomBytes(32));
    mkdirSync(vault, { recursive: true });
    writeFileSync(join(vault, SECRETS_FILE), JSON.stringify(sealSecrets(store.key()!, V1), null, 2));
    const v1Bytes = readFileSync(join(vault, SECRETS_FILE));

    const r = readVault(vault);
    expect(r.version).toBe(1);
    expect(r.secrets).toEqual(V1);
    const listed = Object.fromEntries(vaultList().map((m) => [m.ref, m]));
    expect(listed["key:LUCID_V2_TEST_KEY"]).toMatchObject({ kind: "apikey", source: "migrated-settings", envName: "LUCID_V2_TEST_KEY", last4: "0001" });
    expect(listed["mcp:docs"]).toMatchObject({ kind: "bearer", source: "migrated-settings", last4: "0002" });
    expect(listed["turn:credential"]!.last4).toBeUndefined(); // never for a secret shorter than 12 chars
    for (const m of Object.values(listed)) expect(typeof m.addedAt).toBe("number");

    // A write that changes nothing leaves the v1 file byte-for-byte.
    expect(vaultDelete("key:NOT_THERE")).toBe(false);
    expect(readFileSync(join(vault, SECRETS_FILE)).equals(v1Bytes)).toBe(true);

    const before = Date.now();
    vaultPut({ ref: "figma_pat", value: "figd-NEW-ENTRY-0000000009", kind: "pat", label: "Figma", source: "typed" });
    const raw = JSON.parse(readFileSync(join(vault, SECRETS_FILE), "utf8"));
    expect(raw.v).toBe(2);
    for (const [ref, value] of Object.entries(V1)) expect(vaultGet(ref)).toBe(value);
    const after = Object.fromEntries(vaultList().map((m) => [m.ref, m]));
    expect(after["key:LUCID_V2_TEST_KEY"]).toMatchObject({ source: "migrated-settings", envName: "LUCID_V2_TEST_KEY" });
    expect(after["key:LUCID_V2_TEST_KEY"]!.addedAt).toBeGreaterThanOrEqual(before); // stamped at the upgrade
    expect(after.figma_pat).toMatchObject({ kind: "pat", label: "Figma", source: "typed", last4: "0009" });
    // settings_store still hydrates the settings key from the upgraded file.
    expect(load().keys?.LUCID_V2_TEST_KEY).toBe(V1["key:LUCID_V2_TEST_KEY"]);
    expect(allBytes(vault)).not.toContain("UPGRADE");
  });
});

describe("Contract B API", () => {
  test("put keeps addedAt and source on replace, rotate stamps rotatedAt, delete removes", () => {
    scratch();
    useFakeStore();
    const first = vaultPut({ ref: "key:LUCID_V2_TEST_KEY", value: "sk-first-value-00000001", kind: "apikey", source: "env-import", envName: "LUCID_V2_TEST_KEY", rotationIntervalDays: 90 });
    expect(first).toMatchObject({ source: "env-import", envName: "LUCID_V2_TEST_KEY", rotationIntervalDays: 90, last4: "0001" });
    expect(JSON.stringify(first)).not.toContain("sk-first");
    const replaced = vaultPut({ ref: "key:LUCID_V2_TEST_KEY", value: "sk-second-value-0000002", kind: "apikey", source: "typed" });
    expect(replaced.source).toBe("env-import");
    expect(replaced.addedAt).toBe(first.addedAt);
    expect(replaced.rotatedAt).toBeNumber();
    const rotated = vaultRotate("key:LUCID_V2_TEST_KEY", "sk-third-value-00000003", { expiresAt: 4_000_000_000_000 });
    expect(rotated).toMatchObject({ expiresAt: 4_000_000_000_000, rotationIntervalDays: 90, last4: "0003" });
    expect(vaultGet("key:LUCID_V2_TEST_KEY")).toBe("sk-third-value-00000003");
    expect(vaultRotate("key:NOPE", "x".repeat(20))).toBeNull();
    expect(vaultDelete("key:LUCID_V2_TEST_KEY")).toBe(true);
    expect(vaultGet("key:LUCID_V2_TEST_KEY")).toBeUndefined();
    expect(() => vaultPut({ ref: "bad ref", value: "v", kind: "apikey", source: "typed" })).toThrow(/invalid vault ref/);
    expect(() => vaultPut({ ref: "key:X", value: "", kind: "apikey", source: "typed" })).toThrow(/empty value/);
  });

  test("export / import newer-wins, workspaceRef format, status carries crypto and count", () => {
    scratch();
    useFakeStore();
    vaultPut({ ref: "a_ref", value: "value-A-original-0001", kind: "token", source: "typed" });
    const exported = vaultExportEntries();
    expect(exported.map((e) => e.ref)).toEqual(["a_ref"]);
    const older = { ...exported[0]!, value: "value-A-OLDER-0000002", updatedAt: exported[0]!.updatedAt - 10 };
    const newer = { ...exported[0]!, ref: "b_ref", value: "value-B-restored-0003", source: "restore" as const };
    expect(vaultImportEntries([older, newer], "newer-wins")).toEqual({ added: 1, updated: 0, skipped: 1 });
    expect(vaultGet("a_ref")).toBe("value-A-original-0001");
    const newest = { ...exported[0]!, value: "value-A-NEWEST-000004", updatedAt: exported[0]!.updatedAt + 10 };
    expect(vaultImportEntries([newest], "newer-wins")).toEqual({ added: 0, updated: 1, skipped: 0 });
    expect(vaultGet("a_ref")).toBe("value-A-NEWEST-000004");
    expect(workspaceRef("C:\\Repo\\App", "API_KEY")).toMatch(/^ws:[0-9a-f]{16}:API_KEY$/);
    const s = vaultStatus();
    expect(s).toMatchObject({ custody: "dpapi", state: "ok", entries: 2 });
    expect(typeof s.crypto.fips).toBe("boolean");
  });
});

describe("fail-closed", () => {
  test("a failed write refuses: no backend means a throw, an error response, and no value anywhere on disk", async () => {
    const { root } = scratch();
    _setVaultBackendForTest(() => null);
    const secret = "sk-NEVER-PLAINTEXT-000001";
    expect(() => vaultPut({ ref: "key:LUCID_V2_ROUTE_KEY", value: secret, kind: "apikey", source: "typed" })).toThrow(/no OS vault backend/);
    const res = await handleVaultRoutes(uiReq("/api/vault/put", { value: secret, kind: "apikey", envName: "LUCID_V2_ROUTE_KEY", label: "x" }), "/api/vault/put", CTX);
    expect(res!.status).toBe(500);
    const body = await res!.text();
    expect(body).toContain("not stored");
    expect(body).not.toContain(secret);
    expect(allBytes(root)).not.toContain(secret);
    expect(process.env.LUCID_V2_ROUTE_KEY).toBeUndefined();
  });

  test("a master key that cannot be read refuses the write and leaves the file untouched", () => {
    const { vault } = scratch();
    const store = useFakeStore(randomBytes(32));
    vaultPut({ ref: "a_ref", value: "value-A-original-0001", kind: "token", source: "typed" });
    const before = readFileSync(join(vault, SECRETS_FILE));
    _setVaultBackendForTest(() => ({ kind: "dpapi", read: () => ({ missing: "unreadable", detail: "locked" }), create: () => false }));
    expect(() => vaultPut({ ref: "b_ref", value: "value-B-000000000002", kind: "token", source: "typed" })).toThrow(/unreadable/);
    expect(readFileSync(join(vault, SECRETS_FILE)).equals(before)).toBe(true);
    expect(store.key()).not.toBeNull();
  });

  test("an unreadable vault is never overwritten: rotate/delete refuse, put sets the old file aside byte-for-byte", async () => {
    const { vault } = scratch();
    useFakeStore(randomBytes(32));
    vaultPut({ ref: "a_ref", value: "value-A-original-0001", kind: "token", source: "typed" });
    const before = readFileSync(join(vault, SECRETS_FILE));
    useFakeStore(randomBytes(32)); // another account's key: the file no longer opens
    expect(vaultStatus().state).toBe("unreadable");
    expect(vaultList()).toEqual([]);
    expect(() => vaultDelete("a_ref")).toThrow(/unreadable/);
    expect(() => vaultRotate("a_ref", "value-A-rotated-000002")).toThrow(/unreadable/);
    const del = await handleVaultRoutes(uiReq("/api/vault/delete", { ref: "a_ref" }), "/api/vault/delete", CTX);
    expect(del!.status).toBe(500);
    expect(() => vaultExportEntries()).toThrow(/unreadable/);
    expect(readFileSync(join(vault, SECRETS_FILE)).equals(before)).toBe(true);
    await quiet(() => vaultPut({ ref: "b_ref", value: "value-B-000000000002", kind: "token", source: "typed" }));
    const aside = readdirSync(vault).filter((f) => f.startsWith(`${SECRETS_FILE}.unreadable-`));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(vault, aside[0]!)).equals(before)).toBe(true);
  });
});

const UI = "ui-token-0123456789abcdef0123456789abcdef";
const AGENT = "agent-token-0123456789abcdef0123456789ab";
const MAIN = "main-vault-token-0123456789abcdef012345";
const CTX = { uiToken: UI, mainToken: MAIN };
function uiReq(path: string, body?: unknown, headers: Record<string, string> = { "x-lucid-token": UI }): Request {
  return new Request(`http://127.0.0.1:1/${path.replace(/^\//, "")}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("routes", () => {
  test("UI routes: values go in, never come out; env refreshes on write", async () => {
    scratch();
    useFakeStore();
    const secrets = ["sk-ROUTE-SECRET-VALUE-001", "sk-ROUTE-SECRET-VALUE-002", "sk-ROUTE-SECRET-VALUE-003"];
    const bodies: string[] = [];
    const call = async (path: string, body?: unknown) => {
      const res = await handleVaultRoutes(uiReq(path, body), path, CTX);
      const text = await res!.text();
      bodies.push(text);
      return { status: res!.status, json: JSON.parse(text) };
    };
    const put = await quiet(() => call("/api/vault/put", { value: secrets[0], kind: "apikey", envName: "LUCID_V2_ROUTE_KEY", label: "Route key" }));
    expect(put.status).toBe(200);
    expect(put.json.data).toMatchObject({ ref: "key:LUCID_V2_ROUTE_KEY", envName: "LUCID_V2_ROUTE_KEY", source: "typed", last4: "-001" });
    expect(process.env.LUCID_V2_ROUTE_KEY).toBe(secrets[0]); // live for the next omp spawn, like setKey
    const labelled = await quiet(() => call("/api/vault/put", { value: secrets[1], kind: "token", label: "Prod JWT" }));
    expect(labelled.json.data.ref).toBe("secret:prod_jwt");
    const again = await quiet(() => call("/api/vault/put", { value: secrets[2], kind: "token", label: "Prod JWT" }));
    expect(again.json.data.ref).toBe("secret:prod_jwt_2"); // a label never clobbers another entry
    const rot = await quiet(() => call("/api/vault/rotate", { ref: "key:LUCID_V2_ROUTE_KEY", value: "sk-ROUTE-ROTATED-00000004" }));
    expect(rot.json.data.rotatedAt).toBeNumber();
    expect(process.env.LUCID_V2_ROUTE_KEY).toBe("sk-ROUTE-ROTATED-00000004");
    const list = await call("/api/vault/list");
    expect(list.json.data.entries.map((e: { ref: string }) => e.ref)).toEqual(["key:LUCID_V2_ROUTE_KEY", "secret:prod_jwt", "secret:prod_jwt_2"]);
    expect(list.json.data.status).toMatchObject({ state: "ok", entries: 3 });
    expect((await call("/api/vault/rotate", { ref: "key:NOPE", value: "x".repeat(20) })).status).toBe(404);
    const del = await quiet(() => call("/api/vault/delete", { ref: "key:LUCID_V2_ROUTE_KEY" }));
    expect(del.json.data).toEqual({ deleted: true });
    expect(process.env.LUCID_V2_ROUTE_KEY).toBeUndefined();
    const all = bodies.join("\n");
    for (const s of [...secrets, "sk-ROUTE-ROTATED-00000004"]) expect(all).not.toContain(s);
    expect(all).not.toContain("\"value\"");
  });

  test("the agent token, a query token and a missing vault token are refused", async () => {
    scratch();
    useFakeStore();
    vaultPut({ ref: "a_ref", value: "value-A-original-0001", kind: "token", source: "typed" });
    const agent = await handleVaultRoutes(uiReq("/api/vault/list", undefined, { "x-lucid-token": AGENT }), "/api/vault/list", CTX);
    expect(agent!.status).toBe(403);
    const query = await handleVaultRoutes(new Request(`http://127.0.0.1:1/api/vault/list?t=${UI}`), "/api/vault/list", CTX);
    expect(query!.status).toBe(403);
    const noVaultToken = await handleVaultRoutes(uiReq("/api/vault/main/list"), "/api/vault/main/list", CTX);
    expect(noVaultToken!.status).toBe(403);
    const agentMain = await handleVaultRoutes(uiReq("/api/vault/main/list", undefined, { "x-lucid-token": AGENT, [VAULT_MAIN_TOKEN_HEADER]: MAIN }), "/api/vault/main/list", CTX);
    expect(agentMain!.status).toBe(403);
    const headless = await handleVaultRoutes(uiReq("/api/vault/main/list", undefined, { "x-lucid-token": UI, [VAULT_MAIN_TOKEN_HEADER]: "" }), "/api/vault/main/list", { uiToken: UI, mainToken: "" });
    expect(headless!.status).toBe(403); // no Electron main: the main-only routes are closed
    const mainOk = await handleVaultRoutes(uiReq("/api/vault/main/list", undefined, { "x-lucid-token": UI, [VAULT_MAIN_TOKEN_HEADER]: MAIN }), "/api/vault/main/list", CTX);
    expect(mainOk!.status).toBe(200);
    expect(await mainOk!.text()).not.toContain("value-A-original");
    expect(await handleVaultRoutes(uiReq("/api/other"), "/api/other", CTX)).toBeNull();
    expect(await handleVaultRoutes(uiReq("/api/vault/backup"), "/api/vault/backup", CTX)).toBeNull(); // a later slice's route
  });

  test("dev.ts never lists a vault route among the agent / query-token routes", () => {
    const src = readFileSync(join(import.meta.dir, "dev.ts"), "utf8");
    const block = src.slice(src.indexOf("const QUERY_TOKEN_ROUTES"), src.indexOf("const AGENT_ROUTES"));
    expect(block.length).toBeGreaterThan(100);
    expect(block).not.toContain("/api/vault");
    expect(src).toContain("handleVaultRoutes(req, p, { uiToken: TOKEN })");
  });
});
