// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/whistle_stage.ts - CREATOR-WHISTLE (ADR-0432 decision 1): stage the pinned Whistle model and
// Needle wasm engine AT RUNTIME, for DEV runs (`bun run desktop/dev.ts`), into a managed dir the
// caller names (~/.omp/whistle). The packaged app bundles the same three files under
// <resources>/whistle via build/fetch-whistle.ts; a dev run has no resources dir, so without this the
// engine would report "not installed" forever. Same P-STT.7 rule as whisper_binary_stage.ts: dev and
// bundle hold the SAME hash-verified bytes.
//
// Fail-closed: every download is checked by size then sha256 BEFORE it is renamed into place; the
// bytes land in `<name>.part` first and a bad `.part` is deleted, so `dir` never holds a file that
// did not verify. Files that already exist AND verify are skipped (no re-download on every boot).

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir } from "../harness/fs_dirs.ts";
import { WHISTLE_ASSETS, verifyWhistleAsset, type WhistleAssetSpec } from "./whistle_assets.ts";

export type StageResult = { ok: true; dir: string; staged: string[] } | { ok: false; reason: string };

/** Injected IO so the gate is unit-tested without a network or a real home dir. Every member is
 *  optional; the defaults are the real fs + global fetch. */
export interface WhistleStageIO {
  fetchImpl?: typeof fetch;
  exists?: (path: string) => boolean;
  readFile?: (path: string) => Uint8Array;
  writeFile?: (path: string, bytes: Uint8Array) => void;
  rename?: (from: string, to: string) => void;
  remove?: (path: string) => void;
  mkdir?: (dir: string) => void;
}

function sha256Hex(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  return hasher.digest("hex");
}

/** Download + verify the pinned assets into `dir`. Returns the names it downloaded (`staged`); files
 *  already present and verified are not listed. The first failure stops the run and reports by name. */
export async function stageWhistleAssets(
  io: WhistleStageIO,
  dir: string,
  specs: readonly WhistleAssetSpec[] = WHISTLE_ASSETS,
): Promise<StageResult> {
  const fetchImpl = io.fetchImpl ?? globalThis.fetch;
  const exists = io.exists ?? existsSync;
  const readFile = io.readFile ?? ((p: string) => new Uint8Array(readFileSync(p)));
  const writeFile = io.writeFile ?? ((p: string, b: Uint8Array) => writeFileSync(p, b));
  const rename = io.rename ?? renameSync;
  const remove = io.remove ?? ((p: string) => rmSync(p, { force: true }));
  const mkdir = io.mkdir ?? ensureDir;

  try { mkdir(dir); } catch (e) {
    return { ok: false, reason: `whistle: cannot create ${dir}: ${e instanceof Error ? e.message : String(e)}` };
  }

  const staged: string[] = [];
  for (const spec of specs) {
    const finalPath = join(dir, spec.name);
    if (exists(finalPath)) {
      let present: Uint8Array | null = null;
      try { present = readFile(finalPath); } catch { present = null; }
      if (present && verifyWhistleAsset(spec, present, sha256Hex(present)).ok) continue;
      // A stale or corrupt copy is replaced, never trusted.
    }

    let bytes: Uint8Array;
    try {
      const res = await fetchImpl(spec.url);
      if (!res.ok) return { ok: false, reason: `${spec.name}: download failed (HTTP ${res.status})` };
      bytes = new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      return { ok: false, reason: `${spec.name}: download failed: ${e instanceof Error ? e.message : String(e)}` };
    }

    // Land the bytes as `.part`, verify, and only then rename into place; a bad `.part` is deleted.
    const partPath = `${finalPath}.part`;
    try {
      writeFile(partPath, bytes);
      const verdict = verifyWhistleAsset(spec, bytes, sha256Hex(bytes));
      if (!verdict.ok) {
        remove(partPath);
        return { ok: false, reason: verdict.reason };
      }
      rename(partPath, finalPath);
    } catch (e) {
      try { remove(partPath); } catch { /* best effort */ }
      return { ok: false, reason: `${spec.name}: write failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    staged.push(spec.name);
  }
  return { ok: true, dir, staged };
}
