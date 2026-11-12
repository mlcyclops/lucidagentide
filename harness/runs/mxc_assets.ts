// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/runs/mxc_assets.ts - P-MXC.1 (ADR-0441 decision 6): the PINNED Microsoft eXecution Container
// executors LUCID stages and runs. Pure data plus one verifier; no IO. The desktop build (fetch-mxc.ts)
// and a dev boot (mxc_stage.ts) both stage from the npm tarball of the pinned SDK version and verify
// every file by size and sha256 before it may be used; the MxcBackend probe re-verifies the executor on
// disk before its first run (a swapped binary is "not available", never "trusted because it is there").
//
// Only the EXECUTORS are pinned: the npm package also ships `koffi`, `node-pty` and the SDK JavaScript,
// none of which the executor transport needs (ADR-0441 decision 2). Hashes were taken from
// `@microsoft/mxc-sdk@1.0.0` on 2026-10-08 (Authenticode `CN=Microsoft Corporation` on all four).

export const MXC_SDK_VERSION = "1.0.0";
export const MXC_SCHEMA_VERSION = "1.0.0";
export const MXC_TARBALL_URL = `https://registry.npmjs.org/@microsoft/mxc-sdk/-/mxc-sdk-${MXC_SDK_VERSION}.tgz`;
/** npm's `dist.integrity` for the tarball (sha512, base64). */
export const MXC_TARBALL_INTEGRITY = "sha512-7aVR+GHVKveIknZmUtkAEFwUBp61qgEmhJRe1ZyKHJ274yWlKWB/ZfDP/u/whfmDyck0wRNKZN49atlF+SZt2Q==";

export type MxcPlatformKey = "win32-x64" | "win32-arm64";

export interface MxcAssetSpec {
  /** `<os>-<arch>` folder the file is staged under. */
  platform: MxcPlatformKey;
  /** File name as staged (and as shipped). */
  name: "wxc-exec.exe" | "wxc-host-prep.exe";
  /** Path inside the npm tarball. */
  tarPath: string;
  bytes: number;
  sha256: string;
}

export const MXC_ASSETS: readonly MxcAssetSpec[] = [
  { platform: "win32-x64", name: "wxc-exec.exe", tarPath: "package/bin/x64/wxc-exec.exe", bytes: 12_002_664, sha256: "8a6d1db4dd1846981127d9014741be18b094d07be967765dff6754bda1d40259" },
  { platform: "win32-x64", name: "wxc-host-prep.exe", tarPath: "package/bin/x64/wxc-host-prep.exe", bytes: 1_275_200, sha256: "c07c94acf62844c5c20590a2d3e7944d0beaaf424df934afc8c83d531bf72825" },
  { platform: "win32-arm64", name: "wxc-exec.exe", tarPath: "package/bin/arm64/wxc-exec.exe", bytes: 5_810_496, sha256: "a1dc1218e26dfae2e463ebede99591ab9b4adcc4efe5d09cc3302b053997244e" },
  { platform: "win32-arm64", name: "wxc-host-prep.exe", tarPath: "package/bin/arm64/wxc-host-prep.exe", bytes: 804_704, sha256: "d7b0adff28285d0bc5395f9409fb435f33fcca75a6465beae04bb2079f96345d" },
];

/** The platform key for a Node platform/arch pair, or null where MXC's executor is not pinned. */
export function mxcPlatformKey(platform: NodeJS.Platform, arch: string): MxcPlatformKey | null {
  if (platform !== "win32") return null;
  if (arch === "x64") return "win32-x64";
  if (arch === "arm64") return "win32-arm64";
  return null;
}

export function mxcAssetsFor(platform: MxcPlatformKey): readonly MxcAssetSpec[] {
  return MXC_ASSETS.filter((a) => a.platform === platform);
}

/** PURE: do the bytes match the pin? Size first (cheap, and a truncated download reads as "wrong size",
 *  not a hash riddle), then the digest the caller computed. The reason names the file and both hashes. */
export function verifyMxcAsset(spec: MxcAssetSpec, byteLength: number, sha256Hex: string): { ok: true } | { ok: false; reason: string } {
  if (byteLength !== spec.bytes) return { ok: false, reason: `${spec.platform}/${spec.name}: ${byteLength} bytes, pinned ${spec.bytes}` };
  if (sha256Hex.toLowerCase() !== spec.sha256) return { ok: false, reason: `${spec.platform}/${spec.name}: sha256 ${sha256Hex.toLowerCase()} does not match the pinned ${spec.sha256}` };
  return { ok: true };
}
