// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/build/fetch-mxc.ts - P-MXC.1 (ADR-0441 decision 6): stage the pinned Microsoft eXecution
// Container executors (`wxc-exec.exe`, `wxc-host-prep.exe`, per Windows arch) into desktop/mxc/<key>/,
// which electron-builder bundles into `<resources>/mxc/<key>/` (mxc_runtime.ts `resolveMxcDir`).
//
// Same supply-chain posture as fetch-whistle.ts: the npm tarball of the pinned SDK version is downloaded
// ONCE and checked against npm's sha512 integrity; only the pinned files are extracted, each checked by
// size + sha256 (fail-closed) before it is renamed into place. Nothing else from the 105 MB package
// (koffi, node-pty, the SDK JavaScript) is staged: the executor transport needs none of it.
//
// Usage: `bun run mxc` (from desktop/) stages every pinned platform for the installer;
//        `bun run mxc --dev` stages THIS host's platform into ~/.omp/mxc/<key> for `bun run dev.ts`.

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MXC_TARBALL_URL, mxcAssetsFor, mxcPlatformKey, type MxcPlatformKey } from "../../harness/runs/mxc_assets.ts";
import { mxcPlatformKeys, resolveMxcDir, stageMxcExecutors, verifiedMxcExecutors } from "../mxc_runtime.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const dev = process.argv.includes("--dev");
const keys: MxcPlatformKey[] = dev ? [mxcPlatformKey(process.platform, process.arch)].filter((k): k is MxcPlatformKey => !!k) : mxcPlatformKeys();
if (!keys.length) { console.error(`fetch-mxc: MXC executors are not pinned for ${process.platform}-${process.arch}`); process.exit(1); }

// One download serves every platform: cache the verified tarball beside the stage for this run.
const cacheDir = join(HERE, "..", "mxc", ".cache");
mkdirSync(cacheDir, { recursive: true });
const tgz = join(cacheDir, "mxc-sdk.tgz");
let tarball: string | undefined = existsSync(tgz) ? tgz : undefined;

for (const key of keys) {
  const out = dev ? join(homedir(), ".omp", "mxc", key) : join(HERE, "..", "mxc", key);
  if (!tarball) {
    // First platform: let the stager download + verify, then keep the tarball for the next one.
    const caching = (async (u: string | URL | Request) => { const res = await fetch(u); if (res.ok) { const b = new Uint8Array(await res.arrayBuffer()); await Bun.write(tgz, b); return new Response(b, { status: 200 }); } return res; }) as unknown as typeof fetch;
    const r = await stageMxcExecutors(out, key, { fetchImpl: caching });
    if (!r.ok) { console.error(`fetch-mxc: ${r.reason}`); process.exit(1); }
    tarball = existsSync(tgz) ? tgz : undefined;
    report(key, out, r.staged);
    continue;
  }
  const r = await stageMxcExecutors(out, key, { tarball });
  if (!r.ok) { console.error(`fetch-mxc: ${r.reason}`); process.exit(1); }
  report(key, out, r.staged);
}
console.log(`fetch-mxc: ${MXC_TARBALL_URL} -> ${keys.join(", ")}${dev ? " (dev stage under ~/.omp/mxc)" : ""}`);

function report(key: MxcPlatformKey, out: string, staged: string[]): void {
  const dir = resolveMxcDir({ env: { LUCID_MXC_DIR: out }, home: homedir(), platform: "win32", arch: key === "win32-x64" ? "x64" : "arm64", exists: existsSync });
  const v = dir ? verifiedMxcExecutors(dir, "win32", key === "win32-x64" ? "x64" : "arm64") : { ok: false as const, reason: "stage dir missing" };
  if (!v.ok) { console.error(`fetch-mxc: ${key}: ${v.reason}`); process.exit(1); }
  for (const s of mxcAssetsFor(key)) console.log(`fetch-mxc: ${key}/${s.name} ${s.bytes} bytes sha256 ${s.sha256} verified (${staged.includes(s.name) ? "extracted" : "already staged"})`);
}
