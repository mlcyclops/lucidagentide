// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/build/fetch-whistle.ts - CREATOR-WHISTLE (ADR-0432 decision 1): stage the pinned Whistle model
// (`whistle.cact`) and the Needle wasm engine (`needle.js` + `needle.wasm`) into desktop/whistle/, which
// electron-builder bundles into `<resources>/whistle/` so the engine runs them with zero prereqs (see
// whistle_assets.ts `resolveWhistleDir`).
//
// Same supply-chain posture as fetch-whisper.ts: download the PINNED URL, VERIFY size + SHA-256
// (fail-closed), write `<name>.part`, rename into place only after the bytes verify. The same stager
// (whistle_stage.ts) serves dev runs into ~/.omp/whistle, so the bundle and a dev run hold identical
// hash-verified bytes. Platform-independent: wasm is the same file everywhere.
//
// Usage: `bun run whistle` (from desktop/) or `bun run desktop/build/fetch-whistle.ts`.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WHISTLE_ASSETS, verifyWhistleAsset } from "../whistle_assets.ts";
import { stageWhistleAssets } from "../whistle_stage.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "whistle"); // desktop/whistle -> extraResources `from: "whistle"`

const result = await stageWhistleAssets({}, OUT);
if (!result.ok) {
  console.error(`fetch-whistle: ${result.reason}`);
  process.exit(1);
}
for (const spec of WHISTLE_ASSETS) {
  const path = join(OUT, spec.name);
  if (!existsSync(path)) {
    console.error(`fetch-whistle: ${spec.name} missing after staging`);
    process.exit(1);
  }
  const bytes = new Uint8Array(readFileSync(path));
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  const digest = hasher.digest("hex");
  const verdict = verifyWhistleAsset(spec, bytes, digest);
  if (!verdict.ok) {
    console.error(`fetch-whistle: ${verdict.reason}`);
    process.exit(1);
  }
  const how = result.staged.includes(spec.name) ? "downloaded" : "already staged";
  console.log(`fetch-whistle: ${spec.name} ${bytes.length} bytes sha256 ${digest} verified (${how})`);
}
console.log(`fetch-whistle: staged ${WHISTLE_ASSETS.length} files into ${OUT}`);
