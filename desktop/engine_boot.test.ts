// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/engine_boot.test.ts - P-WINBOOT.1 (ADR-0259): the pure engine-failure brain.

import { describe, expect, test } from "bun:test";
import {
  bestEngineLine,
  classifyEngineFailure,
  isProtectedInstallRoot,
  probeDirWritable,
  type EngineFailureInput,
  type WriteProbe,
} from "./engine_boot.ts";

const base: EngineFailureInput = {
  packaged: true,
  repoRoot: "C:\\Users\\me\\AppData\\Local\\Programs\\LucidAgentIDE\\resources\\repo",
  repoWritable: true,
  protectedRoot: false,
  exited: false,
  exitCode: null,
  lastLogLine: "",
  port: 5319,
  logPath: "C:\\Users\\me\\AppData\\Roaming\\lucidagentide-desktop\\engine.log",
  platform: "win32",
};

describe("isProtectedInstallRoot", () => {
  test("flags Program Files and Program Files (x86)", () => {
    expect(isProtectedInstallRoot("C:\\Program Files\\LucidAgentIDE\\resources\\repo")).toBe(true);
    expect(isProtectedInstallRoot("C:\\Program Files (x86)\\LucidAgentIDE\\resources\\repo")).toBe(true);
    expect(isProtectedInstallRoot("C:\\Windows\\System32\\foo")).toBe(true);
  });
  test("does not flag a per-user or portable location", () => {
    expect(isProtectedInstallRoot("C:\\Users\\me\\AppData\\Local\\Programs\\LucidAgentIDE\\resources\\repo")).toBe(false);
    expect(isProtectedInstallRoot("D:\\PortableApps\\LucidAgent\\resources\\repo")).toBe(false);
    expect(isProtectedInstallRoot("/Applications/LucidAgent.app/Contents/Resources/repo")).toBe(false);
    expect(isProtectedInstallRoot("")).toBe(false);
  });
  test("does not false-positive on a sibling-named folder", () => {
    // "Program Files Backup" is not the protected segment; the regex is separator-bounded.
    expect(isProtectedInstallRoot("D:\\Program Files Backup\\LucidAgent\\repo")).toBe(false);
  });
});

describe("bestEngineLine", () => {
  test("prefers the error line over trailing noise (the real EPERM case)", () => {
    const tail =
      "--- engine start 2026-07-31T12:55:36.474Z | v1.12.0 (packaged) ---\n" +
      'error: EPERM reading "C:\\Program Files\\LucidAgentIDE\\resources\\repo\\desktop\\dev.ts"\n' +
      "\n" +
      "Bun v1.3.14 (Windows x64)\n";
    expect(bestEngineLine(tail)).toBe('error: EPERM reading "C:\\Program Files\\LucidAgentIDE\\resources\\repo\\desktop\\dev.ts"');
  });
  test("falls back to the last non-empty line when nothing looks like an error", () => {
    expect(bestEngineLine("listening\nready on 5319\n\n")).toBe("ready on 5319");
  });
  test("empty tail yields empty string", () => {
    expect(bestEngineLine("   \n  \n")).toBe("");
  });
});

describe("probeDirWritable", () => {
  test("true when the write+remove succeed", () => {
    const probe: WriteProbe = { write: () => {}, remove: () => {} };
    expect(probeDirWritable("C:\\anywhere", probe)).toBe(true);
  });
  test("false when the write throws (protected dir)", () => {
    const probe: WriteProbe = {
      write: () => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); },
      remove: () => {},
    };
    expect(probeDirWritable("C:\\Program Files\\LucidAgentIDE\\resources\\repo", probe)).toBe(false);
  });
  test("false for an empty dir without touching the probe", () => {
    let touched = false;
    const probe: WriteProbe = { write: () => { touched = true; }, remove: () => { touched = true; } };
    expect(probeDirWritable("", probe)).toBe(false);
    expect(touched).toBe(false);
  });
});

describe("classifyEngineFailure", () => {
  test("protected-location by PATH: names the folder, offers reinstall + portable", () => {
    const r = classifyEngineFailure({ ...base, protectedRoot: true, repoRoot: "C:\\Program Files\\LucidAgentIDE\\resources\\repo", exited: true, exitCode: 1 });
    expect(r.kind).toBe("protected-location");
    expect(r.detail).toContain("C:\\Program Files\\LucidAgentIDE\\resources\\repo");
    expect(r.detail).toContain("%LOCALAPPDATA%\\Programs\\LucidAgentIDE");
    expect(r.detail.toLowerCase()).toContain("portable");
  });
  test("protected-location by a FAILED WRITE PROBE even when the path looks ordinary", () => {
    const r = classifyEngineFailure({ ...base, repoWritable: false });
    expect(r.kind).toBe("protected-location");
  });
  test("protected-location by a PERMISSION SIGNAL in the log (path + probe inconclusive)", () => {
    const r = classifyEngineFailure({ ...base, lastLogLine: 'error: EPERM reading "...\\desktop\\dev.ts"' });
    expect(r.kind).toBe("protected-location");
    expect(r.detail).toContain("EPERM");
  });
  test("engine-exited when the child died without any protected/permission evidence", () => {
    const r = classifyEngineFailure({ ...base, exited: true, exitCode: 3, lastLogLine: "TypeError: boom" });
    expect(r.kind).toBe("engine-exited");
    expect(r.detail).toContain("exit code 3");
    expect(r.detail).toContain("TypeError: boom");
  });
  test("timeout when the engine is alive but silent", () => {
    const r = classifyEngineFailure({ ...base });
    expect(r.kind).toBe("timeout");
    expect(r.detail).toContain("5319");
    expect(r.detail).toContain("may still be starting");
  });
  test("a DEV run never blames the install location, even under Program Files", () => {
    const r = classifyEngineFailure({ ...base, packaged: false, protectedRoot: true, repoWritable: false, exited: true, exitCode: 1 });
    expect(r.kind).toBe("engine-exited");
  });
  test("non-Windows protected-location wording drops the Windows-only paths", () => {
    const r = classifyEngineFailure({ ...base, platform: "darwin", repoWritable: false, repoRoot: "/Applications/LucidAgent.app/Contents/Resources/repo" });
    expect(r.kind).toBe("protected-location");
    expect(r.detail).not.toContain("%LOCALAPPDATA%");
    expect(r.detail.toLowerCase()).toContain("home directory");
  });
});
