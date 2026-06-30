// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Tests for the full-tree folder browser (P-FS.1, ADR-0103 — supersedes ADR-0022 M1's home confinement).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { COMPUTER, listDir } from "./fs_browse.ts";

// A temp tree:  <tmp>/root/{home/{proj/.git}, sibling, .hidden}
const TMP = mkdtempSync(join(tmpdir(), "fsbrowse-"));
const ROOT = join(TMP, "root");
const HOME = join(ROOT, "home");
mkdirSync(join(HOME, "proj", ".git"), { recursive: true });
mkdirSync(join(ROOT, "sibling"), { recursive: true });
mkdirSync(join(ROOT, ".hidden"), { recursive: true });
writeFileSync(join(HOME, "afile.txt"), "x");
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

describe("listDir — full-tree (unmanaged)", () => {
  test("null path lands on home and lists only sub-DIRECTORIES (no files, no dotfiles)", () => {
    const d = listDir(null, { home: HOME, platform: "linux" });
    expect(d.path).toBe(resolve(HOME));
    expect(d.dirs.map((x) => x.name)).toEqual(["proj"]); // afile.txt + nothing hidden
    expect(d.dirs[0].isGit).toBe(true); // proj has a .git
    expect(d.parent).toBe(resolve(ROOT)); // can navigate ABOVE home — the whole point
  });

  test("can browse ABOVE home, up toward the filesystem root", () => {
    const atRoot = listDir(ROOT, { home: HOME, platform: "linux" });
    // sibling + home are dirs; .hidden is suppressed
    expect(atRoot.dirs.map((x) => x.name).sort()).toEqual(["home", "sibling"]);
    expect(atRoot.parent).toBe(resolve(TMP)); // keeps going up — not clamped to home
  });

  test("parent of the filesystem root is null (top of the tree)", () => {
    const d = listDir("/", { home: HOME, platform: "linux" });
    expect(d.parent).toBeNull();
  });

  test("a non-existent / unreadable target falls back to home, never throws", () => {
    const d = listDir(join(ROOT, "nope-does-not-exist"), { home: HOME, platform: "linux" });
    expect(d.path).toBe(resolve(HOME));
  });
});

describe("listDir — managed workspaceRoots (only tightens)", () => {
  test("a target outside the allowed roots snaps back into the root", () => {
    const d = listDir("/etc", { home: HOME, platform: "linux", allowedRoots: [HOME] });
    expect(d.path).toBe(resolve(HOME));
  });

  test("never offers a parent above an allowed root", () => {
    const d = listDir(HOME, { home: HOME, platform: "linux", allowedRoots: [HOME] });
    expect(d.parent).toBeNull(); // HOME is the managed ceiling
  });

  test("navigation within an allowed root still works", () => {
    const d = listDir(join(HOME, "proj"), { home: HOME, platform: "linux", allowedRoots: [HOME] });
    expect(d.path).toBe(resolve(HOME, "proj"));
    expect(d.parent).toBe(resolve(HOME)); // up to the root, but no further
  });
});

describe("listDir — Windows drive (computer) level via injected deps", () => {
  const winDeps = {
    platform: "win32" as const,
    home: "C:\\Users\\me",
    drives: () => ["C:\\", "D:\\"],
    exists: (p: string) => p === "C:\\" || p === "D:\\" || p.endsWith("\\.git") === false,
    isDir: () => true,
    readdir: () => [] as string[],
  };

  test("COMPUTER sentinel enumerates drives, with no parent", () => {
    const d = listDir(COMPUTER, winDeps);
    expect(d.path).toBe(COMPUTER);
    expect(d.dirs.map((x) => x.path).sort()).toEqual(["C:\\", "D:\\"]);
    expect(d.parent).toBeNull();
  });

  test("a drive root's parent is the COMPUTER level (so 'Up' reaches the drive list)", () => {
    const d = listDir("C:\\", { ...winDeps, isDir: (p: string) => p === "C:\\" });
    expect(d.parent).toBe(COMPUTER);
  });
});
