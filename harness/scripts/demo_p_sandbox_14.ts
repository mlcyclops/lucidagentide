// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_p_sandbox_14.ts
//
// P-SANDBOX.14 (ADR-0394): enterprise policy for the Windows sandbox the user controls from the Security
// panel. Four keys under HKLM\Software\Policies\LucidAgentIDE (or security.sandbox in the policy file):
//   SandboxAllowUserOff=0      the switch stays on (no fail-closed exec block, unlike ExecRequireIsolation);
//   SandboxReadFolders         admin-approved read-only folders, applied at every contained spawn;
//   SandboxReadWriteFolders    admin-approved read-write folders;
//   SandboxLockFolders=1       users and the agent cannot add folders; revoking still works.
//
// Run: bun run harness/scripts/demo_p_sandbox_14.ts

import { managedSandboxFolders, managedSandboxFoldersLocked, managedSandboxLocksOn, parseRegistryPolicy } from "../../desktop/managed_config.ts";
import { planModeChange, policyFolderPlan, refuseUserFolderAdd, runtimeFolderView, sandboxControlView, userTurnedSandboxOff } from "../../desktop/sandbox_control.ts";

const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
const ok = (cond: boolean, m: string) => { if (!cond) fail(m); console.log(`  ok  ${m}`); };

console.log("== #ADR-0394 P-SANDBOX.14: enterprise policy for the Windows sandbox ==\n");

const cfg = parseRegistryPolicy([
  "HKEY_LOCAL_MACHINE\\Software\\Policies\\LucidAgentIDE",
  "    SandboxAllowUserOff    REG_DWORD    0x0",
  "    SandboxReadFolders    REG_MULTI_SZ    %USERPROFILE%\\Documents\\Specs\\0C:\\",
  "    SandboxReadWriteFolders    REG_SZ    D:\\scratch",
  "    SandboxLockFolders    REG_DWORD    0x1",
].join("\r\n"));

console.log("[1] the GPO keys parse");
ok(cfg?.security?.sandbox?.allowUserOff === false && cfg.security.sandbox.lockUserFolders === true, "SandboxAllowUserOff and SandboxLockFolders land in security.sandbox");
ok(managedSandboxFolders(cfg).read.length === 2 && managedSandboxFolders(cfg).readWrite[0] === "D:\\scratch", "the folder lists land as written (expanded per user later)");
ok(!managedSandboxLocksOn(null) && !managedSandboxFoldersLocked(null), "unmanaged: the switch and the folders stay the user's");

console.log("\n[2] the switch stays on");
const view = sandboxControlView({ platform: "win32", helperBundled: true, mode: "off", policyRequiresIsolation: managedSandboxLocksOn(cfg), registered: true, foldersLocked: managedSandboxFoldersLocked(cfg) });
ok(view.policyLocked && !view.userOff, "a saved Off is not honored under the policy");
ok(!userTurnedSandboxOff("off", managedSandboxLocksOn(cfg)), "the next agent spawn stays inside the AppContainer");
ok(planModeChange({ mode: "off" }, view).action === "refuse", "Turn off is refused");

console.log("\n[3] the admin's folders ride every contained spawn, bounded like a user's pick");
const plan = policyFolderPlan({ ...managedSandboxFolders(cfg), env: { USERPROFILE: "C:\\Users\\U" }, home: "C:\\Users\\U", isDir: () => true });
ok(plan.grantRx.join() === "C:\\Users\\U\\Documents\\Specs" && plan.grantRw.join() === "D:\\scratch", "%USERPROFILE% expands per user; read and read-write sort into their grants");
ok(plan.skipped.length === 1 && plan.skipped[0]!.entry === "C:\\" && plan.skipped[0]!.why.includes("whole drive"), "a drive root is refused even from policy, and the skip is explained");
const listed = runtimeFolderView({ workspace: "C:\\ws", grantRx: [], grantRw: [], tmpDir: "C:\\t", policy: plan });
ok(listed.filter((f) => f.why.includes("organization")).length === 2, "the panel lists them as your organization's");

console.log("\n[4] users and the agent cannot add their own");
ok((refuseUserFolderAdd(view) ?? "").includes("organization"), "Add folder is refused before any dialog opens (the panel shows a note, not buttons)");

console.log("\n✓ P-SANDBOX.14 demo passed - the switch can be locked on, admin folders apply at every spawn within the same bounds, and user folder adds can be locked.");
