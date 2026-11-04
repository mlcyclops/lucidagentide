// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-VAULT-KEYS.2 (ADR-0480): the engine-side boot (migration + omp's auth broker over the vault store), the
// retargeted account features, the in-process sign-in, and the three non-vault modes. The broker is omp's
// own server, read with omp's own client (AuthBrokerClient, what `omp acp` uses), on 127.0.0.1. Every path is
// a temp dir, agent.db is a scratch copy written by omp's store, the OS backend is an in-memory fake.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteAuthCredentialStore, type AuthCredential, type UsageHistoryEntry } from "@oh-my-pi/pi-ai";
import { AuthBrokerClient } from "@oh-my-pi/pi-ai/auth-broker";
import { registerOAuthProvider, unregisterOAuthProvider } from "@oh-my-pi/pi-ai/oauth";
import { LUCID_INACTIVE_CAUSE } from "./account_policy.ts";
import { providerAuth } from "./auth_status.ts";
import {
  activateOauthIdentity, clearAllOauthCredentials, clearDisabledCredential, credentialSnapshot, disconnectCredential,
  disconnectOauthIdentity, landedFreshCredential, listOauthRows, parkAllOauth,
} from "./auth_vault.ts";
import { _setVaultBackendForTest, readVault, type OsKeyStore } from "./engine_vault.ts";
import { bootOauthVault, oauthVaultActive, startOauthLoginProcess, stopOauthVault, type OauthLoginProcess } from "./oauth_broker.ts";
import { oauthRowsTarget } from "./oauth_rows_target.ts";
import { OAUTH_REF_PREFIX, OAUTH_VAULT_MARKER, openRow, VaultAuthCredentialStore } from "./oauth_vault_store.ts";

const ENV_KEYS = ["LUCID_GUI_SETTINGS_FILE", "LUCID_ENGINE_VAULT_DIR", "LUCID_OAUTH_VAULT", "OMP_AUTH_BROKER_URL", "OMP_AUTH_BROKER_TOKEN", "OMP_AUTH_BROKER_SNAPSHOT_TTL_MS"] as const;
const ENV_BEFORE = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const dirs: string[] = [];
afterEach(async () => {
  await stopOauthVault();
  _setVaultBackendForTest(null);
  delete process.env.LUCID_OAUTH_VAULT;
});
afterAll(() => {
  for (const k of ENV_KEYS) { const v = ENV_BEFORE[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* windows sqlite handle lag */ } }
});

function fakeBackend(): void {
  let held: Buffer | null = randomBytes(32);
  const store: OsKeyStore = { kind: "dpapi", read: () => (held ? Buffer.from(held) : { missing: "absent" }), create: (k) => { held = Buffer.from(k); return true; } };
  _setVaultBackendForTest(() => store);
}
function brokenBackend(): void {
  _setVaultBackendForTest(() => ({ kind: "dpapi", read: () => ({ missing: "unavailable", detail: "test: backend down" }), create: () => false }));
}
const quiet = async <T>(fn: () => T | Promise<T>): Promise<T> => {
  const log = console.log; const warn = console.warn;
  console.log = () => {}; console.warn = () => {};
  try { return await fn(); } finally { console.log = log; console.warn = warn; }
};

const CREDS: Array<{ provider: string; credential: AuthCredential }> = [
  { provider: "anthropic", credential: { type: "oauth", access: "sk-ant-oat01-ACCESS-WORK-1111", refresh: "sk-ant-ort01-REFRESH-WORK-1111", expires: Date.now() + 9e8, email: "work@example.com" } },
  { provider: "openai-codex", credential: { type: "oauth", access: "ACCESS-CODEX-A-2222", refresh: "REFRESH-CODEX-A-2222", expires: Date.now() + 9e8, accountId: "acct-a" } },
  { provider: "openai-codex", credential: { type: "oauth", access: "ACCESS-CODEX-B-3333", refresh: "REFRESH-CODEX-B-3333", expires: Date.now() + 9e8, accountId: "acct-b" } },
  { provider: "openrouter", credential: { type: "api_key", key: "sk-or-LOGINKEY-4444", source: "login" } },
];

async function scratch(): Promise<{ root: string; vault: string; db: string }> {
  const root = mkdtempSync(join(tmpdir(), "lucid-oauth-broker-"));
  dirs.push(root);
  process.env.LUCID_GUI_SETTINGS_FILE = join(root, "lucid-gui.json");
  const vault = join(root, "lucid-engine-vault");
  process.env.LUCID_ENGINE_VAULT_DIR = vault;
  delete process.env.LUCID_OAUTH_VAULT; // a developer's shell setting must not steer these tests
  const db = join(root, "agent", "agent.db");
  const omp = await SqliteAuthCredentialStore.open(db);
  for (const c of CREDS) await omp.upsertAuthCredential(c.provider, c.credential);
  omp.close();
  return { root, vault, db };
}
function agentRows(db: string): number {
  const d = new Database(db);
  try { return d.query<{ n: number }, []>("select count(*) as n from auth_credentials").get()?.n ?? -1; } finally { d.close(); }
}
const oauthRefs = (vault: string): string[] => Object.keys(readVault(vault).entries).filter((r) => r.startsWith(OAUTH_REF_PREFIX)).sort();
function client(token = process.env.OMP_AUTH_BROKER_TOKEN ?? ""): AuthBrokerClient {
  return new AuthBrokerClient({ url: process.env.OMP_AUTH_BROKER_URL ?? "", token });
}
async function snapshotProviders(): Promise<string[]> {
  const r = await client().fetchSnapshot();
  if (r.status !== 200) throw new Error(`snapshot status ${r.status}`);
  return r.snapshot.credentials.map((c) => `${c.provider}:${c.identityKey ?? "-"}`).sort();
}
async function drain(s: ReadableStream<Uint8Array>): Promise<string> {
  let out = "";
  const dec = new TextDecoder();
  for await (const c of s) out += dec.decode(c);
  return out;
}
const noLegacy = (): OauthLoginProcess => { throw new Error("the legacy CLI path must not run"); };
function allBytes(dir: string): string {
  if (!existsSync(dir)) return "";
  let out = "";
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    out += e.isDirectory() ? allBytes(p) : readFileSync(p).toString("latin1");
  }
  return out;
}

describe("boot: omp's broker over the vault", () => {
  test("agent.db moves into the vault and omp's client reads it through the broker (refresh tokens stay home)", async () => {
    const { root, vault, db } = await scratch();
    fakeBackend();
    const state = await quiet(() => bootOauthVault({ vaultDir: vault, agentDbPath: db, disableRefresher: true }));
    expect(state.mode).toBe("vault");
    expect(state.migration).toMatchObject({ moved: 4, left: 0 });
    expect(agentRows(db)).toBe(0);
    expect(existsSync(join(vault, OAUTH_VAULT_MARKER))).toBe(true);
    expect(process.env.OMP_AUTH_BROKER_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(process.env.OMP_AUTH_BROKER_TOKEN).toMatch(/^[0-9a-f]{64}$/);
    expect(process.env.OMP_AUTH_BROKER_SNAPSHOT_TTL_MS).toBe("0");
    expect(state.detail).not.toContain(process.env.OMP_AUTH_BROKER_TOKEN ?? "x");

    const r = await client().fetchSnapshot();
    if (r.status !== 200) throw new Error("no snapshot");
    const anthropic = r.snapshot.credentials.find((c) => c.provider === "anthropic");
    expect(anthropic?.credential).toMatchObject({ type: "oauth", access: "sk-ant-oat01-ACCESS-WORK-1111", refresh: "__remote__" });
    expect(JSON.stringify(r.snapshot)).not.toContain("REFRESH-WORK");
    await expect(client("not-the-token").fetchSnapshot()).rejects.toThrow();
    for (const t of ["ACCESS-WORK-1111", "REFRESH-CODEX-A-2222", "LOGINKEY-4444"]) expect(allBytes(root)).not.toContain(t);
  });

  test("usage history goes to omp's own agent.db tables, where the budget reader looks", async () => {
    const { db, vault } = await scratch();
    fakeBackend();
    const store = VaultAuthCredentialStore.open({ vaultDir: vault, blocksFile: null });
    try {
      store.setUsageLedger(await SqliteAuthCredentialStore.open(db));
      const entry: UsageHistoryEntry = { recordedAt: Date.now(), provider: "anthropic", accountKey: "email:work@example.com", limitId: "5h", label: "5 hours", usedFraction: 0.25, resetsAt: Date.now() + 3_600_000 };
      store.recordUsageSnapshots([entry]);
    } finally { store.close(); }
    const d = new Database(db);
    try { expect(d.query<{ n: number }, []>("select count(*) as n from usage_history where provider = 'anthropic'").get()?.n).toBe(1); } finally { d.close(); }
  });
});

describe("LUCID's account features on the vault path", () => {
  test("status, park/unpark, re-enable, disconnect and sign-out-all act on the sealed rows and reach omp through the broker", async () => {
    const { vault, db } = await scratch();
    fakeBackend();
    await quiet(() => bootOauthVault({ vaultDir: vault, agentDbPath: db, disableRefresher: true }));
    expect(oauthRowsTarget()).not.toBeNull();
    const auth = providerAuth();
    expect(auth.majors.find((p) => p.id === "anthropic")).toMatchObject({ oauthActive: true, oauthIdentity: "email:work@example.com" });
    expect(listOauthRows("openai-codex").map((r) => r.identityKey)).toEqual(["account:acct-a", "account:acct-b"]);

    // Switch to acct-b: acct-a parked under LUCID's cause, sealed, and gone from what omp children see.
    expect(activateOauthIdentity("openai-codex", "account:acct-b")).toMatchObject({ parked: 1, unparked: 0 });
    const parked = openRow(readVault(vault).entries["oauth:openai-codex:account:acct-a"]!.value)!;
    expect(parked.disabled_cause).toBe(LUCID_INACTIVE_CAUSE);
    expect(await snapshotProviders()).toEqual(["anthropic:email:work@example.com", "openai-codex:account:acct-b", "openrouter:-"]);
    expect(activateOauthIdentity("openai-codex", "account:acct-a")).toMatchObject({ parked: 1, unparked: 1 });
    expect(parkAllOauth("openai-codex").parked).toBe(1);
    expect(await snapshotProviders()).toEqual(["anthropic:email:work@example.com", "openrouter:-"]);

    // An omp logout (soft-disable through the broker wire), then LUCID's explicit re-enable.
    const snap = await client().fetchSnapshot();
    if (snap.status !== 200) throw new Error("no snapshot");
    const id = snap.snapshot.credentials.find((c) => c.provider === "anthropic")!.id;
    await client().disableCredential(id, "logged out by user");
    expect(providerAuth().majors.find((p) => p.id === "anthropic")?.oauthActive).toBe(false);
    expect(clearDisabledCredential("anthropic")).toMatchObject({ cleared: 1, identity: "email:work@example.com" });
    expect(providerAuth().majors.find((p) => p.id === "anthropic")?.oauthActive).toBe(true);
    expect(credentialSnapshot("anthropic")).toMatchObject({ present: true, id, disabled: false });
    expect(await snapshotProviders()).toContain("anthropic:email:work@example.com");

    // Disconnect one identity, then one provider, then everything OAuth: sealed entries go with the rows.
    expect(disconnectOauthIdentity("openai-codex", "account:acct-a").removed).toBe(1);
    expect(oauthRefs(vault)).not.toContain("oauth:openai-codex:account:acct-a");
    expect(disconnectCredential("openai-codex").removed).toBe(1);
    expect(clearAllOauthCredentials().removed).toBe(1);
    expect(oauthRefs(vault)).toEqual(["oauth:openrouter:row-4"]); // the login API key is not an OAuth row
    expect(agentRows(db)).toBe(0); // and none of it went back to agent.db
  });

  test("a refused vault write changes nothing: the feature reports 0 and the row keeps its state", async () => {
    const { vault, db } = await scratch();
    fakeBackend();
    await quiet(() => bootOauthVault({ vaultDir: vault, agentDbPath: db, disableRefresher: true }));
    brokenBackend();
    const r = await quiet(() => parkAllOauth("openai-codex"));
    expect(r.parked).toBe(0);
    expect(r.reason).toContain("vault");
    expect(listOauthRows("openai-codex").every((x) => x.disabledCause === null)).toBe(true);
  });
});

describe("sign-in through the vault", () => {
  test("the in-process sign-in prints what omp's CLI prints, answers prompts from stdin, and seals the credential", async () => {
    const { root, vault, db } = await scratch();
    fakeBackend();
    await quiet(() => bootOauthVault({ vaultDir: vault, agentDbPath: db, disableRefresher: true }));
    registerOAuthProvider({
      id: "lucid-test-oauth",
      name: "LUCID test",
      async login(cb) {
        cb.onAuth({ url: "https://auth.example.com/authorize?x=1", instructions: "Enter code: ABCD-1234" });
        const domain = await cb.onPrompt({ message: "Enterprise domain", placeholder: "blank for github.com" });
        cb.onProgress?.("Exchanging code");
        return { access: `ACCESS-SIGNIN-${domain}-5555`, refresh: "REFRESH-SIGNIN-5555", expires: Date.now() + 9e8, email: "tester@example.com" };
      },
    });
    try {
      const before = credentialSnapshot("lucid-test-oauth");
      const proc = startOauthLoginProcess("lucid-test-oauth", noLegacy);
      proc.stdin.write(new TextEncoder().encode("ghe.example.com\n")); // written before the prompt, as dev.ts does for Copilot
      const [out, err, code] = await Promise.all([drain(proc.stdout), drain(proc.stderr), proc.exited]);
      expect(code).toBe(0);
      expect(err).toBe("");
      expect(out).toContain("\nOpen this URL in your browser:\nhttps://auth.example.com/authorize?x=1\n");
      expect(out).toContain("Enter code: ABCD-1234\n");
      expect(out).toContain("Enterprise domain (blank for github.com): ");
      expect(out).toContain("Exchanging code\n");
      expect(out).not.toContain("ACCESS-SIGNIN");
      expect(oauthRefs(vault)).toContain("oauth:lucid-test-oauth:email:tester@example.com");
      expect(landedFreshCredential(before, credentialSnapshot("lucid-test-oauth"))).toBe(true);
      expect(await snapshotProviders()).toContain("lucid-test-oauth:email:tester@example.com");
      expect(allBytes(root)).not.toContain("ACCESS-SIGNIN");
    } finally { unregisterOAuthProvider("lucid-test-oauth"); }
  });

  test("a failed sign-in exits 1 with the reason on stderr, the way dev.ts's failure note reads it", async () => {
    const { vault, db } = await scratch();
    fakeBackend();
    await quiet(() => bootOauthVault({ vaultDir: vault, agentDbPath: db, disableRefresher: true }));
    const proc = startOauthLoginProcess("no-such-provider-xyz", noLegacy);
    const [, err, code] = await Promise.all([drain(proc.stdout), drain(proc.stderr), proc.exited]);
    expect(code).toBe(1);
    expect(err).toMatch(/^Login failed: .+/);
  });
});

describe("kill switch and the non-vault modes", () => {
  test("LUCID_OAUTH_VAULT=0 keeps the old path: agent.db untouched, no broker env, legacy sign-in", async () => {
    const { vault, db } = await scratch();
    fakeBackend();
    process.env.LUCID_OAUTH_VAULT = "0";
    delete process.env.OMP_AUTH_BROKER_URL;
    const state = await quiet(() => bootOauthVault({ vaultDir: vault, agentDbPath: db }));
    expect(state.mode).toBe("off");
    expect(agentRows(db)).toBe(4);
    expect(oauthVaultActive()).toBe(false);
    expect(oauthRowsTarget()).toBeNull();
    expect(process.env.OMP_AUTH_BROKER_URL).toBeUndefined();
    let legacyRan = false;
    const legacy = (): OauthLoginProcess => { legacyRan = true; return { stdin: { write: () => 0 }, stdout: new ReadableStream(), stderr: new ReadableStream(), exited: Promise.resolve(0) }; };
    startOauthLoginProcess("anthropic", legacy);
    expect(legacyRan).toBe(true);
    expect(existsSync(join(vault, "secrets.v1.json"))).toBe(false);
  });

  test("a profile whose vault is not the default one (tests, Creator, fleet profiles) never moves the shared agent.db", async () => {
    await scratch(); // LUCID_ENGINE_VAULT_DIR points at a scratch vault: not ~/.omp/lucid-engine-vault
    fakeBackend();
    const state = await quiet(() => bootOauthVault()); // no explicit agent.db: the engine's own call
    expect(state.mode).toBe("off");
    expect(state.detail).toContain("not the default profile");
    expect(oauthVaultActive()).toBe(false);
  });

  test("a vault that is not usable before anything moved: the old path, agent.db untouched, no marker", async () => {
    const { vault, db } = await scratch();
    brokenBackend();
    const state = await quiet(() => bootOauthVault({ vaultDir: vault, agentDbPath: db }));
    expect(state.mode).toBe("legacy");
    expect(agentRows(db)).toBe(4);
    expect(existsSync(join(vault, OAUTH_VAULT_MARKER))).toBe(false);
  });

  test("a vault that took the credentials and is not usable now: refused, never a plaintext sign-in", async () => {
    const { vault, db } = await scratch();
    mkdirSync(vault, { recursive: true });
    writeFileSync(join(vault, OAUTH_VAULT_MARKER), JSON.stringify({ v: 1, since: 1 }));
    brokenBackend();
    const state = await quiet(() => bootOauthVault({ vaultDir: vault, agentDbPath: db }));
    expect(state.mode).toBe("refused");
    expect(oauthVaultActive()).toBe(false);
    expect(() => startOauthLoginProcess("anthropic", noLegacy)).toThrow(/refused/);
  });
});
