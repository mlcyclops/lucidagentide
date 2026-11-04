// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_vault_keys_2.ts
//
// Increment P-VAULT-KEYS.2 (ADR-0480): omp's OAuth credentials sealed in the engine vault and served to omp by
// omp's OWN auth broker running inside the engine. Everything runs in a scratch dir with the REAL OS vault
// backend; the user's ~/.omp is never opened (a pre-flight proves the child processes resolve their home to
// the scratch dir before anything boots, and aborts otherwise):
//   1) a real engine (`bun run dev.ts`) boots over a scratch agent.db that omp's own store seeded with fake
//      OAuth rows: the rows move into the vault (agent.db keeps none and no plaintext), Settings status and
//      accounts read them, a disconnect removes the sealed entry, and a restart keeps the sign-ins (no re-login).
//   2) the engine's broker boot (the same oauth_broker.ts dev.ts runs) in this process, then a real `omp acp`
//      started with only the broker's URL + token: it answers ACP and lists Anthropic models whose ONLY
//      credential is the one the broker serves; the same omp with a wrong token refuses to start; after the
//      sealed row is removed a fresh omp lists no Anthropic model. omp's own broker client reads the access token
//      with the refresh token held back. The spawned omp's version must equal the imported pi-ai's (the pin).
//   3) no seeded token appears in any file under the scratch root, in the engine's output or in any response.
// Exit code 0 = every check held.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { AuthBrokerClient } from "@oh-my-pi/pi-ai/auth-broker";
import { bootOauthVault, stopOauthVault } from "../oauth_broker.ts";
import { oauthRowsTarget } from "../oauth_rows_target.ts";

const DESKTOP = join(import.meta.dir, "..");
const REPO = join(DESKTOP, "..");
const fail = (msg: string): never => { throw new Error(msg); };
const ok = (msg: string): void => console.log(`   ${msg} - ok`);
const check = (cond: unknown, msg: string): void => { if (!cond) fail(msg); ok(msg); };

const root = mkdtempSync(join(tmpdir(), "lucid-vaultkeys2-"));
const home = join(root, "home");
const agentDir = join(home, ".omp", "agent");
const agentDb = join(agentDir, "agent.db");
// The DEFAULT profile layout inside the scratch home (settings and engine vault in <home>/.omp, beside
// agent.db): only the default profile moves omp's shared agent.db into its vault (oauth_broker.ts).
const paths = {
  settings: join(home, ".omp", "lucid-gui.json"), vault: join(home, ".omp", "lucid-engine-vault"), cred: join(root, "lucid-cred-vault"),
  personal: join(root, "personal"), models: join(root, "models.yml"), data: join(root, "data"), ws: join(root, "ws"),
};
for (const d of [agentDir, paths.data, paths.ws, join(home, "AppData", "Roaming"), join(home, "AppData", "Local")]) mkdirSync(d, { recursive: true });
const OMP = join(REPO, "node_modules", ".bin", process.platform === "win32" ? "omp.exe" : "omp");
const PI_AI_VERSION: string = JSON.parse(readFileSync(join(REPO, "node_modules", "@oh-my-pi", "pi-ai", "package.json"), "utf8")).version;

const TOKENS = {
  workAccess: "sk-ant-oat01-DEMO-K2-WORK-ACCESS-000001", workRefresh: "sk-ant-ort01-DEMO-K2-WORK-REFRESH-000002",
  oldAccess: "sk-ant-oat01-DEMO-K2-OLD-ACCESS-000003", oldRefresh: "sk-ant-ort01-DEMO-K2-OLD-REFRESH-000004",
  codexAccess: "DEMO-K2-CODEX-ACCESS-000005", codexRefresh: "DEMO-K2-CODEX-REFRESH-000006",
} as const;
const SECRETS = Object.values(TOKENS);

/** Home-scoped env for every child: the scratch home, omp's agent dir, nothing of the user's profile. */
const homeEnv = { HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"), PI_CODING_AGENT_DIR: agentDir };
/** A minimal env for a spawned omp: system basics, the scratch home, and NO provider key of this machine. */
function ompEnv(extra: Record<string, string>): Record<string, string> {
  const keep = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "windir", "ComSpec", "COMSPEC", "PATHEXT", "TEMP", "TMP", "OS", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE"];
  const env: Record<string, string> = {};
  for (const k of keep) { const v = process.env[k]; if (v !== undefined) env[k] = v; }
  return { ...env, ...homeEnv, ...extra };
}

function freePort(): number {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = s.port;
  s.stop(true);
  if (typeof port !== "number") throw new Error("no free port");
  return port;
}

interface Engine { proc: Bun.Subprocess; base: string; log: () => string }
const engineLogs: string[] = [];
async function boot(): Promise<Engine> {
  const port = freePort();
  const env: Record<string, string | undefined> = {
    ...process.env, ...homeEnv, PORT: String(port), LUCID_GUI_SETTINGS_FILE: paths.settings,
    LUCID_PERSONAL_DIR: paths.personal, LUCID_OMP_MODELS_YAML: paths.models, LUCID_CRED_VAULT_DIR: paths.cred, LUCID_DATA_ROOT: paths.data,
    LUCID_OMP_BIN: OMP,
  };
  // No LUCID_ENGINE_VAULT_DIR: the vault sits beside the scratch-home settings, the default profile layout.
  for (const k of ["LUCID_ENGINE_VAULT_DIR", "LUCID_MAIN_TOKEN", "LUCID_VAULT_MAIN_TOKEN", "LUCID_OAUTH_VAULT", "OMP_AUTH_BROKER_URL", "OMP_AUTH_BROKER_TOKEN"]) delete env[k];
  const proc = Bun.spawn([process.execPath, "run", "dev.ts"], { cwd: DESKTOP, env, stdout: "pipe", stderr: "pipe" });
  let out = "";
  const slot = engineLogs.push("") - 1;
  for (const s of [proc.stdout, proc.stderr]) {
    void (async () => { for await (const chunk of s as ReadableStream<Uint8Array>) { out += new TextDecoder().decode(chunk); engineLogs[slot] = out; } })();
  }
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) fail(`the engine exited (${proc.exitCode}):\n${out.slice(-3000)}`);
    try { if ((await fetch(`${base}/api/health`)).ok) return { proc, base, log: () => out }; } catch { /* not yet */ }
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
async function api<T>(e: Engine, path: string, token: string, body?: unknown): Promise<T | undefined> {
  const res = await fetch(`${e.base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "x-lucid-token": token },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  bodies.push(text);
  let parsed: unknown = null;
  try { parsed = JSON.parse(text); } catch { /* a plain "forbidden" */ }
  return parsed && typeof parsed === "object" && "data" in parsed ? (parsed.data as T) : undefined;
}
async function pageToken(e: Engine): Promise<string> {
  const html = await (await fetch(`${e.base}/`)).text();
  return /<meta name="lucid-token" content="([0-9a-f]+)">/.exec(html)?.[1] ?? fail("no lucid-token meta tag in the served page");
}

function agentDbRows(): number {
  const d = new Database(agentDb);
  try { return d.query<{ n: number }, []>("select count(*) as n from auth_credentials").get()?.n ?? -1; } finally { d.close(); }
}
/** Every file under `dir` whose bytes contain any secret, as "relative/path: <first 12 chars>". */
function plaintextHits(dir: string, rel = ""): string[] {
  const hits: string[] = [];
  if (!existsSync(dir)) return hits;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { hits.push(...plaintextHits(p, join(rel, e.name))); continue; }
    let text = "";
    try { text = readFileSync(p).toString("latin1"); } catch { continue; }
    for (const s of SECRETS) if (text.includes(s)) hits.push(`${join(rel, e.name)}: ${s.slice(0, 12)}...`);
  }
  return hits;
}

/** `selfExit`: the exit code when omp ended on its own before the probe stopped it, else null. */
interface Probe { answered: boolean; session: string; selfExit: number | null; stderr: string }
/** A real `omp acp` against `env`: ACP initialize, then session/new. Never inherits this machine's keys. */
async function acpProbe(env: Record<string, string>): Promise<Probe> {
  const proc = Bun.spawn([OMP, "acp"], { cwd: paths.ws, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  let stopping = false;
  let selfExit: number | null = null;
  void proc.exited.then((c) => { if (!stopping) selfExit = c; });
  const pending = new Map<number, (msg: unknown) => void>();
  let stderr = "";
  void (async () => { for await (const c of proc.stderr) stderr = (stderr + new TextDecoder().decode(c)).slice(-4000); })();
  void (async () => {
    let buf = "";
    for await (const c of proc.stdout) {
      buf += new TextDecoder().decode(c);
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        let msg: unknown;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg && typeof msg === "object" && "id" in msg && typeof msg.id === "number" && ("result" in msg || "error" in msg)) pending.get(msg.id)?.(msg);
      }
    }
  })();
  const call = (id: number, method: string, params: unknown): Promise<unknown> => {
    const answer = new Promise<unknown>((resolve) => { pending.set(id, resolve); });
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    proc.stdin.flush();
    return Promise.race([answer, proc.exited.then(() => null), Bun.sleep(120_000).then(() => null)]);
  };
  const init = await call(1, "initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } });
  const answered = !!init && typeof init === "object" && "result" in init;
  const session = answered ? await call(2, "session/new", { cwd: paths.ws, mcpServers: [] }) : null;
  await Bun.sleep(0); // let an exit that already happened settle selfExit before the stop below
  stopping = true;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
  else proc.kill();
  await Promise.race([proc.exited, Bun.sleep(10_000)]);
  return { answered, session: JSON.stringify(session ?? null), selfExit, stderr };
}

let engine: Engine | null = null;
let code = 0;
try {
  console.log("== ADR-0480 P-VAULT-KEYS.2: omp's OAuth credentials sealed in the vault, served by omp's own auth broker ==");
  console.log("-- 0) scratch home, seeded agent.db, version pin");
  check(existsSync(OMP), `the repo's omp shim exists (${OMP})`);
  const probeHome = spawnSync(process.execPath, ["-e", "process.stdout.write(require('os').homedir())"], { env: { ...process.env, ...homeEnv }, encoding: "utf8" });
  check(probeHome.stdout === home, "a child with the scratch env resolves its home to the scratch dir (else this demo would touch the real ~/.omp: aborting)");
  const seed = await SqliteAuthCredentialStore.open(agentDb);
  await seed.upsertAuthCredential("anthropic", { type: "oauth", access: TOKENS.workAccess, refresh: TOKENS.workRefresh, expires: Date.now() + 30 * 86_400_000, email: "demo-work@example.com" });
  await seed.upsertAuthCredential("anthropic", { type: "oauth", access: TOKENS.oldAccess, refresh: TOKENS.oldRefresh, expires: Date.now() + 30 * 86_400_000, email: "demo-old@example.com" });
  await seed.upsertAuthCredential("openai-codex", { type: "oauth", access: TOKENS.codexAccess, refresh: TOKENS.codexRefresh, expires: Date.now() + 30 * 86_400_000, accountId: "acct-demo" });
  const oldRow = seed.listAuthCredentials("anthropic").find((r) => r.credential.type === "oauth" && r.credential.email === "demo-old@example.com");
  await seed.deleteAuthCredential(oldRow?.id ?? fail("no seeded old row"), "logged out by user");
  seed.close();
  check(agentDbRows() === 3, "omp's own store seeded 3 credential rows (one logged out) in the scratch agent.db");
  const ompVersion = spawnSync(OMP, ["--version"], { env: ompEnv({}), encoding: "utf8" });
  check(`${ompVersion.stdout}${ompVersion.stderr}`.includes(PI_AI_VERSION), `the spawned omp (${`${ompVersion.stdout}`.trim() || "?"}) is the same build as the imported pi-ai ${PI_AI_VERSION} (broker and client must match)`);

  console.log("-- 1) a real engine over the scratch agent.db");
  engine = await boot();
  const token = await pageToken(engine);
  check(/\[oauth-vault\] vault: .*moved 3 credential row/.test(engine.log()), "the engine moved the 3 rows into the vault at boot and started the broker");
  check(agentDbRows() === 0, "agent.db holds no credential row after the move");
  check(plaintextHits(agentDir).length === 0, "agent.db, its WAL and its shm hold no token bytes (secure_delete + checkpoint + VACUUM)");
  interface VaultList { entries: Array<{ ref: string; kind: string; source: string }> }
  const listed = await api<VaultList>(engine, "/api/vault/list", token);
  const oauthRefs = (listed?.entries ?? []).filter((e) => e.ref.startsWith("oauth:"));
  check(oauthRefs.length === 3 && oauthRefs.every((e) => e.source === "migrated-agentdb" && e.kind === "oauth"), `the vault lists ${oauthRefs.map((e) => e.ref).join(", ")} (metadata only)`);
  interface Auth { majors: Array<{ id: string; oauthActive: boolean }> }
  const auth = await api<Auth>(engine, "/api/auth", token);
  check(auth?.majors.find((p) => p.id === "anthropic")?.oauthActive === true && auth.majors.find((p) => p.id === "openai")?.oauthActive === true, "Settings status shows the Anthropic and OpenAI sign-ins as active (read from the vault)");
  interface View { id: string; kind: string; active: boolean }
  const accounts = await api<Record<string, View[]>>(engine, "/api/accounts", token);
  const anth = (accounts?.anthropic ?? []).filter((v) => v.kind === "oauth");
  check(anth.length === 1 && anth[0]!.id === "oauth:email:demo-work@example.com", "accounts list the live Anthropic identity and not the one omp logged out");
  const codexView = (accounts?.openai ?? []).find((v) => v.kind === "oauth") ?? fail("no OpenAI oauth account");
  await api(engine, "/api/accounts/remove", token, { providerId: "openai", accountId: codexView.id });
  const after = await api<VaultList>(engine, "/api/vault/list", token);
  check(!(after?.entries ?? []).some((e) => e.ref.startsWith("oauth:openai-codex:")), "disconnecting the OpenAI account removes its sealed entry");
  await stop(engine);
  engine = null;

  engine = await boot();
  const token2 = await pageToken(engine);
  const auth2 = await api<Auth>(engine, "/api/auth", token2);
  check(auth2?.majors.find((p) => p.id === "anthropic")?.oauthActive === true, "after a restart the Anthropic sign-in is still active: no re-login");
  check(auth2?.majors.find((p) => p.id === "openai")?.oauthActive === false, "and the disconnected OpenAI sign-in stays gone");
  check(/\[oauth-vault\] vault: /.test(engine.log()) && !/moved \d+ credential row/.test(engine.log()), "the second boot had nothing to move (idempotent)");
  check(agentDbRows() === 0, "agent.db still holds no credential row");
  await stop(engine);
  engine = null;

  console.log("-- 2) the engine's broker in this process, read by a real `omp acp` and by omp's own client");
  process.env.LUCID_GUI_SETTINGS_FILE = paths.settings;
  process.env.LUCID_ENGINE_VAULT_DIR = paths.vault;
  delete process.env.LUCID_OAUTH_VAULT;
  const state = await bootOauthVault({ vaultDir: paths.vault, agentDbPath: agentDb, disableRefresher: true });
  check(state.mode === "vault" && !!oauthRowsTarget(), `the broker boots over the vault (${state.brokerUrl})`);
  const brokerEnv = {
    OMP_AUTH_BROKER_URL: process.env.OMP_AUTH_BROKER_URL ?? fail("no broker URL"),
    OMP_AUTH_BROKER_TOKEN: process.env.OMP_AUTH_BROKER_TOKEN ?? fail("no broker token"),
    OMP_AUTH_BROKER_SNAPSHOT_TTL_MS: process.env.OMP_AUTH_BROKER_SNAPSHOT_TTL_MS ?? fail("no snapshot TTL"),
  };
  const snap = await new AuthBrokerClient({ url: brokerEnv.OMP_AUTH_BROKER_URL, token: brokerEnv.OMP_AUTH_BROKER_TOKEN }).fetchSnapshot();
  const work = snap.status === 200 ? snap.snapshot.credentials.find((c) => c.provider === "anthropic") : undefined;
  check(work?.credential.type === "oauth" && work.credential.access === TOKENS.workAccess && work.credential.refresh === "__remote__", "omp's broker client gets the access token; the refresh token never leaves the engine");

  const live = await acpProbe(ompEnv(brokerEnv));
  check(live.answered, "a real `omp acp` with only the broker URL + token starts and answers ACP initialize");
  check(live.session.includes("\"anthropic/"), "its session lists Anthropic models: the broker's sealed credential is the only Anthropic credential it has");
  check(!existsSync(join(home, ".omp", "cache", "auth-broker-snapshot.enc")), "OMP_AUTH_BROKER_SNAPSHOT_TTL_MS=0: omp wrote no access-token snapshot cache");
  const refused = await acpProbe(ompEnv({ ...brokerEnv, OMP_AUTH_BROKER_TOKEN: "0".repeat(64) }));
  check(!refused.answered && refused.selfExit !== null && refused.selfExit !== 0, `the same omp with a wrong bearer token exits on its own (code ${refused.selfExit}) without answering: no fallback to agent.db`);
  const target = oauthRowsTarget() ?? fail("no vault rows target");
  target.write((db) => db.run("delete from auth_credentials where provider = 'anthropic'"));
  const gone = await acpProbe(ompEnv(brokerEnv));
  check(gone.answered && !gone.session.includes("\"anthropic/"), "after the sealed Anthropic row is removed, a fresh omp lists no Anthropic model");
  await stopOauthVault();

  console.log("-- 3) no token anywhere");
  const hits = plaintextHits(root);
  check(hits.length === 0, `no seeded token in any file under the scratch root (agent.db, vault, logs, omp's home)${hits.length ? `: ${hits.join("; ")}` : ""}`);
  check(!engineLogs.some((l) => SECRETS.some((s) => l.includes(s))), "no seeded token in the engine's output");
  check(!bodies.some((b) => SECRETS.some((s) => b.includes(s))), `no route response (${bodies.length} checked) carried a token`);
  console.log("PASS demo-P-VAULT-KEYS.2");
} catch (e) {
  code = 1;
  console.error(`FAIL: ${(e as Error).message}`);
  if (engine) console.error(engine.log().slice(-2000));
} finally {
  if (engine) await stop(engine);
  await stopOauthVault();
  try { rmSync(root, { recursive: true, force: true }); } catch { /* a handle may linger on Windows */ }
}
process.exit(code);
