// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Tests for build/packaged_tree.ts (ADR-0363): finding electron-builder's packaged output tree.
//
// The regression these lock down cost a shippable artifact. The arm64 Linux leg built
// LucidAgent-arm64.AppImage successfully, then the air-gap gate refused with "found no packaged
// resources dir" because it looked for `linux-unpacked` while electron-builder had written
// `linux-arm64-unpacked`. The gate runs before every upload, so the good build was discarded.
//
// Trees are fabricated on the REAL filesystem, never mocked: the resolver's whole job is to answer
// questions about what is on disk, and a mocked fs would let the same class of bug back in.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appOutDirName,
  type ArchTag,
  candidateResourceDirs,
  parseAppOutDirName,
  type Plat,
  resolveResourcesDir,
  resourceDirsIn,
} from "./packaged_tree.ts";

const roots: string[] = [];
function makeRelease(): string {
  const d = mkdtempSync(join(tmpdir(), "lucid-pkgtree-"));
  roots.push(d);
  return join(d, "release");
}
/** Fabricate `<release>/<appOutDir>/resources` carrying pythons for `archs`. */
function unpackedTree(release: string, appOutDir: string, archs: ArchTag[], plat: Plat = "linux"): string {
  const res = join(release, appOutDir, "resources");
  mkdirSync(res, { recursive: true });
  for (const a of archs) mkdirSync(join(res, "runtimes", `python-${plat}-${a}`), { recursive: true });
  return res;
}
/** Fabricate `<release>/<appOutDir>/<name>.app/Contents/Resources`. */
function appTree(release: string, appOutDir: string, name: string, archs: ArchTag[]): string {
  const res = join(release, appOutDir, `${name}.app`, "Contents", "Resources");
  mkdirSync(res, { recursive: true });
  for (const a of archs) mkdirSync(join(res, "runtimes", `python-darwin-${a}`), { recursive: true });
  return res;
}

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("appOutDirName mirrors electron-builder's rule", () => {
  // getArchSuffix(arch, defaultArch) = arch === defaultArch ? "" : `-${Arch[arch]}`, and MAC alone
  // omits the `-unpacked` suffix (app-builder-lib/out/platformPackager.js computeAppOutDir).
  test("the default arch gets NO suffix", () => {
    expect(appOutDirName("linux", "x64")).toBe("linux-unpacked");
    expect(appOutDirName("win32", "x64")).toBe("win-unpacked");
    expect(appOutDirName("darwin", "x64")).toBe("mac");
  });

  test("every non-default arch carries its tag - the case the literal got wrong", () => {
    expect(appOutDirName("linux", "arm64")).toBe("linux-arm64-unpacked");
    expect(appOutDirName("win32", "arm64")).toBe("win-arm64-unpacked");
    expect(appOutDirName("darwin", "arm64")).toBe("mac-arm64");
    expect(appOutDirName("linux", "armv7l")).toBe("linux-armv7l-unpacked");
    expect(appOutDirName("win32", "ia32")).toBe("win-ia32-unpacked");
    expect(appOutDirName("darwin", "universal")).toBe("mac-universal");
  });

  test("a non-x64 defaultArch moves which name is bare", () => {
    expect(appOutDirName("linux", "arm64", "arm64")).toBe("linux-unpacked");
    expect(appOutDirName("linux", "x64", "arm64")).toBe("linux-x64-unpacked");
  });
});

describe("parseAppOutDirName", () => {
  test("round-trips every name appOutDirName can emit", () => {
    for (const plat of ["win32", "linux", "darwin"] as Plat[]) {
      for (const arch of ["x64", "arm64", "ia32", "armv7l", "universal"] as ArchTag[]) {
        const name = appOutDirName(plat, arch);
        const parsed = parseAppOutDirName(name);
        expect(parsed, `${name} must parse`).not.toBeNull();
        expect(parsed!.arch, `${name} arch`).toBe(arch);
        expect(parsed!.plat, `${name} plat`).toBe(plat === "win32" ? "win" : plat === "linux" ? "linux" : "mac");
      }
    }
  });

  test("a missing arch tag means the DEFAULT arch, not 'unknown'", () => {
    expect(parseAppOutDirName("linux-unpacked")!.arch).toBe("x64");
    expect(parseAppOutDirName("linux-unpacked", "arm64")!.arch).toBe("arm64");
  });

  test("rejects names that are not electron-builder output dirs", () => {
    // Wrong suffix for the platform: mac never gets -unpacked, win/linux always do.
    expect(parseAppOutDirName("mac-unpacked")).toBeNull();
    expect(parseAppOutDirName("linux")).toBeNull();
    expect(parseAppOutDirName("linux-arm64")).toBeNull();
    // Not an output dir at all.
    expect(parseAppOutDirName("builder-effective-config.yaml")).toBeNull();
    expect(parseAppOutDirName(".icon-set")).toBeNull();
    expect(parseAppOutDirName("linux-riscv64-unpacked")).toBeNull();
  });
});

describe("resourceDirsIn", () => {
  test("finds the win/linux resources dir", () => {
    const release = makeRelease();
    const res = unpackedTree(release, "linux-arm64-unpacked", ["arm64"]);
    expect(resourceDirsIn(join(release, "linux-arm64-unpacked"))).toEqual([res]);
  });

  test("finds a mac .app's Contents/Resources, and accepts a .app path directly", () => {
    const release = makeRelease();
    const res = appTree(release, "mac-arm64", "LucidAgent", ["arm64"]);
    expect(resourceDirsIn(join(release, "mac-arm64"))).toEqual([res]);
    expect(resourceDirsIn(join(release, "mac-arm64", "LucidAgent.app"))).toEqual([res]);
  });

  test("a missing or empty appOutDir yields nothing rather than throwing", () => {
    const release = makeRelease();
    mkdirSync(join(release, "linux-unpacked"), { recursive: true });
    expect(resourceDirsIn(join(release, "nope"))).toEqual([]);
    expect(resourceDirsIn(join(release, "linux-unpacked"))).toEqual([]);
  });
});

describe("resolveResourcesDir", () => {
  test("REGRESSION: resolves the arm64 tree electron-builder actually writes", () => {
    // Exactly the arm64 release build's layout. The old literal `linux-unpacked` found nothing here
    // and the gate refused after the AppImage had already been built.
    const release = makeRelease();
    const res = unpackedTree(release, "linux-arm64-unpacked", ["x64", "arm64"]);
    const r = resolveResourcesDir({ releaseDir: release, plat: "linux", arch: "arm64" });
    expect(r.ok).toBe(true);
    expect(r.ok && r.dir).toBe(res);
    expect(r.ok && r.exact).toBe(true);
  });

  test("still resolves the x64 trees that were already green", () => {
    for (const [plat, arch, name] of [["linux", "x64", "linux-unpacked"], ["win32", "x64", "win-unpacked"]] as const) {
      const release = makeRelease();
      const res = unpackedTree(release, name, ["x64", "arm64"], plat);
      const r = resolveResourcesDir({ releaseDir: release, plat, arch });
      expect(r.ok && r.dir, name).toBe(res);
    }
  });

  test("the mac leg packages two arches in one job; the arm64 runner gets the arm64 bundle", () => {
    // `dist:mac` runs electron-builder --arm64 then --x64, so `mac-arm64` and `mac` both exist. Both
    // bundles contain BOTH pythons (extraResources copies runtimes/**/* unfiltered), so only the dir
    // NAME can tell them apart. Picking by python would have gated whichever readdir returned first.
    const release = makeRelease();
    const armRes = appTree(release, "mac-arm64", "LucidAgent", ["x64", "arm64"]);
    appTree(release, "mac", "LucidAgent", ["x64", "arm64"]);
    const r = resolveResourcesDir({ releaseDir: release, plat: "darwin", arch: "arm64" });
    expect(r.ok && r.dir).toBe(armRes);
    expect(r.ok && r.exact).toBe(true);
  });

  test("REFUSES a stale tree of a different arch instead of validating the wrong bytes", () => {
    // A leftover x64 tree from an earlier build, on an arm64 runner. Both pythons ship in it, so the
    // arch-matched-python heuristic would have accepted it and reported green about the wrong package.
    const release = makeRelease();
    unpackedTree(release, "linux-unpacked", ["x64", "arm64"]);
    const r = resolveResourcesDir({ releaseDir: release, plat: "linux", arch: "arm64" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.expected).toBe("linux-arm64-unpacked");
    // The message must name what it wanted AND what was there, or the next person debugs blind.
    expect(!r.ok && r.reason).toContain("linux-arm64-unpacked");
    expect(!r.ok && r.reason).toContain("linux-unpacked");
  });

  test("a universal mac bundle is accepted for either concrete arch", () => {
    const release = makeRelease();
    const res = appTree(release, "mac-universal", "LucidAgent", ["x64", "arm64"]);
    for (const arch of ["arm64", "x64"] as ArchTag[]) {
      const r = resolveResourcesDir({ releaseDir: release, plat: "darwin", arch });
      expect(r.ok && r.dir, arch).toBe(res);
      expect(r.ok && r.exact, arch).toBe(false); // accepted as a fallback, not the exact name
    }
  });

  test("an unrecognized dir name is still searched, so a naming change degrades softly", () => {
    const release = makeRelease();
    const res = unpackedTree(release, "linux-future-flavor", ["arm64"]);
    const r = resolveResourcesDir({ releaseDir: release, plat: "linux", arch: "arm64" });
    expect(r.ok && r.dir).toBe(res);
    expect(r.ok && r.exact).toBe(false);
  });

  test("a missing release dir reports that electron-builder never ran", () => {
    const r = resolveResourcesDir({ releaseDir: join(makeRelease(), "absent"), plat: "linux", arch: "arm64" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain("did electron-builder run?");
  });

  test("a release dir holding only loose artifacts fails and lists what it saw", () => {
    const release = makeRelease();
    mkdirSync(release, { recursive: true });
    writeFileSync(join(release, "LucidAgent-arm64.AppImage"), "not a dir");
    mkdirSync(join(release, ".cache"), { recursive: true });
    const r = resolveResourcesDir({ releaseDir: release, plat: "linux", arch: "arm64" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain(".cache");
    // A FILE next to the trees must not crash the scan (statSync + isDirectory guard).
    expect(!r.ok && r.reason).not.toContain("LucidAgent-arm64.AppImage");
  });
});

describe("candidateResourceDirs ordering", () => {
  test("the exactly-named tree comes first even when other trees qualify", () => {
    const release = makeRelease();
    const exact = unpackedTree(release, "linux-arm64-unpacked", ["arm64"]);
    const loose = unpackedTree(release, "linux-something-else", ["arm64"]);
    const cands = candidateResourceDirs({ releaseDir: release, plat: "linux", arch: "arm64" });
    expect(cands[0]).toBe(exact);
    expect(cands).toContain(loose);
  });

  test("no duplicates when a tree is reachable more than one way", () => {
    const release = makeRelease();
    appTree(release, "mac-arm64", "LucidAgent", ["arm64"]);
    const cands = candidateResourceDirs({ releaseDir: release, plat: "darwin", arch: "arm64" });
    expect(new Set(cands).size).toBe(cands.length);
  });
});
