// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/mxc_runtime.test.ts - P-MXC.1 (ADR-0441): executor resolution, pin verification on disk, the
// --probe reading, and the one elevated prep script. No executor is spawned here.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MXC_ASSETS } from "../harness/runs/mxc_assets.ts";
import { mxcHostPrepScript, parseMxcProbe, resolveMxcDir, verifiedMxcExecutors } from "./mxc_runtime.ts";
import { mxcHostPrepSteps, sandboxControlView } from "./sandbox_control.ts";

const scratch = mkdtempSync(join(tmpdir(), "lucid-mxc-rt-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("resolveMxcDir", () => {
  const files = new Set<string>();
  const exists = (p: string) => files.has(p.replace(/\\/g, "/").toLowerCase());
  const have = (dir: string) => { for (const n of ["wxc-exec.exe", "wxc-host-prep.exe"]) files.add(join(dir, n).replace(/\\/g, "/").toLowerCase()); };

  test("env override, then the bundle, then the dev stage; a dir missing either file does not count", () => {
    files.clear();
    have("C:/res/mxc/win32-x64");
    have("C:/home/.omp/mxc/win32-x64");
    const base = { env: {}, resourcesPath: "C:/res", home: "C:/home", platform: "win32" as const, arch: "x64", exists };
    expect(resolveMxcDir(base)?.source).toBe("bundled");
    expect(resolveMxcDir({ ...base, resourcesPath: undefined })?.source).toBe("staged");
    files.add("c:/override/wxc-exec.exe"); // only one of the two files
    expect(resolveMxcDir({ ...base, env: { LUCID_MXC_DIR: "C:/override" } })?.source).toBe("bundled");
    have("C:/override");
    expect(resolveMxcDir({ ...base, env: { LUCID_MXC_DIR: "C:/override" } })).toEqual({ dir: "C:/override", source: "env" });
  });
  test("no pinned executors off Windows or on an unpinned arch", () => {
    files.clear(); have("C:/res/mxc/win32-x64");
    expect(resolveMxcDir({ env: {}, resourcesPath: "C:/res", home: "C:/home", platform: "linux", arch: "x64", exists })).toBeNull();
    expect(resolveMxcDir({ env: {}, resourcesPath: "C:/res", home: "C:/home", platform: "win32", arch: "ia32", exists })).toBeNull();
  });
});

describe("verifiedMxcExecutors", () => {
  test("a file whose bytes do not match the pin makes the whole dir unusable, named with both hashes", () => {
    const dir = join(scratch, "bad");
    const spec = MXC_ASSETS.find((a) => a.platform === "win32-x64" && a.name === "wxc-exec.exe")!;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "wxc-exec.exe"), Buffer.alloc(spec.bytes, 1)); // right size, wrong bytes
    writeFileSync(join(dir, "wxc-host-prep.exe"), "x");
    const v = verifiedMxcExecutors({ dir, source: "staged" }, "win32", "x64");
    expect(v.ok).toBe(false);
    if (!v.ok) { expect(v.reason).toContain("wxc-exec.exe"); expect(v.reason).toContain(spec.sha256); }
  });
  test("a missing file is a reason, not a throw", () => {
    const v = verifiedMxcExecutors({ dir: join(scratch, "absent"), source: "staged" }, "win32", "x64");
    expect(v.ok).toBe(false);
  });
});

describe("parseMxcProbe", () => {
  test("reads the tier and turns the two host-prep warnings into steps", () => {
    const p = parseMxcProbe(JSON.stringify({ tier: "appcontainer-dacl", warnings: ["BaseContainer tier not selected ... falling back", "... Run `wxc-host-prep prepare-system-drive` (elevated) ...", "... Run `wxc-host-prep prepare-null-device` (elevated) ..."] }));
    expect(p?.tier).toBe("appcontainer-dacl");
    expect(p?.prepNeeded).toEqual(["prepare-system-drive", "prepare-null-device"]);
    expect(parseMxcProbe(JSON.stringify({ tier: "base-container", warnings: [] }))).toEqual({ tier: "base-container", prepNeeded: [], warnings: [] });
    expect(parseMxcProbe("{}")).toBeNull();
  });
});

describe("the elevated prep script and the panel's step plan", () => {
  test("runs only the steps still needed, quoting the prep path, and exits non-zero if any step failed", () => {
    const s = mxcHostPrepScript("C:\\Program Files\\L'UCID\\wxc-host-prep.exe", { systemDrive: true, nullDevice: false, loopback: true });
    expect(s).toContain("& 'C:\\Program Files\\L''UCID\\wxc-host-prep.exe' prepare-system-drive");
    expect(s).not.toContain("prepare-null-device");
    expect(s).toContain("CheckNetIsolation.exe LoopbackExempt -a -n=LucidAgentIDE.Sandbox.v1");
    expect(s.endsWith("exit $ec")).toBe(true);
  });
  test("mxcHostPrepSteps: null when not staged or nothing pending; the switch is available with MXC alone", () => {
    const none = sandboxControlView({ platform: "win32", helperBundled: false, policyRequiresIsolation: false, registered: false, mxc: { staged: false, prepNeeded: [], loopbackNeeded: false } });
    expect(none.available).toBe(false);
    expect(mxcHostPrepSteps(none)).toBeNull();
    const ready = sandboxControlView({ platform: "win32", helperBundled: false, policyRequiresIsolation: false, registered: true, mxc: { staged: true, tier: "base-container", prepNeeded: [], loopbackNeeded: false } });
    expect(ready.available).toBe(true);
    expect(mxcHostPrepSteps(ready)).toBeNull();
    const pending = sandboxControlView({ platform: "win32", helperBundled: false, policyRequiresIsolation: false, registered: false, mxc: { staged: true, tier: "appcontainer-dacl", prepNeeded: ["prepare-null-device"], loopbackNeeded: true } });
    expect(mxcHostPrepSteps(pending)).toEqual({ systemDrive: false, nullDevice: true, loopback: true });
  });
});
