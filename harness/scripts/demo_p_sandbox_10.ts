// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_p_sandbox_10.ts
//
// P-SANDBOX.10 (ADR-0387): the AppContainer pill needs the REAL runtime to boot. After P-SANDBOX.9 gave the
// contained omp its stdio, the field showed the next wall: bun 1.3.14 dies with CouldntReadCurrentDirectory
// before running any script inside the container. A Windows-runner lab (bun 1.3.14 vs 1.4.2, with and
// without ancestor ACLs, drive roots included) showed no ACL fixes 1.3.14 and 1.4.2 needs none. So:
//   1. the bundled bun moves to 1.4.2 (vendor-hash cross-checked);
//   2. the engine probes `<omp> --version` through the SAME wrap before committing, and keeps chat on the
//      disclosed passthrough, with the reason, when it cannot boot;
//   3. a Windows CI smoke (appcontainer-smoke.yml) runs the real contained omp on the bundled bun.
//
// Run: bun run harness/scripts/demo_p_sandbox_10.ts

import { readFileSync } from "node:fs";
import { runtimeProbeVerdict } from "../runs/sandbox_exec.ts";

const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
const ok = (cond: boolean, m: string) => { if (!cond) fail(m); console.log(`  ok  ${m}`); };

console.log("== #ADR-0387 P-SANDBOX.10: the AppContainer pill needs the real runtime to boot ==\n");

console.log("[1] the bundled bun is one that can run a script inside the AppContainer");
const src = readFileSync("desktop/build/fetch-runtimes.ts", "utf8");
const ver = /const BUN_VERSION = "(\d+)\.(\d+)\.(\d+)"/.exec(src);
ok(!!ver, "BUN_VERSION is pinned in fetch-runtimes.ts");
const [maj, min] = [Number(ver![1]), Number(ver![2])];
ok(maj > 1 || (maj === 1 && min >= 4), `bundled bun ${ver![1]}.${ver![2]}.${ver![3]} >= 1.4 (1.3.14 cannot start a script in the container)`);
ok(!src.includes("bun-v1.3.14/SHASUMS256.txt"), "the hash provenance note points at the new release");

console.log("\n[2] the engine commits to the container only when the contained omp answers --version");
ok(runtimeProbeVerdict({ exitCode: 0, stdout: "omp/18.2.10\n", stderr: "" }).ok, "clean exit with a version commits");
const field = runtimeProbeVerdict({ exitCode: 1, stdout: "", stderr: "error loading current directory\nerror: An internal error occurred (CouldntReadCurrentDirectory)\n" });
ok(!field.ok && field.reason.includes("CouldntReadCurrentDirectory"), "the field failure keeps chat on the passthrough, and names the cause");
ok(!runtimeProbeVerdict({ exitCode: 0, stdout: "", stderr: "" }).ok, "exit 0 without output does not commit (no stdio)");
ok(!runtimeProbeVerdict({ exitCode: null, stdout: "", stderr: "", timedOut: true }).ok, "a hang does not commit");

console.log("\n[3] a Windows CI smoke runs the real contained omp on the bundled bun");
const wf = readFileSync(".github/workflows/appcontainer-smoke.yml", "utf8");
ok(wf.includes("runs-on: windows-latest") && wf.includes("BUN_VERSION"), "the smoke runs on Windows with the bun version read from fetch-runtimes.ts");
ok(readFileSync("harness/scripts/appcontainer_smoke.ps1", "utf8").includes("omp/"), "and fails unless the contained omp prints its version");

console.log("\n✓ P-SANDBOX.10 demo passed - bun 1.4.2 is bundled, the pill needs a booted runtime, and Windows CI proves it on every sandbox change.");
