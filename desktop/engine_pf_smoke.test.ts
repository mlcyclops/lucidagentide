// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/engine_pf_smoke.test.ts - P-WINBOOT.2C (ADR-0261): the Program Files boot smoke's pure
// decisions. The load-bearing cases: strict mode NEVER silently downgrades off Program Files (that
// silent downgrade is how the v1.12.0 gap survived), the win32 hardening is an inheritable DENY that
// covers the existing tree, and the restore removes exactly that deny so cleanup can delete the stage.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { SMOKE_LEAF, bootVerdict, hardenPlan, pickSmokeRoot, requiredLayout, restorePlan } from "./engine_pf_smoke.ts";

describe("pickSmokeRoot", () => {
  const base = { programFilesDir: "C:\\Program Files", tmpDir: "C:\\tmp" };

  test("prefers the real Program Files tree when writable", () => {
    const d = pickSmokeRoot({ ...base, strict: false, programFilesWritable: true });
    expect(d.programFiles).toBe(true);
    expect(d.root).toBe(join("C:\\Program Files", SMOKE_LEAF));
  });

  test("strict + Program Files unwritable THROWS - never a silent temp-dir downgrade", () => {
    expect(() => pickSmokeRoot({ ...base, strict: true, programFilesWritable: false })).toThrow(/strict/);
  });

  test("non-strict falls back to the hardened temp dir", () => {
    const d = pickSmokeRoot({ ...base, strict: false, programFilesWritable: false });
    expect(d.programFiles).toBe(false);
    expect(d.root).toBe(join("C:\\tmp", SMOKE_LEAF));
  });

  test("the override escape hatch wins and is never reported as Program Files", () => {
    const d = pickSmokeRoot({ ...base, strict: false, programFilesWritable: true, override: "D:\\scratch" });
    expect(d.programFiles).toBe(false);
    expect(d.root).toBe(join("D:\\scratch", SMOKE_LEAF));
  });

  test("the staged leaf keeps its space (quoting bugs around 'Program Files' are in scope)", () => {
    expect(SMOKE_LEAF).toContain(" ");
  });
});

describe("hardenPlan / restorePlan", () => {
  test("win32 hardening is an inheritable deny of write+delete applied to the whole existing tree", () => {
    const [cmd] = hardenPlan("C:\\Program Files\\X", "runner", "win32");
    expect(cmd[0]).toBe("icacls");
    expect(cmd).toContain("/deny");
    expect(cmd).toContain("runner:(OI)(CI)(WD,AD,WEA,WA,DE,DC)");
    expect(cmd).toContain("/T");
  });

  test("win32 hardening NEVER denies generic W (it includes SYNCHRONIZE, which EPERMs CreateProcess)", () => {
    const flat = hardenPlan("C:\\X", "runner", "win32").flat().join(" ");
    expect(flat).not.toMatch(/\((?:[A-Z]+,)*W(?:,[A-Z]+)*\)/);
  });

  test("win32 restore removes exactly the deny for that user (so the stage can be deleted)", () => {
    const [cmd] = restorePlan("C:\\Program Files\\X", "runner", "win32");
    expect(cmd).toContain("/remove:d");
    expect(cmd).toContain("runner");
    expect(cmd).toContain("/T");
  });

  test("POSIX uses the chmod equivalent (demo runs on a dev mac/linux too)", () => {
    expect(hardenPlan("/tmp/x", "u", "darwin")[0]).toEqual(["chmod", "-R", "a-w", "/tmp/x"]);
    expect(restorePlan("/tmp/x", "u", "linux")[0]).toEqual(["chmod", "-R", "u+w", "/tmp/x"]);
  });
});

describe("requiredLayout", () => {
  test("demands the compiled engine AND the prebuilt renderer bundle before a boot means anything", () => {
    const win = requiredLayout("win32");
    expect(win).toContain(join("bin", "lucid-engine.exe"));
    expect(win).toContain(join("desktop", "renderer", "app.bundle.js"));
    expect(requiredLayout("darwin")).toContain(join("bin", "lucid-engine"));
  });
});

describe("bootVerdict", () => {
  test("a healthy answer passes", () => {
    expect(bootVerdict({ health: '{"ok":true}', exitCode: null, stderrTail: "" }).ok).toBe(true);
  });
  test("an unparseable or not-ok health answer fails (never 'close enough')", () => {
    expect(bootVerdict({ health: "<html>proxy error</html>", exitCode: null, stderrTail: "" }).ok).toBe(false);
    expect(bootVerdict({ health: '{"ok":false}', exitCode: null, stderrTail: "" }).ok).toBe(false);
  });
  test("an early exit reports the code + stderr tail (the EPERM class must be legible)", () => {
    const v = bootVerdict({ health: null, exitCode: 1, stderrTail: "EPERM: operation not permitted" });
    expect(v.ok).toBe(false);
    expect(v.detail).toContain("code 1");
    expect(v.detail).toContain("EPERM");
  });
  test("a silent never-answered boot is a distinct verdict", () => {
    expect(bootVerdict({ health: null, exitCode: null, stderrTail: "" }).detail).toContain("never answered");
  });
});
