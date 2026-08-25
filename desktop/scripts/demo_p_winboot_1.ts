// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Increment P-WINBOOT.1 - Windows installed-app startup hardening (ADR-0250).
//
// v1.12.0 for Windows showed a blank window for 30 seconds when installed under C:\Program Files:
// main.ts spawns `bun run desktop/dev.ts` from <resources>/repo, and Bun's module loader EPERMs
// loading TypeScript out of that ACL-protected tree, so the engine dies before binding port 5319.
// The portable build worked only because it runs from a user-owned directory.
//
// This proves the fix end to end: (1) the pure classifier turns that dead-end into an immediate,
// actionable "reinstall per-user / run portable" dialog and distinguishes it from a plain crash or a
// still-starting engine; (2) main.ts is wired to detect the early exit + protected location and no
// longer waits the full 30s; (3) the installer posture. ADR-0250 originally CLAMPED the installer
// away from Program Files as a mitigation; ADR-0262 relaxed it (assisted installer, per-user default,
// per-machine allowed) once the compiled engine (ADR-0251) plus the strict CI boot gate (ADR-0261)
// made a protected-tree boot a proven, regression-gated property. Section [5] pins that posture AND
// its justification: the gate must stay wired, or this demo goes red.
//
// Run with: bun run desktop/scripts/demo_p_winboot_1.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bestEngineLine, classifyEngineFailure, isProtectedInstallRoot, probeDirWritable, type EngineFailureInput, type WriteProbe } from "../engine_boot.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) { console.error("  \u2717 " + msg); process.exit(1); }
  console.log("  \u2713 " + msg);
}

console.log("== #ADR-0250 P-WINBOOT.1: Windows installed-app startup hardening ==\n");

const PROGRAM_FILES = "C:\\Program Files\\LucidAgentIDE\\resources\\repo";
const PER_USER = "C:\\Users\\me\\AppData\\Local\\Programs\\LucidAgentIDE\\resources\\repo";
const failInput: EngineFailureInput = {
  packaged: true, repoRoot: PER_USER, repoWritable: true, protectedRoot: false,
  exited: false, exitCode: null, lastLogLine: "", port: 5319,
  logPath: "C:\\Users\\me\\AppData\\Roaming\\lucidagentide-desktop\\engine.log", platform: "win32",
};

console.log("[1] the exact field failure is diagnosed, not mislabeled as a generic timeout");
const eperm = 'error: EPERM reading "C:\\Program Files\\LucidAgentIDE\\resources\\repo\\desktop\\dev.ts"';
const rProtected = classifyEngineFailure({ ...failInput, repoRoot: PROGRAM_FILES, protectedRoot: true, exited: true, exitCode: 1, lastLogLine: eperm });
assert(rProtected.kind === "protected-location", "a Program Files install is diagnosed as a protected-location failure");
assert(rProtected.detail.includes(PROGRAM_FILES), "the dialog names the actual broken install folder");
assert(rProtected.detail.includes("%LOCALAPPDATA%\\Programs\\LucidAgentIDE") && rProtected.detail.toLowerCase().includes("portable"), "it offers the two real fixes: reinstall per-user, or run portable");
assert(bestEngineLine("hdr\n" + eperm + "\n\nBun v1.3.14 (Windows x64)\n") === eperm, "the EPERM line is surfaced as the last engine message, not the trailing 'Bun v...' noise");

console.log("\n[2] a failed write probe or a permission signal alone is enough (no path guess needed)");
assert(classifyEngineFailure({ ...failInput, repoWritable: false }).kind === "protected-location", "an unwritable engine dir is treated as protected even when the path looks ordinary");
assert(classifyEngineFailure({ ...failInput, lastLogLine: eperm }).kind === "protected-location", "an EPERM/EACCES signal in the log is treated as protected");
const throwing: WriteProbe = { write: () => { throw new Error("EPERM"); }, remove: () => {} };
assert(probeDirWritable(PROGRAM_FILES, throwing) === false && probeDirWritable(PER_USER, { write: () => {}, remove: () => {} }) === true, "probeDirWritable reflects real writability");

console.log("\n[3] other failures keep their honest, distinct messages");
assert(classifyEngineFailure({ ...failInput, exited: true, exitCode: 3, lastLogLine: "TypeError: boom" }).kind === "engine-exited", "a plain crash (no protected/permission evidence) is 'engine-exited', with its code + crash line");
assert(classifyEngineFailure({ ...failInput }).kind === "timeout", "an alive-but-silent engine stays a 'may still be starting' timeout");
assert(classifyEngineFailure({ ...failInput, packaged: false, protectedRoot: true, repoWritable: false, exited: true }).kind !== "protected-location", "a DEV run never blames the install location");
assert(isProtectedInstallRoot(PROGRAM_FILES) && !isProtectedInstallRoot(PER_USER), "isProtectedInstallRoot flags Program Files, not the per-user root");

console.log("\n[4] main.ts is wired to fail FAST and ACTIONABLY (not a 30s blank box)");
const main = readFileSync(join(import.meta.dir, "..", "main.ts"), "utf8");
assert(main.includes('dev.on("exit"'), "the engine child's exit is watched");
assert(/if \(engineExit\) return false;/.test(main), "waitForServer bails the moment the engine dies, instead of polling for the full window");
assert(main.includes("classifyEngineFailure({"), "the failure dialog is built by the classifier");
assert(main.includes("bestEngineLine(engineTail)") && main.includes(".slice(-4000)"), "a bounded engine tail feeds the dialog's last-message line");
assert(!main.includes("The bundled background service did not respond"), "the old generic-only message is gone");
const allCopy = [rProtected.title, rProtected.detail, classifyEngineFailure({ ...failInput, exited: true, exitCode: 1 }).detail, classifyEngineFailure({ ...failInput }).detail];
assert(allCopy.every((s) => !s.includes("\u2014")), "no em dash in any failure dialog copy (invariant #1)");

console.log("\n[5] the installer may offer Program Files again BECAUSE the boot gate holds (ADR-0262)");
const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"));
assert(pkg.build.nsis.oneClick === false, "assisted installer - the user consciously picks the install location, never a silent redirect");
assert(pkg.build.nsis.perMachine === false, "the DEFAULT stays per-user (%LOCALAPPDATA%\\Programs - writable, no elevation needed)");
assert(pkg.build.nsis.allowElevation === true && pkg.build.nsis.allowToChangeInstallationDirectory === true, "per-machine installs (Program Files) are allowed again - the compiled engine boots from protected trees");
const wf = readFileSync(join(import.meta.dir, "..", "..", ".github", "workflows", "build-desktop.yml"), "utf8");
assert(wf.includes("build/pf-boot-smoke.ts") && wf.includes("LUCID_PF_SMOKE_STRICT"), "the relax is COUPLED to the strict Program Files boot gate (ADR-0261): removing the gate turns this demo red");

console.log("\n\u2713 P-WINBOOT.1 demo passed - a protected install fails fast with a fix, and per-machine installs are guarded by the boot gate.");
