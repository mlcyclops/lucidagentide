// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/whisper_binaries.ts - P-STT.2c: WHICH whisper.cpp server binary to bundle per OS/arch, PINNED and
// SHA-256 verified (same supply-chain posture as build/fetch-runtimes.ts). Windows + Linux use the official
// ggml-org release archives (each committed hash was cross-checked against the GitHub release API digest, not
// merely "whatever downloaded"). macOS has NO prebuilt server asset in the release (only a Swift xcframework),
// so it is BUILT FROM SOURCE at package time - the same path proven live this session.
//
// Pure + IO-free so the mapping + keep-filter are unit-tested; build/fetch-whisper.ts does the real
// download / verify / extract / build, and desktop/whisper_manager.ts (resolveWhisperBin) finds the result
// under `<resources>/whisper/whisper-server[.exe]` at runtime.

export const WHISPER_VERSION = "1.9.1"; // ggml-org/whisper.cpp release tag - bump deliberately, then REFRESH hashes
const REL = `https://github.com/ggml-org/whisper.cpp/releases/download/v${WHISPER_VERSION}`;

/** A prebuilt release archive we download + verify, then extract the server binary + shared libs from. */
export interface WhisperPrebuilt {
  kind: "prebuilt";
  asset: string; // release asset filename
  url: string; // full download URL
  sha256: string; // committed hash (cross-checked vs the release API `digest`)
  bytes: number; // asset size - a cheap pre-check before hashing
  member: string; // basename of the server binary inside the archive
}
/** No prebuilt server binary is published (macOS): build it from source at package time. */
export interface WhisperSource {
  kind: "source";
  member: string; // basename the build produces (`whisper-server`)
}
export type WhisperBinarySpec = WhisperPrebuilt | WhisperSource;

// Keyed by `${process.platform}-${process.arch}`. The bundle is CPU-only on Win/Linux (the ggml CPU backend
// dlopen's the best micro-arch variant at runtime) - fine for the no-code default (tiny/base run on CPU);
// CUDA/BLAS variants are intentionally NOT bundled (hundreds of MB + a driver toolkit). macOS builds with
// Metal from source.
export const WHISPER_BINARIES: Record<string, WhisperBinarySpec> = {
  "linux-x64": {
    kind: "prebuilt",
    asset: "whisper-bin-ubuntu-x64.tar.gz",
    url: `${REL}/whisper-bin-ubuntu-x64.tar.gz`,
    sha256: "f3bf3b4369a99b54665b0f19b88483b30de27f25963b0414235dea03198515c5",
    bytes: 9379235,
    member: "whisper-server",
  },
  "linux-arm64": {
    kind: "prebuilt",
    asset: "whisper-bin-ubuntu-arm64.tar.gz",
    url: `${REL}/whisper-bin-ubuntu-arm64.tar.gz`,
    sha256: "e0b66cd551ff6f2a28fabe3c6e89691eea037bb76833493abb9a71ca788994b3",
    bytes: 4555819,
    member: "whisper-server",
  },
  "win32-x64": {
    kind: "prebuilt",
    asset: "whisper-bin-x64.zip",
    url: `${REL}/whisper-bin-x64.zip`,
    sha256: "7d8be46ecd31828e1eb7a2ecdd0d6b314feafd82163038ab6092594b0a063539",
    bytes: 7982101,
    member: "whisper-server.exe",
  },
  "darwin-arm64": { kind: "source", member: "whisper-server" },
  "darwin-x64": { kind: "source", member: "whisper-server" },
};

/** The bundle spec for a platform/arch (Node's `process.platform` + `process.arch` names), or null. */
export function whisperBinarySpec(platform: string, arch: string): WhisperBinarySpec | null {
  return WHISPER_BINARIES[`${platform}-${arch}`] ?? null;
}

/**
 * Which extracted archive members to KEEP when staging: the `whisper-server` binary + the whisper/ggml
 * SHARED LIBS (all of them - the ggml CPU backend loads the best micro-arch variant by SONAME at runtime, so
 * every `ggml*`/`libggml*` file is required, versioned files and symlinks included). Everything else the
 * archive carries (parakeet, tests, bench, other CLIs, SDL2) is dropped, keeping the bundle ~4-10 MB.
 */
export function keepWhisperMember(basename: string): boolean {
  if (basename === "whisper-server" || basename === "whisper-server.exe") return true;
  const isSharedLib = /\.(so|dylib)(\.[0-9]+)*$/.test(basename) || basename.endsWith(".dll");
  if (!isSharedLib) return false;
  // whisper core + ggml backend libs, across all three platforms' naming:
  //   linux  libwhisper.so[.x.y.z] / libggml*.so[.x.y.z]
  //   macOS  libwhisper[.x.y.z].dylib / libggml*[.x.y.z].dylib
  //   win    whisper.dll / ggml*.dll
  return (
    basename.startsWith("libwhisper") ||
    basename.startsWith("libggml") ||
    basename === "whisper.dll" ||
    /^ggml.*\.dll$/.test(basename)
  );
}
