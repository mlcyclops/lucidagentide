// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// tools/build_world.ts - P-WORLDS.1 (ADR-0648): the Lucid Agent World packer.
//
// A world source folder holds `world.json` ({ id: "world-<key>", version, name, description, apiVersion }),
// `src/index.ts` (default export `(host: WorldHost) => WorldDefinition`, desktop/renderer/viz_world_api.ts) and an
// optional `assets/` folder. This tool:
//   bundles src/index.ts with Bun.build (esm, browser, minified, one file) into a stage folder as world.js, with
//   "three" kept EXTERNAL so a runtime import of it survives and is caught: the build FAILS when the bundle
//   imports "three" or any other bare specifier (the renderer resolves none; a world uses host.THREE) ->
//   copies assets/ -> writes LICENSE (the LUCID Premium Plugin License) and lucid-plugin.json (kind world,
//   premium, civilian, entry.module world.js, every payload file's sha256) -> signs and zips through
//   tools/build_plugin.ts buildPlugin, which re-reads the zip through the installer's own gate.
//
// Usage:
//   bun tools/build_world.ts --src <world dir> --out <dir> [--key <ed25519 private key path>]

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sha256Bytes } from "../harness/kb/pack.ts";
import { PLUGIN_LICENSE, PLUGIN_MANIFEST } from "../harness/plugins/package.ts";
import { DEFAULT_KEY_PATH, buildPlugin, listStageFiles, loadPrivateKey, type BuildResult } from "./build_plugin.ts";
import type { KeyObject } from "node:crypto";

export const WORLD_MODULE = "world.js";
export const WORLD_PUBLISHER = "TECHLEAD 187 LLC";
export const WORLD_LICENSE_ID = "LUCID-Premium-Plugin-1.0";
const WORLD_ID_RE = /^world-[a-z0-9][a-z0-9-]{0,40}$/;
const VERSION_RE = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,40})?$/;

/** The LUCID Premium Plugin License (LUCID-Premium-Plugin-1.0, published at /legal/plugins), shipped as LICENSE. */
export const PREMIUM_LICENSE_TEXT = `LUCID Premium Plugin License
Identifier: LUCID-Premium-Plugin-1.0

Copyright (c) 2026 TECHLEAD 187 LLC. All rights reserved.

Each LUCID premium plugin (the "Software") is proprietary software owned by TECHLEAD 187 LLC
("Licensor") and distributed as a premium plugin for the LUCID Agent platform.
The Software is licensed, not sold.

1. License grant. Subject to these terms and to payment of the applicable fee, or to a grant of access
made by Licensor, Licensor grants you a perpetual, non-exclusive, non-transferable, non-sublicensable
license to install and run the Software for your own use, inside the LUCID Agent platform, on devices you
own or control and that are signed in to your LUCID Agent account.

2. Restrictions. Except as this license expressly permits or applicable law allows despite this
limitation, you may not:
  (a) copy, modify, translate, or create derivative works of the Software;
  (b) sell, resell, rent, lease, lend, sublicense, distribute, publish, or otherwise make the Software
      available to any third party, including as a hosted or managed service;
  (c) reverse engineer, decompile, or disassemble the Software, or attempt to derive its source code;
  (d) remove, alter, or circumvent any license check, entitlement check, signature, or proprietary
      notice in the Software;
  (e) share your license or account access with another person.

3. Ownership. Licensor and its licensors keep all right, title, and interest in the Software, including
all intellectual property rights. No rights are granted other than those expressly stated in this license.

4. Updates. Licensor may provide updates through the LUCID Agent plugin marketplace. Updates are covered
by this license unless they come with different terms.

5. Third-party components. The Software includes open-source components that are licensed under their
own terms. Those terms apply to those components only and do not grant any rights in the rest of the
Software.

6. Termination. This license ends automatically if you breach it. When it ends, you must stop using the
Software and delete every copy. Sections 2, 3, 7, 8, and 9 survive termination.

7. No warranty. THE SOFTWARE IS PROVIDED "AS IS" AND "AS AVAILABLE", WITHOUT WARRANTY OF ANY KIND, EXPRESS
OR IMPLIED, INCLUDING WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND
NON-INFRINGEMENT.

8. Limitation of liability. TO THE MAXIMUM EXTENT PERMITTED BY LAW, LICENSOR WILL NOT BE LIABLE FOR ANY
INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR FOR ANY LOSS OF DATA, PROFITS, OR
REVENUE. LICENSOR'S TOTAL LIABILITY UNDER THIS LICENSE WILL NOT EXCEED THE AMOUNT YOU PAID FOR THE SOFTWARE.

9. Governing law. This license is governed by the laws of the State of Florida, without regard to its
conflict-of-laws rules.

Questions about licensing: nick@techlead187.com
`;

/** A world source folder's `world.json`. */
export interface WorldSource { id: string; version: string; name: string; description: string; apiVersion: number }

/** Validate `world.json`. Pure; throws with the first problem. */
export function parseWorldJson(raw: unknown): WorldSource {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("world.json is not a JSON object");
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !WORLD_ID_RE.test(r.id)) throw new Error('world.json id must be "world-<key>" (lowercase letters, digits, dashes)');
  if (typeof r.version !== "string" || !VERSION_RE.test(r.version)) throw new Error("world.json version must be MAJOR.MINOR.PATCH");
  if (typeof r.name !== "string" || !r.name.trim() || r.name.length > 200) throw new Error("world.json name is required (max 200)");
  if (typeof r.description !== "string" || !r.description.trim() || r.description.length > 2000) throw new Error("world.json description is required (max 2000)");
  if (typeof r.apiVersion !== "number" || !Number.isInteger(r.apiVersion) || r.apiVersion < 1) throw new Error("world.json apiVersion must be a positive integer (viz_world_api.ts WORLD_API_VERSION)");
  return { id: r.id, version: r.version, name: r.name.trim(), description: r.description.trim(), apiVersion: r.apiVersion };
}

/** The staged `lucid-plugin.json` of a world. Pure. `files` maps every payload path to its sha256. */
export function worldManifest(w: WorldSource, files: Record<string, string>): Record<string, unknown> {
  return {
    schema: 1, id: w.id, name: w.name, description: w.description, version: w.version,
    publisher: WORLD_PUBLISHER, license: WORLD_LICENSE_ID, tier: "premium", section: "civilian",
    kind: "world", entry: { module: WORLD_MODULE }, apiVersion: w.apiVersion, files,
  };
}

const IMPORT_RES = [
  // import x from "s" / import {a as b} from"s" / import*as t from"s" / import"s" / export * from "s" / export {a} from "s"
  /\b(?:import|export)\s*(?:[\w*${}\s,]+?\s*from\s*)?["'`]([^"'`\n]+)["'`]/g,
  // import("s")
  /\bimport\s*\(\s*["'`]([^"'`\n]+)["'`]\s*\)/g,
];

/** Every bare module specifier (not ./, ../, / or a URL) an ES module imports. Pure. A world bundle must have
 *  none: the renderer resolves no package names, and three.js comes from host.THREE. */
export function findBareImports(js: string): string[] {
  const out = new Set<string>();
  for (const re of IMPORT_RES) {
    for (const m of js.matchAll(re)) {
      const spec = m[1]!;
      if (/^(?:\.{1,2}\/|\/|[a-z][a-z0-9+.-]*:)/i.test(spec)) continue;
      out.add(spec);
    }
  }
  return [...out].sort();
}

/** Bundle src/index.ts into one minified browser ES module. "three" stays external so a runtime import of it is
 *  caught by findBareImports instead of silently bundling a second copy of three.js. */
export async function bundleWorld(entry: string): Promise<string> {
  const out = await Bun.build({ entrypoints: [entry], format: "esm", target: "browser", minify: true, splitting: false, external: ["three", "three/*"] });
  if (!out.success) throw new Error(`bundle failed:\n${out.logs.map((l) => String(l)).join("\n")}`);
  if (out.outputs.length !== 1) throw new Error(`the bundle must be one file; it emitted ${out.outputs.length} (import assets at runtime from assets/ instead)`);
  const js = await out.outputs[0]!.text();
  const bare = findBareImports(js);
  if (bare.length) throw new Error(`the bundle imports ${bare.map((s) => JSON.stringify(s)).join(", ")}; a world must not import "three" or any package at runtime (use host.THREE and host.kit; type-only imports are fine)`);
  return js;
}

/** Build `<id>-<version>.lplugin.zip` from a world source folder. `privateKey` is required (a world is premium). */
export async function buildWorld(opts: { src: string; out: string; privateKey?: KeyObject }): Promise<BuildResult> {
  const src = resolve(opts.src);
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(join(src, "world.json"), "utf8")); }
  catch (e) { throw new Error(`${join(src, "world.json")}: ${(e as Error).message}`); }
  const world = parseWorldJson(raw);
  const entry = join(src, "src", "index.ts");
  if (!existsSync(entry)) throw new Error(`${entry} is missing`);
  const js = await bundleWorld(entry);

  const stage = mkdtempSync(join(tmpdir(), "lucid-world-stage-"));
  try {
    writeFileSync(join(stage, WORLD_MODULE), js);
    const assets = join(src, "assets");
    if (existsSync(assets)) {
      if (!statSync(assets).isDirectory()) throw new Error(`${assets} is not a folder`);
      cpSync(assets, join(stage, "assets"), { recursive: true }); // a symlink stays a link, which listStageFiles refuses
    }
    writeFileSync(join(stage, PLUGIN_LICENSE), PREMIUM_LICENSE_TEXT);
    const files: Record<string, string> = {};
    for (const rel of listStageFiles(stage)) files[rel] = sha256Bytes(readFileSync(join(stage, rel)));
    writeFileSync(join(stage, PLUGIN_MANIFEST), JSON.stringify(worldManifest(world, files), null, 2));
    return buildPlugin({ src: stage, out: opts.out, privateKey: opts.privateKey });
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

export interface WorldArgs { src?: string; out?: string; key?: string; help: boolean }

/** Pure argument parser. Unknown flags throw. */
export function parseWorldArgs(argv: string[]): WorldArgs {
  const a: WorldArgs = { help: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!;
    const value = (): string => { const v = argv[++i]; if (v == null) throw new Error(`${t} needs a value`); return v; };
    if (t === "--help" || t === "-h") a.help = true;
    else if (t === "--src") a.src = value();
    else if (t === "--out") a.out = value();
    else if (t === "--key") a.key = value();
    else throw new Error(`unknown argument: ${t}`);
  }
  return a;
}

const USAGE = `build_world - the Lucid Agent World packer (ADR-0648)

  bun tools/build_world.ts --src <world dir> --out <dir> [--key <path>]
      Bundle <world dir>/src/index.ts to world.js (no runtime imports), copy assets/, write LICENSE and
      lucid-plugin.json (kind world), sign with the publisher key (default ${DEFAULT_KEY_PATH})
      and write <id>-<version>.lplugin.zip. See docs/WORLDS.md.`;

async function main(): Promise<void> {
  const a = parseWorldArgs(process.argv.slice(2));
  if (a.help || !a.src) { console.log(USAGE); return; }
  if (!a.out) throw new Error("--out is required");
  const keyPath = resolve(a.key ?? DEFAULT_KEY_PATH);
  if (!existsSync(keyPath)) throw new Error(`no publisher key at ${keyPath}: a world is premium and must be signed`);
  const r = await buildWorld({ src: a.src, out: a.out, privateKey: loadPrivateKey(keyPath) });
  console.log(`built ${r.zipPath}`);
  console.log(`  ${r.manifest.id} ${r.manifest.version}, ${r.files} files, ${r.bytes} bytes`);
  console.log(`  sha256 ${r.sha256}`);
  console.log(`  signed by ${r.keyId}`);
}

if (import.meta.main) {
  main().catch((e: unknown) => { console.error(`build_world: ${(e as Error).message}`); process.exitCode = 1; });
}
