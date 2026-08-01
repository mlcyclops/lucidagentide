// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/engine_launch.test.ts - P-WINBOOT.2 (ADR-0251): the compiled-engine launch decisions.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { engineDesktopDir, engineExeName, resolveEngineSpawn } from "./engine_launch.ts";

describe("engineDesktopDir", () => {
  test("dev run: import.meta.dir IS the desktop dir (renderer/ exists there)", () => {
    const here = "C:\\repo\\desktop";
    const exists = (p: string) => p === "C:\\repo\\desktop\\renderer";
    expect(engineDesktopDir(here, "C:\\somewhere\\bun.exe", exists)).toBe(here);
  });
  test("compiled: import.meta.dir is a virtual bunfs path -> derive desktop from the binary at <repo>/bin", () => {
    // A compiled binary reports a bunfs import.meta.dir with no renderer/ on disk; the exe lives at
    // <repo>/bin/lucid-engine.exe, so the desktop dir is <repo>/desktop.
    const bunfs = "B:\\~BUN\\root";
    const repo = "C:\\Program Files\\LucidAgentIDE\\resources\\repo";
    const exePath = join(repo, "bin", "lucid-engine.exe");
    const exists = () => false; // bunfs\renderer does not exist on disk
    // derives <repo>/desktop from the on-disk binary at <repo>/bin (join normalizes the ..).
    expect(engineDesktopDir(bunfs, exePath, exists)).toBe(join(repo, "desktop"));
  });
});

describe("engineExeName", () => {
  test("appends .exe only on win32", () => {
    expect(engineExeName("win32")).toBe("lucid-engine.exe");
    expect(engineExeName("darwin")).toBe("lucid-engine");
    expect(engineExeName("linux")).toBe("lucid-engine");
  });
});

describe("resolveEngineSpawn", () => {
  const bun = "C:\\rt\\bun.exe";
  test("packaged + the compiled binary present -> spawn the binary, no args", () => {
    const exe = "C:\\Program Files\\LucidAgentIDE\\resources\\repo\\bin\\lucid-engine.exe";
    const r = resolveEngineSpawn({ packaged: true, repoRoot: "C:\\Program Files\\LucidAgentIDE\\resources\\repo", bun, exists: (p) => p === exe, platform: "win32" });
    expect(r).toEqual({ cmd: exe, args: [], compiled: true });
  });
  test("packaged but the binary is MISSING -> fall back to `bun run desktop/dev.ts` (app still starts)", () => {
    const r = resolveEngineSpawn({ packaged: true, repoRoot: "C:\\x\\resources\\repo", bun, exists: () => false, platform: "win32" });
    expect(r).toEqual({ cmd: bun, args: ["run", "desktop/dev.ts"], compiled: false });
  });
  test("dev run (not packaged) -> always `bun run desktop/dev.ts`, even if a stray binary exists", () => {
    const r = resolveEngineSpawn({ packaged: false, repoRoot: "C:\\repo", bun, exists: () => true, platform: "win32" });
    expect(r).toEqual({ cmd: bun, args: ["run", "desktop/dev.ts"], compiled: false });
  });
  test("posix packaged: binary name carries no .exe", () => {
    const repo = "/opt/LucidAgentIDE/resources/repo";
    const exe = join(repo, "bin", engineExeName("linux"));
    expect(exe.endsWith("lucid-engine")).toBe(true); // no .exe suffix on posix
    const r = resolveEngineSpawn({ packaged: true, repoRoot: repo, bun: "/rt/bun", exists: (p) => p === exe, platform: "linux" });
    expect(r).toEqual({ cmd: exe, args: [], compiled: true });
  });
});
