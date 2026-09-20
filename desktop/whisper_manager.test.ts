// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// The Whisper manager (whisper_manager.ts): binary resolution order + the download-with-integrity flow. All
// I/O is injected, so success / HTTP-error / HTML-error-page cases are exercised with no network or fs.

import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadWhisperModel, resolveWhisperBin, spawnWhisperServer, type BinResolveIO, type DownloadIO } from "./whisper_manager.ts";
import type { WhisperProc } from "./whisper_runtime.ts";
import { WHISPER_MODELS } from "./whisper_install.ts";

function binIO(over: Partial<BinResolveIO> = {}): BinResolveIO {
  return { env: {}, exists: () => false, which: () => null, platform: "darwin", ...over };
}

describe("resolveWhisperBin", () => {
  it("prefers an explicit LUCID_WHISPER_BIN that exists", () => {
    const r = resolveWhisperBin(binIO({ env: { LUCID_WHISPER_BIN: "/opt/ws" }, exists: (p) => p === "/opt/ws" }));
    expect(r).toEqual({ path: "/opt/ws", source: "env" });
  });
  it("falls back to a bundled binary in the packaged app", () => {
    const r = resolveWhisperBin(binIO({ resourcesPath: "/app/res", exists: (p) => p === "/app/res/whisper/whisper-server" }));
    expect(r).toEqual({ path: "/app/res/whisper/whisper-server", source: "bundled" });
  });
  // P-STT.7: the runtime-staged dir (dev runs) sits between the bundle and PATH.
  it("resolves the staged binary when no bundle exists", () => {
    const r = resolveWhisperBin(binIO({ stagedDir: "/home/u/.omp/whisper/bin", exists: (p) => p === "/home/u/.omp/whisper/bin/whisper-server" }));
    expect(r).toEqual({ path: "/home/u/.omp/whisper/bin/whisper-server", source: "staged" });
  });
  it("the bundle still wins over the staged dir; staged wins over PATH", () => {
    const both = resolveWhisperBin(binIO({ resourcesPath: "/app/res", stagedDir: "/staged", exists: () => true }));
    expect(both?.source).toBe("bundled");
    const stagedVsPath = resolveWhisperBin(binIO({ stagedDir: "/staged", exists: (p) => p === "/staged/whisper-server", which: () => "/usr/bin/whisper-server" }));
    expect(stagedVsPath?.source).toBe("staged");
  });
  it("uses a binary on PATH for a dev who already has whisper.cpp", () => {
    const r = resolveWhisperBin(binIO({ which: (n) => (n === "whisper-server" ? "/usr/local/bin/whisper-server" : null) }));
    expect(r).toEqual({ path: "/usr/local/bin/whisper-server", source: "path" });
  });
  it("returns null when nothing resolves (UI then flags the bundle step)", () => {
    expect(resolveWhisperBin(binIO())).toBeNull();
  });
  it("uses the .exe name on Windows", () => {
    const r = resolveWhisperBin(binIO({ platform: "win32", which: (n) => (n === "whisper-server.exe" ? "C:/ws.exe" : null) }));
    expect(r?.path).toBe("C:/ws.exe");
  });
});

describe("local Whisper assets and native processes", () => {
  it("resolves build-staged assets in a dev resources directory with spaces", () => {
    const root = mkdtempSync(join(tmpdir(), "lucid whisper assets "));
    try {
      mkdirSync(join(root, "whisper"));
      const exe = process.platform === "win32" ? "whisper-server.exe" : "whisper-server";
      const file = join(root, "whisper", exe);
      writeFileSync(file, "binary discovery fixture");
      const resolved = resolveWhisperBin({ env: {}, exists: existsSync, which: Bun.which, resourcesPath: root, platform: process.platform });
      expect(resolved?.source).toBe("bundled");
      expect(resolved && existsSync(resolved.path)).toBe(true);
      expect(resolved && join(resolved.path)).toBe(file);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("does not mistake a CLI-only PATH installation for an HTTP server", () => {
    const root = mkdtempSync(join(tmpdir(), "lucid whisper cli "));
    try {
      const exe = process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli";
      writeFileSync(join(root, exe), "CLI discovery fixture", { mode: 0o755 });
      expect(Bun.which(exe, { PATH: root })).not.toBeNull();
      expect(resolveWhisperBin({ env: {}, exists: existsSync, which: (name) => Bun.which(name, { PATH: root }), platform: process.platform })).toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("preserves spaced and quoted argv and reports the real child exit and stderr", async () => {
    const root = mkdtempSync(join(tmpdir(), "lucid whisper process "));
    let proc: WhisperProc | undefined;
    try {
      const script = join(root, "native child.js");
      writeFileSync(script, 'process.stderr.write(JSON.stringify(process.argv.slice(2))); process.exit(7);');
      const arg = 'C:/Voice models/tiny "quoted" & local.bin';
      proc = spawnWhisperServer(process.execPath, [script, arg]);
      const reason = await nativeFailure(proc);
      expect(reason).toContain("exited (7)");
      expect(reason).toContain(JSON.stringify([arg]));
    } finally { proc?.kill(); rmSync(root, { recursive: true, force: true }); }
  });

  it("reports a missing executable without waiting for the health timeout", async () => {
    const root = mkdtempSync(join(tmpdir(), "lucid whisper missing "));
    const proc = spawnWhisperServer(join(root, "absent-whisper-server.exe"), []);
    try {
      const reason = await nativeFailure(proc);
      expect(reason).toContain("Could not start whisper-server:");
      expect(reason).toContain("absent-whisper-server.exe");
    }
    finally { proc.kill(); rmSync(root, { recursive: true, force: true }); }
  });

  it("bounds diagnostics from a noisy failed native process", async () => {
    const proc = spawnWhisperServer(process.execPath, ["-e", 'process.stderr.write("x".repeat(5000) + "MODEL_LOAD_FAILED"); process.exit(3);']);
    try {
      const reason = await nativeFailure(proc);
      expect(reason).toContain("MODEL_LOAD_FAILED");
      expect(reason.length).toBeLessThan(2200);
    } finally { proc.kill(); }
  });
});

async function nativeFailure(proc: WhisperProc): Promise<string> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const failure = proc.failure?.();
    if (failure) return failure;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Native process did not report its exit");
}

const BIG = 200 * 1024 * 1024;
function res(opts: { ok?: boolean; status?: number; body?: boolean; len?: number }): Response {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    headers: { get: (k: string) => (k.toLowerCase() === "content-length" ? String(opts.len ?? BIG) : null) },
    body: opts.body === false ? null : new ReadableStream<Uint8Array>({ start(c) { c.close(); } }),
  } as unknown as Response;
}
function dlIO(over: Partial<DownloadIO> = {}): DownloadIO {
  return {
    fetch: (async () => res({})) as unknown as typeof fetch,
    writeStream: async (_p, _b, onBytes) => { onBytes(BIG); return BIG; },
    readHead: async () => new Uint8Array([0x00, 0x01, 0x02, 0x03]),
    rename: async () => {},
    remove: async () => {},
    ...over,
  };
}

describe("downloadWhisperModel", () => {
  it("streams, integrity-checks, and atomically renames on success", async () => {
    let renamed: [string, string] | null = null;
    const r = await downloadWhisperModel(WHISPER_MODELS.base, "/m/ggml-base.en.bin", dlIO({ rename: async (a, b) => { renamed = [a, b]; } }));
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.bytes).toBe(BIG); expect(r.path).toBe("/m/ggml-base.en.bin"); }
    expect(renamed).toEqual(["/m/ggml-base.en.bin.part", "/m/ggml-base.en.bin"]);
  });
  it("fails on an HTTP error, never throwing", async () => {
    const r = await downloadWhisperModel(WHISPER_MODELS.base, "/m/x.bin", dlIO({ fetch: (async () => res({ ok: false, status: 404 })) as unknown as typeof fetch }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/404/);
  });
  it("rejects (and cleans up) an HTML error page saved as .bin", async () => {
    let removed = "";
    const r = await downloadWhisperModel(WHISPER_MODELS.base, "/m/x.bin", dlIO({ readHead: async () => new Uint8Array([0x3c]), remove: async (p) => { removed = p; } }));
    expect(r.ok).toBe(false);
    expect(removed).toBe("/m/x.bin.part");
  });
});
