// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/whisper_manager.ts - P-STT.2: resolve the whisper.cpp server binary + download a model, with all
// I/O INJECTED so the logic is unit-tested (the pattern used across the codebase for testable IO). main.ts
// wires the real fetch / fs / child_process; here the DECISIONS (which binary, integrity of a download) are
// pure and covered. Invariant #2: whisper.cpp is a native C++ binary - no Python is added.
//
// Binary resolution order: an explicit `LUCID_WHISPER_BIN`, then a binary BUNDLED with the packaged app
// (`<resources>/whisper/whisper-server[.exe]` - the no-code, zero-prereq path the installer ships), then one
// on PATH (a dev who already has whisper.cpp). If none resolves, the UI reports it and offers the guided
// download of the model only (the bundle step is a packaging task, tracked in PROGRESS).

import { looksLikeWhisperModel, type WhisperModel } from "./whisper_install.ts";

export interface BinResolveIO {
  env: Record<string, string | undefined>;
  exists: (path: string) => boolean;
  which: (name: string) => string | null;
  resourcesPath?: string; // packaged-app resources dir (process.resourcesPath), if any
  platform: string; // process.platform
}

export interface ResolvedBin { path: string; source: "env" | "bundled" | "path" }

/** Find the whisper.cpp server binary (env -> bundled -> PATH), or null. Pure (I/O injected). */
export function resolveWhisperBin(io: BinResolveIO): ResolvedBin | null {
  const exe = io.platform === "win32" ? "whisper-server.exe" : "whisper-server";
  const envBin = io.env.LUCID_WHISPER_BIN;
  if (envBin && io.exists(envBin)) return { path: envBin, source: "env" };
  if (io.resourcesPath) {
    const bundled = `${io.resourcesPath}/whisper/${exe}`;
    if (io.exists(bundled)) return { path: bundled, source: "bundled" };
  }
  const onPath = io.which(exe) ?? io.which("whisper-server") ?? io.which("whisper-cli");
  return onPath ? { path: onPath, source: "path" } : null;
}

export interface DownloadIO {
  fetch: typeof fetch;
  /** Stream the body to `path`, returning the bytes written. Reports progress bytes as they land. */
  writeStream: (path: string, body: ReadableStream<Uint8Array>, onBytes: (n: number) => void) => Promise<number>;
  readHead: (path: string, n: number) => Promise<Uint8Array>;
  rename: (from: string, to: string) => Promise<void>;
  remove: (path: string) => Promise<void>;
}

export type DownloadResult = { ok: true; path: string; bytes: number } | { ok: false; reason: string };

/**
 * Download `model` to `destPath` (via a `.part` temp + atomic rename), streaming progress and running the
 * fail-closed integrity gate (`looksLikeWhisperModel`) before committing. Never throws. Pure orchestration:
 * fetch + fs are injected, so success / HTTP-error / HTML-error-page / truncated cases are all unit-tested.
 */
export async function downloadWhisperModel(
  model: WhisperModel,
  destPath: string,
  io: DownloadIO,
  onProgress?: (fraction: number) => void,
): Promise<DownloadResult> {
  const tmp = `${destPath}.part`;
  try {
    const res = await io.fetch(model.url);
    if (!res.ok || !res.body) return { ok: false, reason: `download failed (HTTP ${res.status || 0})` };
    const total = Number(res.headers.get("content-length") ?? 0) || model.approxMB * 1024 * 1024;
    let seen = 0;
    const bytes = await io.writeStream(tmp, res.body, (n) => { seen += n; onProgress?.(Math.min(1, seen / total)); });
    const head = await io.readHead(tmp, 16);
    const check = looksLikeWhisperModel(head, bytes, model.approxMB);
    if (!check.ok) { await io.remove(tmp).catch(() => {}); return { ok: false, reason: check.reason ?? "integrity check failed" }; }
    await io.rename(tmp, destPath);
    return { ok: true, path: destPath, bytes };
  } catch (e) {
    await io.remove(tmp).catch(() => {});
    return { ok: false, reason: String((e as Error)?.message ?? e) };
  }
}
