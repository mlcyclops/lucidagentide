// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_vault_v2_1.ts
//
// Increment P-VAULT-V2.1 (ADR-0474): one engine vault (v2 sealed format with per-entry metadata), the
// safeStorage credential vault drained into it, and the vault API. REAL engine processes (`bun run
// dev.ts`) and the REAL OS backend (DPAPI / Keychain / Secret Service), every path in a scratch dir so
// the user's ~/.omp is never touched:
//   1) a headless engine: the page's meta token drives /api/vault/put, /list, /rotate, /delete; no
//      response carries a value; the sealed file is v2 with no plaintext; the main-only routes are closed
//      (no Electron main) and nothing answers without the token.
//   2) an engine launched the way Electron main launches it (LUCID_MAIN_TOKEN + LUCID_VAULT_MAIN_TOKEN):
//      main's side (cred_engine_client.ts) migrates a safeStorage vault (a stand-in SafeStorageLike over
//      real files): each entry is imported, verified by the engine, and only then deleted; a marker lists
//      the refs; a second run is a no-op; bridge cred* store/list/rotate/delete round-trip. Every main-only
//      reply is MAC-checked: a forged `verified: true` without the engine's reply MAC deletes nothing.
// Exit code 0 = every check held.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  credDeleteEverywhere, credListMerged, credRotateEngine, credStoreEngine, engineCredClient, migrateCredVault, type LegacyCredVault,
} from "../cred_engine_client.ts";
import { storeCredential, type SafeStorageLike, type VaultIo } from "../cred_vault.ts";

const DESKTOP = join(import.meta.dir, "..");
const fail = (msg: string): never => { throw new Error(msg); };
const ok = (msg: string): void => console.log(`   ${msg} - ok`);
const check = (cond: unknown, msg: string): void => { if (!cond) fail(msg); ok(msg); };

const root = mkdtempSync(join(tmpdir(), "lucid-vaultv21-"));
const paths = {
  settings: join(root, "lucid-gui.json"),
  vault: join(root, "lucid-engine-vault"),
  cred: join(root, "lucid-cred-vault"),
  personal: join(root, "personal"),
  models: join(root, "models.yml"),
  data: join(root, "data"),
};
mkdirSync(paths.data, { recursive: true });

function freePort(): number {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = s.port;
  s.stop(true);
  if (typeof port !== "number") throw new Error("no free port");
  return port;
}

interface Engine { port: number; proc: Bun.Subprocess; base: string; log: () => string }
async function boot(extra: Record<string, string>): Promise<Engine> {
  const port = freePort();
  const env: Record<string, string | undefined> = {
    ...process.env, PORT: String(port), LUCID_GUI_SETTINGS_FILE: paths.settings, LUCID_ENGINE_VAULT_DIR: paths.vault,
    LUCID_PERSONAL_DIR: paths.personal, LUCID_OMP_MODELS_YAML: paths.models, LUCID_CRED_VAULT_DIR: paths.cred,
    LUCID_DATA_ROOT: paths.data, // the engine's discovery / audit files stay in the scratch dir too
    ...extra,
  };
  if (!extra.LUCID_MAIN_TOKEN) { delete env.LUCID_MAIN_TOKEN; delete env.LUCID_VAULT_MAIN_TOKEN; }
  const proc = Bun.spawn([process.execPath, "run", "dev.ts"], { cwd: DESKTOP, env, stdout: "pipe", stderr: "pipe" });
  let out = "";
  for (const s of [proc.stdout, proc.stderr]) {
    void (async () => { for await (const chunk of s as ReadableStream<Uint8Array>) out = (out + new TextDecoder().decode(chunk)).slice(-20_000); })();
  }
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) fail(`the engine exited (${proc.exitCode}):\n${out.slice(-3000)}`);
    try { if ((await fetch(`${base}/api/health`)).ok) return { port, proc, base, log: () => out }; } catch { /* not yet */ }
    await Bun.sleep(300);
  }
  return fail(`the engine did not answer /api/health in time:\n${out.slice(-3000)}`);
}
async function stop(e: Engine): Promise<void> {
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(e.proc.pid), "/T", "/F"], { stdio: "ignore" });
  else e.proc.kill("SIGTERM");
  await Promise.race([e.proc.exited, Bun.sleep(10_000)]);
}

const bodies: string[] = [];
interface Meta { ref: string; source: string; last4?: string; rotatedAt?: number }
interface ListData { entries: Meta[]; status: { state: string; custody: string; crypto: { module: string; fips: boolean } } }
/** One engine call. `data` is the route's `{ ok, data }` payload, typed by the caller (a demo reading its
 *  own engine's documented shapes; every field it relies on is checked below). */
async function api<T>(e: Engine, path: string, token: string | null, body?: unknown): Promise<{ status: number; data: T | undefined }> {
  const res = await fetch(`${e.base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(token ? { "x-lucid-token": token } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  bodies.push(text);
  let parsed: unknown = null;
  try { parsed = JSON.parse(text); } catch { /* a plain "forbidden" */ }
  const data = parsed && typeof parsed === "object" && "data" in parsed ? (parsed.data as T) : undefined;
  return { status: res.status, data };
}

const SS: SafeStorageLike = { // stand-in for Electron safeStorage (the demo has no Electron main)
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`SS1:${Buffer.from(s, "utf8").toString("base64")}`, "utf8"),
  decryptString: (b) => { const t = b.toString("utf8"); if (!t.startsWith("SS1:")) throw new Error("bad blob"); return Buffer.from(t.slice(4), "base64").toString("utf8"); },
};
const FS_IO: VaultIo = { // exactly main.ts VAULT_IO
  ensureDir: (dir) => mkdirSync(dir, { recursive: true }),
  writeFile: (p, data) => writeFileSync(p, data, { mode: 0o600 }),
  readFile: (p) => readFileSync(p),
  exists: (p) => existsSync(p),
  remove: (p) => rmSync(p, { force: true }),
  list: (dir) => (existsSync(dir) ? readdirSync(dir) : []),
};
function plaintextUnder(dir: string, needles: readonly string[]): string[] {
  const hits: string[] = [];
  if (!existsSync(dir)) return hits;
  for (const name of readdirSync(dir)) {
    const text = readFileSync(join(dir, name)).toString("latin1");
    for (const n of needles) if (text.includes(n)) hits.push(`${name}: ${n.slice(0, 6)}...`);
  }
  return hits;
}

const UI_SECRET = ["sk-demo-V21-PUT-0000000001", "sk-demo-V21-ROTATED-000002"] as const;
const LEGACY = { figma_pat: "figd_demo_V21_LEGACY_0000003", git_pat_github_com: "ghp_demo_V21_LEGACY_00000004" };
const BRIDGE = ["eyJ.demo.V21.BRIDGE.000005", "eyJ.demo.V21.BRIDGE.ROT.06"] as const;
let engine: Engine | null = null;
let code = 0;
try {
  console.log("== ADR-0474 P-VAULT-V2.1: one engine vault, v2 metadata, safeStorage migrated, vault API ==");
  console.log("-- 1) headless engine: the Contract B UI routes with the page's meta token");
  engine = await boot({});
  const html = await (await fetch(`${engine.base}/`)).text();
  const token = /<meta name="lucid-token" content="([0-9a-f]+)">/.exec(html)?.[1] ?? fail("no lucid-token meta tag in the served page");
  check((await api(engine, "/api/vault/list", null)).status === 403, "no token: /api/vault/list is refused");
  const put = await api<Meta>(engine, "/api/vault/put", token, { value: UI_SECRET[0], kind: "apikey", envName: "LUCID_DEMO_V21_KEY", label: "Demo key" });
  check(put.status === 200 && put.data?.ref === "key:LUCID_DEMO_V21_KEY" && put.data.last4 === "0001", "put stores key:LUCID_DEMO_V21_KEY and answers metadata with last-4");
  const listed = (await api<ListData>(engine, "/api/vault/list", token)).data;
  check(listed?.entries.length === 1 && listed.entries[0]?.source === "typed" && listed.status.state === "ok", `list shows one entry, custody ${listed?.status.custody}, crypto ${listed?.status.crypto.module} (fips ${listed?.status.crypto.fips})`);
  const rot = await api<Meta>(engine, "/api/vault/rotate", token, { ref: "key:LUCID_DEMO_V21_KEY", value: UI_SECRET[1] });
  check(rot.status === 200 && typeof rot.data?.rotatedAt === "number" && rot.data.last4 === "0002", "rotate replaces the value in place and stamps rotatedAt");
  const sealed: { v?: unknown; alg?: unknown } = JSON.parse(readFileSync(join(paths.vault, "secrets.v1.json"), "utf8"));
  check(sealed.v === 2 && sealed.alg === "A256GCM", "the sealed file is format v2 (AES-256-GCM)");
  check(plaintextUnder(paths.vault, UI_SECRET).length === 0, "no value is in the vault directory in the clear");
  check((await api(engine, "/api/vault/main/list", token)).status === 403, "headless: the main-only routes are closed");
  const del = await api<{ deleted: boolean }>(engine, "/api/vault/delete", token, { ref: "key:LUCID_DEMO_V21_KEY" });
  check(del.data?.deleted === true && (await api<ListData>(engine, "/api/vault/list", token)).data?.entries.length === 0, "delete removes it");
  await stop(engine);
  engine = null;

  console.log("-- 2) engine launched as Electron main launches it: safeStorage migration + bridge cred*");
  for (const [ref, secret] of Object.entries(LEGACY)) storeCredential(SS, FS_IO, paths.cred, { ref, kind: "apikey", secret, label: ref, createdAt: Date.now() - 86_400_000 });
  const mainToken = randomBytes(32).toString("hex");
  const vaultToken = randomBytes(32).toString("hex");
  engine = await boot({ LUCID_MAIN_TOKEN: mainToken, LUCID_VAULT_MAIN_TOKEN: vaultToken });
  check(!/<meta name="lucid-token"/.test(await (await fetch(`${engine.base}/`)).text()), "with a main, the page carries no token");
  check((await api(engine, "/api/vault/main/list", mainToken)).status === 403, "the UI token alone does not open the main-only routes");
  const capturing = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const res = await fetch(input, init);
    const text = await res.text();
    bodies.push(text);
    return new Response(text, { status: res.status, headers: res.headers });
  };
  // Bun's `typeof fetch` also carries `preconnect`; the client only ever calls it as a function.
  const client = engineCredClient({ baseUrl: engine.base, uiToken: mainToken, vaultToken, fetch: capturing as unknown as typeof fetch });
  const legacy: LegacyCredVault = { ss: SS, io: FS_IO, dir: paths.cred };
  // ADR-0474 security review: a reply without the engine's MAC (a peer answering `verified: true` to every
  // import, as a socket squatting on [::1]:PORT could) is a refusal, and nothing is deleted.
  const forging = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (!String(input).endsWith("/api/vault/main/import")) return capturing(input, init);
    const ref: unknown = JSON.parse(String(init?.body ?? "{}")).ref;
    return new Response(JSON.stringify({ ok: true, data: { ref, outcome: "stored", verified: true } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const forged = await migrateCredVault(legacy, engineCredClient({ baseUrl: engine.base, uiToken: mainToken, vaultToken, fetch: forging as unknown as typeof fetch }));
  check(forged.migrated.length === 0 && forged.kept.length === 2 && readdirSync(paths.cred).filter((f) => f.endsWith(".bin")).length === 2, "a forged `verified: true` without the engine's reply MAC is refused: no safeStorage entry is deleted");
  const report = await migrateCredVault(legacy, client);
  check(report.migrated.sort().join(",") === "figma_pat,git_pat_github_com" && report.kept.length === 0, "both safeStorage entries were imported, verified by the engine, then deleted");
  check(!readdirSync(paths.cred).some((f) => f.endsWith(".bin")) && !!report.marker && existsSync(report.marker), "no .bin is left; a migrated-<ts>.json marker exists");
  check(plaintextUnder(paths.cred, Object.values(LEGACY)).length === 0, "the marker lists refs, never values");
  check((await migrateCredVault(legacy, client)).migrated.length === 0, "a second run is a no-op");
  const ui = (await api<ListData>(engine, "/api/vault/list", mainToken)).data;
  check(ui?.entries.length === 2 && ui.entries.every((m) => m.source === "migrated-safestorage"), "the vault lists them with source migrated-safestorage");
  const stored = await credStoreEngine(client, legacy, { kind: "jwt", secret: BRIDGE[0], label: "demo JWT" });
  check(!("error" in stored) && stored.ref.startsWith("cred_jwt_") && stored.last4 === "0005", "bridge credStore lands in the engine vault");
  const ref = "error" in stored ? "" : stored.ref;
  check((await credListMerged(client, legacy)).length === 3, "bridge credList shows the engine's credentials");
  const rotated = await credRotateEngine(client, legacy, { ref, secret: BRIDGE[1] });
  check(!("error" in rotated) && rotated.last4 === "T.06", "bridge credRotate rotates in place");
  const removed = await credDeleteEverywhere(client, legacy, ref);
  check("deleted" in removed && removed.deleted, "bridge credDelete removes it");
  check(plaintextUnder(paths.vault, [...UI_SECRET, ...Object.values(LEGACY), ...BRIDGE]).length === 0, "no value is in the vault directory in the clear");
  const leaked = [...UI_SECRET, ...Object.values(LEGACY), ...BRIDGE].filter((s) => bodies.some((b) => b.includes(s)));
  check(leaked.length === 0, `no route response (${bodies.length} checked) carried a secret value`);
  console.log("PASS demo-P-VAULT-V2.1");
} catch (e) {
  code = 1;
  console.error(`FAIL: ${(e as Error).message}`);
  if (engine) console.error(engine.log().slice(-2000));
} finally {
  if (engine) await stop(engine);
  rmSync(root, { recursive: true, force: true });
}
process.exit(code);
