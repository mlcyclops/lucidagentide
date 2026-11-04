// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-VAULT-ENV.1 (ADR-0477): `.env` import into the engine vault and workspace-scoped injection. Every path
// is a temp dir, the OS backend is the in-memory fake (engine_vault _setVaultBackendForTest), and git runs
// only in scratch repositories. Proves: a scan and every route response carry names and last-4, never a
// value; names land in the git host / provider key / workspace slots; workspace refs are stable; blanking
// keeps the names; a committed `.env` is detected; a refused vault write changes nothing in the file; and
// a session's env gets its own workspace's secrets and no other workspace's.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACPClient } from "./acp.ts";
import { engineCredClient } from "./cred_engine_client.ts";
import { _setVaultBackendForTest, type OsKeyStore } from "./engine_vault.ts";
import { _resetVaultEnvForTest } from "./vault_env.ts";
import {
  _resetMaterializedForTest, _setMaterializeJournalForTest, gitEverCommitted, importEnvFile, isIgnored, materializeEnvFile,
  owningWorkspace, reblankMaterializedJournal, scanEnvFile, unmaterializeAll, unmaterializeEnvFile, workspaceSecretEnv,
} from "./vault_env_import.ts";
import { handleVaultRoutes } from "./vault_routes.ts";
import { onVaultWrite, vaultGet, vaultList, workspaceRef } from "./vault_store.ts";
import { setWorkspace } from "./workspace.ts";

const ENV_KEYS = [
  "LUCID_GUI_SETTINGS_FILE", "LUCID_ENGINE_VAULT_DIR", "LUCID_OMP_MODELS_YAML", "LUCID_ACP_LOG", "GROQ_API_KEY", "OPENAI_API_KEY",
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
  _setMaterializeJournalForTest(join(root, "data", "vault-env-materialized.json"));
  return root;
}
const journalOf = (root: string): unknown => JSON.parse(readFileSync(join(root, "data", "vault-env-materialized.json"), "utf8"));
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
  _setMaterializeJournalForTest(null);
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

  // Wave B security review SECRET-INTAKE-ENVNAME-UNRESTRICTED: env_name_policy.ts is the one rule.
  test("reserved names (runtime, proxy, base URL, git, python, CA bundle, LUCID) are blocked", async () => {
    const root = scratch(); useFakeStore();
    const reserved = ["NODE_OPTIONS", "HTTPS_PROXY", "OPENAI_BASE_URL", "GIT_SSH_COMMAND", "PYTHONPATH", "REQUESTS_CA_BUNDLE", "LUCID_X"];
    const ws = workspace(root, "app", reserved.map((n) => `${n}=${V.stripe}`).join("\n") + "\n");
    const s = scanEnvFile(ws);
    expect(s.rows.map((r) => [r.name, r.blocked])).toEqual(reserved.map((n) => [n, "reserved name"]));
    const r = await quiet(() => importEnvFile(ws));
    expect(r.imported).toEqual([]);
    expect(r.skipped.map((x) => x.name).sort()).toEqual([...reserved].sort());
  });

  // VAULT-ENV-IMPORT-OVERWRITE-GLOBAL
  test("a row replacing a saved global key is skipped unless its name is confirmed", async () => {
    const root = scratch(); useFakeStore();
    const ws = workspace(root, "app", `GROQ_API_KEY=${V.groq}\n`);
    await quiet(() => importEnvFile(ws));
    const other = "gsk_FAKEfakeFAKEfake0000009Z";
    writeFileSync(join(ws, ".env"), `GROQ_API_KEY=${other}\n`);
    expect(scanEnvFile(ws).rows[0]).toMatchObject({ slot: "provider-key", status: "replaces" });
    const r = await quiet(() => importEnvFile(ws, ".env", { names: ["GROQ_API_KEY"] }));
    expect(r.imported).toEqual([]);
    expect(r.skipped[0]!.name).toBe("GROQ_API_KEY");
    expect(r.skipped[0]!.reason).toContain("replace your saved key");
    expect(vaultGet("key:GROQ_API_KEY")).toBe(V.groq);
    const ok = await quiet(() => importEnvFile(ws, ".env", { names: ["GROQ_API_KEY"], confirmReplace: ["GROQ_API_KEY"] }));
    expect(ok.imported.map((i) => i.name)).toEqual(["GROQ_API_KEY"]);
    expect(vaultGet("key:GROQ_API_KEY")).toBe(other);
  });

  // VAULT-ENV-SYMLINK-FOLLOW
  test("a .env symlink is refused, never followed", () => {
    const root = scratch(); useFakeStore();
    const ws = workspace(root, "app");
    const target = join(root, "credentials");
    writeFileSync(target, `aws_secret_access_key=${V.stripe}\n`);
    try { symlinkSync(target, join(ws, ".env"), "file"); }
    catch { return; } // the platform refuses links here; nothing to test
    expect(() => scanEnvFile(ws)).toThrow(/not a regular file/);
    expect(() => importEnvFile(ws)).toThrow(/not a regular file/);
  });

  test("an oversize .env is refused before it is read", () => {
    const root = scratch(); useFakeStore();
    const ws = workspace(root, "app", `A=${"x".repeat(300 * 1024)}\n`);
    expect(() => scanEnvFile(ws)).toThrow(/larger than 256 KiB/);
  });

  // VAULT-DEST-AUTOBACKUP-GAP (import part)
  test("an import tells every vault write observer about each imported ref, metadata only", async () => {
    const root = scratch(); useFakeStore();
    const ws = workspace(root, "app", ENV_TEXT);
    const heard: string[] = [];
    const seen: string[] = [];
    const off = onVaultWrite((m) => { heard.push(m.ref); seen.push(JSON.stringify(m)); });
    try {
      const r = await quiet(() => importEnvFile(ws));
      expect(heard.sort()).toEqual(r.imported.map((i) => i.ref).sort());
      expect(leaks(seen.join("\n"))).toEqual([]);
    } finally { off(); }
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

  // VAULT-ENV-IMPORT-OVERWRITE-GLOBAL: a repository's file never fills the user's global slots.
  test("a git-tracked .env maps provider and git names to ws: overrides, not the global slots", async () => {
    const root = scratch(); useFakeStore();
    const openai = "sk-FAKEfakeFAKEfake00000007G";
    const ws = workspace(root, "repo", `OPENAI_API_KEY=${openai}\nGITHUB_TOKEN=${V.gh}\n`);
    expect(git(ws, "init", "-q")).toBe(true); // not ignored inside a repository: tracked
    const before = process.env.OPENAI_API_KEY;
    const s = scanEnvFile(ws);
    expect(s.tracked).toBe(true);
    const by = Object.fromEntries(s.rows.map((r) => [r.name, r]));
    expect(by.OPENAI_API_KEY).toMatchObject({ slot: "workspace", ref: workspaceRef(ws, "OPENAI_API_KEY"), envName: "OPENAI_API_KEY", fromRepo: true });
    expect(by.GITHUB_TOKEN).toMatchObject({ slot: "workspace", ref: workspaceRef(ws, "GITHUB_TOKEN"), envName: "GITHUB_TOKEN", fromRepo: true });
    await quiet(() => importEnvFile(ws));
    expect(vaultGet(workspaceRef(ws, "OPENAI_API_KEY"))).toBe(openai);
    expect(vaultGet(workspaceRef(ws, "GITHUB_TOKEN"))).toBe(V.gh);
    expect(vaultGet("key:OPENAI_API_KEY")).toBeUndefined();
    expect(vaultGet("git_pat_github_com")).toBeUndefined();
    expect(process.env.OPENAI_API_KEY).toBe(before);
    expect(vaultList().find((m) => m.ref === workspaceRef(ws, "OPENAI_API_KEY"))!.label).toContain("from the repository");
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

  /** A workspace holding one imported ws: secret, its .env blanked and git-ignored. */
  const ready = async (root: string, name: string): Promise<string> => {
    const ws = workspace(root, name, `STRIPE_SECRET_KEY=${V.stripe}\n`);
    await quiet(() => importEnvFile(ws, ".env", { blank: true }));
    writeFileSync(join(ws, ".gitignore"), ".env\n");
    return ws;
  };

  // VAULT-ENV-MATERIALIZE-SYNCED
  test("refused in a folder a cloud client syncs", async () => {
    const root = scratch(); useFakeStore();
    const ws = await ready(root, join("OneDrive", "app"));
    const before = readFileSync(join(ws, ".env"), "utf8");
    expect(() => materializeEnvFile(ws)).toThrow(/synced by a cloud client/);
    expect(readFileSync(join(ws, ".env"), "utf8")).toBe(before);
    expect(existsSync(join(root, "data", "vault-env-materialized.json"))).toBe(false);
  });

  test("journaled before the write; the next start re-blanks after a crash", async () => {
    const root = scratch(); useFakeStore();
    const ws = await ready(root, "app");
    await quiet(() => materializeEnvFile(ws, ".env", 5));
    const journal = journalOf(root) as Array<{ path: string; names: string[]; until: number }>;
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({ path: join(ws, ".env"), names: ["STRIPE_SECRET_KEY"] });
    expect(leaks(JSON.stringify(journal))).toEqual([]);
    expect(readFileSync(join(ws, ".env"), "utf8")).toContain(V.stripe);
    _resetMaterializedForTest(); // the engine died: no timer, no in-memory record
    expect(await quiet(() => reblankMaterializedJournal())).toEqual({ reblanked: 1, failed: 0 });
    expect(readFileSync(join(ws, ".env"), "utf8")).not.toContain(V.stripe);
    expect(journalOf(root)).toEqual([]);
  });

  test("unmaterializeAll re-blanks every written file and clears the journal", async () => {
    const root = scratch(); useFakeStore();
    const ws = await ready(root, "app");
    await quiet(() => materializeEnvFile(ws, ".env", 5));
    expect(await quiet(() => unmaterializeAll())).toEqual({ reblanked: 1, failed: 0 });
    expect(readFileSync(join(ws, ".env"), "utf8")).not.toContain(V.stripe);
    expect(journalOf(root)).toEqual([]);
  });

  test("VAULT-ENV-MATERIALIZE-SYNCED: main's graceful shutdown call re-blanks before the kill", async () => {
    const root = scratch(); useFakeStore();
    const ws = await ready(root, "app");
    await quiet(() => materializeEnvFile(ws, ".env", 5));
    expect(readFileSync(join(ws, ".env"), "utf8")).toContain(V.stripe);
    // Electron main's own client, signed with the vault token, answered by the engine's route handler.
    const UI = "ui-token-shutdown-0123456789abcdef0123";
    const MAIN = "main-token-shutdown-0123456789abcdef01";
    const engine = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const req = new Request(input, init);
      return (await handleVaultRoutes(req, new URL(req.url).pathname, { uiToken: UI, mainToken: MAIN })) ?? new Response("not found", { status: 404 });
    };
    // Without the vault token's MAC the route is closed, like every other main-only route, and nothing changes.
    const forged = engineCredClient({ baseUrl: "http://127.0.0.1:1", uiToken: UI, vaultToken: "wrong-token", fetch: engine as typeof fetch });
    await expect(forged.shutdown()).rejects.toThrow();
    expect(readFileSync(join(ws, ".env"), "utf8")).toContain(V.stripe);
    const client = engineCredClient({ baseUrl: "http://127.0.0.1:1", uiToken: UI, vaultToken: MAIN, fetch: engine as typeof fetch });
    const report = await quiet(() => client.shutdown());
    expect(report.reblanked).toBe(1);
    expect(readFileSync(join(ws, ".env"), "utf8")).not.toContain(V.stripe);
    expect(journalOf(root)).toEqual([]);
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
