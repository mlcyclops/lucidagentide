// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// Increment P-WINBOOT.2C - the Program Files boot gate (ADR-0261).
//
// v1.12.0 shipped a brick because nothing ever booted the app from an ACL-protected install tree.
// This demo proves the gate that closes the gap: the pure decisions (strict mode never downgrades,
// the hardening denies write WITHOUT denying SYNCHRONIZE - a generic-W deny EPERMs CreateProcess
// itself and tests nothing), the CI wiring (windows runner, strict), and then the REAL smoke:
// stage -> deny-write -> prove the denial -> boot bin/lucid-engine -> /api/health + prebuilt /app.js.
//
// Run with: bun run desktop/scripts/demo_p_winboot_2c.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SMOKE_LEAF, hardenPlan, pickSmokeRoot, requiredLayout, restorePlan } from "../engine_pf_smoke.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) { console.error("  \u2717 " + msg); process.exit(1); }
  console.log("  \u2713 " + msg);
}

const DESKTOP = join(import.meta.dir, "..");
const REPO = join(DESKTOP, "..");

console.log("== #ADR-0261 P-WINBOOT.2C: engine boots from a Program Files-ACL install ==\n");

console.log("[1] the pure decisions");
assert((() => { try { pickSmokeRoot({ strict: true, programFilesDir: "C:\\Program Files", programFilesWritable: false, tmpDir: "C:\\t" }); return false; } catch { return true; } })(),
  "strict mode THROWS when Program Files is unavailable - CI can never silently downgrade to a temp dir");
const nonStrict = pickSmokeRoot({ strict: false, programFilesDir: "C:\\Program Files", programFilesWritable: false, tmpDir: "C:\\t" });
assert(!nonStrict.programFiles && nonStrict.root.includes(SMOKE_LEAF), "a dev box falls back to a hardened temp dir (same ACL posture, honest label)");
assert(SMOKE_LEAF.includes(" "), "the staged path keeps a SPACE ('Program Files' has one - quoting bugs are in scope)");
const deny = hardenPlan("C:\\X", "u", "win32").flat().join(" ");
assert(deny.includes("(OI)(CI)(WD,AD,WEA,WA,DE,DC)") && deny.includes("/T"), "win32 hardening: inheritable deny of the SPECIFIC write/delete rights over the whole tree");
assert(!/\((?:[A-Z]+,)*W(?:,[A-Z]+)*\)/.test(deny), "generic W is never denied (it includes SYNCHRONIZE, which EPERMs CreateProcess - the engine could not even start)");
assert(restorePlan("C:\\X", "u", "win32").flat().includes("/remove:d"), "restore removes exactly the deny, so cleanup can delete the stage");
assert(requiredLayout("win32").length === 2, "a stage missing the engine or the prebuilt bundle fails BEFORE boot (a timeout would mislead)");

console.log("\n[2] the CI wiring");
const wf = readFileSync(join(REPO, ".github", "workflows", "build-desktop.yml"), "utf8");
assert(wf.includes("build/pf-boot-smoke.ts"), "build-desktop.yml runs the smoke after packaging");
assert(wf.includes("LUCID_PF_SMOKE_STRICT"), "CI runs it STRICT (real Program Files + packaged layout required)");
assert(/if: runner\.os == 'Windows'\s*\n\s*run: bun run build\/pf-boot-smoke\.ts/.test(wf), "gated to the Windows runner (the brick class is a Windows ACL/loader behavior)");

console.log("\n[3] the real smoke (stage -> deny-write -> prove denial -> boot -> health + bundle)");
const r = Bun.spawnSync(["bun", "run", "build/pf-boot-smoke.ts"], { cwd: DESKTOP, stdout: "pipe", stderr: "pipe" });
const out = r.stdout.toString() + r.stderr.toString();
console.log(out.split("\n").map((l) => "    | " + l).join("\n"));
assert(r.exitCode === 0, "pf-boot-smoke passed end to end");
assert(out.includes("DENIED"), "the write-denial was PROVEN before the boot (a soft stage would test nothing)");
assert(out.includes("answered /api/health"), "the compiled engine answered /api/health from the protected tree");
assert(out.includes("/app.js served"), "the prebuilt renderer bundle served from the protected tree");

console.log("\n\u2713 P-WINBOOT.2C demo passed - the boot-from-a-protected-install regression is now a build gate.");
