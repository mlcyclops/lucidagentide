// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-VAULT-ENV.1 (ADR-0477): `.env` import into the engine vault and workspace-scoped injection. Every path
// is a temp dir, the OS backend is the in-memory fake (engine_vault _setVaultBackendForTest), and git runs
// only in scratch repositories. Proves: a scan and every route response carry names and last-4, never a
// value; names land in the git host / provider key / workspace slots; workspace refs are stable; blanking
// keeps the names; a committed `.env` is detected; a refused vault write changes nothing in the file; and
// a session's env gets its own workspace's secrets and no other workspace's.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACPClient } from "./acp.ts";
import { _setVaultBackendForTest, type OsKeyStore } from "./engine_vault.ts";
import { _resetVaultEnvForTest } from "./vault_env.ts";
import {
  _resetMaterializedForTest, gitEverCommitted, importEnvFile, isIgnored, materializeEnvFile, owningWorkspace, scanEnvFile,
  unmaterializeEnvFile, workspaceSecretEnv,
} from "./vault_env_import.ts";
import { handleVaultRoutes } from "./vault_routes.ts";
import { vaultGet, vaultList, workspaceRef } from "./vault_store.ts";
import { setWorkspace } from "./workspace.ts";

const ENV_KEYS = [
  "LUCID_GUI_SETTINGS_FILE", "LUCID_ENGINE_VAULT_DIR", "LUCID_OMP_MODELS_YAML", "LUCID_ACP_LOG", "GROQ_API_KEY",
  "LUCID_GIT_PAT_GITHUB_COM", "LUCID_GIT_PAT_GITLAB_COM",
] as const;
const ENV_BEFORE = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const dirs: string[] = [];
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "lucid-vault-env-"));
  dirs.push(root);
  process.env.LUCID_GUI_SETTINGS_FILE = join(root, "lucid-gui.json");
  process.env.LUCID_OMP_MODELS_YAML = join(root, "models.yml");
  process.env.LUCID_ACP_LOG = join(root, "acp.log");
  delete process.env.LUCID_ENGINE_VAULT_DIR;
  return root;
}
function workspace(root: string, name: string, env?: string): string {
  const ws = join(root, name);
  mkdirSync(ws, { recursive: true });
  if (env !== undefined) writeFileSync(join(ws, ".env"), env);
  return realpathSync(ws);
}
function useFakeStore(): void {
  let held: Buffer | null = null; // a fresh install: the first write creates the master key
  const store: OsKeyStore = {
    kind: "dpapi",
    read: () => (held ? Buffer.from(held) : { missing: "absent" as const }),
    create: (k: Buffer) => { held = Buffer.from(k); return true; },
  };
  _setVaultBackendForTest(() => store);
}
const quiet = async <T>(fn: () => T | Promise<T>): Promise<T> => {
  const orig = console.error; console.error = () => {};
  try { return await fn(); } finally { console.error = orig; }
};
afterEach(() => { _setVaultBackendForTest(null); _resetVaultEnvForTest(); _resetMaterializedForTest(); });
afterAll(() => {
  for (const k of ENV_KEYS) { const v = ENV_BEFORE[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const V = {
  gh: "ghp_" + "FAKEfakeFAKEfake000000000000001A",
  ghAlt: "ghp_" + "FAKEfakeFAKEfake000000000000002B",
  gl: "glpat-" + "FAKEfakeFAKE0000003C",
  groq: "gsk_FAKEfakeFAKEfake0000004D",
  stripe: "sk_test_FAKEfakeFAKEfake0005E",
  db: "short",
  pem: "-----BEGIN PRIVATE KEY-----\nMIIFAKEFAKEFAKE0006F\n-----END PRIVATE KEY-----",
};
const ENV_TEXT = [
  "# app config",
  `export GITHUB_TOKEN=${V.gh}`,
  `GH_TOKEN="${V.ghAlt}"`,
  `GITLAB_TOKEN='${V.gl}' # gitlab`,
  `GROQ_API_KEY=${V.groq}`,
  `STRIPE_SECRET_KEY=${V.stripe}`,
  `DB_PASSWORD=${V.db}`,
  `SIGNING_KEY="${V.pem}"`,
  "EMPTY=",
  "PATH=/tmp/evil",
  "",
].join("\n");
/** Which test values (or a recognizable middle of one, or one of its non-armor lines) appear in `text`. */
const leaks = (text: string): string[] => Object.entries(V).filter(([, v]) =>
  text.includes(v) || (v.length > 8 && text.includes(v.slice(4, -4))) || v.split("\n").some((l) => l.length > 8 && !l.startsWith("-----") && text.includes(l)),
).map(([k]) => k);

describe("scan", () => {
  test("names, slots, last-4 and status; never a value", () => {
    const root = scratch(); useFakeStore();
    const ws = workspace(root, "app", ENV_TEXT);
    const s = scanEnvFile(ws);
    expect(leaks(JSON.stringify(s))).toEqual([]);
    const by = Object.fromEntries(s.rows.map((r) => [r.name, r]));
    expect(by.GITHUB_TOKEN).toMatchObject({ slot: "git-host", ref: "git_pat_github_com", host: "github.com", last4: "001A", status: "new" });
    expect(by.GITHUB_TOKEN!.blocked).toBeUndefined();
    expect(by.GH_TOKEN!.blocked).toBe("same slot as GITHUB_TOKEN"); // GITHUB_TOKEN outranks it, as hostTokenForUrl reads them
    expect(by.GITLAB_TOKEN).toMatchObject({ slot: "git-host", ref: "git_pat_gitlab_com" });
    expect(by.GROQ_API_KEY).toMatchObject({ slot: "provider-key", ref: "key:GROQ_API_KEY", kind: "apikey" });
    expect(by.STRIPE_SECRET_KEY).toMatchObject({ slot: "workspace", ref: workspaceRef(ws, "STRIPE_SECRET_KEY") });
    expect(by.DB_PASSWORD!.last4).toBeUndefined(); // never for a value shorter than 12 characters
    expect(by.SIGNING_KEY!.kind).toBe("pem");
    expect(by.EMPTY!.blocked).toBe("empty value");
    expect(by.PATH!.blocked).toBe("reserved name");
    expect(s.rows.map((r) => r.name)).toEqual(["GITHUB_TOKEN", "GH_TOKEN", "GITLAB_TOKEN", "GROQ_API_KEY", "STRIPE_SECRET_KEY", "DB_PASSWORD", "SIGNING_KEY", "EMPTY", "PATH"]);
  });
});

describe("import", () => {
  test("every name lands in its slot, verified; a re-scan shows them stored", async () => {
    const root = scratch(); useFakeStore();
    const ws = workspace(root, "app", ENV_TEXT);
    const r = await quiet(() => importEnvFile(ws));
    expect(leaks(JSON.stringify(r))).toEqual([]);
    expect(r.imported.map((i) => i.name).sort()).toEqual(["DB_PASSWORD", "GITHUB_TOKEN", "GITLAB_TOKEN", "GROQ_API_KEY", "SIGNING_KEY", "STRIPE_SECRET_KEY"]);
    expect(r.skipped.map((s) => s.name).sort()).toEqual(["EMPTY", "GH_TOKEN", "PATH"]);
    expect(vaultGet("git_pat_github_com")).toBe(V.gh);
    expect(vaultGet("git_pat_gitlab_com")).toBe(V.gl);
    expect(vaultGet("key:GROQ_API_KEY")).toBe(V.groq);
    expect(vaultGet(workspaceRef(ws, "STRIPE_SECRET_KEY"))).toBe(V.stripe);
    expect(vaultGet(workspaceRef(ws, "SIGNING_KEY"))).toBe(V.pem);
    const meta = Object.fromEntries(vaultList().map((m) => [m.ref, m]));
    expect(meta[workspaceRef(ws, "STRIPE_SECRET_KEY")]).toMatchObject({ source: "env-import", scope: { workspace: ws }, envName: "STRIPE_SECRET_KEY" });
    expect(meta.git_pat_github_com).toMatchObject({ source: "env-import", kind: "pat", envName: "LUCID_GIT_PAT_GITHUB_COM" });
    // the git token reaches the engine's credential env (vault_env.ts) and the provider key its env slot
    expect(process.env.LUCID_GIT_PAT_GITHUB_COM).toBe(V.gh);
    expect(process.env.GROQ_API_KEY).toBe(V.groq);
    // workspace secrets never go into the engine's own env
    expect(process.env.STRIPE_SECRET_KEY).toBeUndefined();
    const again = scanEnvFile(ws);
    expect(again.rows.filter((x) => !x.blocked).every((x) => x.status === "same")).toBe(true);
  });

  test("workspace refs are stable: the same workspace maps to the same ref, another workspace to another", async () => {
    const root = scratch(); useFakeStore();
    const a = workspace(root, "alpha", `STRIPE_SECRET_KEY=${V.stripe}\n`);
    const b = workspace(root, "beta", `STRIPE_SECRET_KEY=${V.stripe}\n`);
    await quiet(() => importEnvFile(a));
    await quiet(() => importEnvFile(a));
    await quiet(() => importEnvFile(b));
    const refs = vaultList().map((m) => m.ref).filter((r) => r.startsWith("ws:"));
    expect(refs.sort()).toEqual([workspaceRef(a, "STRIPE_SECRET_KEY"), workspaceRef(b, "STRIPE_SECRET_KEY")].sort());
    expect(workspaceRef(a, "STRIPE_SECRET_KEY")).toBe(workspaceRef(realpathSync(join(root, "alpha")), "STRIPE_SECRET_KEY"));
    expect(workspaceRef(a, "STRIPE_SECRET_KEY")).toMatch(/^ws:[0-9a-f]{16}:STRIPE_SECRET_KEY$/);
    if (process.platform === "win32") expect(workspaceRef(a.toUpperCase(), "X")).toBe(workspaceRef(a.toLowerCase(), "X"));
  });

  test("blanking keeps every name, comments and the names not imported", async () => {
    const root = scratch(); useFakeStore();
    const ws = workspace(root, "app", ENV_TEXT);
    const r = await quiet(() => importEnvFile(ws, ".env", { names: ["GITHUB_TOKEN", "STRIPE_SECRET_KEY", "SIGNING_KEY"], blank: true }));
    expect(r.blanked).toBe(true);
    const text = readFileSync(join(ws, ".env"), "utf8");
    expect(text).toContain("# app config");
    expect(text).toContain("export GITHUB_TOKEN=\n");
    expect(text).toContain("\nSTRIPE_SECRET_KEY=\n");
    expect(text).toContain("\nSIGNING_KEY=\n");
    expect(text).not.toContain(V.gh);
    expect(text).not.toContain(V.stripe);
    expect(text).not.toContain("BEGIN PRIVATE KEY");
    // not selected: untouched, value and all
    expect(text).toContain(`GH_TOKEN="${V.ghAlt}"`);
    expect(text).toContain(`GROQ_API_KEY=${V.groq}`);
    expect(text.split("\n")).toHaveLength(ENV_TEXT.split("\n").length - 2); // the 3-line PEM became one line
  });

  test("a refused vault write blanks nothing and ignores nothing", async () => {
    const root = scratch();
    _setVaultBackendForTest(() => null);
    const ws = workspace(root, "app", ENV_TEXT);
    await quiet(() => expect(() => importEnvFile(ws, ".env", { blank: true, gitignore: true })).toThrow());
    expect(readFileSync(join(ws, ".env"), "utf8")).toBe(ENV_TEXT);
    expect(existsSync(join(ws, ".gitignore"))).toBe(false);
  });

  test("gitignore: added once, then reported as already ignored", async () => {
    const root = scratch(); useFakeStore();
    const ws = workspace(root, "app", `STRIPE_SECRET_KEY=${V.stripe}\n`);
    writeFileSync(join(ws, ".gitignore"), "node_modules");
    const r = await quiet(() => importEnvFile(ws, ".env", { gitignore: true }));
    expect(r.gitignored).toBe(true);
    expect(readFileSync(join(ws, ".gitignore"), "utf8")).toMatch(/^node_modules\n# .*\n\/\.env\n$/);
    expect(isIgnored(ws, ".env")).toBe(true);
    expect((await quiet(() => importEnvFile(ws, ".env", { gitignore: true }))).gitignored).toBe(false);
  });

  test("only .env files directly in the workspace are read", () => {
    const root = scratch(); useFakeStore();
    const ws = workspace(root, "app", "A=1\n");
    expect(() => scanEnvFile(ws, "../outside.env")).toThrow(/only a \.env file/);
    expect(() => scanEnvFile(ws, "secrets.txt")).toThrow(/only a \.env file/);
    expect(scanEnvFile(ws, ".env.local").exists).toBe(false);
  });
});

const gitOk = Bun.spawnSync(["git", "--version"], { stdout: "pipe", stderr: "pipe" }).success;
const git = (cwd: string, ...args: string[]): boolean =>
  Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], {
    cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  }).success;

describe.skipIf(!gitOk)("committed-file detection", () => {
  test("a .env that was ever committed is flagged even after removal; one never committed is not", async () => {
    const root = scratch(); useFakeStore();
    const ws = workspace(root, "repo", `STRIPE_SECRET_KEY=${V.stripe}\n`);
    expect(git(ws, "init", "-q")).toBe(true);
    writeFileSync(join(ws, "README"), "x");
    expect(git(ws, "add", "README")).toBe(true);
    expect(git(ws, "commit", "-q", "-m", "init")).toBe(true);
    expect(gitEverCommitted(ws, ".env")).toBe(false);
    expect(scanEnvFile(ws).committed).toBe(false);
    expect(isIgnored(ws, ".env")).toBe(false);

    expect(git(ws, "add", ".env")).toBe(true);
    expect(git(ws, "commit", "-q", "-m", "oops")).toBe(true);
    expect(git(ws, "rm", "-q", "--cached", ".env")).toBe(true);
    expect(git(ws, "commit", "-q", "-m", "remove")).toBe(true);
    expect(gitEverCommitted(ws, ".env")).toBe(true);
    const r = await quiet(() => importEnvFile(ws, ".env", { gitignore: true }));
    expect(r.committed).toBe(true); // the UI tells the user to ROTATE
    expect(isIgnored(ws, ".env")).toBe(true); // git's own check-ignore agrees with what was written
  });

  test("outside a repository the answer is unknown, not false", () => {
    const root = scratch(); useFakeStore();
    const ws = workspace(root, "plain", "A=1\n");
    expect(gitEverCommitted(ws, ".env")).toBeNull();
    expect(scanEnvFile(ws).committed).toBeNull();
  });
});

describe("injection", () => {
  test("a session gets its own workspace's secrets (incl. lane worktrees and subfolders) and no other's", async () => {
    const root = scratch(); useFakeStore();
    const a = workspace(root, "alpha", `SHARED_NAME=${V.stripe}\nONLY_A=${V.groq}\n`);
    const b = workspace(root, "beta", `SHARED_NAME=${V.gl}\n`);
    await quiet(() => importEnvFile(a));
    await quiet(() => importEnvFile(b));
    expect(workspaceSecretEnv(a)).toEqual({ SHARED_NAME: V.stripe, ONLY_A: V.groq });
    expect(workspaceSecretEnv(b)).toEqual({ SHARED_NAME: V.gl });
    const sub = join(a, "src"); mkdirSync(sub);
    expect(workspaceSecretEnv(sub)).toEqual({ SHARED_NAME: V.stripe, ONLY_A: V.groq });
    const lane = join(root, "alpha.lucid-worktrees", "fix-1"); mkdirSync(lane, { recursive: true });
    expect(workspaceSecretEnv(lane)).toEqual({ SHARED_NAME: V.stripe, ONLY_A: V.groq });
    expect(workspaceSecretEnv(workspace(root, "gamma"))).toEqual({});
    expect(workspaceSecretEnv(workspace(root, "alphabet"))).toEqual({}); // a name prefix is not a parent
    // the engine's own env never holds them
    expect(process.env.SHARED_NAME).toBeUndefined();
    expect(process.env.ONLY_A).toBeUndefined();
  });

  test("the most specific workspace owns a nested cwd", () => {
    const sep = process.platform === "win32" ? "\\" : "/";
    const outer = `${sep}w${sep}outer`;
    const inner = `${outer}${sep}inner`;
    expect(owningWorkspace(`${inner}${sep}x`, [outer, inner])).toBe(inner);
    expect(owningWorkspace(`${outer}${sep}y`, [outer, inner])).toBe(outer);
    expect(owningWorkspace(`${sep}w${sep}outer.lucid-worktrees${sep}lane`, [outer, inner])).toBe(outer);
    expect(owningWorkspace(`${sep}w${sep}other`, [outer, inner])).toBeNull();
  });

  test("the agent process spawned for a workspace sees its secrets; one for another workspace does not", async () => {
    const root = scratch(); useFakeStore();
    const a = workspace(root, "alpha", `ONLY_A=${V.groq}\n`);
    const b = workspace(root, "beta", `ONLY_B=${V.gl}\n`);
    await quiet(() => importEnvFile(a));
    await quiet(() => importEnvFile(b));
    // The same overlay acp_backend.ts (master) and dev.ts (fleet lanes) hand to ACPClient for a cwd.
    const probe = async (cwd: string): Promise<{ a: string | null; b: string | null }> => {
      const out = join(root, `probe-${Math.random().toString(36).slice(2)}.json`);
      const script = "require('node:fs').writeFileSync(process.env.PROBE_OUT, JSON.stringify({ a: process.env.ONLY_A ?? null, b: process.env.ONLY_B ?? null }))";
      const client = new ACPClient(process.execPath, ["-e", script], cwd, { ...workspaceSecretEnv(cwd), PROBE_OUT: out });
      const exited = new Promise<void>((resolve) => { client.onExit = () => resolve(); });
      client.start();
      await exited;
      return JSON.parse(readFileSync(out, "utf8")) as { a: string | null; b: string | null };
    };
    expect(await probe(a)).toEqual({ a: V.groq, b: null });
    expect(await probe(b)).toEqual({ a: null, b: V.gl });
    expect(await probe(workspace(root, "gamma"))).toEqual({ a: null, b: null });
  });
});

describe("write .env temporarily", () => {
  test("refused unless git-ignored; fills placeholders, then blanks them again", async () => {
    const root = scratch(); useFakeStore();
    const ws = workspace(root, "app", `# keep\nSTRIPE_SECRET_KEY=${V.stripe}\nDB_PASSWORD="${V.db}"\nOTHER=plain\n`);
    await quiet(() => importEnvFile(ws, ".env", { names: ["STRIPE_SECRET_KEY", "DB_PASSWORD"], blank: true }));
    expect(() => materializeEnvFile(ws)).toThrow(/not git-ignored/);
    writeFileSync(join(ws, ".gitignore"), ".env\n");
    const m = await quiet(() => materializeEnvFile(ws, ".env", 5));
    expect(m.names).toEqual(["DB_PASSWORD", "STRIPE_SECRET_KEY"]);
    expect(leaks(JSON.stringify(m))).toEqual([]);
    const written = readFileSync(join(ws, ".env"), "utf8");
    expect(written).toContain(`STRIPE_SECRET_KEY='${V.stripe}'`);
    expect(written).toContain("# keep");
    expect(written).toContain("OTHER="); // a name this workspace does not hold stays as it was
    const back = unmaterializeEnvFile(ws);
    expect(back.blanked).toBe(true);
    const text = readFileSync(join(ws, ".env"), "utf8");
    expect(text).not.toContain(V.stripe);
    expect(text).toContain("STRIPE_SECRET_KEY=\n");
    expect(text).toContain("# keep");
  });
});

describe("routes", () => {
  const UI = "ui-token-0123456789abcdef0123456789abcdef";
  const CTX = { uiToken: UI, mainToken: "main-vault-token-0123456789abcdef012345" };
  const req = (path: string, body: unknown, headers: Record<string, string> = { "x-lucid-token": UI }): Request =>
    new Request(`http://127.0.0.1:1${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  test("scan and import answer on the current workspace with names only; any other token is refused", async () => {
    const root = scratch(); useFakeStore();
    const ws = workspace(root, "app", ENV_TEXT);
    await quiet(() => setWorkspace(ws));
    for (const headers of [{}, { "x-lucid-token": "agent-token-0123456789abcdef0123456789ab" }]) {
      const res = await handleVaultRoutes(req("/api/vault/env/scan", {}, headers), "/api/vault/env/scan", CTX);
      expect(res!.status).toBe(403);
    }
    const q = await handleVaultRoutes(new Request(`http://127.0.0.1:1/api/vault/env/scan?t=${UI}`, { method: "POST", body: "{}" }), "/api/vault/env/scan", CTX);
    expect(q!.status).toBe(403); // a query token is never accepted
    const scan = await handleVaultRoutes(req("/api/vault/env/scan", {}), "/api/vault/env/scan", CTX);
    const scanText = await scan!.text();
    expect(scan!.status).toBe(200);
    expect(leaks(scanText)).toEqual([]);
    expect(JSON.parse(scanText).data.rows.length).toBe(9);
    const imp = await quiet(() => handleVaultRoutes(req("/api/vault/env/import", { names: ["STRIPE_SECRET_KEY"], blank: true }), "/api/vault/env/import", CTX));
    const impText = await imp!.text();
    expect(imp!.status).toBe(200);
    expect(leaks(impText)).toEqual([]);
    expect(JSON.parse(impText).data).toMatchObject({ imported: [{ name: "STRIPE_SECRET_KEY", slot: "workspace" }], blanked: true });
    expect(vaultGet(workspaceRef(ws, "STRIPE_SECRET_KEY"))).toBe(V.stripe);
    const bad = await handleVaultRoutes(req("/api/vault/env/scan", { file: "../x.env" }), "/api/vault/env/scan", CTX);
    expect(bad!.status).toBe(400);
    const get = await handleVaultRoutes(new Request("http://127.0.0.1:1/api/vault/env/scan", { headers: { "x-lucid-token": UI } }), "/api/vault/env/scan", CTX);
    expect(get!.status).toBe(405);
  });
});
