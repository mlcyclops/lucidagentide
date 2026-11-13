// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/build/stage-mac-arch.ts - #614 (ADR-0569): build every native binary the mac apps ship ONCE PER ARCH.
//
// One macOS job packages both apps (one job keeps latest-mac.yml whole for electron-updater), and it runs on an
// arm64 runner. compile-lucid, compile-engine, build-holder and natives used to write host-arch binaries into
// one bin/, which electron-builder packed into the arm64 AND the x64 app, so v2.5.4-beta.1's x64 zip carried an
// arm64 lucid-engine and an Intel Mac could not start the engine. This script replaces those four steps on
// macOS and stages, for each of arm64 and x64:
//
//   <repo>/bin-darwin-<arch>/lucid          bun build --compile --target=bun-darwin-<arch>  (as compile-lucid)
//   <repo>/bin-darwin-<arch>/lucid-engine   bun build --compile --target=bun-darwin-<arch>  (as compile-engine)
//   <repo>/bin-darwin-<arch>/lucid-holder   cargo build --target <arch>-apple-darwin        (build-holder.ts)
//   <repo>/bin-darwin-<arch>/pi_natives.darwin-<arch>*.node  links into node_modules     (copy-natives.ts)
//
// and installs the other arch's `*-darwin-<arch>` addon packages next to the host's, pinned by bun.lock
// (darwin_packages.ts). desktop/package.json `build.mac.extraResources` maps `bin-darwin-${arch}` onto the app's
// `repo/bin` (so resolveEngineSpawn and holderBinary() see the same path as before) and ships each app only its
// own `node_modules/*-darwin-${arch}` packages. bin/ keeps only what serves both apps: the universal lucid-sep.
//
// Every staged binary is checked for its Mach-O arch here, before packaging; build/mac-arch-gate.ts checks the
// packed apps again afterwards. Not macOS: a no-op, like compile-sep.
//
//   bun run stage-mac            (from desktop/; needs rustup targets aarch64-apple-darwin + x86_64-apple-darwin)
//
// Keep the bun build arguments below in step with `compile-lucid` / `compile-engine` in desktop/package.json.

import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { darwinTwins, installDir, type LockPackage, parseBunLockPackages, tarballUrl } from "./darwin_packages.ts";
import { describeMachO, MAC_ARCHS, type MacArch, machRunsOn, readMachO } from "./macho.ts";

if (process.platform !== "darwin") {
  console.log("stage-mac: not macOS, nothing to stage");
  process.exit(0);
}

const HERE = dirname(fileURLToPath(import.meta.url)); // desktop/build
const DESKTOP = join(HERE, "..");
const REPO = join(DESKTOP, "..");
const BUN = process.execPath;
const RUST_TRIPLE: Record<MacArch, string> = { arm64: "aarch64-apple-darwin", x64: "x86_64-apple-darwin" };

function fail(msg: string): never {
  console.error(`\nstage-mac: ${msg}\n`);
  process.exit(1);
}

function run(cmd: string[], cwd: string): void {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) fail(`\`${cmd.join(" ")}\` failed (exit ${r.exitCode})`);
}

const HOST = process.arch;
if (HOST !== "arm64" && HOST !== "x64") fail(`unsupported build machine arch ${HOST}`);

// --- 1) the other arch's addon packages, pinned by bun.lock ---------------------------------------------------

function installedVersion(dir: string): string | null {
  try {
    const pkg: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    return pkg && typeof pkg === "object" && "version" in pkg && typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

async function installTwin(p: LockPackage): Promise<void> {
  const dest = join(REPO, installDir(p));
  if (installedVersion(dest) === p.version) {
    console.log(`  ${p.name}@${p.version} present`);
    return;
  }
  const url = tarballUrl(p);
  const res = await fetch(url);
  if (!res.ok) fail(`download failed: HTTP ${res.status} for ${url}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const got = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  if (got !== p.integrity) fail(`integrity MISMATCH for ${p.name}@${p.version}\n  bun.lock ${p.integrity}\n  got      ${got}`);
  const tmp = mkdtempSync(join(tmpdir(), "lucid-twin-"));
  try {
    writeFileSync(join(tmp, "a.tgz"), bytes);
    run(["tar", "xzf", "a.tgz"], tmp);
    const root = join(tmp, "package");
    if (!existsSync(join(root, "package.json"))) fail(`${url} has no package/package.json`);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(root, dest, { recursive: true });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`  ${p.name}@${p.version} installed (sha512 matches bun.lock)`);
}

console.log(`stage-mac: other-arch addon packages (build machine is ${HOST})`);
const lock = parseBunLockPackages(readFileSync(join(REPO, "bun.lock"), "utf8"));
const { twins, problems } = darwinTwins(lock, HOST, (p) => existsSync(join(REPO, installDir(p))));
if (problems.length) fail(`cannot give both mac apps their own addons:\n  ${problems.join("\n  ")}`);
if (!twins.some((t) => t.host.name.startsWith("@oh-my-pi/pi-natives-darwin-"))) {
  fail("bun.lock pairs no @oh-my-pi/pi-natives-darwin-* package; did `bun install` run at the repo root?");
}
for (const { twin } of twins) await installTwin(twin);

// --- 2) per-arch binaries ----------------------------------------------------------------------------------

/** Mach-O arch check on one staged file (through a symlink). */
function expectArch(file: string, arch: MacArch): string {
  if (!existsSync(file)) fail(`${file} was not produced`);
  const m = readMachO(file);
  if (!m) fail(`${file} is not a Mach-O binary`);
  if (!machRunsOn(m, arch)) fail(`${file} is ${describeMachO(m)}, not ${arch}`);
  return describeMachO(m);
}

for (const arch of MAC_ARCHS) {
  const rel = `bin-darwin-${arch}`;
  const out = join(REPO, rel);
  console.log(`\nstage-mac: ${rel}/`);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const target = `--target=bun-darwin-${arch}`;
  run([BUN, "build", "--compile", target, "../harness/launcher/lucid_acp.ts", "--outfile", join(out, "lucid")], DESKTOP);
  run([BUN, "build", "--compile", target, "dev.ts", "--outfile", join(out, "lucid-engine"), "--external", "*.node", "--external", "omp-legacy-pi-modules"], DESKTOP);
  run([BUN, "run", "build/build-holder.ts", `--target=${RUST_TRIPLE[arch]}`, `--outdir=${rel}`], DESKTOP);
  run([BUN, "run", "build/copy-natives.ts", "--platform=darwin", `--arch=${arch}`, `--outdir=${rel}`], DESKTOP);

  const natives = readdirSync(out).filter((f) => f.startsWith(`pi_natives.darwin-${arch}`) && f.endsWith(".node"));
  if (!natives.length) fail(`no pi_natives.darwin-${arch}*.node in ${rel}/`);
  for (const name of ["lucid", "lucid-engine", "lucid-holder", ...natives]) {
    console.log(`  ${arch.padEnd(5)} ${rel}/${name}  ${expectArch(join(out, name), arch)}`);
  }
}

// --- 3) bin/ serves both apps: no per-arch binary may remain there --------------------------------------------
// The shared `repo` extraResources still packs bin/**, and a stale host-arch lucid-engine there (a local
// compile-engine run) would land in repo/bin of BOTH apps beside the per-arch copy. Remove those names.
const BIN = join(REPO, "bin");
if (existsSync(BIN)) {
  for (const name of readdirSync(BIN)) {
    const perArch = ["lucid", "lucid-engine", "lucid-holder"].includes(name) || (name.startsWith("pi_natives.darwin-") && name.endsWith(".node"));
    if (!perArch) continue;
    const p = join(BIN, name);
    if (lstatSync(p).isDirectory()) continue;
    rmSync(p, { force: true });
    console.log(`stage-mac: removed bin/${name} (per-arch on macOS; bin-darwin-<arch>/ carries it)`);
  }
}
console.log("\nstage-mac: both arches staged");
