// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/build/pf-boot-smoke.ts - P-WINBOOT.2C (ADR-0261): the Program Files boot gate.
//
// v1.12.0 shipped a brick: installed under C:\Program Files, the engine died because Bun EPERMs
// module-loading .ts out of the ACL-protected tree - and NO gate ever booted the app from such a tree
// (packaged_boot.test.ts boots from a writable temp dir; demo_p_winboot_2 boots from the writable
// repo). This script closes that hole. It stages the packaged repo (or a source-built skeleton) into a
// Program Files directory, makes the whole tree read+execute-only for the current user (an explicit
// DENY ACE - CI runners are admins, so inherited Program Files ACLs alone would not constrain them the
// way they constrain a real standard user), PROVES the denial took, then requires the compiled
// bin/lucid-engine to answer /api/health and serve the prebuilt renderer bundle from that tree.
//
// Modes (auto-detected):
//   packaged - desktop/release/<plat>-unpacked (or the mac .app) carries repo/bin/lucid-engine:
//              stage THAT repo tree verbatim. This is what CI runs right after dist:<os>.
//   source   - no packaged engine on disk (a dev box): compile the engine + renderer into a minimal
//              skeleton (bin/ + desktop/renderer/ + the native-addon packages) and stage that.
// Env:
//   LUCID_PF_SMOKE_STRICT=1  CI: REQUIRE the real Program Files tree AND the packaged layout; any
//                            fallback is a build failure, never a silent downgrade.
//   LUCID_PF_SMOKE_DIR=<dir> debugging: stage under <dir> instead (still hardened).
//
// Run with: bun run build/pf-boot-smoke.ts   (cwd = desktop/, like airgap-smoke.ts)

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { engineExeName, resolveEngineSpawn } from "../engine_launch.ts";
import { bootVerdict, hardenPlan, pickSmokeRoot, requiredLayout, restorePlan } from "../engine_pf_smoke.ts";

const HERE = dirname(fileURLToPath(import.meta.url)); // desktop/build
const DESKTOP = join(HERE, "..");
const REPO = join(DESKTOP, "..");
const RELEASE = join(DESKTOP, "release");
const PLAT = process.platform;
const STRICT = process.env.LUCID_PF_SMOKE_STRICT === "1";

function fail(msg: string): never {
  console.error(`\n\u2717 pf-boot smoke: ${msg}\n`);
  process.exit(1);
}
function ok(msg: string): void {
  console.log(`  \u2713 ${msg}`);
}

function run(argv: string[], opts: { cwd?: string; okCodes?: number[] } = {}): void {
  const r = Bun.spawnSync(argv, { cwd: opts.cwd ?? REPO, stdout: "pipe", stderr: "pipe" });
  if (!(opts.okCodes ?? [0]).includes(r.exitCode ?? -1)) {
    fail(`\`${argv.join(" ")}\` exited ${r.exitCode}:\n${r.stderr.toString().slice(0, 1200)}`);
  }
}

// --- 1) resolve the source layout: packaged repo tree, or a source-built skeleton --------------------

/** The packaged repo dir (…/resources/repo) that carries the compiled engine, if one exists. */
function packagedRepoDir(): string | null {
  if (!existsSync(RELEASE)) return null;
  const candidates: string[] = [];
  const direct = PLAT === "win32" ? join(RELEASE, "win-unpacked", "resources")
    : PLAT === "linux" ? join(RELEASE, "linux-unpacked", "resources") : null;
  if (direct && existsSync(direct)) candidates.push(direct);
  for (const entry of readdirSync(RELEASE)) {
    const p = join(RELEASE, entry);
    if (!statSync(p).isDirectory()) continue;
    const apps = entry.endsWith(".app") ? [p] : readdirSync(p).filter((x) => x.endsWith(".app")).map((x) => join(p, x));
    for (const app of apps) {
      const r = join(app, "Contents", "Resources");
      if (existsSync(r)) candidates.push(r);
    }
  }
  for (const res of candidates) {
    const repo = join(res, "repo");
    if (requiredLayout(PLAT).every((f) => existsSync(join(repo, f)))) return repo;
  }
  return null;
}

/** Source mode: compile the engine + renderer into a minimal repo skeleton at `dst`, plus every
 *  native-addon package (the only node_modules content a compiled engine loads off disk). */
function buildSourceSkeleton(dst: string): void {
  mkdirSync(join(dst, "bin"), { recursive: true });
  mkdirSync(join(dst, "desktop", "renderer"), { recursive: true });
  console.log("  building renderer bundle + compiling the engine (source mode)...");
  run(["bun", "build", "renderer/app.ts", "--target=browser", "--outfile", join(dst, "desktop", "renderer", "app.bundle.js"), "--sourcemap=inline"], { cwd: DESKTOP });
  run(["bun", "build", "--compile", "dev.ts", "--outfile", join(dst, "bin", engineExeName(PLAT)), "--external", "*.node"], { cwd: DESKTOP });
  // package.json files ride along - cheap, and boot-time version reads must not 404 the skeleton.
  for (const rel of ["package.json", join("desktop", "package.json")]) {
    if (existsSync(join(REPO, rel))) cpSync(join(REPO, rel), join(dst, rel));
  }
  // Native addons: find every *.node under both node_modules trees and copy its TOP-LEVEL package dir
  // (structure + package.json intact, so runtime resolution works), preserving its tree position.
  const packages = new Set<string>();
  for (const nmRel of ["node_modules", join("desktop", "node_modules")]) {
    const nm = join(REPO, nmRel);
    if (!existsSync(nm)) continue;
    for (const m of new Bun.Glob("**/*.node").scanSync({ cwd: nm, onlyFiles: true })) {
      const parts = m.split(/[\\/]/);
      const pkg = parts[0]!.startsWith("@") ? join(parts[0]!, parts[1]!) : parts[0]!;
      packages.add(join(nmRel, pkg));
    }
  }
  for (const rel of packages) {
    cpSync(join(REPO, rel), join(dst, rel), { recursive: true, force: true, dereference: true });
  }
  ok(`source skeleton built (engine + renderer bundle + ${packages.size} native-addon packages)`);
}

console.log("== P-WINBOOT.2C (ADR-0261): engine boots from a Program Files-ACL install ==\n");
console.log("[1] resolve what to stage");
const packaged = packagedRepoDir();
if (STRICT && !packaged) fail("strict mode requires the PACKAGED repo (dist output with bin/lucid-engine) and none was found under desktop/release");
console.log(`  mode: ${packaged ? `packaged (${relative(REPO, packaged)})` : "source-built skeleton"}`);

// --- 2) pick + create the staging root ---------------------------------------------------------------
console.log("\n[2] stage into a Program Files-ACL location");
const programFilesDir = PLAT === "win32" ? (process.env.ProgramFiles ?? "C:\\Program Files") : "";
const probeWritable = (dir: string): boolean => {
  try { mkdirSync(join(dir, "lucid-pf-probe"), { recursive: true }); rmSync(join(dir, "lucid-pf-probe"), { recursive: true, force: true }); return true; } catch { return false; }
};
let dest;
try {
  dest = pickSmokeRoot({
    strict: STRICT,
    programFilesDir,
    programFilesWritable: !!programFilesDir && probeWritable(programFilesDir),
    tmpDir: tmpdir(),
    override: process.env.LUCID_PF_SMOKE_DIR,
  });
} catch (e) {
  fail((e as Error).message);
}
const STAGE = dest.root;
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });
console.log(`  staging root: ${STAGE}${dest.programFiles ? " (real Program Files)" : " (hardened fallback dir)"}`);

if (packaged) {
  // robocopy on Windows: long-path-safe + fast; exit codes 0-7 all mean success (its documented quirk).
  if (PLAT === "win32") run(["robocopy", packaged, STAGE, "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NP"], { okCodes: [0, 1, 2, 3, 4, 5, 6, 7] });
  else cpSync(packaged, STAGE, { recursive: true, force: true, dereference: true });
  ok("packaged repo tree staged verbatim");
} else {
  buildSourceSkeleton(STAGE);
}
for (const f of requiredLayout(PLAT)) {
  if (!existsSync(join(STAGE, f))) fail(`staged tree is missing ${f} - the boot would prove nothing`);
}
ok(`required layout present (${requiredLayout(PLAT).join(", ")})`);

// --- 3) harden: read+execute only for THIS user, then PROVE the denial took --------------------------
console.log("\n[3] deny ourselves write on the staged tree (the standard-user Program Files posture)");
const user = PLAT === "win32"
  ? (process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : (process.env.USERNAME ?? "")) || fail("cannot resolve the current Windows user for the deny ACE")
  : (process.env.USER ?? "");
let hardened = false;
const restore = (): void => {
  if (!hardened) return;
  for (const cmd of restorePlan(STAGE, user, PLAT)) Bun.spawnSync(cmd, { stdout: "ignore", stderr: "ignore" });
  hardened = false;
};

let verdict: { ok: boolean; detail: string } | null = null;
let appjs: { status: number; bytes: number } | null = null;
try {
  for (const cmd of hardenPlan(STAGE, user, PLAT)) run(cmd);
  hardened = true;
  let denied = false;
  try { writeFileSync(join(STAGE, "deny-probe.txt"), "x"); } catch { denied = true; }
  if (!denied) fail("the staged tree is still writable after hardening - the smoke would not test the Program Files constraint");
  ok("write into the staged tree is DENIED (probe write failed as required)");

  // --- 4) boot the engine the way main.ts does -------------------------------------------------------
  console.log("\n[4] boot bin/lucid-engine from the protected tree");
  const spec = resolveEngineSpawn({ packaged: true, repoRoot: STAGE, bun: "bun", exists: existsSync, platform: PLAT });
  if (!spec.compiled) fail("resolveEngineSpawn did not pick the compiled binary from the staged repo - main.ts would fall back to the brick path");
  ok("resolveEngineSpawn picks the compiled binary (the exact main.ts decision)");

  const port = 5400 + Math.floor(Math.random() * 300);
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
  try {
    proc = Bun.spawn([spec.cmd, ...spec.args], {
      cwd: STAGE, // main.ts spawns with cwd = the packaged repo root
      env: { ...process.env, PORT: String(port) },
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (e) {
    // A spawn refusal from the protected tree IS the brick class (v1.12.0 was an EPERM here).
    verdict = { ok: false, detail: `engine could not even SPAWN from the protected tree: ${(e as Error).message}` };
  }
  let health: string | null = null;
  if (proc) {
    // Drain BOTH pipes from the start: an undrained 64KB pipe buffer blocks a chatty engine mid-
    // console.log and it never finishes booting - a hang this smoke itself must not cause.
    const outP = new Response(proc.stdout).text();
    const errP = new Response(proc.stderr).text();
    try {
      for (let i = 0; i < 120; i++) { // <=30s, bail early on exit
        await Bun.sleep(250);
        if (proc.exitCode !== null) break;
        try {
          const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
          if (r.ok) { health = await r.text(); break; }
        } catch { /* still starting */ }
      }
      if (health) {
        const r = await fetch(`http://127.0.0.1:${port}/app.js`, { signal: AbortSignal.timeout(5000) });
        appjs = { status: r.status, bytes: (await r.text()).length };
      }
    } finally {
      // Kill FIRST, read after: the streams only close when the process dies - awaiting them on a
      // still-running engine deadlocks the smoke.
      try { if (PLAT === "win32") Bun.spawnSync(["taskkill", "/PID", String(proc.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" }); else proc.kill(); } catch { /* best effort */ }
      const tail = (s: string) => s.split("\n").slice(-15).join("\n").trim();
      const [out, err] = await Promise.all([outP, errP]);
      verdict = bootVerdict({ health, exitCode: proc.exitCode, stderrTail: [tail(err), tail(out)].filter(Boolean).join("\n--- stdout tail ---\n") });
    }
  }
} finally {
  // --- 5) cleanup: un-deny, then delete (Windows briefly locks a just-killed exe - retry) ------------
  restore();
  for (let i = 0; i < 8; i++) {
    try { rmSync(STAGE, { recursive: true, force: true }); break; } catch { await Bun.sleep(500); }
  }
}

if (!verdict?.ok) fail(verdict?.detail ?? "no boot verdict");
ok(verdict.detail);
if (!appjs || appjs.status !== 200 || appjs.bytes < 1_000_000) {
  fail(`prebuilt renderer bundle did not serve from the protected tree (status ${appjs?.status}, ${appjs?.bytes ?? 0} bytes)`);
}
ok(`prebuilt /app.js served from the protected tree (${(appjs.bytes / 1_000_000).toFixed(1)} MB)`);
console.log(`\n\u2713 pf-boot smoke passed: the compiled engine boots + serves from a ${dest.programFiles ? "real Program Files" : "write-denied"} install tree.${sep === "\\" ? "" : " (POSIX chmod posture)"}\n`);
