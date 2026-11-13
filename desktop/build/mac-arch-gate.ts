// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/build/mac-arch-gate.ts - #614 (ADR-0569): every native binary a packed mac app ships runs on that
// app's CPU.
//
// v2.5.4-beta.1's LucidAgent-mac-x64.zip carried an arm64 repo/bin/lucid-engine, bin/lucid and pi_natives addon,
// so an Intel Mac could not start the engine. Every gate passed: the air-gap smoke runs on the arm64 runner and
// only opens the arm64 app, and the identity gate reads names and versions, not CPUs. This gate opens BOTH
// packed apps (electron-builder's `mac-arm64/` and `mac/` trees, which the zips and pkgs are made from) and reads
// the Mach-O header of every file in them (build/macho.ts):
//
//   strict: repo/bin/** and runtimes/bun must run on the app's arch, whatever they are named. These are what the
//           app execs by fixed path (resolveEngineSpawn, holderBinary(), the IDE extensions' bin/lucid, herd).
//   rest:   repo/**, runtimes/**, whisper/**: a binary for the other arch is allowed only when its path names
//           that arch (runtimes/python-darwin-arm64/..., node_modules/@img/sharp-darwin-arm64/...), i.e. an
//           arch-keyed copy the app selects by process.arch and never runs here.
//
// Required present, per app: repo/bin/{lucid, lucid-engine, lucid-holder, lucid-sep}, a pi_natives.darwin-<arch>
// addon beside them, runtimes/{bun, bun-darwin-<arch>, uv-darwin-<arch>} and the pi-natives-darwin-<arch>
// package in repo/node_modules; the other arch's pi_natives must be absent from repo/bin. A missing app tree, a
// dangling link in repo/bin or an unreadable header fails the gate: it fails closed, never skips.
//
// Run with: bun run build/mac-arch-gate.ts   (cwd = desktop/, after dist:mac)
// Env: LUCID_RELEASE_DIR=<name>  bare output-dir NAME under desktop/ (default `release`; Creator: release-creator)

import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { otherArch } from "./darwin_packages.ts";
import { describeMachO, MAC_ARCHS, type MacArch, type MachO, machVerdict, readMachO } from "./macho.ts";
import { appOutDirName, resourceDirsIn } from "./packaged_tree.ts";

const DESKTOP = join(import.meta.dir, "..");
const releaseName = process.env.LUCID_RELEASE_DIR ?? "release";
if (!/^[A-Za-z0-9._-]+$/.test(releaseName) || releaseName.startsWith(".")) {
  console.error(`mac-arch-gate: LUCID_RELEASE_DIR must be a bare directory name under desktop/, got "${releaseName}"`);
  process.exit(1);
}
const RELEASE = join(DESKTOP, releaseName);

const problems: string[] = [];
const rows: string[] = [];
const posix = (p: string): string => p.split(sep).join("/");

/** Check one required file: present (through links), Mach-O, runs on `arch`. */
function required(res: string, rel: string, arch: MacArch): void {
  const file = join(res, rel);
  if (!existsSync(file)) {
    problems.push(`${arch}: ${rel} is missing`);
    return;
  }
  try {
    const m = readMachO(file);
    if (!m) {
      problems.push(`${arch}: ${rel} is not a Mach-O binary`);
      return;
    }
    const verdict = machVerdict(rel, m, arch, true);
    rows.push(`  ${arch.padEnd(5)} ${verdict === "match" ? "ok  " : "FAIL"} ${describeMachO(m).padEnd(22)} ${rel}`);
    if (verdict !== "match") problems.push(`${arch}: ${rel} is ${describeMachO(m)}`);
  } catch (e) {
    problems.push(`${arch}: ${rel} cannot be read: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Walk `dir` (no descent through directory links) and judge every Mach-O file in it. */
function scan(res: string, dir: string, arch: MacArch, counts: { files: number; macho: number; keyed: number }): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const p = join(dir, name);
    const rel = posix(relative(res, p));
    const strict = rel.startsWith("repo/bin/") || rel === "runtimes/bun";
    const l = lstatSync(p);
    if (l.isDirectory()) {
      scan(res, p, arch, counts);
      continue;
    }
    let isFile = l.isFile();
    if (l.isSymbolicLink()) {
      try {
        isFile = statSync(p).isFile();
      } catch {
        if (strict) problems.push(`${arch}: ${rel} is a dangling link`);
        continue;
      }
    }
    if (!isFile) continue;
    counts.files++;
    let m: MachO | null;
    try {
      m = readMachO(p);
    } catch (e) {
      problems.push(`${arch}: ${rel} cannot be read: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (!m) continue;
    counts.macho++;
    const verdict = machVerdict(rel, m, arch, strict);
    if (verdict === "keyed-other-arch") counts.keyed++;
    else if (verdict === "mismatch") problems.push(`${arch}: ${rel} is ${describeMachO(m)}${strict ? "" : " and its path does not name another arch"}`);
  }
}

console.log("== #614 (ADR-0569): mac arch gate ==\n");
console.log(`  release dir  desktop/${releaseName}\n`);

for (const arch of MAC_ARCHS) {
  const other = otherArch(arch);
  const appOut = join(RELEASE, appOutDirName("darwin", arch));
  const resDirs = resourceDirsIn(appOut);
  if (resDirs.length !== 1) {
    problems.push(`${arch}: expected exactly one .app/Contents/Resources under desktop/${releaseName}/${appOutDirName("darwin", arch)}, found ${resDirs.length}`);
    continue;
  }
  const res = resDirs[0]!;
  console.log(`  ${arch}: ${posix(relative(DESKTOP, res))}`);

  for (const rel of ["repo/bin/lucid", "repo/bin/lucid-engine", "repo/bin/lucid-holder", "repo/bin/lucid-sep", "runtimes/bun", `runtimes/bun-darwin-${arch}`, `runtimes/uv-darwin-${arch}`]) {
    required(res, rel, arch);
  }
  const bin = join(res, "repo", "bin");
  const binNames = existsSync(bin) ? readdirSync(bin) : [];
  const own = binNames.filter((f) => f.startsWith(`pi_natives.darwin-${arch}`) && f.endsWith(".node"));
  if (!own.length) problems.push(`${arch}: no pi_natives.darwin-${arch}*.node in repo/bin`);
  for (const f of own) required(res, `repo/bin/${f}`, arch);
  for (const f of binNames.filter((n) => n.startsWith(`pi_natives.darwin-${other}`))) problems.push(`${arch}: repo/bin/${f} is the ${other} addon`);
  const pkgRel = `repo/node_modules/@oh-my-pi/pi-natives-darwin-${arch}`;
  const pkgAddons = existsSync(join(res, pkgRel)) ? readdirSync(join(res, pkgRel)).filter((f) => f.endsWith(".node")) : [];
  if (!pkgAddons.length) problems.push(`${arch}: no addon in ${pkgRel}`);
  for (const f of pkgAddons) required(res, `${pkgRel}/${f}`, arch);

  const counts = { files: 0, macho: 0, keyed: 0 };
  for (const top of ["repo", "runtimes", "whisper"]) scan(res, join(res, top), arch, counts);
  rows.push(`  ${arch.padEnd(5)} scanned ${counts.files} files: ${counts.macho} Mach-O, ${counts.keyed} of them keyed to ${other} by path`);
}

console.log("");
for (const r of rows) console.log(r);
if (problems.length) {
  console.error(`\nmac-arch-gate: ${problems.length} problem${problems.length === 1 ? "" : "s"}; a mac app would ship a binary its CPU cannot run:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log("\nmac-arch-gate passed: every Mach-O in both mac apps runs on its app's arch (or is keyed to the other by path).\n");
