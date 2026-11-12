// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/sandbox_control.test.ts - P-SANDBOX.12 (ADR-0390): the sandbox switch and the policy bounding it.

import { expect, test } from "bun:test";
import { expandPolicyPath, planModeChange, policyFolderPlan, refuseGrantPath, refuseUserFolderAdd, runtimeFolderView, sandboxControlView, userTurnedSandboxOff } from "./sandbox_control.ts";
import { managedSandboxFolders, managedSandboxFoldersLocked, managedSandboxLocksOn, mergeManaged, parseRegistryPolicy } from "./managed_config.ts";

const win = (o: Partial<Parameters<typeof sandboxControlView>[0]> = {}) =>
  sandboxControlView({ platform: "win32", helperBundled: true, mode: "auto", policyRequiresIsolation: false, registered: true, ...o });

test("the switch exists only on Windows with the helper bundled", () => {
  expect(win().available).toBe(true);
  expect(win({ helperBundled: false }).available).toBe(false);
  expect(sandboxControlView({ platform: "linux", helperBundled: true, mode: "off", policyRequiresIsolation: false, registered: true })).toEqual({ available: false, userOff: false, policyLocked: false, registered: false, foldersLocked: false });
});

test("managed require-isolation wins over the user's Off, in the view and at spawn", () => {
  expect(win({ mode: "off" }).userOff).toBe(true);
  expect(win({ mode: "off", policyRequiresIsolation: true }).userOff).toBe(false);
  expect(userTurnedSandboxOff("off", false)).toBe(true);
  expect(userTurnedSandboxOff("off", true)).toBe(false);
  expect(userTurnedSandboxOff(undefined, false)).toBe(false);
  expect(userTurnedSandboxOff("auto", false)).toBe(false);
});

test("Off never needs admin; policy refuses it with a sentence the panel can show", () => {
  expect(planModeChange({ mode: "off" }, win())).toEqual({ action: "set-off" });
  const locked = planModeChange({ mode: "off" }, win({ policyRequiresIsolation: true }));
  expect(locked.action).toBe("refuse");
  if (locked.action === "refuse") expect(locked.reason).toContain("policy");
});

test("On registers the loopback exemption first only when it is missing", () => {
  expect(planModeChange({ mode: "auto" }, win({ mode: "off", registered: true }))).toEqual({ action: "set-on", registerFirst: false });
  expect(planModeChange({ mode: "auto" }, win({ mode: "off", registered: false }))).toEqual({ action: "set-on", registerFirst: true });
});

test("Remove from Windows: only once the user turned it off, never against policy", () => {
  expect(planModeChange({ mode: "unregister" }, win({ mode: "off" }))).toEqual({ action: "unregister" });
  expect(planModeChange({ mode: "unregister" }, win()).action).toBe("refuse"); // still on
  expect(planModeChange({ mode: "unregister" }, win({ mode: "off", policyRequiresIsolation: true })).action).toBe("refuse");
  expect(planModeChange({ mode: "off" }, win({ helperBundled: false })).action).toBe("refuse");
});

// ── P-SANDBOX.13 (ADR-0391): user-added folders ──
test("refuseGrantPath allows a normal folder and refuses the too-broad or pointless picks", () => {
  const home = "C:\\Users\\User";
  expect(refuseGrantPath("C:\\Users\\User\\Pictures\\Screenshots", home)).toBeNull();
  expect(refuseGrantPath("D:\\data\\", home)).toBeNull();
  expect(refuseGrantPath("C:\\", home)).toContain("whole drive");
  expect(refuseGrantPath("c:", home)).toContain("whole drive");
  expect(refuseGrantPath("c:\\users\\user\\", home)).toContain("whole user folder");
  expect(refuseGrantPath("C:\\Windows\\System32", home)).toContain("already readable");
  expect(refuseGrantPath("C:\\Program Files (x86)\\Tool", home)).toContain("already readable");
  expect(refuseGrantPath("\\\\server\\share\\x", home)).toContain("network");
  expect(refuseGrantPath("relative\\dir", home)).toContain("local drive");
});

test("runtimeFolderView lists the workspace, the agent's state and the runtime, without the temp dir", () => {
  const v = runtimeFolderView({ workspace: "C:\\ws", grantRx: ["C:\\app\\repo", "C:\\Users\\U\\AppData\\Local\\Programs\\MinGit"], grantRw: ["C:\\Users\\U\\.omp"], tmpDir: "C:\\Users\\U\\.omp\\lucid-sandbox-tmp" });
  expect(v.map((f) => `${f.mode} ${f.path}`)).toEqual(["rw C:\\ws", "rw C:\\Users\\U\\.omp", "rx C:\\app\\repo", "rx C:\\Users\\U\\AppData\\Local\\Programs\\MinGit"]);
  expect(v.every((f) => f.why.length > 0)).toBe(true);
});

// ── P-SANDBOX.14 (ADR-0394): enterprise policy for the switch and the folders ──
test("GPO values parse into security.sandbox, and either knob keeps the switch on", () => {
  const cfg = parseRegistryPolicy([
    "HKEY_LOCAL_MACHINE\\Software\\Policies\\LucidAgentIDE",
    "    SandboxAllowUserOff    REG_DWORD    0x0",
    "    SandboxReadFolders    REG_MULTI_SZ    %USERPROFILE%\\Documents\\Specs\\0D:\\shared\\refdata",
    "    SandboxReadWriteFolders    REG_SZ    D:\\scratch",
    "    SandboxLockFolders    REG_DWORD    0x1",
  ].join("\r\n"));
  expect(cfg?.security?.sandbox).toEqual({ allowUserOff: false, readFolders: ["%USERPROFILE%\\Documents\\Specs", "D:\\shared\\refdata"], readWriteFolders: ["D:\\scratch"], lockUserFolders: true });
  expect(managedSandboxLocksOn(cfg)).toBe(true);
  expect(managedSandboxFoldersLocked(cfg)).toBe(true);
  expect(managedSandboxLocksOn({ security: { exec: { requireIsolation: true } } })).toBe(true);
  expect(managedSandboxLocksOn({ security: { sandbox: { allowUserOff: true } } })).toBe(false);
  expect(managedSandboxLocksOn(null) || managedSandboxFoldersLocked(null)).toBe(false); // unmanaged: the user's
  expect(managedSandboxFolders(null)).toEqual({ read: [], readWrite: [] });
  expect(managedSandboxFolders({ security: { sandbox: { readFolders: ["C:\\a", 7 as unknown as string, " "] } } }).read).toEqual(["C:\\a"]);
});

test("a policy file can override one sandbox knob without wiping the registry's others", () => {
  const m = mergeManaged({ security: { sandbox: { allowUserOff: false, readFolders: ["C:\\a"] } } }, { security: { sandbox: { lockUserFolders: true } } });
  expect(m?.security?.sandbox).toEqual({ allowUserOff: false, readFolders: ["C:\\a"], lockUserFolders: true });
});

test("allowUserOff=false locks the switch like require-isolation: Off is refused and not honored", () => {
  const v = win({ mode: "off", policyRequiresIsolation: managedSandboxLocksOn({ security: { sandbox: { allowUserOff: false } } }) });
  expect(v.policyLocked).toBe(true);
  expect(v.userOff).toBe(false);
  expect(planModeChange({ mode: "off" }, v).action).toBe("refuse");
  expect(userTurnedSandboxOff("off", true)).toBe(false);
});

test("lockUserFolders refuses user folder adds; unlocked and available allows them", () => {
  expect(refuseUserFolderAdd(win())).toBeNull();
  expect(refuseUserFolderAdd(win({ foldersLocked: true }))).toContain("organization");
  expect(refuseUserFolderAdd(win({ helperBundled: false }))).toContain("not available");
});

test("expandPolicyPath expands %VAR% case-insensitively and ~, and refuses an unset variable", () => {
  const env = { USERPROFILE: "C:\\Users\\U", Share: "D:\\s" };
  expect(expandPolicyPath("%userprofile%\\Documents\\Specs\\", env, "C:\\Users\\U")).toBe("C:\\Users\\U\\Documents\\Specs");
  expect(expandPolicyPath("%SHARE%/ref", env, "C:\\Users\\U")).toBe("D:\\s\\ref");
  expect(expandPolicyPath("~\\Pictures", env, "C:\\Users\\U")).toBe("C:\\Users\\U\\Pictures");
  expect(expandPolicyPath("%NOPE%\\x", env, "C:\\Users\\U")).toBeNull();
  expect(expandPolicyPath("  ", env, "C:\\Users\\U")).toBeNull();
});

test("policyFolderPlan: bounded like user picks, missing folders skipped, rw wins over rx, every skip explained", () => {
  const exists = new Set(["c:\\users\\u\\documents\\specs", "d:\\scratch", "d:\\both"]);
  const plan = policyFolderPlan({
    read: ["%USERPROFILE%\\Documents\\Specs", "D:\\both", "C:\\", "%USERPROFILE%", "C:\\Windows", "D:\\gone", "%UNSET%\\x"],
    readWrite: ["D:\\scratch", "d:\\both\\"],
    env: { USERPROFILE: "C:\\Users\\U" },
    home: "C:\\Users\\U",
    isDir: (p) => exists.has(p.toLowerCase()),
  });
  expect(plan.grantRw).toEqual(["D:\\scratch", "d:\\both"]);
  expect(plan.grantRx).toEqual(["C:\\Users\\U\\Documents\\Specs"]);
  expect(plan.skipped.map((s) => s.entry)).toEqual(["C:\\", "%USERPROFILE%", "C:\\Windows", "D:\\gone", "%UNSET%\\x"]);
  expect(plan.skipped.every((s) => s.why.length > 0)).toBe(true);
});

test("runtimeFolderView labels the policy folders as your organization's", () => {
  const v = runtimeFolderView({ workspace: "C:\\ws", grantRx: [], grantRw: [], tmpDir: "C:\\t", policy: { grantRx: ["D:\\ref"], grantRw: ["D:\\scratch"], skipped: [] } });
  expect(v.map((f) => `${f.mode} ${f.path}`)).toEqual(["rw C:\\ws", "rw D:\\scratch", "rx D:\\ref"]);
  expect(v[1]!.why).toContain("organization");
});
