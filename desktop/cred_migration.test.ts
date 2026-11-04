// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-VAULT-V2.1 (ADR-0474): the Electron safeStorage credential vault drains into the engine vault.
// Main's side (cred_engine_client.ts) runs against a fake SafeStorageLike + in-memory VaultIo; the
// "transport" is the REAL engine route handler (vault_routes.ts) behind a fetch shim, over a real engine
// vault in a temp dir with an in-memory OS key store. Proves: import -> engine verify -> delete ordering,
// a crash between import and delete re-runs cleanly, nothing is deleted when the engine is down or
// refuses, the Creator root stays isolated, the engine resolves the same env main injected, and the
// bridge cred* calls round-trip through the routes without a value ever coming back.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  credDeleteEverywhere, credListMerged, credRotateEngine, credStoreEngine, engineCredClient, migrateCredVault,
  VAULT_MAC_HEADER, VAULT_NONCE_HEADER, vaultResponseMac, type EngineCredClient, type LegacyCredVault,
} from "./cred_engine_client.ts";
import { credEnvPlan } from "./cred_env.ts";
import { listCredentials, readCredential, storeCredential, type SafeStorageLike, type VaultIo } from "./cred_vault.ts";
import { _setVaultBackendForTest, engineVaultDir, SECRETS_FILE, type OsKeyStore } from "./engine_vault.ts";
import { materializeLocalProviders } from "./local_providers_runtime.ts";
import { meetingHubToken, setMeetingHubToken } from "./meetings_hub.ts";
import { embeddingsConfig, listLocalProviders, setEmbeddingsConfig, upsertLocalProvider } from "./settings_store.ts";
import { _resetVaultEnvForTest, applyVaultEnv } from "./vault_env.ts";
import { handleVaultRoutes } from "./vault_routes.ts";
import { vaultGet, vaultList, vaultPut } from "./vault_store.ts";

const INJECTED = ["LUCID_FIGMA_TOKEN", "LUCID_GIT_PAT", "LUCID_GIT_PAT_GITHUB_COM", "LUCID_EMBEDDINGS_KEY", "LUCID_LP_DGX_VIENNA_KEY", "LUCID_MEETING_HUB_TOKEN"];
const ENV_KEYS = ["LUCID_GUI_SETTINGS_FILE", "LUCID_ENGINE_VAULT_DIR", "LUCID_OMP_MODELS_YAML", ...INJECTED];
const ENV_BEFORE = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const roots: string[] = [];
/** A fresh settings root (the engine vault sits beside its settings file) and its legacy cred dir. */
function scratch(): { root: string; credDir: string } {
  const root = mkdtempSync(join(tmpdir(), "lucid-credmig-"));
  roots.push(root);
  useRoot(root);
  return { root, credDir: join(root, "lucid-cred-vault") };
}
function useRoot(root: string): void {
  process.env.LUCID_GUI_SETTINGS_FILE = join(root, "lucid-gui.json");
  process.env.LUCID_OMP_MODELS_YAML = join(root, "models.yml");
  delete process.env.LUCID_ENGINE_VAULT_DIR;
}
afterEach(() => {
  _setVaultBackendForTest(null);
  _resetVaultEnvForTest();
  setMeetingHubToken("");
  for (const k of INJECTED) delete process.env[k];
});
afterAll(() => {
  for (const k of ENV_KEYS) { const v = ENV_BEFORE[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
});
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const orig = console.error; console.error = () => {};
  try { return await fn(); } finally { console.error = orig; }
};
function useFakeStore(): void {
  let held: Buffer | null = null;
  const store: OsKeyStore = { kind: "dpapi", read: () => (held ? Buffer.from(held) : { missing: "absent" }), create: (k) => { held = Buffer.from(k); return true; } };
  _setVaultBackendForTest(() => store);
}

/** safeStorage stand-in: reversible, prefix-checked (a foreign blob fails to decrypt, as DPAPI would). */
const SS: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`SS1:${Buffer.from(s, "utf8").toString("base64")}`, "utf8"),
  decryptString: (b) => {
    const t = b.toString("utf8");
    if (!t.startsWith("SS1:")) throw new Error("bad blob");
    return Buffer.from(t.slice(4), "base64").toString("utf8");
  },
};
interface MemIo extends VaultIo { files: Map<string, Buffer>; onRemove?: (path: string) => void }
function memIo(): MemIo {
  const files = new Map<string, Buffer>();
  const io: MemIo = {
    files,
    ensureDir: () => {},
    writeFile: (p, d) => { files.set(p, Buffer.from(d)); },
    readFile: (p) => { const b = files.get(p); if (!b) throw new Error(`ENOENT ${p}`); return b; },
    exists: (p) => files.has(p),
    remove: (p) => { io.onRemove?.(p); files.delete(p); },
    list: (dir) => [...files.keys()].filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes("/")).map((p) => p.slice(dir.length + 1)),
  };
  return io;
}

const UI = "ui-token-0123456789abcdef0123456789abcdef";
const MAIN = "main-vault-token-0123456789abcdef012345";
/** The engine's real route handler behind fetch; every response body is kept for the no-values check. */
function routeClient(bodies: string[] = [], opts: { down?: boolean } = {}): EngineCredClient {
  const shim = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (opts.down) throw new Error("connect ECONNREFUSED");
    const req = new Request(input, init);
    const res = (await handleVaultRoutes(req, new URL(req.url).pathname, { uiToken: UI, mainToken: MAIN })) ?? new Response("not found", { status: 404 });
    const text = await res.text();
    bodies.push(text);
    return new Response(text, { status: res.status, headers: res.headers });
  };
  return engineCredClient({ baseUrl: "http://127.0.0.1:1", uiToken: UI, vaultToken: MAIN, fetch: shim as unknown as typeof fetch });
}

const T0 = 1_760_000_000_000;
const CREDS = {
  figma_pat: { kind: "apikey" as const, secret: "figd_LEGACY_FIGMA_000000001", label: "Figma personal access token" },
  git_pat: { kind: "apikey" as const, secret: "ghp_LEGACY_GENERIC_00000002" },
  git_pat_github_com: { kind: "apikey" as const, secret: "ghp_LEGACY_GITHUB_000000003", label: "github.com" },
  embeddings_key: { kind: "apikey" as const, secret: "sk-LEGACY-EMBEDDINGS-000004" },
  meeting_hub_token: { kind: "jwt" as const, secret: "hub-LEGACY-BEARER-000000005" },
  cred_dgx: { kind: "pem" as const, secret: "-----BEGIN KEY-----\nLEGACYDGXKEY000006\n-----END KEY-----\n", label: "DGX" },
};
function seed(v: LegacyCredVault, refs: (keyof typeof CREDS)[] = Object.keys(CREDS) as (keyof typeof CREDS)[]): void {
  refs.forEach((ref, i) => {
    const c = CREDS[ref];
    storeCredential(v.ss, v.io, v.dir, { ref, kind: c.kind, secret: c.secret, label: "label" in c ? c.label : undefined, createdAt: T0 + i, rotationIntervalDays: 30, expiresAt: T0 + 9e9 });
  });
}

describe("safeStorage -> engine vault migration", () => {
  test("import, engine read-back, THEN delete; same ref and CredMeta fields; a marker without values", async () => {
    const { credDir } = scratch();
    useFakeStore();
    const io = memIo();
    const v: LegacyCredVault = { ss: SS, io, dir: credDir };
    seed(v);
    const events: string[] = [];
    io.onRemove = (p) => {
      const ref = p.slice(credDir.length + 1).replace(/\.(bin|meta\.json)$/, "");
      if (p.endsWith(".bin")) events.push(`remove:${ref}:engineHolds=${vaultGet(ref) === CREDS[ref as keyof typeof CREDS].secret}`);
    };
    const base = routeClient();
    const traced: EngineCredClient = { ...base, importLegacy: async (item) => { const r = await base.importLegacy(item); events.push(`imported:${item.ref}:${r.outcome}:${r.verified}`); return r; } };
    const report = await quiet(() => migrateCredVault(v, traced, () => T0 + 1000));
    expect(report.kept).toEqual([]);
    expect(report.migrated.sort()).toEqual(Object.keys(CREDS).sort());
    for (const ref of Object.keys(CREDS)) {
      const imported = events.indexOf(`imported:${ref}:stored:true`);
      const removed = events.indexOf(`remove:${ref}:engineHolds=true`);
      expect(imported).toBeGreaterThanOrEqual(0);
      expect(removed).toBeGreaterThan(imported);
    }
    const metas = Object.fromEntries(vaultList().map((m) => [m.ref, m]));
    expect(metas.figma_pat).toMatchObject({ kind: "apikey", label: "Figma personal access token", source: "migrated-safestorage", addedAt: T0, rotatedAt: T0, rotationIntervalDays: 30, expiresAt: T0 + 9e9, last4: "0001" });
    expect(metas.cred_dgx).toMatchObject({ kind: "pem", label: "DGX", source: "migrated-safestorage", last4: "0006" });
    expect(metas.git_pat!.label).toBe("git_pat"); // no label in safeStorage: the ref names it
    for (const [ref, c] of Object.entries(CREDS)) expect(vaultGet(ref)).toBe(c.secret);
    expect([...io.files.keys()].filter((p) => p.endsWith(".bin") || p.endsWith(".meta.json"))).toEqual([]);
    const marker = report.marker!;
    expect(marker).toBe(`${credDir}/migrated-${T0 + 1000}.json`);
    const text = io.files.get(marker)!.toString("utf8");
    expect(JSON.parse(text).refs.sort()).toEqual(Object.keys(CREDS).sort());
    for (const c of Object.values(CREDS)) expect(text).not.toContain(c.secret.trim().slice(-10));
    // Idempotent: a second run finds nothing to do and writes no second marker.
    const again = await migrateCredVault(v, traced);
    expect(again).toEqual({ migrated: [], kept: [] });
  });

  test("a crash between the engine's import and main's delete re-runs cleanly (present, no rewrite)", async () => {
    const { root, credDir } = scratch();
    useFakeStore();
    const io = memIo();
    const v: LegacyCredVault = { ss: SS, io, dir: credDir };
    seed(v, ["figma_pat", "git_pat_github_com"]);
    const base = routeClient();
    const crashing: EngineCredClient = { ...base, importLegacy: async (item) => { await base.importLegacy(item); throw new Error("main crashed here"); } };
    const first = await quiet(() => migrateCredVault(v, crashing));
    expect(first.migrated).toEqual([]);
    expect(first.kept.map((k) => k.ref)).toEqual(["figma_pat", "git_pat_github_com"]);
    expect(io.files.has(`${credDir}/figma_pat.bin`)).toBe(true); // the source survives the crash
    expect(vaultGet("figma_pat")).toBe(CREDS.figma_pat.secret);
    const sealedBefore = readFileSync(join(engineVaultDir(join(root, "lucid-gui.json")), SECRETS_FILE));
    const outcomes: string[] = [];
    const traced: EngineCredClient = { ...base, importLegacy: async (item) => { const r = await base.importLegacy(item); outcomes.push(r.outcome); return r; } };
    const second = await quiet(() => migrateCredVault(v, traced));
    expect(second.migrated).toEqual(["figma_pat", "git_pat_github_com"]);
    expect(outcomes).toEqual(["present", "present"]);
    expect(readFileSync(join(engineVaultDir(join(root, "lucid-gui.json")), SECRETS_FILE)).equals(sealedBefore)).toBe(true);
    expect(io.files.has(`${credDir}/figma_pat.bin`)).toBe(false);
  });

  test("nothing is deleted when the engine is down, refuses, or a blob cannot be decrypted", async () => {
    const { credDir } = scratch();
    const io = memIo();
    const v: LegacyCredVault = { ss: SS, io, dir: credDir };
    seed(v, ["figma_pat", "git_pat"]);
    io.files.set(`${credDir}/broken.bin`, Buffer.from("not-a-safestorage-blob"));
    const removed: string[] = [];
    io.onRemove = (p) => removed.push(p);

    const down = await migrateCredVault(v, routeClient([], { down: true }));
    expect(down.migrated).toEqual([]);
    expect(down.kept.every((k) => /not reachable/.test(k.reason))).toBe(true);

    _setVaultBackendForTest(() => null); // engine up, but no OS vault backend: it refuses
    const refused = await migrateCredVault(v, routeClient());
    expect(refused.migrated).toEqual([]);
    expect(refused.kept.map((k) => k.reason)).toEqual(["engine vault unavailable", "engine vault unavailable", "engine vault unavailable"]);

    useFakeStore();
    const partial = await quiet(() => migrateCredVault(v, routeClient()));
    expect(partial.migrated).toEqual(["figma_pat", "git_pat"]);
    expect(partial.kept).toEqual([{ ref: "broken", reason: "safeStorage could not decrypt it" }]);
    expect(io.files.has(`${credDir}/broken.bin`)).toBe(true);
    expect(removed.some((p) => p.includes("broken"))).toBe(false);
  });

  test("an engine value written after the migration began wins; the stale safeStorage copy is removed", async () => {
    const { credDir } = scratch();
    useFakeStore();
    const io = memIo();
    const v: LegacyCredVault = { ss: SS, io, dir: credDir };
    seed(v, ["figma_pat"]);
    vaultPut({ ref: "figma_pat", value: "figd_NEWER_IN_ENGINE_0000007", kind: "apikey", source: "typed" });
    const r = await quiet(() => migrateCredVault(v, routeClient()));
    expect(r.migrated).toEqual(["figma_pat"]);
    expect(vaultGet("figma_pat")).toBe("figd_NEWER_IN_ENGINE_0000007");
    expect(io.files.has(`${credDir}/figma_pat.bin`)).toBe(false);
  });

  test("newer wins on a value mismatch, both directions; the source goes only once the vault holds the winner", async () => {
    const { credDir } = scratch();
    useFakeStore();
    const io = memIo();
    const v: LegacyCredVault = { ss: SS, io, dir: credDir };
    const now = Date.now();
    // figma_pat: the engine copy is older than the safeStorage one (an older build kept writing safeStorage).
    vaultPut({ ref: "figma_pat", value: "figd_OLDER_IN_ENGINE_0000010", kind: "apikey", source: "typed" });
    storeCredential(SS, io, credDir, { ref: "figma_pat", kind: "apikey", secret: "figd_NEWER_IN_SAFESTORAGE_11", createdAt: now + 60_000 }); // rotatedAt = createdAt
    // git_pat: the engine copy is newer than the safeStorage one.
    storeCredential(SS, io, credDir, { ref: "git_pat", kind: "apikey", secret: "ghp_OLDER_IN_SAFESTORAGE_012", createdAt: now - 86_400_000 });
    vaultPut({ ref: "git_pat", value: "ghp_NEWER_IN_ENGINE_000000013", kind: "apikey", source: "typed" });
    const outcomes: Record<string, string> = {};
    const base = routeClient();
    const traced: EngineCredClient = { ...base, importLegacy: async (item) => { const r = await base.importLegacy(item); outcomes[item.ref] = r.outcome; return r; } };
    const r = await quiet(() => migrateCredVault(v, traced));
    expect(r.migrated.sort()).toEqual(["figma_pat", "git_pat"]);
    expect(outcomes).toEqual({ figma_pat: "replaced", git_pat: "superseded" });
    expect(vaultGet("figma_pat")).toBe("figd_NEWER_IN_SAFESTORAGE_11");
    expect(vaultGet("git_pat")).toBe("ghp_NEWER_IN_ENGINE_000000013");
    expect(vaultList().find((m) => m.ref === "figma_pat")).toMatchObject({ source: "typed", updatedAt: now + 60_000 });
    expect(io.files.has(`${credDir}/figma_pat.bin`)).toBe(false);
    expect(io.files.has(`${credDir}/git_pat.bin`)).toBe(false);
  });

  test("an unauthenticated reply (no MAC, a wrong MAC, a body altered after signing) is a refusal: nothing is deleted", async () => {
    const { credDir } = scratch();
    useFakeStore();
    const io = memIo();
    const v: LegacyCredVault = { ss: SS, io, dir: credDir };
    seed(v, ["figma_pat", "git_pat"]);
    const removed: string[] = [];
    io.onRemove = (p) => removed.push(p);
    const engine = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const req = new Request(input, init);
      return (await handleVaultRoutes(req, new URL(req.url).pathname, { uiToken: UI, mainToken: MAIN }))!;
    };
    // The status check reaches the real engine; only the import reply is forged, claiming `verified: true`.
    const forging = (forge: (init: RequestInit | undefined, ref: string) => Promise<Response>) =>
      async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        if (!String(input).endsWith("/import")) return engine(input, init);
        return forge(init, JSON.parse(String(init?.body)).ref);
      };
    const claim = (ref: string): string => JSON.stringify({ ok: true, data: { ref, outcome: "stored", verified: true } });
    const NODE_MAC = { hmac: (k: Buffer, d: Buffer) => createHmac("sha256", k).update(d).digest(), sha256: (d: Buffer) => createHash("sha256").update(d).digest() };
    // A peer that is not the engine (e.g. squatting on [::1]:PORT) answering with no MAC ...
    const unsigned = forging(async (_init, ref) => new Response(claim(ref), { status: 200 }));
    // ... with a MAC made under some other key ...
    const wrongKey = forging(async (init, ref) => {
      const nonce = Buffer.from(new Headers(init?.headers).get(VAULT_NONCE_HEADER)!, "hex");
      const mac = vaultResponseMac(NODE_MAC, "a-guessed-token", nonce, Buffer.from(claim(ref), "utf8"));
      return new Response(claim(ref), { status: 200, headers: { [VAULT_MAC_HEADER]: mac.toString("hex") } });
    });
    // ... or the real engine's signed reply with its body changed in transit (one byte is enough).
    const altered = forging(async (init) => {
      const res = await engine("http://127.0.0.1:1/api/vault/main/import", init);
      return new Response(`${await res.text()} `, { status: res.status, headers: res.headers });
    });
    for (const f of [unsigned, wrongKey, altered]) {
      const client = engineCredClient({ baseUrl: "http://127.0.0.1:1", uiToken: UI, vaultToken: MAIN, fetch: f as unknown as typeof fetch });
      const r = await quiet(() => migrateCredVault(v, client));
      expect(r.migrated).toEqual([]);
      expect(r.kept.map((k) => k.ref)).toEqual(["figma_pat", "git_pat"]);
      expect(r.kept.every((k) => /not authenticated/.test(k.reason))).toBe(true);
    }
    expect(removed).toEqual([]);
    expect(io.files.has(`${credDir}/figma_pat.bin`)).toBe(true);
    expect(io.files.has(`${credDir}/git_pat.bin`)).toBe(true);
    // The same vault through the real, signing engine migrates: the refusals above were the MAC, not the data.
    expect((await quiet(() => migrateCredVault(v, routeClient()))).migrated).toEqual(["figma_pat", "git_pat"]);
  });

  test("the Creator root migrates into ITS engine vault only", async () => {
    const std = scratch();
    const creator = scratch();
    useFakeStore();
    const stdV: LegacyCredVault = { ss: SS, io: memIo(), dir: std.credDir };
    const creV: LegacyCredVault = { ss: SS, io: memIo(), dir: creator.credDir };
    storeCredential(SS, stdV.io, stdV.dir, { ref: "figma_pat", kind: "apikey", secret: "figd_STANDARD_BUILD_0000008" });
    storeCredential(SS, creV.io, creV.dir, { ref: "figma_pat", kind: "apikey", secret: "figd_CREATOR_BUILD_00000009" });
    useRoot(creator.root);
    expect((await quiet(() => migrateCredVault(creV, routeClient()))).migrated).toEqual(["figma_pat"]);
    expect(vaultGet("figma_pat")).toBe("figd_CREATOR_BUILD_00000009");
    useRoot(std.root);
    expect(vaultGet("figma_pat")).toBeUndefined(); // the standard vault was not touched
    expect(readCredential(SS, stdV.io, stdV.dir, "figma_pat")).toBe("figd_STANDARD_BUILD_0000008");
    expect((await quiet(() => migrateCredVault(stdV, routeClient()))).migrated).toEqual(["figma_pat"]);
    expect(vaultGet("figma_pat")).toBe("figd_STANDARD_BUILD_0000008");
    useRoot(creator.root);
    expect(vaultGet("figma_pat")).toBe("figd_CREATOR_BUILD_00000009");
  });
});

describe("engine-side env resolution", () => {
  test("after migration the engine sets the same env names and values main injected from safeStorage", async () => {
    const { credDir } = scratch();
    useFakeStore();
    const v: LegacyCredVault = { ss: SS, io: memIo(), dir: credDir };
    seed(v);
    setEmbeddingsConfig({ enabled: true, baseUrl: "https://api.openai.com/v1", model: "text-embedding-3-small", dim: 1536, authKind: "bearer", vaultRef: "embeddings_key" });
    upsertLocalProvider({
      id: "dgx1", name: "DGX Vienna", ompProvider: "dgx-vienna", baseUrl: "https://10.20.30.40:8000/v1", api: "openai-completions",
      authKind: "bearer", vaultRef: "cred_dgx", zone: "internal", models: [{ id: "llama-3.1-70b", name: "Llama 3.1 70B" }],
      enabled: true, createdAt: T0, updatedAt: T0,
    });
    // What main.ts injects at spawn: prepareCredEnv() + prepareLocalProviders() over safeStorage.
    const readLegacy = (ref: string) => readCredential(SS, v.io, v.dir, ref);
    const mainEnv: Record<string, string> = {
      ...materializeLocalProviders({ defs: listLocalProviders(), readSecret: readLegacy }).childEnv,
      ...credEnvPlan({ refs: () => listCredentials(v.io, v.dir).map((m) => m.ref), read: readLegacy }, embeddingsConfig()),
    };
    expect(Object.keys(mainEnv).sort()).toEqual([...INJECTED].sort());

    expect((await quiet(() => migrateCredVault(v, routeClient()))).migrated).toHaveLength(Object.keys(CREDS).length);
    expect(readLegacy("figma_pat")).toBeNull(); // main has nothing left to inject
    for (const k of INJECTED) delete process.env[k];
    _resetVaultEnvForTest();
    const report = await quiet(async () => applyVaultEnv());
    const { LUCID_MEETING_HUB_TOKEN: hub, ...envNames } = mainEnv;
    expect(report.names).toEqual(Object.keys(envNames).sort());
    for (const [name, value] of Object.entries(envNames)) expect(process.env[name]).toBe(value);
    // P-MEET.1 semantics: the bearer is held in module state, never in the engine's process.env.
    expect(meetingHubToken()).toBe(hub!);
    expect(process.env.LUCID_MEETING_HUB_TOKEN).toBeUndefined();
    expect(report.localProviders).toEqual(["dgx-vienna"]);
    expect(readFileSync(process.env.LUCID_OMP_MODELS_YAML!, "utf8")).not.toContain("LEGACYDGXKEY");
  });

  test("a vault change re-resolves the env; a name main injected is never removed", async () => {
    scratch();
    useFakeStore();
    process.env.LUCID_GIT_PAT = "ghp_FROM_MAIN_STILL_LEGACY_01"; // injected by main from safeStorage
    const bodies: string[] = [];
    const client = routeClient(bodies);
    await quiet(() => credStoreEngine(client, { ss: SS, io: memIo(), dir: "/nowhere" }, { ref: "git_pat_github_com", kind: "apikey", secret: "ghp_SAVED_NOW_FOR_GITHUB_02" }));
    expect(process.env.LUCID_GIT_PAT_GITHUB_COM).toBe("ghp_SAVED_NOW_FOR_GITHUB_02"); // live without a relaunch
    expect(process.env.LUCID_GIT_PAT).toBe("ghp_FROM_MAIN_STILL_LEGACY_01");
    await quiet(() => credDeleteEverywhere(client, { ss: SS, io: memIo(), dir: "/nowhere" }, "git_pat_github_com"));
    expect(process.env.LUCID_GIT_PAT_GITHUB_COM).toBeUndefined();
    expect(process.env.LUCID_GIT_PAT).toBe("ghp_FROM_MAIN_STILL_LEGACY_01");
  });
});

describe("bridge cred* through the main-only routes", () => {
  test("store, list, rotate, delete keep their shapes, reach the engine vault, and never return a value", async () => {
    const { credDir } = scratch();
    useFakeStore();
    const io = memIo();
    const v: LegacyCredVault = { ss: SS, io, dir: credDir };
    seed(v, ["cred_dgx", "figma_pat"]); // not yet migrated
    const bodies: string[] = [];
    const client = routeClient(bodies);
    const stored = await quiet(() => credStoreEngine(client, v, { kind: "jwt", secret: "eyJ.BRIDGE.STORED.TOKEN.000010", label: "prod JWT", rotationIntervalDays: 7 }));
    if ("error" in stored) throw new Error(stored.error);
    expect(stored).toMatchObject({ kind: "jwt", label: "prod JWT", last4: "0010", rotationIntervalDays: 7 });
    expect(stored.ref).toMatch(/^cred_jwt_[0-9a-z]+_[0-9a-z]+$/);
    expect(stored.createdAt).toBeNumber();
    expect(io.files.has(`${credDir}/${stored.ref}.bin`)).toBe(false); // no safeStorage write any more

    // Re-saving a ref that is still in safeStorage moves it: the stale copy can never be injected again.
    await quiet(() => credStoreEngine(client, v, { ref: "figma_pat", kind: "apikey", secret: "figd_BRIDGE_RESAVED_0000011" }));
    expect(io.files.has(`${credDir}/figma_pat.bin`)).toBe(false);

    const listed = await credListMerged(client, v);
    expect(listed.map((c) => c.ref).sort()).toEqual(["cred_dgx", "figma_pat", stored.ref].sort()); // engine + not-yet-migrated

    const rotated = await quiet(() => credRotateEngine(client, v, { ref: stored.ref, secret: "eyJ.BRIDGE.ROTATED.TOKEN.00012" }));
    expect(rotated).toMatchObject({ ref: stored.ref, last4: "0012" });
    expect(vaultGet(stored.ref)).toBe("eyJ.BRIDGE.ROTATED.TOKEN.00012");
    // Rotating a credential still in safeStorage moves it into the engine with the NEW value.
    const moved = await quiet(() => credRotateEngine(client, v, { ref: "cred_dgx", secret: "-----BEGIN KEY-----\nROTATEDDGX0013\n-----END KEY-----" }, () => T0 + 5));
    expect(moved).toMatchObject({ ref: "cred_dgx", kind: "pem", label: "DGX", rotatedAt: T0 + 5 });
    expect(io.files.has(`${credDir}/cred_dgx.bin`)).toBe(false);
    expect(await credRotateEngine(client, v, { ref: "cred_nope", secret: "x".repeat(20) })).toEqual({ error: "not-found" });

    expect(await quiet(() => credDeleteEverywhere(client, v, stored.ref))).toEqual({ deleted: true });
    expect(await credDeleteEverywhere(client, v, stored.ref)).toEqual({ deleted: false });
    expect(vaultGet(stored.ref)).toBeUndefined();

    const all = bodies.join("\n");
    for (const s of ["BRIDGE.STORED", "BRIDGE.ROTATED", "BRIDGE_RESAVED", "ROTATEDDGX", "LEGACYDGXKEY"]) expect(all).not.toContain(s);
  });

  test("security review CRED-DELETE-ENGINE-DOWN: delete is a failure unless the engine answered; a legacy-only copy counts once the engine confirms it holds none", async () => {
    const { credDir } = scratch();
    useFakeStore();
    const io = memIo();
    const v: LegacyCredVault = { ss: SS, io, dir: credDir };
    seed(v, ["git_pat"]); // a legacy safeStorage copy is present
    await quiet(() => credStoreEngine(routeClient(), { ss: SS, io: memIo(), dir: "/nowhere" }, { ref: "git_pat", kind: "apikey", secret: "ghp_ENGINE_HOLDS_THIS_000020" }));
    expect(vaultGet("git_pat")).toBe("ghp_ENGINE_HOLDS_THIS_000020");

    // Engine unreachable: not removed, said why, and nothing touched in either store.
    const down = await quiet(() => credDeleteEverywhere(routeClient([], { down: true }), v, "git_pat"));
    expect(down).toEqual({ error: expect.stringContaining("not removed, engine unavailable") });
    expect(vaultGet("git_pat")).toBe("ghp_ENGINE_HOLDS_THIS_000020");
    expect(readCredential(SS, io, credDir, "git_pat")).toBe(CREDS.git_pat.secret);

    // Engine answers: both copies go, success.
    expect(await quiet(() => credDeleteEverywhere(routeClient(), v, "git_pat"))).toEqual({ deleted: true });
    expect(vaultGet("git_pat")).toBeUndefined();
    expect(io.files.has(`${credDir}/git_pat.bin`)).toBe(false);

    // Legacy-only (not yet migrated): success because the engine confirmed it has no such ref.
    seed(v, ["figma_pat"]);
    expect(await quiet(() => credDeleteEverywhere(routeClient(), v, "figma_pat"))).toEqual({ deleted: true });
    expect(io.files.has(`${credDir}/figma_pat.bin`)).toBe(false);

    // A safeStorage copy that cannot be removed would still be injected by main: not removed either.
    seed(v, ["embeddings_key"]);
    io.onRemove = (p) => { if (p.endsWith("embeddings_key.bin")) throw new Error("EBUSY"); };
    expect(await quiet(() => credDeleteEverywhere(routeClient(), v, "embeddings_key"))).toEqual({ error: expect.stringContaining("not removed") });
    expect(io.files.has(`${credDir}/embeddings_key.bin`)).toBe(true);
  });

  test("fail-closed: with no OS vault the store is an { error } and nothing lands in safeStorage", async () => {
    const { credDir } = scratch();
    _setVaultBackendForTest(() => null);
    const io = memIo();
    const r = await quiet(() => credStoreEngine(routeClient(), { ss: SS, io, dir: credDir }, { kind: "apikey", secret: "sk-NO-VAULT-ANYWHERE-000014" }));
    expect("error" in r).toBe(true);
    expect(JSON.stringify(r)).not.toContain("NO-VAULT-ANYWHERE");
    expect(io.files.size).toBe(0);
  });
});
