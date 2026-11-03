// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_vault_keys_1.ts
//
// Increment P-VAULT-KEYS.1 (ADR-0472): provider keys, named-account keys, MCP bearer tokens and the TURN
// credential leave lucid-gui.json for an engine-side OS vault. REAL processes and the REAL OS backend
// (DPAPI on Windows; Keychain / Secret Service elsewhere) against a scratch settings file:
//   1) a plaintext lucid-gui.json and .bak from an older build: the first engine start migrates them; no
//      secret value is left in either file or in the vault dir; keys load unchanged and reach process.env.
//   2) a second engine process sharing the directory reads the same keys (no re-entry).
//   3) Windows only: with master.dpapi gone the vault is unreadable; load() serves no vaulted key and
//      rewrites nothing; re-entering a key sets the old vault aside and starts a fresh one.
//   4) Electron main safety: engine_vault.ts bundled for Node reports `unavailable` and never reads a vault
//      file (run under Node when it is on PATH); main.ts still bundles with --target=node.
// On a host with no usable OS vault the demo checks the documented fallback instead (keys stay in the file).

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyEnv, keyVaultStatus, load, setKey, type GuiSettings } from "../settings_store.ts";
import type { VaultStatus } from "../engine_vault.ts";

const SECRET = { key: "sk-demo-VAULT-0001", acct: "sk-demo-ACCT-0002", mcp: "mcp-demo-BEARER-0003", turn: "turn-demo-CRED-0004" };
const LEGACY: GuiSettings = {
  username: "Nick",
  keys: { LUCID_DEMO_VAULT_KEY: SECRET.key },
  accounts: { openai: [{ id: "key:demo-acct", name: "Work", kind: "key", key: SECRET.acct, createdAt: 1 }] },
  mcpServers: [{ id: "mcp-demo", name: "Docs", transport: "http", url: "https://mcp.example.com", token: SECRET.mcp, enabled: true }],
  collabTurnUsername: "turnuser",
  collabTurnCredential: SECRET.turn,
};

// ---- child role: one engine start -------------------------------------------------------------------
if (process.argv[2] === "--engine") {
  const settings = load();
  applyEnv();
  console.log(JSON.stringify({ settings, env: process.env.LUCID_DEMO_VAULT_KEY ?? null, status: keyVaultStatus() }));
  process.exit(0);
}

// ---- driver -------------------------------------------------------------------------------------------
const fail = (msg: string): never => { console.error(`FAIL: ${msg}`); process.exit(1); };
const ok = (msg: string): void => console.log(`   ${msg} - ok`);
const DESKTOP = join(import.meta.dir, "..");

console.log("== ADR-0472 P-VAULT-KEYS.1: keys move from lucid-gui.json into the engine OS vault ==");
const dir = mkdtempSync(join(tmpdir(), "lucid-vaultkeys1-"));
const file = join(dir, "lucid-gui.json");
const vault = join(dir, "lucid-engine-vault");
process.env.LUCID_GUI_SETTINGS_FILE = file;
delete process.env.LUCID_ENGINE_VAULT_DIR;
delete process.env.LUCID_DEMO_VAULT_KEY;
const env = { ...process.env, LUCID_GUI_SETTINGS_FILE: file };

async function engine(): Promise<{ settings: GuiSettings; env: string | null; status: VaultStatus }> {
  const p = Bun.spawn([process.execPath, import.meta.path, "--engine"], { env, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  if ((await p.exited) !== 0) fail(`the engine process failed: ${err.slice(0, 400)}`);
  return JSON.parse(out.trim().split("\n").pop() ?? "{}");
}
const plaintextIn = (path: string): string[] => {
  const text = readFileSync(path, "latin1");
  return Object.values(SECRET).filter((v) => text.includes(v));
};

try {
  // 1) the first engine start migrates an older build's plaintext file
  writeFileSync(file, JSON.stringify(LEGACY, null, 2));
  writeFileSync(`${file}.bak`, JSON.stringify(LEGACY, null, 2));
  const first = await engine();
  if (first.status.state !== "ok") {
    console.log(`   no usable OS vault on this host (${first.status.custody}, ${first.status.detail ?? first.status.state}): checking the fallback`);
    if (!Bun.deepEquals(first.settings, LEGACY)) fail("the fallback must serve the settings unchanged");
    if (!readFileSync(file, "utf8").includes(SECRET.key)) fail("the fallback must keep the key in the user-only file");
    ok("fallback: keys stay in lucid-gui.json (0600) exactly as before");
  } else {
    if (!Bun.deepEquals(first.settings, LEGACY)) fail("the first engine start must return the same settings, secrets included");
    if (first.env !== SECRET.key) fail("applyEnv must still export the provider key for the omp child");
    for (const path of [file, `${file}.bak`]) {
      const left = plaintextIn(path);
      if (left.length) fail(`${path} still holds ${left.length} plaintext secret(s)`);
    }
    const vaultFiles = readdirSync(vault);
    if (process.platform === "win32" && !vaultFiles.includes("master.dpapi")) fail("the DPAPI-protected master key must be on disk");
    for (const f of vaultFiles) if (plaintextIn(join(vault, f)).length) fail(`${f} in the vault dir holds a plaintext secret`);
    ok(`first engine start sealed 4 secret fields into the ${first.status.custody} vault (${vaultFiles.join(", ")}); lucid-gui.json and .bak hold none; keys load unchanged and reach process.env`);

    // 2) another engine (lucid hub, a fleet lane, the dev port) shares the directory
    const second = await engine();
    if (!Bun.deepEquals(second.settings, LEGACY)) fail("a second engine must read the same keys");
    ok("a second engine process reads the same keys from the shared vault: no re-entry");

    // 3) fail closed (Windows: the master key is a file we can remove; Keychain / Secret Service are left alone)
    if (process.platform === "win32") {
      const sealed = join(vault, "secrets.v1.json");
      const sealedBytes = readFileSync(sealed);
      const fileBytes = readFileSync(file);
      rmSync(join(vault, "master.dpapi"));
      const third = await engine();
      if (third.status.state !== "unreadable") fail(`a vault without its master key must read as unreadable, got ${third.status.state}`);
      if (third.settings.keys?.LUCID_DEMO_VAULT_KEY) fail("an unreadable vault must serve no vaulted key");
      if (!readFileSync(sealed).equals(sealedBytes) || !readFileSync(file).equals(fileBytes)) fail("an unreadable vault and the settings file must be left untouched");
      ok("master key gone: the vault reads as unreadable, no key is served, neither file is rewritten");

      const quietErr = console.error; console.error = () => {};
      try { setKey("LUCID_DEMO_VAULT_KEY", "sk-demo-REENTERED-0005"); } finally { console.error = quietErr; }
      const aside = readdirSync(vault).filter((f) => f.startsWith("secrets.v1.json.unreadable-"));
      if (aside.length !== 1 || !readFileSync(join(vault, aside[0]!)).equals(sealedBytes)) fail("the unreadable vault must be kept aside, byte for byte");
      const fourth = await engine();
      if (fourth.status.state !== "ok" || fourth.settings.keys?.LUCID_DEMO_VAULT_KEY !== "sk-demo-REENTERED-0005") fail("the re-entered key must load from a fresh vault");
      if (readFileSync(file, "utf8").includes("sk-demo-REENTERED-0005")) fail("the re-entered key must not land in lucid-gui.json");
      ok("re-entering a key set the old vault aside (kept, not overwritten) and started a fresh one");
    }
  }

  // 4) Electron main never opens the engine vault
  const nodeBundle = join(dir, "engine_vault.node.cjs");
  const b = Bun.spawnSync([process.execPath, "build", join(DESKTOP, "engine_vault.ts"), "--target=node", "--format=cjs", "--outfile", nodeBundle], { stderr: "pipe" });
  if (b.exitCode !== 0) fail(`engine_vault.ts must bundle for Node: ${b.stderr.toString().slice(0, 400)}`);
  const node = Bun.which("node");
  if (node) {
    const nodeVault = join(dir, "node-vault");
    mkdirSync(nodeVault);
    writeFileSync(join(nodeVault, "secrets.v1.json"), "not a sealed record");
    const probe = `const v = require(${JSON.stringify(nodeBundle)}); const d = ${JSON.stringify(nodeVault)};
      console.log(JSON.stringify({ status: v.vaultStatus(d), read: v.readVault(d) }));`;
    const r = Bun.spawnSync([node, "-e", probe], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) fail(`the Node-bundled vault must load under Node: ${r.stderr.toString().slice(0, 400)}`);
    const seen = JSON.parse(r.stdout.toString().trim()) as { status: VaultStatus; read: { exists: boolean } };
    if (seen.status.state !== "unavailable" || seen.status.custody !== "plaintext-file" || seen.read.exists) fail(`under Node the vault must report unavailable and read nothing, got ${JSON.stringify(seen)}`);
    if (readdirSync(nodeVault).join() !== "secrets.v1.json") fail("under Node no vault file may be created");
    ok("under Node (Electron main) the vault loads without bun:ffi, reports unavailable, and never reads its files");
  } else {
    console.log("   (node is not on PATH: the Node-runtime check is skipped; the bundle check still ran)");
  }
  const mainOut = join(dir, "main.js");
  const m = Bun.spawnSync([process.execPath, "build", "main.ts", "--target=node", "--format=cjs", "--external", "electron", "--outfile", mainOut], { cwd: DESKTOP, stderr: "pipe" });
  if (m.exitCode !== 0 || !existsSync(mainOut)) fail(`main.ts must still bundle for Electron main: ${m.stderr.toString().slice(0, 400)}`);
  ok("main.ts (Electron main) still bundles with --target=node, the vault in its import graph");

  console.log("\nP-VAULT-KEYS.1 demo: all checks passed - saved keys are sealed by the OS, and nobody re-enters them.");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
