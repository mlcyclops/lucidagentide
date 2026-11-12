// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_vault_dest_1.ts
//
// Increment P-VAULT-DEST.1 (ADR-0478): enterprise vault destinations, core half. REAL engine processes
// (`bun run dev.ts`), the REAL OS vault backend and, for phase 2, the REAL private add-on's kms connector,
// every path in a scratch dir (settings, engine vault, personal, cred vault, data root and the engine's
// TEMP) so the user's ~/.omp is never touched. No cloud is contacted: the add-on answers "not implemented
// yet" for an aws-sm destination without any network call, which exercises the whole seam (0600 request in
// a private temp dir, spawn, the exit-1 JSON line, wipe) honestly.
//   1) no add-on: GET /api/vault/destinations says installed:false; save / push answer 409.
//   2) the add-on (LUCID_ADDON_DIR, else the sibling lucidagentIDEaddon-akv or lucidagentIDEaddon):
//      installed:true with the connector version; an azure-kv destination validates and saves; an aws-sm
//      destination's Test / Push / Contents / Pull reach the connector and come back as honest failures;
//      auto-backup after a vault put records the connector's refusal; no request dir is left in TEMP; no
//      route response and no engine log line carries a secret value.
// Exit code 0 = every check held.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DESKTOP = join(import.meta.dir, "..");
const fail = (msg: string): never => { throw new Error(msg); };
const check = (cond: unknown, msg: string): void => { if (!cond) fail(msg); console.log(`   ${msg} - ok`); };

const root = mkdtempSync(join(tmpdir(), "lucid-vaultdest1-"));
const paths = {
  settings: join(root, "lucid-gui.json"),
  vault: join(root, "lucid-engine-vault"),
  cred: join(root, "lucid-cred-vault"),
  personal: join(root, "personal"),
  models: join(root, "models.yml"),
  data: join(root, "data"),
  tmp: join(root, "tmp"),
};
mkdirSync(paths.data, { recursive: true });
mkdirSync(paths.tmp, { recursive: true });

function realAddon(): string | null {
  const candidates = [process.env.LUCID_ADDON_DIR, join(DESKTOP, "..", "..", "lucidagentIDEaddon-akv"), join(DESKTOP, "..", "..", "lucidagentIDEaddon")];
  for (const c of candidates) if (c && existsSync(join(resolve(c), "connectors", "kms", "src", "cli.ts"))) return resolve(c);
  return null;
}

function freePort(): number {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = s.port;
  s.stop(true);
  if (typeof port !== "number") throw new Error("no free port");
  return port;
}

interface Engine { proc: Bun.Subprocess; base: string; token: string; log: () => string }
async function boot(addonDir: string): Promise<Engine> {
  const port = freePort();
  const env: Record<string, string | undefined> = {
    ...process.env, PORT: String(port), LUCID_GUI_SETTINGS_FILE: paths.settings, LUCID_ENGINE_VAULT_DIR: paths.vault,
    LUCID_PERSONAL_DIR: paths.personal, LUCID_OMP_MODELS_YAML: paths.models, LUCID_CRED_VAULT_DIR: paths.cred, LUCID_DATA_ROOT: paths.data,
    LUCID_ADDON_DIR: addonDir, TEMP: paths.tmp, TMP: paths.tmp, TMPDIR: paths.tmp,
  };
  delete env.LUCID_MAIN_TOKEN; delete env.LUCID_VAULT_MAIN_TOKEN;
  const proc = Bun.spawn([process.execPath, "run", "dev.ts"], { cwd: DESKTOP, env, stdout: "pipe", stderr: "pipe" });
  let out = "";
  for (const s of [proc.stdout, proc.stderr]) {
    void (async () => { for await (const chunk of s as ReadableStream<Uint8Array>) out = (out + new TextDecoder().decode(chunk)).slice(-40_000); })();
  }
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) fail(`the engine exited (${proc.exitCode}):\n${out.slice(-3000)}`);
    try {
      if ((await fetch(`${base}/api/health`)).ok) {
        const html = await (await fetch(`${base}/`)).text();
        const token = /<meta name="lucid-token" content="([0-9a-f]+)">/.exec(html)?.[1] ?? fail("no lucid-token meta tag in the served page");
        return { proc, base, token, log: () => out };
      }
    } catch { /* not yet */ }
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
/** One engine call; `T` is the route's documented data shape (every field relied on is checked below). */
async function api<T>(e: Engine, path: string, body?: unknown): Promise<{ status: number; data: T | undefined; error: string }> {
  const res = await fetch(`${e.base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "x-lucid-token": e.token },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  bodies.push(text);
  const parsed: { data?: T; error?: string } = JSON.parse(text);
  return { status: res.status, data: parsed.data, error: parsed.error ?? "" };
}

interface View { addon: { installed: boolean; note: string; version: string | null }; destinations: Array<{ id: string; lastAutoBackup?: { ok: boolean; detail: string } }> }
interface Outcome { ok: boolean; detail: string }

const SECRETS = ["sk-demo-VDEST-PUT-00000001", "client-demo-VDEST-SECRET-02", "sk-demo-VDEST-AUTO-0000003"] as const;
const requestDirs = (): string[] => (existsSync(paths.tmp) ? readdirSync(paths.tmp).filter((n) => n.startsWith("lucid-vdest-")) : []);
let engine: Engine | null = null;
let code = 0;
try {
  console.log("== ADR-0478 P-VAULT-DEST.1: enterprise vault destinations (core seam + Settings routes) ==");
  console.log("-- 1) no add-on: an honest not-installed state");
  engine = await boot(join(root, "no-addon-here"));
  const none = await api<View>(engine, "/api/vault/destinations");
  check(none.status === 200 && none.data?.addon.installed === false && /enterprise add-on/.test(none.data.addon.note), "GET /api/vault/destinations: installed:false with the seam's note");
  check((await api(engine, "/api/vault/destinations/save", { name: "x", kind: "azure-kv", config: { vaultName: "lucid-demo-kv", cloud: "usgov", auth: "azure-cli" } })).status === 409, "save answers 409 Enterprise add-on not installed");
  check((await api(engine, "/api/vault/push", { id: "dest-x" })).status === 409, "push answers 409");
  await stop(engine);
  engine = null;

  const addon = realAddon();
  if (!addon) fail("phase 2 needs the private add-on: set LUCID_ADDON_DIR to a lucidagentIDEaddon checkout with connectors/kms (feat/akv-destinations)");
  console.log(`-- 2) the real add-on at ${addon}`);
  engine = await boot(addon!);
  const view = await api<View>(engine, "/api/vault/destinations");
  check(view.data?.addon.installed === true && !!view.data.addon.version, `installed:true, kms connector ${view.data?.addon.version}`);
  check((await api(engine, "/api/vault/put", { value: SECRETS[0], kind: "apikey", envName: "LUCID_DEMO_VDEST_KEY", label: "Demo key" })).status === 200, "a vault entry is stored");
  check((await api(engine, "/api/vault/put", { value: SECRETS[1], kind: "password", label: "demo kv client" })).status === 200, "a client secret is stored in the vault");
  const az = await api<{ id: string }>(engine, "/api/vault/destinations/save", {
    name: "Demo Gov KV", kind: "azure-kv",
    config: { vaultName: "lucid-demo-kv", cloud: "usgov", auth: "client-secret", tenantId: "contoso.onmicrosoft.us", clientId: "11111111-2222-3333-4444-555555555555", clientSecretRef: "secret:demo_kv_client" },
  });
  check(az.status === 200 && !!az.data?.id, "an azure-kv destination with client-secret auth validates and saves (the secret named by ref)");
  check((await api(engine, "/api/vault/destinations/save", { name: "bad", kind: "azure-kv", config: { vaultName: "lucid-demo-kv", cloud: "usgov", auth: "azure-cli", clientSecret: SECRETS[1] } })).status === 400, "a config carrying a secret value is refused");
  const aws = await api<{ id: string }>(engine, "/api/vault/destinations/save", { name: "Demo AWS", kind: "aws-sm", config: { region: "us-gov-west-1" }, autoBackup: true });
  check(aws.status === 200 && !!aws.data?.id, "an aws-sm destination saves with auto-backup on");
  const id = aws.data!.id;
  const tested = await api<Outcome>(engine, "/api/vault/destinations/check", { id });
  check(tested.data?.ok === false && /not implemented yet for aws-sm/.test(tested.data.detail), `Test reaches the connector: "${tested.data?.detail}"`);
  const pushed = await api<Outcome & { pushed: unknown[] }>(engine, "/api/vault/push", { id });
  check(pushed.data?.ok === false && pushed.data.pushed.length === 0 && /not implemented yet/.test(pushed.data.detail), "Push all reaches the connector and reports its refusal (nothing claimed pushed)");
  const listed = await api<Outcome>(engine, "/api/vault/destinations/list", { id });
  check(listed.data?.ok === false, "Contents reports the connector's refusal");
  const pulled = await api<Outcome & { added: number }>(engine, "/api/vault/pull", { id });
  check(pulled.data?.ok === false && pulled.data.added === 0, "Pull writes nothing on a refusal");
  check((await api(engine, "/api/vault/put", { value: SECRETS[2], kind: "apikey", envName: "LUCID_DEMO_VDEST_AUTO" })).status === 200, "a new secret is stored");
  let last: { ok: boolean; detail: string } | undefined;
  for (let i = 0; i < 60 && !last; i++) {
    await Bun.sleep(500);
    last = (await api<View>(engine, "/api/vault/destinations")).data?.destinations.find((d) => d.id === id)?.lastAutoBackup;
  }
  check(last?.ok === false && /not implemented yet/.test(last.detail), "auto-backup ran after the put and recorded the connector's refusal, not a success");
  check(requestDirs().length === 0, "no lucid-vdest-* request dir is left in the engine's TEMP");
  const leakedBodies = SECRETS.filter((s) => bodies.some((b) => b.includes(s)));
  check(leakedBodies.length === 0, `no route response (${bodies.length} checked) carried a secret value`);
  check(SECRETS.every((s) => !engine!.log().includes(s)), "no engine log line carried a secret value");
  console.log("PASS demo-P-VAULT-DEST.1");
} catch (e) {
  code = 1;
  console.error(`FAIL: ${(e as Error).message}`);
  if (engine) console.error(engine.log().slice(-2000));
} finally {
  if (engine) await stop(engine);
  rmSync(root, { recursive: true, force: true });
}
process.exit(code);
