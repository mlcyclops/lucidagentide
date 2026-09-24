// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_p_sandbox_12.ts
//
// P-SANDBOX.12 (ADR-0390): the Security panel's Windows sandbox switch. Off is a per-user LUCID setting
// (no admin, honored at the next agent spawn); On registers the one-time loopback exemption behind UAC
// when it is missing; "Remove from Windows" unregisters it. Managed require-isolation locks the switch.
//
// Run: bun run harness/scripts/demo_p_sandbox_12.ts

import { planModeChange, sandboxControlView, userTurnedSandboxOff } from "../../desktop/sandbox_control.ts";
// (The panel HTML is covered by desktop/renderer/sandbox_panel.test.ts: renderer modules need the DOM lib,
// which the root harness typecheck deliberately does not load.)

const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
const ok = (cond: boolean, m: string) => { if (!cond) fail(m); console.log(`  ok  ${m}`); };
const view = (o: Partial<Parameters<typeof sandboxControlView>[0]> = {}) =>
  sandboxControlView({ platform: "win32", helperBundled: true, mode: "auto", policyRequiresIsolation: false, registered: true, ...o });

console.log("== #ADR-0390 P-SANDBOX.12: the Windows sandbox switch ==\n");

console.log("[1] Off is the user's to take, without admin");
ok(planModeChange({ mode: "off" }, view()).action === "set-off", "Turn off -> a LUCID setting, no UAC");
ok(userTurnedSandboxOff("off", false), "the next agent spawn honors it (disclosed passthrough)");
ok(!view().userOff && view().available, "while on, the panel's view offers Turn off");

console.log("\n[2] On asks Windows for admin only when the loopback exemption is missing");
ok(JSON.stringify(planModeChange({ mode: "auto" }, view({ mode: "off", registered: false }))) === JSON.stringify({ action: "set-on", registerFirst: true }), "missing exemption -> register behind UAC, then on");
ok(JSON.stringify(planModeChange({ mode: "auto" }, view({ mode: "off" }))) === JSON.stringify({ action: "set-on", registerFirst: false }), "exemption present -> just on");
ok(view({ mode: "off" }).userOff && view({ mode: "off" }).registered, "while off and registered, the view carries what Remove from Windows needs");

console.log("\n[3] Enterprise policy wins");
ok(!userTurnedSandboxOff("off", true), "managed require-isolation: the user's Off is not honored at spawn");
ok(planModeChange({ mode: "off" }, view({ policyRequiresIsolation: true })).action === "refuse", "and the Off request is refused");
ok(view({ policyRequiresIsolation: true }).policyLocked && !view({ mode: "off", policyRequiresIsolation: true }).userOff, "the view is policy-locked (the panel renders a note, no button)");

console.log("\n✓ P-SANDBOX.12 demo passed - Off without admin, On with one UAC prompt when needed, Remove from Windows, and managed policy locks it.");
