// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// tools/build_addons.ts - ADR-0541: stage, pack and sign the optional add-ons a build OFFERS.
//
// An offered add-on (Herd) is never installed by setup. The build places each signed package in
// desktop/addons/ (shipped as electron-builder extraResources `addons`) beside addons/index.json,
// `{ id, version, file, sha256 }[]`. The Plugins drawer's Install button is the only thing that installs it,
// through POST /api/plugins/install-offered, which refuses an id the index does not name, a package whose
// sha256 differs from the index, and an unsigned package.
//
// Per add-on: `bun <stage script> <dir>` writes the plugin stage, tools/build_plugin.ts packs it, and then it
// is signed one of two ways: `--key <path>` (default: the publisher key at its usual path, when it exists)
// signs while packing, or `--sign-cmd <cmd>` runs a command over the packed file (`{file}` is replaced by its
// path, or the path is appended) that must leave the package signed in place. Either way the package must
// verify against the publisher key baked into this IDE before it is indexed, or the build fails. With no key
// and no sign command the index is empty: the card then says Not in this build, and no unsigned code ships.
//
// Usage:
//   bun tools/build_addons.ts [--out <dir>] [--key <path> | --sign-cmd <cmd>]

import type { KeyObject } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sha256Bytes, type TrustedPackKey } from "../harness/kb/pack.ts";
import { readAllZipEntries } from "../harness/personal/unzip.ts";
import { ADDONS_INDEX, verifyPluginEntries, type OfferedAddon } from "../harness/plugins/package.ts";
import { trustedPluginKeys } from "../harness/plugins/publisher_key.ts";
import { DEFAULT_KEY_PATH, MAX_PACKAGE_BYTES, buildPlugin, loadPrivateKey } from "./build_plugin.ts";

const REPO = resolve(import.meta.dir, "..");
export const DEFAULT_OUT = join(REPO, "desktop", "addons");

/** One add-on a build offers: its id, and the repo-relative script that writes its plugin stage. */
export interface AddonSpec { id: string; stage: string }

/** Every optional add-on the IDE offers (ADR-0541). */
export const ADDONS: readonly AddonSpec[] = [{ id: "herd", stage: "plugins/herd/stage.ts" }];

export interface AddonsArgs { out?: string; key?: string; signCmd?: string; help: boolean }

/** Pure argument parser. Unknown flags throw (fail loud rather than silently mis-build). */
export function parseAddonsArgs(argv: string[]): AddonsArgs {
  const a: AddonsArgs = { help: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!;
    const value = (): string => { const v = argv[++i]; if (v == null) throw new Error(`${t} needs a value`); return v; };
    if (t === "--help" || t === "-h") a.help = true;
    else if (t === "--out") a.out = value();
    else if (t === "--key") a.key = value();
    else if (t === "--sign-cmd") a.signCmd = value();
    else throw new Error(`unknown argument: ${t}`);
  }
  if (a.key && a.signCmd) throw new Error("--key and --sign-cmd are two ways to sign; pass one");
  return a;
}

/** Split a sign command into argv (double quotes group, no shell) and put the package path where `{file}`
 *  is, or at the end when no argument names it. Pure. */
export function signCommandArgv(cmd: string, file: string): string[] {
  const parts: string[] = [];
  let cur = "", quoted = false, started = false;
  for (const ch of cmd) {
    if (ch === "\"") { quoted = !quoted; started = true; continue; }
    if (!quoted && /\s/.test(ch)) { if (started) parts.push(cur); cur = ""; started = false; continue; }
    cur += ch;
    started = true;
  }
  if (quoted) throw new Error("--sign-cmd has an unclosed quote");
  if (started) parts.push(cur);
  if (!parts.length) throw new Error("--sign-cmd is empty");
  return parts.some((p) => p.includes("{file}")) ? parts.map((p) => p.replaceAll("{file}", file)) : [...parts, file];
}

export interface BuildAddonsOpts {
  out: string;
  addons?: readonly AddonSpec[];
  /** Signs while packing. */
  privateKey?: KeyObject;
  /** Signs the packed file in place (see signCommandArgv). */
  signCmd?: string;
  /** The keys the shipped IDE trusts; default: the publisher key baked into this build. */
  trusted?: TrustedPackKey[];
  /** Write the plugin stage for `spec` into `dir`; default: `bun <repo>/<spec.stage> <dir>`. */
  stage?: (spec: AddonSpec, dir: string) => void;
  /** Run one command; returns its exit code. Default: Bun.spawnSync with inherited output. */
  run?: (argv: string[]) => number;
}

export interface BuildAddonsResult { index: OfferedAddon[]; skipped: string | null }

function spawnStage(spec: AddonSpec, dir: string): void {
  const p = Bun.spawnSync([process.execPath, join(REPO, spec.stage), dir], { stdout: "inherit", stderr: "inherit" });
  if (p.exitCode !== 0) throw new Error(`${spec.id}: ${spec.stage} exited with ${p.exitCode}`);
}

function spawnRun(argv: string[]): number {
  return Bun.spawnSync(argv, { stdout: "inherit", stderr: "inherit" }).exitCode ?? 1;
}

/** Stage, pack, sign and verify every add-on, then write the index. The index is written empty first, so a
 *  failed build never leaves an index naming a package that did not pass. */
export function buildAddons(opts: BuildAddonsOpts): BuildAddonsResult {
  const out = resolve(opts.out);
  mkdirSync(out, { recursive: true });
  for (const n of readdirSync(out)) if (n === ADDONS_INDEX || n.endsWith(".lplugin.zip")) rmSync(join(out, n), { force: true });
  const indexPath = join(out, ADDONS_INDEX);
  writeFileSync(indexPath, "[]\n");
  if (!opts.privateKey && !opts.signCmd) return { index: [], skipped: "no publisher key and no sign command: no add-on is offered in this build" };

  const trusted = opts.trusted ?? trustedPluginKeys();
  const index: OfferedAddon[] = [];
  for (const spec of opts.addons ?? ADDONS) {
    const stageDir = mkdtempSync(join(tmpdir(), `lucid-addon-${spec.id}-`));
    try {
      (opts.stage ?? spawnStage)(spec, stageDir);
      const built = buildPlugin({ src: stageDir, out, privateKey: opts.privateKey });
      if (built.manifest.id !== spec.id) throw new Error(`${spec.stage} staged "${built.manifest.id}", not "${spec.id}"`);
      if (opts.signCmd) {
        const code = (opts.run ?? spawnRun)(signCommandArgv(opts.signCmd, built.zipPath));
        if (code !== 0) throw new Error(`${spec.id}: the sign command exited with ${code}`);
      }
      const bytes = readFileSync(built.zipPath);
      const check = verifyPluginEntries(readAllZipEntries(bytes, { maxTotalBytes: MAX_PACKAGE_BYTES }), { expectId: spec.id, trusted });
      if (!check.ok) throw new Error(`${spec.id}: refused at the ${check.gate} gate: ${check.reason}`);
      if (!check.signed) throw new Error(`${spec.id}: the package is not signed by a publisher key this IDE trusts; an offered add-on is never shipped unsigned`);
      const file = `${check.manifest.id}-${check.manifest.version}.lplugin.zip`;
      if (join(out, file) !== built.zipPath) throw new Error(`${spec.id}: expected the package at ${join(out, file)}`);
      index.push({ id: spec.id, version: check.manifest.version, file, sha256: sha256Bytes(bytes) });
    } finally {
      rmSync(stageDir, { recursive: true, force: true });
    }
  }
  writeFileSync(indexPath, JSON.stringify(index, null, 2) + "\n");
  return { index, skipped: null };
}

const USAGE = `build_addons - the optional add-ons a build offers (ADR-0541)

  bun tools/build_addons.ts [--out <dir>] [--key <path>]
      Stage and pack every add-on, signed with the publisher key (default ${DEFAULT_KEY_PATH},
      when it exists), into --out (default ${DEFAULT_OUT}) with index.json.

  bun tools/build_addons.ts [--out <dir>] --sign-cmd <cmd>
      The same, packed unsigned and then signed in place by <cmd> ({file} is the package path).

  With no key and no sign command, index.json is [] and the IDE's add-on cards say Not in this build.`;

function main(): void {
  const a = parseAddonsArgs(process.argv.slice(2));
  if (a.help) { console.log(USAGE); return; }
  const keyPath = a.key ? resolve(a.key) : !a.signCmd && existsSync(DEFAULT_KEY_PATH) ? DEFAULT_KEY_PATH : null;
  const r = buildAddons({ out: a.out ?? DEFAULT_OUT, privateKey: keyPath ? loadPrivateKey(keyPath) : undefined, signCmd: a.signCmd });
  if (r.skipped) { console.log(`build_addons: ${r.skipped}`); return; }
  for (const row of r.index) console.log(`offered ${row.id} ${row.version} ${row.file} sha256 ${row.sha256}`);
}

if (import.meta.main) {
  try { main(); } catch (e) { console.error(`build_addons: ${(e as Error).message}`); process.exitCode = 1; }
}
