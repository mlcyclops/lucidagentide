// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/whistle_assets.ts - CREATOR-WHISTLE (ADR-0432 decision 1): WHICH Whistle / Needle files the
// engine runs, PINNED by URL + byte size + sha256. The three files (Emscripten glue, the wasm engine and
// the `.cact` model container) are staged into desktop/whistle/ by build/fetch-whistle.ts for the
// installer's extraResources, and into ~/.omp/whistle/ for dev runs by whistle_stage.ts. Both paths and
// the engine itself verify the SAME pins before the first `needle_load`: a mismatch is a named refusal,
// never a silent fallback. Bumping a pin is a reviewed decision (the wasm import table is pinned too, in
// harness/voice/whistle.test.ts).
//
// Pure + IO-free: the resolver takes an injected `exists` and env so it is unit-tested without a disk.

import { join } from "node:path";

export type WhistleAssetName = "needle.js" | "needle.wasm" | "whistle.cact";

export interface WhistleAssetSpec {
  readonly name: WhistleAssetName;
  readonly url: string; // exact download URL (HF `resolve/<commit>`, never a branch)
  readonly sha256: string; // committed hash, matched against the HF LFS OID
  readonly bytes: number; // asset size - the cheap pre-check before hashing
}

// Resolve by COMMIT, never `main`: Cactus replaces binaries in place ("Replace binaries from production
// build"), and on 2026-10-05 needle3's main moved needle.js to 63,072 bytes and needle.wasm to 923,348, so a
// `main` URL turned every fresh stage into a hash refusal. These revisions hold exactly the pinned bytes
// (needle3 c7c415a3, 2026-10-02; whistle b358ddad, 2026-10-02). A re-pin moves the revision AND the hashes.
const NEEDLE3_REVISION = "c7c415a3d1b3d929014bc6e866d51ebb971f7089";
const WHISTLE_REVISION = "b358ddadd89b7a713b5aa131f23032d3cca1b251";
const NEEDLE_WASM_BASE = `https://huggingface.co/Cactus-Compute/needle3/resolve/${NEEDLE3_REVISION}/wasm`;
const WHISTLE_BASE = `https://huggingface.co/Cactus-Compute/whistle/resolve/${WHISTLE_REVISION}`;

export const WHISTLE_ASSETS: readonly WhistleAssetSpec[] = [
  {
    name: "needle.js",
    url: `${NEEDLE_WASM_BASE}/needle.js`,
    sha256: "f3f7366dcad9555b792ee519d2518f3c506038bcb2ffd179e76e850000749359",
    bytes: 62823,
  },
  {
    name: "needle.wasm",
    url: `${NEEDLE_WASM_BASE}/needle.wasm`,
    sha256: "c19b9ddf9c7de4eb4f37e5f1811c5bbea9f099041d2a27284daf89789ee8523d",
    bytes: 903655,
  },
  {
    name: "whistle.cact",
    url: `${WHISTLE_BASE}/whistle.cact`,
    sha256: "b6e02f048568ac5d01a2042556c658061e699acbc0aa2a1439f52f3d461dffeb",
    bytes: 16919407,
  },
];

/** The model pin, recorded on every measured timeline as `alignedBy.modelSha256`. */
export const WHISTLE_MODEL_SHA256: string = WHISTLE_ASSETS.find((a) => a.name === "whistle.cact")?.sha256 ?? "";

export interface WhistleDirIO {
  resourcesPath?: string; // packaged app: `<resources>/whistle`
  stagedDir?: string; // dev runs: ~/.omp/whistle
  exists(path: string): boolean;
}

export interface WhistleDir {
  readonly dir: string;
  readonly source: "env" | "bundled" | "staged";
}

/** env LUCID_WHISTLE_DIR -> `<resourcesPath>/whistle` -> stagedDir. A dir counts only when all three
 *  files exist; a partially staged dir is skipped so the next candidate can still win. */
export function resolveWhistleDir(io: WhistleDirIO & { env: Record<string, string | undefined> }): WhistleDir | null {
  const candidates: WhistleDir[] = [];
  const fromEnv = io.env.LUCID_WHISTLE_DIR;
  if (fromEnv) candidates.push({ dir: fromEnv, source: "env" });
  if (io.resourcesPath) candidates.push({ dir: join(io.resourcesPath, "whistle"), source: "bundled" });
  if (io.stagedDir) candidates.push({ dir: io.stagedDir, source: "staged" });
  for (const candidate of candidates) {
    if (WHISTLE_ASSETS.every((spec) => io.exists(join(candidate.dir, spec.name)))) return candidate;
  }
  return null;
}

export type AssetVerdict = { ok: true } | { ok: false; reason: string };

/** Size first (cheap), then the sha256 the caller already computed over `bytes`. Pure: the hash is an
 *  input so the engine, the stager and the tests share one verdict without sharing a hasher. */
export function verifyWhistleAsset(spec: WhistleAssetSpec, bytes: Uint8Array, sha256Hex: string): AssetVerdict {
  if (bytes.length !== spec.bytes) {
    return { ok: false, reason: `${spec.name}: size mismatch (got ${bytes.length} bytes, pinned ${spec.bytes})` };
  }
  const got = sha256Hex.toLowerCase();
  if (got !== spec.sha256) {
    return { ok: false, reason: `${spec.name}: sha256 mismatch (got ${got.slice(0, 12)}, pinned ${spec.sha256.slice(0, 12)})` };
  }
  return { ok: true };
}
