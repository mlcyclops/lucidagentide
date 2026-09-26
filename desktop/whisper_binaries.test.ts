// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// The pinned per-OS whisper bundle table + the staging keep-filter (whisper_binaries.ts), plus the bundled
// binary resolution precedence (whisper_manager.ts). The keep-filter is the load-bearing correctness bit:
// it must keep whisper-server + EVERY whisper/ggml shared lib (incl. versioned files + symlinks + the ggml
// CPU micro-arch variants) and drop everything else the release archives carry.

import { describe, expect, test } from "bun:test";
import { WHISPER_VERSION, whisperBinarySpec, keepWhisperMember } from "./whisper_binaries.ts";
import { resolveWhisperBin } from "./whisper_manager.ts";

describe("whisperBinarySpec", () => {
  test("Windows x64 -> the pinned, verified release asset", () => {
    const s = whisperBinarySpec("win32", "x64");
    expect(s?.kind).toBe("prebuilt");
    if (s?.kind !== "prebuilt") throw new Error("unreachable");
    expect(s.member).toBe("whisper-server.exe");
    expect(s.asset).toBe("whisper-bin-x64.zip");
    expect(s.sha256).toBe("7d8be46ecd31828e1eb7a2ecdd0d6b314feafd82163038ab6092594b0a063539");
    expect(s.bytes).toBe(7982101);
    expect(s.url).toContain(`/v${WHISPER_VERSION}/`);
  });

  test("Linux x64 + arm64 -> pinned prebuilt tarballs, server member is whisper-server", () => {
    for (const arch of ["x64", "arm64"]) {
      const s = whisperBinarySpec("linux", arch);
      expect(s?.kind).toBe("prebuilt");
      if (s?.kind !== "prebuilt") throw new Error("unreachable");
      expect(s.member).toBe("whisper-server");
      expect(s.asset).toContain("ubuntu");
      expect(s.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("macOS -> build-from-source (no prebuilt server asset exists upstream)", () => {
    expect(whisperBinarySpec("darwin", "arm64")?.kind).toBe("source");
    expect(whisperBinarySpec("darwin", "x64")?.kind).toBe("source");
  });

  test("unknown platform/arch -> null", () => {
    expect(whisperBinarySpec("aix", "ppc")).toBeNull();
    expect(whisperBinarySpec("win32", "arm64")).toBeNull(); // not offered as a prebuilt (yet)
  });
});

describe("keepWhisperMember", () => {
  test("keeps the server binary on every platform", () => {
    expect(keepWhisperMember("whisper-server")).toBe(true);
    expect(keepWhisperMember("whisper-server.exe")).toBe(true);
  });

  test("keeps whisper + ggml shared libs across so / dylib / dll, versioned + symlinks", () => {
    const keep = [
      // linux (from the real ubuntu-x64 archive)
      "libwhisper.so", "libwhisper.so.1", "libwhisper.so.1.9.1",
      "libggml.so", "libggml.so.0", "libggml.so.0.15.1",
      "libggml-base.so.0.15.1", "libggml-cpu-haswell.so", "libggml-cpu-zen4.so", "libggml-cpu-x64.so",
      // macOS (from the real source build)
      "libwhisper.1.9.1.dylib", "libwhisper.dylib", "libggml-metal.0.16.0.dylib", "libggml-cpu.0.16.0.dylib",
      // windows (from the real whisper-bin-x64.zip)
      "whisper.dll", "ggml.dll", "ggml-base.dll", "ggml-cpu-alderlake.dll",
    ];
    for (const m of keep) expect(keepWhisperMember(m)).toBe(true);
  });

  test("drops the other binaries + libs the archives ship", () => {
    const drop = [
      "whisper-cli", "main", "whisper-bench", "whisper-quantize", "test-vad", "test-vad-full",
      "parakeet-cli", "libparakeet.so", "libparakeet.so.1.9.1",
      "whisper-cli.exe", "main.exe", "stream.exe", "wchess.exe", "SDL2.dll", "parakeet.dll",
      "LICENSE", "test-common-utf8",
    ];
    for (const m of drop) expect(keepWhisperMember(m)).toBe(false);
  });
});

describe("resolveWhisperBin - bundled path precedence (P-STT.2c)", () => {
  const io = (over: Partial<Parameters<typeof resolveWhisperBin>[0]>) => ({
    env: {} as Record<string, string | undefined>,
    exists: () => false,
    which: () => null,
    platform: "darwin",
    ...over,
  });

  test("finds the binary bundled under <resources>/whisper", () => {
    const r = resolveWhisperBin(io({ resourcesPath: "/App/Contents/Resources", exists: (p) => p === "/App/Contents/Resources/whisper/whisper-server" }));
    expect(r).toEqual({ path: "/App/Contents/Resources/whisper/whisper-server", source: "bundled" });
  });

  test("uses whisper-server.exe under the bundle on Windows", () => {
    const r = resolveWhisperBin(io({ platform: "win32", resourcesPath: "C:/res", exists: (p) => p === "C:/res/whisper/whisper-server.exe" }));
    expect(r?.source).toBe("bundled");
    expect(r?.path).toBe("C:/res/whisper/whisper-server.exe");
  });

  test("an explicit LUCID_WHISPER_BIN still wins over the bundle", () => {
    const r = resolveWhisperBin(io({
      env: { LUCID_WHISPER_BIN: "/custom/whisper-server" },
      resourcesPath: "/App/Contents/Resources",
      exists: () => true,
    }));
    expect(r).toEqual({ path: "/custom/whisper-server", source: "env" });
  });

  test("no env, no bundle, nothing on PATH -> null (the UI then offers guided setup)", () => {
    expect(resolveWhisperBin(io({}))).toBeNull();
  });
});
