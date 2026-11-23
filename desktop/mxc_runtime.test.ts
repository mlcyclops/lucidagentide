// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/mxc_runtime.test.ts - P-MXC.1 (ADR-0441): executor resolution, pin verification on disk, the
// --probe reading, and the one elevated prep script. No executor is spawned here.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MXC_ASSETS } from "../harness/runs/mxc_assets.ts";
import { MXC_BOOT_DIR_NAME, MXC_BOOT_TASK, mxcBootPrepPath, mxcHost, mxcHostPrepScript, mxcOffer, mxcRoundTripDetail, parseMxcProbe, resolveMxcDir, verifiedMxcExecutors, type MxcDir, type MxcHostIo, type MxcHostResult, type MxcProbe } from "./mxc_runtime.ts";
import { mxcHostPrepSteps, sandboxControlView } from "./sandbox_control.ts";

const PREP_SHA = MXC_ASSETS.find((a) => a.platform === "win32-x64" && a.name === "wxc-host-prep.exe")!.sha256;

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
    const s = mxcHostPrepScript("C:\\Program Files\\L'UCID\\wxc-host-prep.exe", { systemDrive: true, nullDevice: false, loopback: true, bootTask: false }, PREP_SHA);
    expect(s).toContain("& 'C:\\Program Files\\L''UCID\\wxc-host-prep.exe' prepare-system-drive");
    expect(s).not.toContain("prepare-null-device");
    expect(s).not.toContain("Register-ScheduledTask");
    expect(s).toContain("CheckNetIsolation.exe LoopbackExempt -a -n=LucidAgentIDE.Sandbox.v1");
    expect(s.endsWith("exit $ec")).toBe(true);
  });
  test("P-SANDBOX.WIN1: the NUL step also registers the boot task, at a pinned admin-only copy, replaced if present", () => {
    const s = mxcHostPrepScript("C:\\Users\\a\\.omp\\mxc\\win32-x64\\wxc-host-prep.exe", { systemDrive: false, nullDevice: true, loopback: false, bootTask: true }, PREP_SHA);
    expect(s).toContain("& 'C:\\Users\\a\\.omp\\mxc\\win32-x64\\wxc-host-prep.exe' prepare-null-device --quiet");
    expect(s).toContain(`$bd = Join-Path $env:ProgramFiles '${MXC_BOOT_DIR_NAME}'`);
    expect(s).toContain("Copy-Item -LiteralPath 'C:\\Users\\a\\.omp\\mxc\\win32-x64\\wxc-host-prep.exe' -Destination $bp -Force");
    expect(s).toContain(`(Get-FileHash -LiteralPath $bp -Algorithm SHA256).Hash -ne '${PREP_SHA}'`);
    expect(s).toContain("New-ScheduledTaskAction -Execute $bp -Argument 'prepare-null-device --quiet'");
    expect(s).toContain("New-ScheduledTaskTrigger -AtStartup");
    expect(s).toContain("New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest");
    expect(s).toContain(`Register-ScheduledTask -TaskName '${MXC_BOOT_TASK}' -Action $ta -Trigger $tt -Principal $tp -Force`);
    expect(s).toContain("catch { $ec = 5 }");
    // the task runs the stable copy, never the per-user source path
    expect(s).not.toMatch(/-Execute '/);
    expect(s).not.toContain('"'); // travels as one Start-Process argument: single quotes only
    expect(s.endsWith("exit $ec")).toBe(true);
  });
  test("P-SANDBOX.WIN1: a path cannot close the literal, typographic quotes included; a bad pin is refused", () => {
    const evil = "C:\\x\u2019; Remove-Item C:\\ -Recurse; \u2018'\\wxc-host-prep.exe";
    const s = mxcHostPrepScript(evil, { systemDrive: false, nullDevice: true, loopback: false, bootTask: true }, PREP_SHA);
    expect(s).toContain("& 'C:\\x\u2019\u2019; Remove-Item C:\\ -Recurse; \u2018\u2018''\\wxc-host-prep.exe' prepare-null-device");
    expect(() => mxcHostPrepScript("C:\\p.exe", { systemDrive: false, nullDevice: true, loopback: false, bootTask: true }, "abc'; whoami")).toThrow();
    expect(mxcBootPrepPath("C:\\Program Files")).toBe(join("C:\\Program Files", MXC_BOOT_DIR_NAME, "wxc-host-prep.exe"));
  });
  test("mxcHostPrepSteps: null when not staged or nothing pending; the switch is available with MXC alone", () => {
    const none = sandboxControlView({ platform: "win32", helperBundled: false, policyRequiresIsolation: false, registered: false, mxc: { staged: false, prepNeeded: [], loopbackNeeded: false } });
    expect(none.available).toBe(false);
    expect(mxcHostPrepSteps(none)).toBeNull();
    const ready = sandboxControlView({ platform: "win32", helperBundled: false, policyRequiresIsolation: false, registered: true, mxc: { staged: true, tier: "base-container", prepNeeded: [], loopbackNeeded: false } });
    expect(ready.available).toBe(true);
    expect(mxcHostPrepSteps(ready)).toBeNull();
    const pending = sandboxControlView({ platform: "win32", helperBundled: false, policyRequiresIsolation: false, registered: false, mxc: { staged: true, tier: "appcontainer-dacl", prepNeeded: ["prepare-null-device"], loopbackNeeded: true } });
    expect(mxcHostPrepSteps(pending)).toEqual({ systemDrive: false, nullDevice: true, loopback: true, bootTask: true });
    // the boot task never opens a prompt by itself: no NUL step pending, no task step
    const drive = sandboxControlView({ platform: "win32", helperBundled: false, policyRequiresIsolation: false, registered: true, mxc: { staged: true, tier: "appcontainer-dacl", prepNeeded: ["prepare-system-drive"], loopbackNeeded: false, bootTask: false } });
    expect(mxcHostPrepSteps(drive)).toEqual({ systemDrive: true, nullDevice: false, loopback: false, bootTask: false });
    const booted = sandboxControlView({ platform: "win32", helperBundled: false, policyRequiresIsolation: false, registered: true, mxc: { staged: true, tier: "appcontainer-dacl", prepNeeded: [], loopbackNeeded: false, bootTask: false } });
    expect(mxcHostPrepSteps(booted)).toBeNull();
  });
});

describe("P-SANDBOX.WIN1: the concrete reason and the prep gate", () => {
  const dir: MxcDir = { dir: "C:\\mxc", source: "staged" };
  const executors = { exe: "C:\\mxc\\wxc-exec.exe", prep: "C:\\mxc\\wxc-host-prep.exe", prepSha256: PREP_SHA, platform: "win32-x64" as const, source: "staged" as const };
  const dacl = (prepNeeded: MxcProbe["prepNeeded"]): MxcProbe => ({ tier: "appcontainer-dacl", prepNeeded, warnings: [] });
  const io = (o: Partial<MxcHostIo>): MxcHostIo => ({
    candidates: [{ dir: "C:\\res\\mxc\\win32-x64", source: "bundled" }, { dir: "C:\\home\\.omp\\mxc\\win32-x64", source: "staged" }],
    resolveDir: () => dir,
    verify: () => ({ ok: true, executors }),
    readProbe: () => dacl([]),
    ...o,
  });

  test("not staged names every dir searched; refused carries the pin reason; a silent --probe says so", () => {
    const none = mxcHost({}, io({ resolveDir: () => null }));
    expect(none.host).toBeNull();
    if (!none.host) {
      expect(none.fallback.kind).toBe("mxc-not-staged");
      expect(none.fallback.detail).toContain("MXC not staged at C:\\res\\mxc\\win32-x64, C:\\home\\.omp\\mxc\\win32-x64");
    }
    const refused = mxcHost({}, io({ verify: () => ({ ok: false, reason: "win32-x64/wxc-exec.exe: sha256 aa does not match the pinned bb" }) }));
    expect(!refused.host && refused.fallback).toEqual({ kind: "mxc-refused", detail: "MXC executor refused: win32-x64/wxc-exec.exe: sha256 aa does not match the pinned bb" });
    const mute = mxcHost({}, io({ readProbe: () => null }));
    expect(!mute.host && mute.fallback.kind).toBe("mxc-no-probe");
    expect(!mute.host && mute.fallback.detail).toContain("MXC --probe did not answer");
    const ok = mxcHost({}, io({}));
    expect(ok.host?.exe).toBe(executors.exe);
  });

  test("prep pending answers at once and NEVER runs the round trip; loopback is the next gate; then offered", () => {
    let roundTrips = 0;
    const withProbe = (p: MxcProbe): MxcHostResult => ({ host: { exe: executors.exe, tier: p.tier, probe: () => { roundTrips++; return true; } }, executors, probe: p });
    const pending = mxcOffer(withProbe(dacl(["prepare-system-drive", "prepare-null-device"])), { needsNetwork: true, loopbackExempted: () => { throw new Error("not read when prep is pending"); } });
    expect(pending).toEqual({ fallback: { kind: "mxc-prep-pending", detail: "MXC staged but host prep pending: prepare-system-drive, prepare-null-device" } });
    const loop = mxcOffer(withProbe(dacl([])), { needsNetwork: true, loopbackExempted: () => false });
    expect("fallback" in loop && loop.fallback.kind).toBe("mxc-loopback");
    expect("mxc" in mxcOffer(withProbe({ tier: "base-container", prepNeeded: [], warnings: [] }), { needsNetwork: true, loopbackExempted: () => false })).toBe(true);
    expect("mxc" in mxcOffer(withProbe(dacl([])), { needsNetwork: false, loopbackExempted: () => false })).toBe(true);
    const missing = mxcOffer(mxcHost({}, io({ resolveDir: () => null })), { needsNetwork: true, loopbackExempted: () => true });
    expect("fallback" in missing && missing.fallback.kind).toBe("mxc-not-staged");
    expect(roundTrips).toBe(0);
  });

  test("a failed round trip is described by what was measured", () => {
    expect(mxcRoundTripDetail({ exitCode: null, stdout: "", stderr: "" })).toBe("no exit code (timed out after 30 s)");
    expect(mxcRoundTripDetail({ exitCode: 0, stdout: "", stderr: "" })).toBe("exit 0 but the marker never came back through stdout");
    expect(mxcRoundTripDetail({ exitCode: 5, stdout: "", stderr: "  Access is\r\n denied. " })).toBe("exit 5: Access is denied.");
  });
});
