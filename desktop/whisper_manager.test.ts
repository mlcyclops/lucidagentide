// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// The Whisper manager (whisper_manager.ts): binary resolution order + the download-with-integrity flow. All
// I/O is injected, so success / HTTP-error / HTML-error-page cases are exercised with no network or fs.

import { describe, expect, it } from "bun:test";
import { downloadWhisperModel, resolveWhisperBin, type BinResolveIO, type DownloadIO } from "./whisper_manager.ts";
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
