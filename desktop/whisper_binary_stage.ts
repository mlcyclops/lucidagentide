// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/whisper_binary_stage.ts - P-STT.7: stage the pinned whisper.cpp `whisper-server` binary AT
// RUNTIME, for DEV runs (the .bat / `bun run desktop/dev.ts` path).
//
// THE GAP THIS CLOSES: the packaged app bundles whisper-server under <resources>/whisper, but a dev run
// has no resources dir - so unless the user set LUCID_WHISPER_BIN or has whisper.cpp on PATH, the Voice
// card's "Install & start" downloaded MODELS it could never serve, reported "No whisper.cpp binary
// found", and autostart never fired. This module downloads the SAME pinned release asset the installer
// stages (whisper_binaries.ts: exact URL + sha256 + byte size), verifies it fail-closed, extracts only
// the keep-listed members (server binary + whisper/ggml shared libs), and drops them in a managed dir
// (~/.omp/whisper/bin) that resolveWhisperBin now checks. One download, then every later boot resolves
// the staged binary and autostart works like the installed app.
//
// Windows assets are .zip (read with the dependency-free harness unzip); Linux are .tar.gz (system tar).
// macOS publishes no prebuilt server: that stays the guided source-build path (`bun run whisper`).

import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keepWhisperMember, whisperBinarySpec } from "./whisper_binaries.ts";
import { readZipEntriesMatching } from "../harness/personal/unzip.ts";
import { ensureDir } from "../harness/fs_dirs.ts";

export type StageResult = { ok: true; path: string } | { ok: false; reason: string };

export interface StageIO {
  fetchImpl?: typeof fetch;
  platform?: string;
  arch?: string;
}

/** Download + verify + extract the pinned whisper-server into `destDir`. Fail-closed: a hash or size
 *  mismatch discards the download and reports; nothing partial is ever left in `destDir`. */
export async function stageWhisperBinary(destDir: string, io: StageIO = {}): Promise<StageResult> {
  const platform = io.platform ?? process.platform;
  const arch = io.arch ?? process.arch;
  const spec = whisperBinarySpec(platform, arch);
  if (!spec) return { ok: false, reason: `no pinned whisper.cpp build for ${platform}-${arch} - set LUCID_WHISPER_BIN to a whisper-server you built.` };
  if (spec.kind === "source") {
    return { ok: false, reason: "macOS builds whisper-server from source: run `bun run whisper` in desktop/ (needs cmake), or set LUCID_WHISPER_BIN." };
  }
  const fetchImpl = io.fetchImpl ?? globalThis.fetch;
  let archive: Buffer;
  try {
    const res = await fetchImpl(spec.url);
    if (!res.ok) return { ok: false, reason: `whisper-server download failed (HTTP ${res.status})` };
    archive = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    return { ok: false, reason: `whisper-server download failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  // Fail-closed integrity gate: the EXACT pinned size and sha256 (same pins the installer build uses).
  if (archive.length !== spec.bytes) return { ok: false, reason: `whisper-server download size mismatch (got ${archive.length}, pinned ${spec.bytes})` };
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(archive);
  const digest = hasher.digest("hex");
  if (digest !== spec.sha256) return { ok: false, reason: `whisper-server download hash mismatch (got ${digest.slice(0, 12)}\u2026, pinned ${spec.sha256.slice(0, 12)}\u2026)` };

  ensureDir(destDir);
  try {
    if (spec.asset.endsWith(".zip")) {
      // Windows: the dependency-free zip reader; keep only the server + whisper/ggml libs.
      for (const entry of readZipEntriesMatching(archive, keepWhisperMember)) {
        const base = entry.name.split("/").pop() ?? entry.name;
        writeFileSync(join(destDir, base), entry.data);
      }
    } else {
      // Linux: system tar into a scratch dir, then copy the keep-listed members flat into destDir.
      const scratch = mkdtempSync(join(tmpdir(), "whisper-stage-"));
      try {
        const tmpArchive = join(scratch, spec.asset);
        writeFileSync(tmpArchive, archive);
        const tar = Bun.spawnSync(["tar", "-xzf", tmpArchive, "-C", scratch]);
        if (tar.exitCode !== 0) return { ok: false, reason: `tar extract failed: ${tar.stderr.toString().slice(0, 200)}` };
        const walk = (d: string): void => {
          for (const f of readdirSync(d)) {
            const p = join(d, f);
            if (statSync(p).isDirectory()) { walk(p); continue; }
            if (keepWhisperMember(f)) writeFileSync(join(destDir, f), readFileSync(p));
          }
        };
        walk(scratch);
      } finally { rmSync(scratch, { recursive: true, force: true }); }
    }
  } catch (e) {
    return { ok: false, reason: `whisper-server extract failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  const binPath = join(destDir, spec.member);
  try { statSync(binPath); } catch { return { ok: false, reason: `archive did not contain ${spec.member}` }; }
  if (platform !== "win32") { try { chmodSync(binPath, 0o755); } catch { /* fs without modes */ } }
  return { ok: true, path: binPath };
}
