// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-SECRET-INTAKE.1 (ADR-0476): the notepad fallback. Load-bearing: the file lives in a user-only directory
// (verified with the REAL OS permissions on the host running the test), never under a synced folder or
// the workspace; any permission failure refuses and leaves nothing behind; a save is read once, the bytes
// are overwritten with zeros and the file and its directory are deleted.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createUserOnlyDir, createUserOnlyFile, decodeSecretFile, editorCommand, FALLBACK_DIR_PREFIX, FallbackRefused, icaclsUserOnly, isUserOnly,
  MAX_SECRET_FILE_BYTES, parseIcaclsTrustees, parseWhoamiUser, privateTempBase, restrictToUser, startFallback, sweepOrphanTempDirs, wipeAndDelete,
} from "./secret_fallback.ts";
import { isSyncedPath } from "./synced_path.ts";

const scratch: string[] = [];
const dir = (): string => { const d = mkdtempSync(join(tmpdir(), "lucid-fallback-test-")); scratch.push(d); return d; };
afterAll(() => { for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("privateTempBase", () => {
  test("skips a synced base and the workspace, takes the next private one", () => {
    const root = dir();
    const synced = join(root, "OneDrive - Contoso");
    const workspace = join(root, "project");
    const inWorkspace = join(workspace, "tmp");
    const ok = join(root, "local-temp");
    for (const d of [synced, inWorkspace, ok]) mkdirSync(d, { recursive: true });
    expect(privateTempBase({ bases: [synced, workspace, inWorkspace, ok], workspace, env: {}, home: root })).toBe(ok);
  });
  test("refuses when every candidate is synced, missing or in the workspace", () => {
    const root = dir();
    const synced = join(root, "Dropbox");
    mkdirSync(synced);
    expect(() => privateTempBase({ bases: [synced, join(root, "missing"), "relative/dir"], env: {}, home: root })).toThrow(FallbackRefused);
  });
});

describe("createUserOnlyFile", () => {
  test("the real host permissions: the file and its folder are readable by this user only, outside synced folders", () => {
    const base = dir();
    const { dir: d, file } = createUserOnlyFile({ label: "OPENAI_API_KEY", bases: [base] });
    expect(existsSync(file)).toBe(true);
    expect(dirname(file)).toBe(d);
    expect(isUserOnly(d)).toBe(true);
    expect(isUserOnly(file)).toBe(true);
    expect(isSyncedPath(file)).toBe(false);
    expect(file).toContain("paste-OPENAI_API_KEY-here.txt");
    rmSync(d, { recursive: true, force: true });
  });
  test.skipIf(process.platform !== "win32")("v2.5.1 upgrade review SECRET-FALLBACK-EXPLICIT-ACE: an explicit entry for another trustee is removed, not just inherited ones", () => {
    const d = dir();
    const icacls = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe");
    // An explicit (non-inherited) grant, as GitHub's runners put SYSTEM and Administrators on new folders.
    expect(Bun.spawnSync([icacls, d, "/grant", "*S-1-5-32-545:(OI)(CI)R"]).exitCode).toBe(0); // BUILTIN\Users
    restrictToUser(d);
    expect(isUserOnly(d)).toBe(true);
  });
  test("fail-closed: a restrict failure refuses and leaves no folder behind", () => {
    const base = dir();
    expect(() => createUserOnlyFile({ label: "x", bases: [base], restrict: () => { throw new Error("EPERM"); } })).toThrow(FallbackRefused);
    expect(readdirSync(base)).toEqual([]);
  });
  test("fail-closed: permissions that do not verify as user-only refuse and leave nothing behind", () => {
    const base = dir();
    expect(() => createUserOnlyFile({ label: "x", bases: [base], restrict: () => {}, userOnly: () => false })).toThrow(FallbackRefused);
    expect(readdirSync(base)).toEqual([]);
  });
});

describe("createUserOnlyDir and sweepOrphanTempDirs (SECRET-FALLBACK-ORPHAN, VAULT-DEST-REQFILE-PERMS-ORPHAN)", () => {
  const seams = { restrict: () => {}, userOnly: () => true };
  const leftover = (base: string, name: string, pid: number | null): string => {
    const d = join(base, name);
    mkdirSync(d);
    writeFileSync(join(d, "put.request.json"), "sk-live-LEFTOVER-PLAINTEXT-000001");
    if (pid !== null) writeFileSync(join(d, "owner.pid"), String(pid));
    return d;
  };

  test("refuses when the userOnly seam says false and leaves nothing", () => {
    const base = dir();
    expect(() => createUserOnlyDir("lucid-vdest-", { bases: [base], restrict: () => {}, userOnly: () => false })).toThrow(FallbackRefused);
    expect(readdirSync(base)).toEqual([]);
  });

  test("the dir holds an owner marker with this pid", () => {
    const base = dir();
    const d = createUserOnlyDir(FALLBACK_DIR_PREFIX, { bases: [base], ...seams });
    expect(readFileSync(join(d, "owner.pid"), "utf8")).toBe(String(process.pid));
  });

  test("wipes then removes orphans, keeps a live other owner, takes own dirs only with includeOwn", () => {
    const base = dir();
    const dead = Bun.spawnSync([process.execPath, "-e", ""]).pid;
    const unmarked = leftover(base, `${FALLBACK_DIR_PREFIX}orphan1`, null);
    const deadOwned = leftover(base, "lucid-vdest-dead01", dead);
    const live = leftover(base, "lucid-vdest-live01", process.ppid);
    const unrelated = leftover(base, "other-dir-keep", null);
    const own = createUserOnlyDir("lucid-vdest-", { bases: [base], ...seams });
    const seen: string[] = [];
    const r = sweepOrphanTempDirs([FALLBACK_DIR_PREFIX, "lucid-vdest-"], { bases: [base], afterOverwrite: (f) => { seen.push(readFileSync(f, "utf8")); } });
    expect(r).toEqual({ removed: 2, kept: 2 });
    for (const d of [unmarked, deadOwned]) expect(existsSync(d)).toBe(false);
    for (const d of [live, unrelated, own]) expect(existsSync(d)).toBe(true);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const s of seen) expect(/^\0*$/.test(s)).toBe(true); // zeroed before removal
    expect(sweepOrphanTempDirs(["lucid-vdest-"], { bases: [base], includeOwn: true })).toEqual({ removed: 1, kept: 1 });
    expect(existsSync(own)).toBe(false);
    expect(existsSync(live)).toBe(true);
  });
});

describe("wipeAndDelete", () => {
  test("overwrites every byte with zeros before the file is removed", () => {
    const f = join(dir(), "s.txt");
    writeFileSync(f, "sk-live-THIS-IS-THE-SECRET-0123456789");
    const seen: Buffer[] = [];
    wipeAndDelete(f, { afterOverwrite: (p) => { seen.push(readFileSync(p)); } });
    expect(seen.length).toBe(1);
    expect(seen[0]!.length).toBe(37);
    expect(seen[0]!.every((b) => b === 0)).toBe(true);
    expect(existsSync(f)).toBe(false);
  });
});

describe("startFallback", () => {
  // The save poll is driven by hand (ticker seam): two ticks with an unchanged size+mtime = a stable save.
  const stubbed = (base: string, opened: string[] = []) => {
    const ticks: Array<() => void> = [];
    const opts = {
      label: "GITHUB_TOKEN", bases: [base], restrict: () => {}, userOnly: () => true,
      openEditor: (f: string) => { opened.push(f); },
      ticker: (t: () => void) => { ticks.push(t); return () => {}; },
    };
    const poll = () => { for (const t of ticks) t(); };
    return { opts, poll };
  };

  test("opens the editor on the file, reads a stable save once, then deletes the file and its folder", async () => {
    const base = dir();
    const opened: string[] = [];
    const { opts, poll } = stubbed(base, opened);
    const s = startFallback(opts);
    expect(opened).toEqual([s.path]);
    writeFileSync(s.path, "  ghp_value-from-the-text-file  \r\n");
    poll();
    expect(existsSync(s.path)).toBe(true); // one sighting is not a stable save yet
    poll();
    expect(await s.read).toEqual({ value: "  ghp_value-from-the-text-file  \r\n" });
    expect(existsSync(s.path)).toBe(false);
    expect(existsSync(dirname(s.path))).toBe(false);
  });

  test("a whitespace-only save is not taken; the real paste after it is", async () => {
    const { opts, poll } = stubbed(dir());
    const s = startFallback(opts);
    writeFileSync(s.path, "\r\n  \r\n");
    poll(); poll();
    expect(existsSync(s.path)).toBe(true);
    writeFileSync(s.path, "real-value");
    poll(); poll();
    expect(await s.read).toEqual({ value: "real-value" });
  });

  test("an oversized file is refused unread and wiped", async () => {
    const { opts, poll } = stubbed(dir());
    const s = startFallback(opts);
    writeFileSync(s.path, Buffer.alloc(MAX_SECRET_FILE_BYTES + 1, 0x41));
    poll();
    const r = await s.read;
    expect(r !== null && "error" in r).toBe(true);
    expect(existsSync(s.path)).toBe(false);
  });

  test("dispose before a save resolves null and removes the file and folder", async () => {
    const { opts } = stubbed(dir());
    const s = startFallback(opts);
    s.dispose();
    expect(await s.read).toBeNull();
    expect(existsSync(dirname(s.path))).toBe(false);
  });

  test("an editor that cannot start refuses and leaves nothing behind", () => {
    const base = dir();
    const { opts } = stubbed(base);
    expect(() => startFallback({ ...opts, openEditor: () => { throw new Error("ENOENT"); } })).toThrow(FallbackRefused);
    expect(readdirSync(base)).toEqual([]);
  });
});

describe("pure helpers", () => {
  test("decodeSecretFile reads UTF-16LE (Notepad 'Unicode') and strips a UTF-8 BOM", () => {
    expect(decodeSecretFile(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("key-1", "utf16le")]))).toBe("key-1");
    expect(decodeSecretFile(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("key-2")]))).toBe("key-2");
    expect(decodeSecretFile(Buffer.from("key-3"))).toBe("key-3");
  });
  test("icacls parsing: only the user's own ACEs pass; any other trustee, or none, fails", () => {
    const path = "C:\\Users\\ada\\AppData\\Local\\Temp\\lucid-secret-ab12";
    const who = parseWhoamiUser('"desktop-1\\ada","S-1-5-21-1-2-3-1001"\r\n')!;
    expect(who).toEqual({ name: "desktop-1\\ada", sid: "S-1-5-21-1-2-3-1001" });
    const mine = `${path} DESKTOP-1\\ada:(OI)(CI)(F)\r\n\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n`;
    expect(parseIcaclsTrustees(mine, path)).toEqual(["DESKTOP-1\\ada"]);
    expect(icaclsUserOnly(mine, path, who)).toBe(true);
    const shared = `${path} DESKTOP-1\\ada:(OI)(CI)(F)\r\n    NT AUTHORITY\\SYSTEM:(I)(OI)(CI)(F)\r\n    BUILTIN\\Administrators:(I)(OI)(CI)(F)\r\n`;
    expect(icaclsUserOnly(shared, path, who)).toBe(false);
    expect(icaclsUserOnly("Successfully processed 0 files\r\n", path, who)).toBe(false);
  });
  test("the OS editor is a fixed program with the path as its own argument", () => {
    expect(editorCommand("C:\\t\\a b.txt", "win32")).toEqual(["notepad.exe", "C:\\t\\a b.txt"]);
    expect(editorCommand("/t/a.txt", "darwin")).toEqual(["open", "-e", "/t/a.txt"]);
    expect(editorCommand("/t/a.txt", "linux")).toEqual(["xdg-open", "/t/a.txt"]);
  });
});
