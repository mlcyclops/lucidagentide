// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/sandbox_control.test.ts - P-SANDBOX.12 (ADR-0390): the sandbox switch and the policy bounding it.

import { expect, test } from "bun:test";
import { planModeChange, refuseGrantPath, runtimeFolderView, sandboxControlView, userTurnedSandboxOff } from "./sandbox_control.ts";

const win = (o: Partial<Parameters<typeof sandboxControlView>[0]> = {}) =>
  sandboxControlView({ platform: "win32", helperBundled: true, mode: "auto", policyRequiresIsolation: false, registered: true, ...o });

test("the switch exists only on Windows with the helper bundled", () => {
  expect(win().available).toBe(true);
  expect(win({ helperBundled: false }).available).toBe(false);
  expect(sandboxControlView({ platform: "linux", helperBundled: true, mode: "off", policyRequiresIsolation: false, registered: true })).toEqual({ available: false, userOff: false, policyLocked: false, registered: false });
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
