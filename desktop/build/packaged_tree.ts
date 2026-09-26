// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/build/packaged_tree.ts - locate electron-builder's packaged output tree (ADR-0363).
//
// The packaging gates (airgap-smoke.ts, pf-boot-smoke.ts) have to find the `resources` dir that
// electron-builder just wrote. Both used to INFER its name with a hardcoded literal:
//
//   PLAT === "win32" ? "win-unpacked" : PLAT === "linux" ? "linux-unpacked" : null
//
// That name is only correct for x64. electron-builder derives it as
// `${buildConfigurationKey}${getArchSuffix(arch, defaultArch)}${MAC ? "" : "-unpacked"}`
// (app-builder-lib/out/platformPackager.js), and getArchSuffix is
// `arch === defaultArch ? "" : "-" + Arch[arch]` (builder-util/out/arch.js). So ONLY the default arch
// (x64) gets a bare name; every other arch carries a suffix. The first arm64 Linux release build wrote
// `release/linux-arm64-unpacked`, the literal said `linux-unpacked`, and the air-gap gate died with
// "found no packaged resources dir" AFTER a perfectly good LucidAgent-arm64.AppImage had been built.
// Because that gate sits before every upload, the artifact was never uploaded: a real, shippable arm64
// build was thrown away by a string.
//
// So the name is DERIVED from the same rule electron-builder uses, never guessed, and the two gates
// share one resolver instead of two copies of the same wrong literal.
//
// The arch in the dir NAME is also the only honest discriminator we have. `build.extraResources` copies
// `runtimes/**/*` with NO arch filter, so a linux package contains BOTH python-linux-x64 and
// python-linux-arm64. Picking a tree by "which resources dir has a python for my arch" therefore cannot
// tell an x64 tree from an arm64 one, and on a runner holding both (a stale tree from an earlier build,
// or the mac leg that packages `mac` and `mac-arm64` in one job) it can validate the WRONG package and
// still report green. Hence: a tree whose name encodes a different concrete arch is REFUSED, not ranked.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";

export type Plat = "win32" | "linux" | "darwin";
/** The arch tags electron-builder can put in an appOutDir name (its `Arch` enum, plus universal). */
export type ArchTag = "x64" | "arm64" | "ia32" | "armv7l" | "universal";
/** electron-builder's `buildConfigurationKey` values. */
export type PlatTag = "win" | "linux" | "mac";

/** The basename electron-builder gives its appOutDir for plat+arch. mac gets no `-unpacked` suffix
 *  (its appOutDir holds the `.app` bundle instead); the default arch gets no arch suffix. */
export function appOutDirName(plat: Plat, arch: ArchTag, defaultArch: ArchTag = "x64"): string {
  const tag: PlatTag = plat === "win32" ? "win" : plat === "linux" ? "linux" : "mac";
  const suffix = arch === defaultArch ? "" : `-${arch}`;
  return tag === "mac" ? `mac${suffix}` : `${tag}${suffix}-unpacked`;
}

/** Parse an appOutDir basename back into the platform + arch it belongs to, or null when the name is
 *  not one of electron-builder's (a stray dir in the release tree). The arch is explicit in the name
 *  for every arch except the default, which is encoded by its ABSENCE. */
export function parseAppOutDirName(
  name: string,
  defaultArch: ArchTag = "x64",
): { plat: PlatTag; arch: ArchTag } | null {
  const m = /^(win|linux|mac)(?:-(x64|arm64|ia32|armv7l|universal))?(-unpacked)?$/.exec(name);
  if (!m) return null;
  const tag = m[1] as PlatTag;
  const unpacked = m[3] !== undefined;
  // mac appOutDirs never carry `-unpacked`; win/linux always do. Enforce both so `mac-unpacked` or a
  // bare `linux` cannot be mistaken for a real output tree.
  if (tag === "mac" ? unpacked : !unpacked) return null;
  return { plat: tag, arch: (m[2] as ArchTag | undefined) ?? defaultArch };
}

/** The `resources` dirs inside one appOutDir: `<dir>/resources` on win/linux, and any
 *  `<dir>/<name>.app/Contents/Resources` on mac (a dir that IS a `.app` is accepted too). */
export function resourceDirsIn(appOutDir: string): string[] {
  if (!existsSync(appOutDir)) return [];
  const out: string[] = [];
  const direct = join(appOutDir, "resources");
  if (existsSync(direct)) out.push(direct);
  let apps: string[];
  if (appOutDir.endsWith(".app")) {
    apps = [appOutDir];
  } else {
    try {
      apps = readdirSync(appOutDir).filter((x) => x.endsWith(".app")).map((x) => join(appOutDir, x));
    } catch {
      return out;
    }
  }
  for (const app of apps) {
    const r = join(app, "Contents", "Resources");
    if (existsSync(r)) out.push(r);
  }
  return out;
}

export interface ResolveOpts {
  /** The electron-builder output dir (desktop/release, or desktop/release-creator for Creator). */
  releaseDir: string;
  plat: Plat;
  arch: ArchTag;
  defaultArch?: ArchTag;
}

/** Packaged `resources` dirs that could belong to THIS plat+arch, best first.
 *
 *  Order: the exactly-named appOutDir for plat+arch, then any other tree that is not disqualified by
 *  its name. Disqualified = a different platform, or a different concrete arch (universal is allowed,
 *  it contains this arch). An unrecognized dir name is NOT disqualified, so a future electron-builder
 *  naming change degrades to the old hunt rather than to a hard failure. */
export function candidateResourceDirs(opts: ResolveOpts): string[] {
  const { releaseDir, plat, arch, defaultArch = "x64" } = opts;
  if (!existsSync(releaseDir)) return [];
  const tag: PlatTag = plat === "win32" ? "win" : plat === "linux" ? "linux" : "mac";
  const expected = appOutDirName(plat, arch, defaultArch);
  const out = resourceDirsIn(join(releaseDir, expected));

  let entries: string[];
  try {
    entries = readdirSync(releaseDir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === expected) continue;
    const p = join(releaseDir, entry);
    try {
      if (!statSync(p).isDirectory()) continue;
    } catch {
      continue;
    }
    const parsed = parseAppOutDirName(entry, defaultArch);
    if (parsed && (parsed.plat !== tag || (parsed.arch !== arch && parsed.arch !== "universal"))) continue;
    out.push(...resourceDirsIn(p));
  }
  // A `.app` reachable both directly and through its parent dir would otherwise appear twice.
  return [...new Set(out)];
}

export type ResourcesResolution =
  | { ok: true; dir: string; expected: string; exact: boolean }
  | { ok: false; reason: string; expected: string };

/** Resolve the one packaged `resources` dir to gate. Fail-closed: when nothing plausible exists the
 *  caller gets a reason naming the dir it expected, never a silent fallback onto a foreign tree. */
export function resolveResourcesDir(opts: ResolveOpts): ResourcesResolution {
  const { releaseDir, plat, arch, defaultArch = "x64" } = opts;
  const expected = appOutDirName(plat, arch, defaultArch);
  if (!existsSync(releaseDir)) {
    return {
      ok: false,
      expected,
      reason: `no release dir at ${releaseDir}: did electron-builder run? (LUCID_RELEASE_DIR selects a non-default output dir)`,
    };
  }
  const cands = candidateResourceDirs(opts);
  if (!cands.length) {
    let found: string[] = [];
    try {
      found = readdirSync(releaseDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      /* reported below as an empty listing */
    }
    return {
      ok: false,
      expected,
      reason:
        `found no packaged resources dir for ${plat}-${arch} under ${releaseDir}. Expected ` +
        `${expected}/resources (or ${expected}/<name>.app/Contents/Resources). Dirs present: ` +
        `${found.length ? found.join(", ") : "(none)"}`,
    };
  }
  // Among plausible trees prefer one carrying this arch's Python. Both linux arches ship in every
  // linux package, so this only breaks ties the NAME already narrowed; it is not the discriminator.
  const match = cands.find((r) => existsSync(join(r, "runtimes", `python-${plat}-${arch}`)));
  const dir = match ?? cands[0]!;
  // Anchor on a separator: a bare `dir.startsWith(expectedPath)` also matches SIBLINGS that merely
  // share the prefix, and on mac the expected x64 name is literally `mac`, so `mac-universal` and
  // `mac-arm64` both passed a plain prefix test and got reported as the exact tree.
  const expectedPath = join(releaseDir, expected);
  return { ok: true, dir, expected, exact: dir === expectedPath || dir.startsWith(expectedPath + sep) };
}
