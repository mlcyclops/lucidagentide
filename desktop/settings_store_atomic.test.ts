// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-SETTINGS.1 (ADR-0439): the settings file is written atomically, keeps a last-good backup, and a
// corrupt file is recovered (never silently treated as an empty profile that the next save persists).

import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync, renameSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load, save, setSandboxWindowsMode, setDeveloperMode, _setSettingsIoForTest } from "./settings_store.ts";

const dirs: string[] = [];
const prevEnv = process.env.LUCID_GUI_SETTINGS_FILE;
function scratch(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "lucid-settings-"));
  dirs.push(dir);
  const file = join(dir, "lucid-gui.json");
  process.env.LUCID_GUI_SETTINGS_FILE = file;
  return { dir, file };
}
afterEach(() => {
  _setSettingsIoForTest(null);
  if (prevEnv === undefined) delete process.env.LUCID_GUI_SETTINGS_FILE;
  else process.env.LUCID_GUI_SETTINGS_FILE = prevEnv;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
// Silence the expected recovery line so the test output stays readable.
const quiet = <T>(fn: () => T): T => {
  const orig = console.error; console.error = () => {};
  try { return fn(); } finally { console.error = orig; }
};

const PROFILE = { username: "Nick", sandboxWindowsMode: "off" as const, lastModel: "anthropic/claude-opus-5-5", tourSeen: true };

describe("P-SETTINGS.1 atomic save", () => {
  test("save round-trips, leaves no temp files, and backs up the previous generation", () => {
    const { dir, file } = scratch();
    save({ username: "first" });
    expect(existsSync(`${file}.bak`)).toBe(false); // nothing to back up on the first save
    save(PROFILE);
    expect(load()).toEqual(PROFILE);
    expect(JSON.parse(readFileSync(`${file}.bak`, "utf8"))).toEqual({ username: "first" });
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("a corrupt primary never overwrites a good backup on save", () => {
    const { file } = scratch();
    save(PROFILE); save(PROFILE); // backup now holds PROFILE
    writeFileSync(file, "{\"username\": \"Ni"); // torn write
    save({ username: "next" });
    expect(JSON.parse(readFileSync(`${file}.bak`, "utf8"))).toEqual(PROFILE);
  });
});

describe("P-SETTINGS.1 corrupt-file recovery", () => {
  test("REGRESSION 2026-10-05: an engine killed mid-save no longer wipes the profile", () => {
    // The old save() truncated in place; a kill between truncate and write left a 0-byte file. load()
    // returned {}, the next toggle saved that, and the Windows sandbox flipped back ON with onboarding
    // re-running. Replay it: good profile + backup, then the primary is truncated to 0 bytes.
    const { dir, file } = scratch();
    save(PROFILE); save(PROFILE);
    writeFileSync(file, "");
    const after = quiet(() => setDeveloperMode(true)); // any read-modify-save after the crash
    expect(after.sandboxWindowsMode).toBe("off");
    expect(after.username).toBe("Nick");
    expect(after.tourSeen).toBe(true);
    expect(load()).toEqual({ ...PROFILE, developerMode: true });
    // the torn bytes are kept for forensics, not deleted
    expect(readdirSync(dir).some((f) => f.startsWith("lucid-gui.json.corrupt-"))).toBe(true);
  });

  test("a half-written file is restored from the backup and the primary is rewritten", () => {
    const { file } = scratch();
    save(PROFILE); save(PROFILE);
    writeFileSync(file, "{\"username\": \"Nick\", \"sandboxWin");
    expect(quiet(() => load())).toEqual(PROFILE);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(PROFILE);
  });

  test("valid JSON that is not an object is corrupt, not a profile", () => {
    const { file } = scratch();
    save(PROFILE); save(PROFILE);
    for (const junk of ["null", "[]", "42", "\"x\""]) {
      writeFileSync(file, junk);
      expect(quiet(() => load())).toEqual(PROFILE);
    }
  });

  test("corrupt with no usable backup falls back to defaults but preserves the bad bytes", () => {
    const { dir, file } = scratch();
    writeFileSync(file, "\u0000\u0000\u0000");
    expect(quiet(() => load())).toEqual({});
    const kept = readdirSync(dir).find((f) => f.startsWith("lucid-gui.json.corrupt-"));
    expect(kept).toBeDefined();
    expect(readFileSync(join(dir, kept!), "utf8")).toBe("\u0000\u0000\u0000");
  });

  test("a MISSING primary is a deliberate reset: the backup is not resurrected", () => {
    const { file } = scratch();
    save(PROFILE); save(PROFILE);
    rmSync(file);
    expect(load()).toEqual({});
    expect(existsSync(file)).toBe(false);
  });

  test("the sandbox opt-out survives a write that lands between two loads", () => {
    scratch();
    setSandboxWindowsMode("off");
    for (let i = 0; i < 50; i++) setDeveloperMode(i % 2 === 0);
    expect(load().sandboxWindowsMode).toBe("off");
  });
});

// The Windows failure modes (an antivirus or OneDrive handle, a second process saving) are forced on cue
// through the store's fs seam, because a real lock cannot be held deterministically from a test.
const errno = (code: string, syscall: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: simulated, ${syscall}`), { code, syscall });

describe("P-SETTINGS.1 never an empty profile (review fixes, 2026-10-09)", () => {
  test("a profile that stays locked is an error, never {}, so no setter can save over it", () => {
    const { file } = scratch();
    save(PROFILE);
    _setSettingsIoForTest({ openFault: () => { throw errno("EPERM", "open"); } });
    expect(() => load()).toThrow(/cannot be read/);
    expect(() => setDeveloperMode(true)).toThrow(/cannot be read/);
    _setSettingsIoForTest(null);
    expect(load()).toEqual(PROFILE);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(PROFILE);
  });

  test("a brief lock on open is retried, not reported", () => {
    scratch();
    save(PROFILE);
    let refusals = 2;
    _setSettingsIoForTest({ openFault: () => { if (refusals-- > 0) throw errno("EBUSY", "open"); } });
    expect(load()).toEqual(PROFILE);
  });

  test("a parsed backup is served even when the corrupt primary cannot be rewritten", () => {
    const { dir, file } = scratch();
    save(PROFILE); save(PROFILE);
    writeFileSync(file, "{\"username\": \"Ni");
    _setSettingsIoForTest({ renameSync: (() => { throw errno("EPERM", "rename"); }) as unknown as typeof renameSync });
    expect(quiet(() => load())).toEqual(PROFILE);
    _setSettingsIoForTest(null);
    expect(quiet(() => load())).toEqual(PROFILE); // the next load finishes the restore
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(PROFILE);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("recovery never overwrites a profile another process saved after the corrupt read", () => {
    const { dir, file } = scratch();
    save(PROFILE); save(PROFILE);
    writeFileSync(file, "{\"username\": \"Ni");
    const NEWER = { ...PROFILE, username: "saved by the other process" };
    let raced = false;
    // The other process's atomic save lands after the corrupt read, just as recovery re-checks the path.
    _setSettingsIoForTest({
      statSync: ((path: string) => {
        if (!raced) { raced = true; writeFileSync(`${file}.other`, JSON.stringify(NEWER)); renameSync(`${file}.other`, file); }
        return statSync(path);
      }) as unknown as typeof statSync,
    });
    expect(quiet(() => load())).toEqual(NEWER);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(NEWER);
    expect(readdirSync(dir).filter((f) => f.startsWith("lucid-gui.json.corrupt-"))).toEqual([]);
  });
});
