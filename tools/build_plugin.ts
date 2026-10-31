// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// tools/build_plugin.ts - P-PLUGINS.2 (ADR-0462): the `.lplugin` packer.
//
// An app repo's `plugin:stage` script writes `plugin-stage/` holding `lucid-plugin.json` (WITHOUT `files`),
// `LICENSE` and the payload. This tool turns that directory into `<id>-<version>.lplugin.zip`:
//   validate the staged manifest (schema 1) -> sha256 every file into `files` -> canonical manifest ->
//   Ed25519 sign -> zip -> re-read the zip through the installer's own gate (a package this tool emits is
//   proven installable before it leaves the machine).
//
// KEYS. `--init-key` creates the publisher keypair ONCE at ~/.omp/keys/lucid-plugin-publisher.key (PKCS#8
// PEM, mode 0600, never in a repo) and bakes the PUBLIC half into harness/plugins/publisher_key.ts, the
// IDE's only trusted premium publisher. It never overwrites an existing private key. A premium plugin is
// never built unsigned; a free plugin is built unsigned only when no key file exists.
//
// Usage:
//   bun tools/build_plugin.ts --init-key [--key <path>]
//   bun tools/build_plugin.ts --src <plugin-stage dir> --out <dir> [--key <ed25519 private key path>]

import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { sha256Bytes } from "../harness/kb/pack.ts";
import { zipEntries } from "../harness/kb/zip.ts";
import { readAllZipEntries } from "../harness/personal/unzip.ts";
import {
  PLUGIN_MANIFEST, PLUGIN_SIGNATURE, safeRelPath, signPluginManifest, validatePluginManifest, verifyPluginEntries,
  canonicalPluginBytes, type PluginManifest,
} from "../harness/plugins/package.ts";
import { pluginKeyId } from "../harness/plugins/publisher_key.ts";

export const DEFAULT_KEY_PATH = join(homedir(), ".omp", "keys", "lucid-plugin-publisher.key");
export const BAKED_KEY_FILE = resolve(import.meta.dir, "..", "harness", "plugins", "publisher_key.ts");
/** The installer's ceiling, mirrored so the packer refuses what the IDE would refuse. */
export const MAX_PACKAGE_BYTES = 1024 * 1024 * 1024;

export interface BuildArgs { src?: string; out?: string; key?: string; initKey: boolean; help: boolean }

/** Pure argument parser. Unknown flags throw (fail loud rather than silently mis-build). */
export function parseArgs(argv: string[]): BuildArgs {
  const a: BuildArgs = { initKey: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!;
    const value = (): string => { const v = argv[++i]; if (v == null) throw new Error(`${t} needs a value`); return v; };
    if (t === "--help" || t === "-h") a.help = true;
    else if (t === "--init-key") a.initKey = true;
    else if (t === "--src") a.src = value();
    else if (t === "--out") a.out = value();
    else if (t === "--key") a.key = value();
    else throw new Error(`unknown argument: ${t}`);
  }
  return a;
}

/** Every regular file under `root` as a package-relative forward-slash path. Symlinks and anything that
 *  is not a plain file or folder are refused: a link could pull bytes from outside the stage. */
export function listStageFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const relPath = rel ? `${rel}/${name}` : name;
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) throw new Error(`symlinks are not allowed in a plugin stage: ${relPath}`);
      if (st.isDirectory()) walk(abs, relPath);
      else if (st.isFile()) out.push(relPath);
      else throw new Error(`not a regular file: ${relPath}`);
    }
  };
  walk(root, "");
  return out;
}

export function loadPrivateKey(path: string): KeyObject {
  const key = createPrivateKey(readFileSync(path));
  if (key.asymmetricKeyType !== "ed25519") throw new Error(`${path} is not an Ed25519 private key`);
  return key;
}

export interface BuildResult { zipPath: string; manifest: PluginManifest; signed: boolean; keyId?: string; sha256: string; bytes: number; files: number }

/** Build a package from a stage directory. `privateKey` absent builds unsigned, which is refused for premium. */
export function buildPlugin(opts: { src: string; out: string; privateKey?: KeyObject }): BuildResult {
  const src = resolve(opts.src);
  let staged: unknown;
  try { staged = JSON.parse(readFileSync(join(src, PLUGIN_MANIFEST), "utf8")); }
  catch (e) { throw new Error(`${join(src, PLUGIN_MANIFEST)}: ${(e as Error).message}`); }
  const pre = validatePluginManifest(staged, { requireFiles: false });
  if (!pre.ok) throw new Error(`${PLUGIN_MANIFEST}: ${pre.reason}`);
  if (pre.manifest.tier === "premium" && !opts.privateKey) throw new Error("premium plugins must be signed: no publisher key (run --init-key or pass --key)");

  const files: Record<string, string> = {};
  const payload: { name: string; data: Buffer }[] = [];
  const lower = new Set<string>();
  let total = 0;
  for (const rel of listStageFiles(src)) {
    if (rel === PLUGIN_MANIFEST || rel === PLUGIN_SIGNATURE) continue; // the packer writes both
    if (!safeRelPath(rel)) throw new Error(`unsafe file name in stage: ${rel}`);
    if (lower.has(rel.toLowerCase())) throw new Error(`two files differ only by case: ${rel}`);
    lower.add(rel.toLowerCase());
    const data = readFileSync(join(src, rel));
    total += data.length;
    if (total > MAX_PACKAGE_BYTES) throw new Error(`stage is larger than ${MAX_PACKAGE_BYTES} bytes`);
    files[rel] = sha256Bytes(data);
    payload.push({ name: rel, data });
  }

  const full = validatePluginManifest({ ...pre.manifest, files }, { requireFiles: true });
  if (!full.ok) throw new Error(`${PLUGIN_MANIFEST}: ${full.reason}`);
  const manifest = full.manifest;
  const entries: { name: string; data: Buffer }[] = [{ name: PLUGIN_MANIFEST, data: canonicalPluginBytes(manifest) }];
  let keyId: string | undefined;
  if (opts.privateKey) {
    entries.push({ name: PLUGIN_SIGNATURE, data: Buffer.from(signPluginManifest(manifest, opts.privateKey), "utf8") });
    keyId = pluginKeyId(createPublicKey(opts.privateKey).export({ type: "spki", format: "der" }));
  }
  entries.push(...payload);
  const zip = zipEntries(entries);

  // Round-trip through the installer's gate with the key that signed it: a package that would be refused
  // at install is refused here, before it is uploaded anywhere.
  const trusted = opts.privateKey ? [{ id: keyId!, key: createPublicKey(opts.privateKey) }] : [];
  const check = verifyPluginEntries(readAllZipEntries(zip, { maxTotalBytes: MAX_PACKAGE_BYTES }), { expectId: manifest.id, trusted });
  if (!check.ok) throw new Error(`self-check failed at the ${check.gate} gate: ${check.reason}`);

  mkdirSync(resolve(opts.out), { recursive: true });
  const zipPath = join(resolve(opts.out), `${manifest.id}-${manifest.version}.lplugin.zip`);
  writeFileSync(zipPath, zip);
  return { zipPath, manifest, signed: !!opts.privateKey, keyId, sha256: sha256Bytes(zip), bytes: zip.length, files: payload.length };
}

/** Rewrite the baked SPKI constant in harness/plugins/publisher_key.ts. Pure text transform. */
export function bakePublicKey(source: string, spkiB64: string): string {
  const re = /export const PLUGIN_PUBLISHER_SPKI_B64(: string)? = "[A-Za-z0-9+/=]*";/;
  if (!re.test(source)) throw new Error("publisher_key.ts no longer carries the PLUGIN_PUBLISHER_SPKI_B64 constant");
  return source.replace(re, `export const PLUGIN_PUBLISHER_SPKI_B64: string = "${spkiB64}";`);
}

/** Create the publisher keypair once (never overwrite) and bake its public half into the IDE. */
export function initPublisherKey(keyPath: string, bakeFile = BAKED_KEY_FILE): { created: boolean; keyId: string; spkiB64: string } {
  let created = false;
  mkdirSync(dirname(keyPath), { recursive: true });
  try { chmodSync(dirname(keyPath), 0o700); } catch { /* best effort on Windows */ }
  // Exclusive create ("wx") is the only existence check: no check-then-write window, never overwrites a key.
  try {
    const { privateKey } = generateKeyPairSync("ed25519");
    writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
    created = true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  const der = createPublicKey(loadPrivateKey(keyPath)).export({ type: "spki", format: "der" });
  const spkiB64 = der.toString("base64");
  writeFileSync(bakeFile, bakePublicKey(readFileSync(bakeFile, "utf8"), spkiB64));
  return { created, keyId: pluginKeyId(der), spkiB64 };
}

const USAGE = `build_plugin - the .lplugin packer (ADR-0462)

  bun tools/build_plugin.ts --init-key [--key <path>]
      Create the publisher Ed25519 key once (default ${DEFAULT_KEY_PATH})
      and bake its public half into harness/plugins/publisher_key.ts.

  bun tools/build_plugin.ts --src <plugin-stage dir> --out <dir> [--key <path>]
      Validate lucid-plugin.json (schema 1), hash every file, sign, and write <id>-<version>.lplugin.zip.`;

function main(): void {
  const a = parseArgs(process.argv.slice(2));
  if (a.help || (!a.initKey && !a.src)) { console.log(USAGE); return; }
  const keyPath = resolve(a.key ?? DEFAULT_KEY_PATH);
  if (a.initKey) {
    const r = initPublisherKey(keyPath);
    console.log(`${r.created ? "created" : "kept existing"} publisher key ${keyPath}`);
    console.log(`baked public key ${r.keyId} into ${BAKED_KEY_FILE}`);
    return;
  }
  if (!a.out) throw new Error("--out is required");
  const r = buildPlugin({ src: a.src!, out: a.out, privateKey: existsSync(keyPath) ? loadPrivateKey(keyPath) : undefined });
  console.log(`built ${r.zipPath}`);
  console.log(`  ${r.manifest.id} ${r.manifest.version} (${r.manifest.tier}, ${r.manifest.kind}), ${r.files} files, ${r.bytes} bytes`);
  console.log(`  sha256 ${r.sha256}`);
  console.log(`  ${r.signed ? `signed by ${r.keyId}` : "UNSIGNED (free plugin, no key file)"}`);
}

if (import.meta.main) {
  try { main(); } catch (e) { console.error(`build_plugin: ${(e as Error).message}`); process.exitCode = 1; }
}
