// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/sandbox_control.test.ts - P-SANDBOX.12 (ADR-0390): the sandbox switch and the policy bounding it.

import { expect, test } from "bun:test";
import { planModeChange, sandboxControlView, userTurnedSandboxOff } from "./sandbox_control.ts";

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
