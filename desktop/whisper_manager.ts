// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/whisper_manager.ts - P-STT.2: resolve the whisper.cpp server binary + download a model, with all
// I/O INJECTED so the logic is unit-tested (the pattern used across the codebase for testable IO). main.ts
// wires the real fetch / fs / child_process; here the DECISIONS (which binary, integrity of a download) are
// pure and covered. Invariant #2: whisper.cpp is a native C++ binary - no Python is added.
//
// Binary resolution order: an explicit `LUCID_WHISPER_BIN`, then a binary BUNDLED with the packaged app
// (`<resources>/whisper/whisper-server[.exe]` - the no-code, zero-prereq path the installer ships), then one
// on PATH (a dev who already has whisper.cpp). Dev runs also use desktop/ as the resources root
// for build-staged assets. If none resolves, the install/start route stages the pinned server.

import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { looksLikeWhisperModel, type WhisperModel } from "./whisper_install.ts";
import type { WhisperProc } from "./whisper_runtime.ts";

export interface BinResolveIO {
  env: Record<string, string | undefined>;
  exists: (path: string) => boolean;
  which: (name: string) => string | null;
  resourcesPath?: string; // packaged-app resources dir (process.resourcesPath), if any
  /** P-STT.7: the runtime-staged dir (~/.omp/whisper/bin) whisper_binary_stage.ts fills on dev runs. */
  stagedDir?: string;
  platform: string; // process.platform
}

export interface ResolvedBin { path: string; source: "env" | "bundled" | "staged" | "path" }

/** Find the whisper.cpp server binary (env -> bundled -> staged -> PATH), or null. Pure (I/O injected). */
export function resolveWhisperBin(io: BinResolveIO): ResolvedBin | null {
  const exe = io.platform === "win32" ? "whisper-server.exe" : "whisper-server";
  const envBin = io.env.LUCID_WHISPER_BIN;
  if (envBin && io.exists(envBin)) return { path: envBin, source: "env" };
  if (io.resourcesPath) {
    const bundled = `${io.resourcesPath}/whisper/${exe}`;
    if (io.exists(bundled)) return { path: bundled, source: "bundled" };
  }
  // P-STT.7: the dev-run staging dir sits between the bundle (installer-verified) and PATH (whatever
  // the user has lying around) - it holds the SAME pinned, hash-verified release the bundle ships.
  if (io.stagedDir) {
    const staged = `${io.stagedDir}/${exe}`;
    if (io.exists(staged)) return { path: staged, source: "staged" };
  }
  // whisper-cli transcribes files; it cannot serve HTTP or accept server arguments.
  const onPath = io.which(exe) ?? io.which("whisper-server");
  return onPath ? { path: onPath, source: "path" } : null;
}

/** Start the native server without a shell, preserving Windows argv and bounded startup diagnostics. */
export function spawnWhisperServer(bin: string, args: string[]): WhisperProc {
  const libDir = dirname(bin);
  // ELF needs an explicit library directory; macOS uses @loader_path and Windows the exe directory.
  const env = process.platform === "linux"
    ? { ...process.env, LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH ? `${libDir}:${process.env.LD_LIBRARY_PATH}` : libDir }
    : process.env;
  const proc = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true, env });
  let stderr = "";
  let failure: string | null = null;
  proc.stderr?.setEncoding("utf8");
  proc.stderr?.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-2000); });
  proc.on("error", (err) => { failure = `Could not start whisper-server: ${err.message}`; });
  proc.on("exit", (code, signal) => { failure ??= `whisper-server exited (${signal ?? code ?? "unknown"})`; });
  return {
    pid: proc.pid ?? 0,
    kill: () => { try { proc.kill(); } catch { /* gone */ } },
    failure: () => failure ? `${failure}${stderr.trim() ? `: ${stderr.trim()}` : ""}` : null,
  };
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
