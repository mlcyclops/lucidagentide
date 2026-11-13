#!/usr/bin/env bun
// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Stage the Herd add-on (ADR-0541) for the packer (tools/build_plugin.ts, ADR-0462):
//   bun plugins/herd/stage.ts <outDir>
// writes exactly four files into a fresh <outDir>:
//   server.js          entry.main. The IDE's plugin runtime runs it under Electron's Node (runtime.ts
//                      asNode), so it is built for Node as CommonJS and holds Node code only
//                      (src/runtime_host.ts: /healthz, and instance main run under the IDE's bun).
//   client.js          the terminal client and the hub server (src/cli.ts), built for Bun. Its npm
//                      packages stay EXTERNAL: pi-tui loads a native addon from beside its own
//                      package, so client.js loads the IDE's copies through NODE_PATH (`lucid herd`
//                      and the runtime host set it to the IDE's node_modules), the same ones the
//                      classic hub runs on. The core hub modules it uses are bundled in.
//   lucid-plugin.json  plugins/herd/lucid-plugin.json, validated, without `files` (the packer adds it).
//   LICENSE            plugins/herd/LICENSE.
// then: bun tools/build_plugin.ts --src <outDir> --out <dir> [--unsigned]

import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PLUGIN_LICENSE, PLUGIN_MANIFEST, validatePluginManifest } from "../../harness/plugins/package.ts";

const HERE = import.meta.dir;

async function bundle(entry: string, target: "node" | "bun", format: "cjs" | "esm"): Promise<string> {
  const built = await Bun.build({ entrypoints: [join(HERE, "src", entry)], target, format, packages: "external", minify: false });
  if (!built.success) throw new Error(built.logs.map(String).join("\n"));
  // One entry, no splitting: anything more (a chunk, an asset) would be a file the package does not name.
  if (built.outputs.length !== 1) throw new Error(`${entry} built to ${built.outputs.length} files; the package carries exactly one per entry`);
  return built.outputs[0]!.text();
}

/** Stage into `outDir` (emptied first). Returns the staged file names. */
export async function stageHerd(outDir: string): Promise<string[]> {
  const manifest: unknown = JSON.parse(readFileSync(join(HERE, PLUGIN_MANIFEST), "utf8"));
  const check = validatePluginManifest(manifest, { requireFiles: false });
  if (!check.ok) throw new Error(`${PLUGIN_MANIFEST}: ${check.reason}`);
  if (check.manifest.files !== undefined) throw new Error(`${PLUGIN_MANIFEST} must not carry a files map; the packer writes it`);
  const server = await bundle("server.ts", "node", "cjs");
  const client = await bundle("client.ts", "bun", "esm");
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "server.js"), server);
  writeFileSync(join(outDir, "client.js"), client);
  writeFileSync(join(outDir, PLUGIN_MANIFEST), JSON.stringify(check.manifest, null, 2) + "\n");
  copyFileSync(join(HERE, PLUGIN_LICENSE), join(outDir, PLUGIN_LICENSE));
  return ["server.js", "client.js", PLUGIN_MANIFEST, PLUGIN_LICENSE];
}

if (import.meta.main) {
  const arg = process.argv[2];
  if (!arg) {
    process.stderr.write("usage: bun plugins/herd/stage.ts <outDir>\n");
    process.exit(2);
  }
  const outDir = resolve(arg);
  try {
    const files = await stageHerd(outDir);
    process.stdout.write(`staged herd in ${outDir}: ${files.join(", ")}\nnext: bun tools/build_plugin.ts --src "${outDir}" --out <dir> [--unsigned]\n`);
  } catch (e) {
    process.stderr.write(`stage: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
}
