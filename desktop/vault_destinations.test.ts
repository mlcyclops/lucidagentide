// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-VAULT-DEST.1 (ADR-0478): the core half of enterprise vault destinations. The connector is a stand-in
// (a fake runner, or a fake add-on CLI spawned through the real seam); no Azure, no network. Proves: the
// name mapping is the add-on's char for char; every request file (and a pull's out file) is gone after
// the call on success, on failure and on a throw; no value reaches a reply, a log line or a route
// response; without the add-on nothing pretends; auto-backup fires on vaultPut / vaultRotate only.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { addonDir, runConnectorReply, type ConnectorReply } from "./addon_seam.ts";
import { _setVaultBackendForTest, type OsKeyStore, type VaultEntryMeta } from "./engine_vault.ts";
import {
  _resetAutoBackupForTest, _setDestinationRunnerForTest, azureSecretName, flushAutoBackup, listVaultDestinations, lucidSecretTags,
  pullFromDestination, pushToDestination, REQUEST_DIR_PREFIX, upsertVaultDestination,
  type DestinationCheckResult, type DestinationListResult, type DestinationPullResult, type DestinationPushResult, type DestinationsView,
  type DestinationVerb,
} from "./vault_destinations.ts";
import type { VaultDestination } from "./settings_store.ts";
import { _resetVaultEnvForTest } from "./vault_env.ts";
import { handleVaultRoutes } from "./vault_routes.ts";
import { vaultGet, vaultImportEntries, vaultList, vaultPut, vaultRotate } from "./vault_store.ts";

// Resolved before any test points LUCID_ADDON_DIR at a fake: the operator's real add-on, if any, for the
// cross-check against the connector's own azureSecretName.
const REAL_ADDON_AZURE = resolve(addonDir(), "connectors", "kms", "azure", "src", "azure.ts");
const REAL_ADDON_HAS_MAPPING = existsSync(REAL_ADDON_AZURE) && readFileSync(REAL_ADDON_AZURE, "utf8").includes("export function azureSecretName");

const ENV_KEYS = ["LUCID_GUI_SETTINGS_FILE", "LUCID_ENGINE_VAULT_DIR", "LUCID_OMP_MODELS_YAML", "LUCID_ADDON_DIR", "LUCID_DEST_T_ONE", "LUCID_DEST_T_TWO", "LUCID_DEST_T_NEW"] as const;
const ENV_BEFORE = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const dirs: string[] = [];
const UI = "u".repeat(64);
const CTX = { uiToken: UI, mainToken: "m".repeat(64) };
const DAY = 86_400_000;

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "lucid-vaultdest-test-")); // not REQUEST_DIR_PREFIX: afterEach counts those
  dirs.push(root);
  process.env.LUCID_GUI_SETTINGS_FILE = join(root, "lucid-gui.json");
  process.env.LUCID_OMP_MODELS_YAML = join(root, "models.yml");
  delete process.env.LUCID_ENGINE_VAULT_DIR;
  return root;
}
function useFakeStore(): void {
  let held: Buffer | null = randomBytes(32);
  const store: OsKeyStore = {
    kind: "dpapi",
    read: () => (held ? Buffer.from(held) : { missing: "absent" }),
    create: (k: Buffer) => { held = Buffer.from(k); return true; },
  };
  _setVaultBackendForTest(() => store);
}
/** A fake add-on checkout whose kms connector CLI is `cliBody`. */
function fakeAddon(root: string, cliBody = `console.log(JSON.stringify({ ok: false, detail: "stub" })); process.exit(1);`): void {
  const dir = join(root, "addon", "connectors", "kms");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@lucid-addon/kms", version: "0.9.0" }));
  writeFileSync(join(dir, "src", "cli.ts"), cliBody);
  process.env.LUCID_ADDON_DIR = join(root, "addon");
}

/** The Contract C request as the add-on reads it. */
interface KmsRequest {
  destination: { kind: string; config: Record<string, string> };
  items?: Array<{ name: string; value: string; tags: Record<string, string> }>;
  names?: string[];
  out?: string;
}
interface Call { verb: DestinationVerb; file: string; existedDuring: boolean; mode: number; request: KmsRequest }
/** Install a fake runner. `answer` builds the reply (and may write the pull `out` file). */
function fakeRunner(answer: (verb: DestinationVerb, req: KmsRequest) => ConnectorReply): Call[] {
  const calls: Call[] = [];
  _setDestinationRunnerForTest(async (verb, file) => {
    const existed = existsSync(file);
    const request: KmsRequest = JSON.parse(readFileSync(file, "utf8")); // the file this module wrote: the documented request shape
    calls.push({ verb, file, existedDuring: existed, mode: statSync(file).mode & 0o777, request });
    return answer(verb, request);
  });
  return calls;
}
const okReply = (reply: Record<string, unknown>): ConnectorReply => ({ ok: true, detail: String(reply.detail ?? "done"), reply: { ok: true, ...reply } });
const failReply = (detail: string): ConnectorReply => ({ ok: false, detail, reply: { ok: false, detail } });
const pushedAll = (req: KmsRequest): ConnectorReply => okReply({ pushed: (req.items ?? []).map((i) => ({ name: i.name })), detail: "ok" });
const leftoverRequestDirs = (): string[] => readdirSync(tmpdir()).filter((n) => n.startsWith(REQUEST_DIR_PREFIX));

const AZ_CONFIG = { vaultName: "lucid-test-kv", cloud: "usgov", auth: "azure-cli" };
function uiReq(path: string, body?: unknown): Request {
  return new Request(`http://127.0.0.1:1${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-lucid-token": UI, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const bodies: string[] = [];
/** One route call through the chained vault handler; `T` is the route's documented data shape. */
async function call<T>(path: string, body?: unknown): Promise<{ status: number; data: T | undefined; error: string | undefined }> {
  const res = await handleVaultRoutes(uiReq(path, body), path, CTX);
  const text = await res!.text();
  bodies.push(text);
  const json: { ok: boolean; data?: T; error?: string } = JSON.parse(text);
  return { status: res!.status, data: json.data, error: json.error };
}
/** Run `fn` with console.log / error / warn captured; returns what was printed. */
async function captureLogs(fn: () => Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  const sink = (...a: unknown[]): void => { lines.push(a.map(String).join(" ")); };
  console.log = sink; console.error = sink; console.warn = sink;
  try { await fn(); } finally { Object.assign(console, orig); }
  return lines.join("\n");
}
const put = (ref: string, value: string, source: VaultEntryMeta["source"] = "typed"): VaultEntryMeta => vaultPut({ ref, value, kind: "apikey", source });

let before: string[] = [];
beforeEach(() => { before = leftoverRequestDirs(); });
afterEach(() => {
  _setDestinationRunnerForTest(null);
  _resetAutoBackupForTest();
  _setVaultBackendForTest(null);
  _resetVaultEnvForTest();
  // No test may leave a request dir behind.
  expect(leftoverRequestDirs().filter((d) => !before.includes(d))).toEqual([]);
});
afterAll(() => {
  for (const k of ENV_KEYS) { const v = ENV_BEFORE[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// The add-on's own expectations (connectors/kms/test/vault-client.test.ts) plus every ref family the
// core mints. Exact per char: nothing trimmed or collapsed.
const NAME_TABLE: Array<[string, string]> = [
  ["key:OPENAI_API_KEY", "lucid-key-OPENAI-API-KEY"],
  ["ws:0123456789abcdef:DB_URL", "lucid-ws-0123456789abcdef-DB-URL"],
  ["oauth:github:user@example.com", "lucid-oauth-github-user-example-com"],
  [" mcp:a__b ", "lucid--mcp-a--b-"],
  ["account:anthropic-work", "lucid-account-anthropic-work"],
  ["turn:credential", "lucid-turn-credential"],
  ["kg:dek:store_01", "lucid-kg-dek-store-01"],
  ["git_pat_github_com", "lucid-git-pat-github-com"],
  ["figma_pat", "lucid-figma-pat"],
  ["cred_apikey_m1x2_9z", "lucid-cred-apikey-m1x2-9z"],
  ["secret:prod_jwt_2", "lucid-secret-prod-jwt-2"],
  ["a.b+c", "lucid-a-b-c"],
  ["key:A_B", "lucid-key-A-B"],
  ["key:A-B", "lucid-key-A-B"],
  ["--x--", "lucid---x--"],
  ["\u00c4\u00d61", "lucid---1"],
];

describe("name mapping (Contract C)", () => {
  test("lucid- + every char outside [0-9A-Za-z-] as '-', max 127, for a table of refs", () => {
    for (const [ref, name] of NAME_TABLE) expect(azureSecretName(ref)).toBe(name);
    const long = azureSecretName(`key:${"A".repeat(300)}`);
    expect(long.length).toBe(127);
    expect(long).toBe(`lucid-key-${"A".repeat(117)}`);
    expect(() => azureSecretName("")).toThrow(/does not map/);
    expect(() => azureSecretName(":::__")).toThrow(/does not map/);
    expect(lucidSecretTags("key:OPENAI", "apikey", Date.UTC(2026, 10, 3, 12))).toEqual({
      "lucid-ref": "key:OPENAI", "lucid-kind": "apikey", "lucid-added": "2026-11-03T12:00:00.000Z",
    });
  });

  test.skipIf(!REAL_ADDON_HAS_MAPPING)("identical to the installed add-on's azureSecretName for every ref in the table", async () => {
    // Runtime-selected path (LUCID_ADDON_DIR or the sibling checkout), so a static import cannot work.
    const mod: { azureSecretName: (ref: string) => string; lucidSecretTags: typeof lucidSecretTags } = await import(REAL_ADDON_AZURE);
    for (const [ref] of NAME_TABLE) expect(azureSecretName(ref)).toBe(mod.azureSecretName(ref));
    expect(azureSecretName(`key:${"A".repeat(300)}`)).toBe(mod.azureSecretName(`key:${"A".repeat(300)}`));
    expect(lucidSecretTags("ws:ab:X", "pem", 1_700_000_000_000)).toEqual(mod.lucidSecretTags("ws:ab:X", "pem", 1_700_000_000_000));
  });
});

describe("request files", () => {
  test("written 0600 in a private dir and deleted after a successful push", async () => {
    const root = scratch(); useFakeStore(); fakeAddon(root);
    put("key:LUCID_DEST_T_ONE", "sk-dest-ONE-000000000001");
    const dest = upsertVaultDestination({ name: "Gov KV", kind: "azure-kv", config: AZ_CONFIG });
    const calls = fakeRunner((_v, req) => okReply({ pushed: (req.items ?? []).map((i) => ({ name: i.name, version: "v7" })), detail: "pushed 1" }));
    const r = await pushToDestination(dest.id);
    expect(r.ok).toBe(true);
    expect(r.pushed).toEqual([{ ref: "key:LUCID_DEST_T_ONE", name: "lucid-key-LUCID-DEST-T-ONE", version: "v7" }]);
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.existedDuring).toBe(true);
    if (process.platform !== "win32") expect(c.mode).toBe(0o600);
    expect(c.file.includes(REQUEST_DIR_PREFIX)).toBe(true);
    expect(c.request).toEqual({
      destination: { kind: "azure-kv", config: AZ_CONFIG },
      items: [{ name: "lucid-key-LUCID-DEST-T-ONE", value: "sk-dest-ONE-000000000001", tags: expect.objectContaining({ "lucid-ref": "key:LUCID_DEST_T_ONE", "lucid-kind": "apikey" }) }],
    });
    expect(existsSync(c.file)).toBe(false);
    expect(existsSync(join(c.file, ".."))).toBe(false);
  });

  test("deleted when the connector fails, and when the call throws", async () => {
    const root = scratch(); useFakeStore(); fakeAddon(root);
    put("key:LUCID_DEST_T_ONE", "sk-dest-ONE-000000000001");
    const dest = upsertVaultDestination({ name: "Gov KV", kind: "azure-kv", config: AZ_CONFIG });
    const failed = fakeRunner(() => failReply("403: assign Key Vault Secrets Officer"));
    const r = await pushToDestination(dest.id);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("Secrets Officer");
    expect(existsSync(failed[0]!.file)).toBe(false);

    let thrownFile = "";
    _setDestinationRunnerForTest(async (_verb, file) => { thrownFile = file; throw new Error("spawn failed"); });
    await expect(pushToDestination(dest.id)).rejects.toThrow("spawn failed");
    expect(thrownFile).not.toBe("");
    expect(existsSync(thrownFile)).toBe(false);
  });

  test("a pull's out file is read, imported and deleted with the request", async () => {
    const root = scratch(); useFakeStore(); fakeAddon(root);
    const dest = upsertVaultDestination({ name: "Gov KV", kind: "azure-kv", config: AZ_CONFIG });
    let outPath = "";
    const calls = fakeRunner((verb, req) => {
      if (verb === "list") return okReply({ items: [{ name: "lucid-key-LUCID-DEST-T-NEW", tags: lucidSecretTags("key:LUCID_DEST_T_NEW", "apikey", 1_000), updatedOn: "2026-11-01T00:00:00.000Z" }], detail: "listed 1" });
      outPath = req.out ?? "";
      writeFileSync(outPath, JSON.stringify({ "lucid-key-LUCID-DEST-T-NEW": "sk-dest-PULLED-00000000003" }), { mode: 0o600 });
      return okReply({ pulled: 1, detail: "pulled 1" });
    });
    const r = await pullFromDestination(dest.id);
    expect(r).toMatchObject({ ok: true, added: 1, updated: 0, refs: ["key:LUCID_DEST_T_NEW"] });
    expect(calls.map((c) => c.verb)).toEqual(["list", "pull"]);
    expect(calls[1]!.request.names).toEqual(["lucid-key-LUCID-DEST-T-NEW"]);
    expect(outPath.includes(REQUEST_DIR_PREFIX)).toBe(true);
    expect(existsSync(outPath)).toBe(false);
    for (const c of calls) expect(existsSync(c.file)).toBe(false);
    expect(vaultGet("key:LUCID_DEST_T_NEW")).toBe("sk-dest-PULLED-00000000003");
    expect(vaultList().find((m) => m.ref === "key:LUCID_DEST_T_NEW")).toMatchObject({ source: "destination-pull", kind: "apikey", envName: "LUCID_DEST_T_NEW" });
    expect(process.env.LUCID_DEST_T_NEW).toBe("sk-dest-PULLED-00000000003"); // live for the next spawn, like a route write
  });

  test("through the real seam: a fake add-on CLI sees a 0600 file, its exit-1 JSON line is parsed, and the file is gone", async () => {
    const root = scratch(); useFakeStore();
    // Beside the fake connector (the child's env is not this test's mutated process.env).
    const log = join(root, "addon", "connectors", "kms", "calls.log");
    fakeAddon(root, `
      import { appendFileSync, readFileSync, statSync } from "node:fs";
      import { join } from "node:path";
      const verb = process.argv[2];
      const file = process.argv[process.argv.indexOf("--file") + 1];
      const req = JSON.parse(readFileSync(file, "utf8"));
      appendFileSync(join(import.meta.dir, "..", "calls.log"), JSON.stringify({ verb, file, mode: statSync(file).mode & 0o777, kind: req.destination.kind }) + "\\n");
      if (verb === "put" && req.destination.kind === "azure-kv") {
        console.log(JSON.stringify({ ok: true, pushed: req.items.map((i) => ({ name: i.name, version: "v1" })), detail: "pushed " + req.items.length }));
      } else {
        console.log(JSON.stringify({ ok: false, detail: verb + " is not implemented yet for " + req.destination.kind }));
        process.exit(1);
      }
    `);
    put("key:LUCID_DEST_T_ONE", "sk-dest-ONE-000000000001");
    const az = upsertVaultDestination({ name: "Gov KV", kind: "azure-kv", config: AZ_CONFIG });
    const aws = upsertVaultDestination({ name: "AWS", kind: "aws-sm", config: { region: "us-gov-west-1" } });
    const pushed = await pushToDestination(az.id);
    expect(pushed).toMatchObject({ ok: true, pushed: [{ ref: "key:LUCID_DEST_T_ONE", name: "lucid-key-LUCID-DEST-T-ONE", version: "v1" }] });
    const refused = await pushToDestination(aws.id);
    expect(refused.ok).toBe(false);
    expect(refused.detail).toContain("not implemented yet for aws-sm");
    const seen: Array<{ verb: string; file: string; mode: number; kind: string }> = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(seen.map((s) => `${s.verb}:${s.kind}`)).toEqual(["put:azure-kv", "put:aws-sm"]);
    for (const s of seen) {
      if (process.platform !== "win32") expect(s.mode).toBe(0o600);
      expect(existsSync(s.file)).toBe(false);
    }
    // A connector that prints no JSON line (here it crashes on a missing file) is a failure with no reply.
    const direct = await runConnectorReply("kms", "put", join(root, "missing.json"), 20_000);
    expect(direct.ok).toBe(false);
    expect(direct.reply).toBeNull();
  });
});

describe("no value in any reply, log or route response", () => {
  test("a connector that echoes values is scrubbed; push, list, pull and check answer metadata only", async () => {
    const root = scratch(); useFakeStore(); fakeAddon(root);
    const VALUES = ["sk-dest-ONE-000000000001", "sk-dest-TWO-000000000002", "client-SECRET-value-0003", "sk-dest-PULLED-00000000004"] as const;
    const out = await captureLogs(async () => {
      expect((await call("/api/vault/put", { value: VALUES[0], kind: "apikey", envName: "LUCID_DEST_T_ONE" })).status).toBe(200);
      expect((await call("/api/vault/put", { value: VALUES[2], kind: "password", label: "kv client secret" })).status).toBe(200);
      const secretRef = vaultList().find((m) => m.kind === "password")!.ref;
      const saved = await call<VaultDestination>("/api/vault/destinations/save", {
        name: "Gov KV", kind: "azure-kv", autoBackup: true,
        config: { vaultName: "lucid-test-kv", cloud: "usgov", auth: "client-secret", tenantId: "contoso.onmicrosoft.us", clientId: "11111111-2222-3333-4444-555555555555", clientSecretRef: secretRef },
      });
      expect(saved.status).toBe(200);
      const id = saved.data!.id;
      const future = new Date(Date.now() + DAY).toISOString();
      const calls = fakeRunner((verb, req) => {
        const echo = `echo ${req.destination.config.clientSecret} ${JSON.stringify(req.items ?? [])}`; // a misbehaving connector
        if (verb === "list") return okReply({ items: [{ name: "lucid-key-LUCID-DEST-T-TWO", tags: lucidSecretTags("key:LUCID_DEST_T_TWO", "apikey", 1), updatedOn: future }], detail: echo });
        if (verb === "pull") {
          writeFileSync(req.out ?? "", JSON.stringify({ "lucid-key-LUCID-DEST-T-TWO": VALUES[3] }));
          return okReply({ pulled: 1, detail: `${echo} ${VALUES[3]}` });
        }
        if (verb === "put") return okReply({ pushed: (req.items ?? []).map((i) => ({ name: i.name })), detail: echo });
        return failReply(`denied ${echo}`);
      });
      // A put through the route triggers auto-backup (its log line is captured too).
      expect((await call("/api/vault/put", { value: VALUES[1], kind: "apikey", envName: "LUCID_DEST_T_TWO" })).status).toBe(200);
      await flushAutoBackup();
      const view = (await call<DestinationsView>("/api/vault/destinations")).data!;
      expect(view.destinations[0]!.lastAutoBackup).toMatchObject({ ok: true, pushed: 1 });
      expect(view.destinations[0]!.config.clientSecretRef).toBe(secretRef);
      expect(view.destinations[0]!.config.clientSecret).toBeUndefined();
      expect((await call<DestinationCheckResult>("/api/vault/destinations/check", { id })).data!.ok).toBe(false);
      expect((await call<DestinationPushResult>("/api/vault/push", { id })).data!.ok).toBe(true);
      expect((await call<DestinationListResult>("/api/vault/destinations/list", { id })).data!.items[0]).toMatchObject({ ref: "key:LUCID_DEST_T_TWO", local: "older" });
      expect((await call<DestinationPullResult>("/api/vault/pull", { id })).data).toMatchObject({ ok: true, updated: 1 });
      // The resolved client secret reached the connector (in the 0600 file), and only there.
      expect(calls.length).toBeGreaterThanOrEqual(5);
      for (const c of calls) {
        expect(c.request.destination.config.clientSecret).toBe(VALUES[2]);
        expect(c.request.destination.config.clientSecretRef).toBeUndefined();
      }
    });
    expect(vaultGet("key:LUCID_DEST_T_TWO")).toBe(VALUES[3]);
    const everything = `${bodies.join("\n")}\n${out}`;
    for (const v of VALUES) expect(everything).not.toContain(v);
    expect(everything).toContain("[redacted]");
  });
});

describe("without the add-on", () => {
  test("honest not-installed state: the view says so, writes and connector calls refuse, nothing runs", async () => {
    const root = scratch(); useFakeStore();
    process.env.LUCID_ADDON_DIR = join(root, "no-addon-here");
    const calls = fakeRunner(() => okReply({ detail: "must never run" }));
    const view = await call<DestinationsView>("/api/vault/destinations");
    expect(view.status).toBe(200);
    expect(view.data!.addon).toMatchObject({ installed: false, version: null });
    expect(view.data!.addon.note).toContain("enterprise add-on");
    const save = await call("/api/vault/destinations/save", { name: "Gov KV", kind: "azure-kv", config: AZ_CONFIG });
    expect(save.status).toBe(409);
    expect(save.error).toContain("Enterprise add-on not installed");
    for (const p of ["/api/vault/push", "/api/vault/pull", "/api/vault/destinations/check", "/api/vault/destinations/list", "/api/vault/destinations/auto-backup"]) {
      expect((await call(p, { id: "dest-x" })).status).toBe(409);
    }
    expect(listVaultDestinations()).toEqual([]);

    // A destination saved while the add-on was present: auto-backup records the refusal, never a success.
    fakeAddon(root);
    const dest = upsertVaultDestination({ name: "Gov KV", kind: "azure-kv", config: AZ_CONFIG, autoBackup: true });
    process.env.LUCID_ADDON_DIR = join(root, "no-addon-here");
    await captureLogs(async () => {
      put("key:LUCID_DEST_T_ONE", "sk-dest-ONE-000000000001");
      await flushAutoBackup();
    });
    const last = (await call<DestinationsView>("/api/vault/destinations")).data!.destinations[0]!.lastAutoBackup;
    expect(last).toMatchObject({ ok: false, pushed: 0 });
    expect(last!.detail).toContain("Enterprise add-on not installed");
    expect(calls).toHaveLength(0);
    expect((await call<{ removed: boolean }>("/api/vault/destinations/remove", { id: dest.id })).data).toEqual({ removed: true }); // removing needs no connector
  });

  test("agent and query tokens are refused on every destination route", async () => {
    const root = scratch(); useFakeStore(); fakeAddon(root);
    const agent = new Request("http://127.0.0.1:1/api/vault/destinations", { headers: { "x-lucid-token": "a".repeat(64) } });
    expect((await handleVaultRoutes(agent, "/api/vault/destinations", CTX))!.status).toBe(403);
    const query = new Request(`http://127.0.0.1:1/api/vault/push?t=${UI}`, { method: "POST", body: "{}" });
    expect((await handleVaultRoutes(query, "/api/vault/push", CTX))!.status).toBe(403);
  });
});

describe("auto-backup", () => {
  test("vaultPut and vaultRotate push the written ref to auto-backup destinations only, a burst coalesced into one put", async () => {
    const root = scratch(); useFakeStore(); fakeAddon(root);
    upsertVaultDestination({ name: "Backup", kind: "azure-kv", config: AZ_CONFIG, autoBackup: true });
    upsertVaultDestination({ name: "Manual only", kind: "azure-kv", config: { ...AZ_CONFIG, vaultName: "lucid-manual-kv" } });
    const calls = fakeRunner((_v, req) => pushedAll(req));
    await captureLogs(async () => {
      put("key:LUCID_DEST_T_ONE", "sk-dest-ONE-000000000001");
      put("key:LUCID_DEST_T_TWO", "sk-dest-TWO-000000000002", "agent-request");
      await flushAutoBackup();
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.verb).toBe("put");
    expect(calls[0]!.request.destination.config.vaultName).toBe("lucid-test-kv");
    expect((calls[0]!.request.items ?? []).map((i) => i.name).sort()).toEqual(["lucid-key-LUCID-DEST-T-ONE", "lucid-key-LUCID-DEST-T-TWO"]);

    await captureLogs(async () => {
      vaultRotate("key:LUCID_DEST_T_ONE", "sk-dest-ONE-ROTATED-0005");
      await flushAutoBackup();
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.request.items).toEqual([expect.objectContaining({ name: "lucid-key-LUCID-DEST-T-ONE", value: "sk-dest-ONE-ROTATED-0005" })]);

    // Restore / pull imports are not new secrets: no push.
    await captureLogs(async () => {
      vaultImportEntries([{ ref: "key:LUCID_DEST_T_NEW", value: "sk-dest-IMPORTED-0000006", kind: "apikey", label: "x", source: "restore", addedAt: 1, updatedAt: 1 }], "newer-wins");
      await flushAutoBackup();
    });
    expect(calls).toHaveLength(2);
  });
});

describe("push and pull rules", () => {
  test("two refs that map to one destination name are both refused, the rest pushed", async () => {
    const root = scratch(); useFakeStore(); fakeAddon(root);
    put("key:A_B", "sk-dest-COLLIDE-00000001");
    put("key:A-B", "sk-dest-COLLIDE-00000002");
    put("key:LUCID_DEST_T_ONE", "sk-dest-ONE-000000000001");
    const dest = upsertVaultDestination({ name: "KV", kind: "azure-kv", config: AZ_CONFIG });
    const calls = fakeRunner((_v, req) => pushedAll(req));
    const r = await pushToDestination(dest.id);
    expect((calls[0]!.request.items ?? []).map((i) => i.name)).toEqual(["lucid-key-LUCID-DEST-T-ONE"]);
    expect(r.skipped.map((s) => s.ref).sort()).toEqual(["key:A-B", "key:A_B"]);
    expect(r.pushed.map((p) => p.ref)).toEqual(["key:LUCID_DEST_T_ONE"]);
  });

  test("pull is newer-wins, ignores secrets whose lucid-ref tag does not match their name, and is all-or-nothing", async () => {
    const root = scratch(); useFakeStore(); fakeAddon(root);
    put("key:LUCID_DEST_T_ONE", "sk-dest-ONE-LOCAL-NEWER-01");
    put("key:LUCID_DEST_T_TWO", "sk-dest-TWO-LOCAL-OLDER-02");
    const dest = upsertVaultDestination({ name: "KV", kind: "azure-kv", config: AZ_CONFIG });
    const past = new Date(Date.now() - DAY).toISOString();
    const future = new Date(Date.now() + DAY).toISOString();
    const items = [
      { name: "lucid-key-LUCID-DEST-T-ONE", tags: lucidSecretTags("key:LUCID_DEST_T_ONE", "apikey", 1), updatedOn: past },
      { name: "lucid-key-LUCID-DEST-T-TWO", tags: lucidSecretTags("key:LUCID_DEST_T_TWO", "apikey", 1), updatedOn: future },
      { name: "someone-elses-secret", tags: {} },
      { name: "lucid-key-OTHER", tags: lucidSecretTags("key:LUCID_DEST_T_ONE", "apikey", 1), updatedOn: future }, // the tag lies about its ref
    ];
    let requested: string[] = [];
    let complete = false;
    fakeRunner((verb, req) => {
      if (verb === "list") return okReply({ items, detail: "listed" });
      requested = req.names ?? [];
      writeFileSync(req.out ?? "", JSON.stringify(complete ? { "lucid-key-LUCID-DEST-T-TWO": "sk-dest-TWO-REMOTE-NEWER-3" } : {}));
      return okReply({ pulled: requested.length, detail: "pulled" });
    });
    const partial = await pullFromDestination(dest.id);
    expect(partial.ok).toBe(false);
    expect(requested).toEqual(["lucid-key-LUCID-DEST-T-TWO"]);
    expect(vaultGet("key:LUCID_DEST_T_TWO")).toBe("sk-dest-TWO-LOCAL-OLDER-02"); // nothing written
    complete = true;
    const r = await pullFromDestination(dest.id);
    expect(r).toMatchObject({ ok: true, added: 0, updated: 1, refs: ["key:LUCID_DEST_T_TWO"] });
    expect(vaultGet("key:LUCID_DEST_T_TWO")).toBe("sk-dest-TWO-REMOTE-NEWER-3");
    expect(vaultGet("key:LUCID_DEST_T_ONE")).toBe("sk-dest-ONE-LOCAL-NEWER-01");
    expect(vaultList().find((m) => m.ref === "key:LUCID_DEST_T_TWO")?.source).toBe("typed"); // an update keeps the entry's own metadata
  });
});

describe("destination config", () => {
  test("non-secret only: a secret-looking field, an unknown field or a dangling clientSecretRef is refused", async () => {
    const root = scratch(); useFakeStore(); fakeAddon(root);
    const bad = [
      { name: "x", kind: "azure-kv", config: { ...AZ_CONFIG, clientSecret: "client-SECRET-value-0003" } },
      { name: "x", kind: "azure-kv", config: { ...AZ_CONFIG, auth: "client-secret", tenantId: "t", clientId: "c", clientSecretRef: "secret:not_there" } },
      { name: "x", kind: "azure-kv", config: { ...AZ_CONFIG, vaultName: "a--b" } },
      { name: "x", kind: "azure-kv", config: { ...AZ_CONFIG, cloud: "china" } },
      { name: "x", kind: "aws-sm", config: { secretAccessKey: "AKIA-SECRET-value-000" } },
      { name: "x", kind: "nope", config: {} },
    ];
    for (const b of bad) {
      const r = await call("/api/vault/destinations/save", b);
      expect(r.status).toBe(400);
      expect(r.error ?? "").not.toContain("SECRET-value");
    }
    expect(listVaultDestinations()).toEqual([]);
    const saved = (await call<VaultDestination>("/api/vault/destinations/save", { name: "  Gov KV  ", kind: "azure-kv", config: AZ_CONFIG, autoBackup: true })).data!;
    expect(saved).toMatchObject({ name: "Gov KV", kind: "azure-kv", config: AZ_CONFIG, autoBackup: true });
    const edited = (await call<VaultDestination>("/api/vault/destinations/save", { id: saved.id, name: "Gov KV 2", kind: "azure-kv", config: AZ_CONFIG })).data!;
    expect(edited).toMatchObject({ id: saved.id, name: "Gov KV 2", addedAt: saved.addedAt });
    expect(edited.autoBackup).toBeUndefined();
    expect((await call<VaultDestination>("/api/vault/destinations/auto-backup", { id: saved.id, on: true })).data!.autoBackup).toBe(true);
    expect(listVaultDestinations()).toHaveLength(1);
  });
});
