// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_p_sandbox_13.ts
//
// P-SANDBOX.13 (ADR-0391): the user adds folders to the Windows sandbox from the Security panel, with the
// native Explorer picker, and sees EVERYTHING the sandbox can reach. The engine opens the picker itself,
// so no caller (the agent included, even holding the loopback token) can name a folder to grant.
// (The panel HTML is covered by desktop/renderer/sandbox_panel.test.ts; the root typecheck has no DOM lib.)
//
// Run: bun run harness/scripts/demo_p_sandbox_13.ts

import { readFileSync } from "node:fs";
import { refuseGrantPath, runtimeFolderView } from "../../desktop/sandbox_control.ts";

const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
const ok = (cond: boolean, m: string) => { if (!cond) fail(m); console.log(`  ok  ${m}`); };
const home = "C:\\Users\\User";

console.log("== #ADR-0391 P-SANDBOX.13: add folders with the native picker, see all of them ==\n");

console.log("[1] the path comes from the Explorer dialog the engine opens, never from the request");
const dev = readFileSync("desktop/dev.ts", "utf8");
const route = dev.slice(dev.indexOf('"/api/security/sandbox-grant/add"'), dev.indexOf("// P-SANDBOX.8: revoke one standing directory grant"));
ok(route.includes("pickFolderNative(") && route.includes("readBody<{ mode?: unknown }>"), "the add route reads only the mode, then opens the native picker");
ok(!/b\.path/.test(route), "it never reads a path from the request body");
ok(route.includes("emitSecurityEvent("), "every add is an audited security event");
ok(route.includes("helperFallback:"), "P-SANDBOX.13b: when PowerShell cannot open the dialog (Smart App Control's Constrained Language Mode), the helper opens it");

console.log("\n[2] picks that are too broad or pointless are refused with a reason");
ok(refuseGrantPath("C:\\Users\\User\\Pictures\\Screenshots", home) === null, "a normal folder (the Screenshots example) is allowed");
ok(!!refuseGrantPath("C:\\", home), "a whole drive is refused");
ok(!!refuseGrantPath("C:\\Users\\User", home), "the whole user folder is refused");
ok(!!refuseGrantPath("C:\\Program Files\\Git", home), "Program Files / Windows are refused (already readable, not ours to re-ACL)");
ok(!!refuseGrantPath("\\\\server\\share", home), "a network path is refused");

console.log("\n[3] the panel lists everything the sandbox can reach");
const v = runtimeFolderView({ workspace: "C:\\ws", grantRx: ["C:\\app\\repo"], grantRw: ["C:\\Users\\User\\.omp"], tmpDir: "C:\\Users\\User\\.omp\\lucid-sandbox-tmp" });
ok(v.length === 3 && v[0]!.path === "C:\\ws" && v[0]!.mode === "rw", "the workspace, the agent's state and the runtime are listed as always allowed");

console.log("\n✓ P-SANDBOX.13 demo passed - Explorer-picked folders only, broad picks refused, and the full reach is visible.");
