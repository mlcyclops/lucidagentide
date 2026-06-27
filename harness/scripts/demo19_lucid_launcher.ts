// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo19_lucid_launcher.ts
//
// P-EXT.1 (ADR-0038) — the `lucid acp` launcher is the fail-closed trust anchor for the marketplace
// IDE extensions. This demo proves the two security guarantees offline (no model/creds needed):
//   1. it assembles the EXACT gated omp command (gate -e loaded, policy appended), and
//   2. it FAIL-CLOSES — when the scanner sidecar is unreachable (the kill-the-sidecar case) or the
//      gate is missing, it refuses to start and NEVER spawns omp, so an IDE can't get an ungated agent.

import { assets, buildAcpArgs, preflight, probeScanner, runAcp, type SpawnFn } from "../launcher/lucid_acp.ts";

const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };

// A spawn spy: records whether omp would have been launched (it must NOT be, on the fail-closed paths).
function spy() {
  const calls: string[][] = [];
  const fn: SpawnFn = (_cmd, args) => { calls.push(args); return { on: (ev, cb) => { if (ev === "exit") queueMicrotask(() => cb(0)); } }; };
  return { fn, calls };
}

const a = assets();

// 1) The gated command the IDE's `lucid acp` reproduces (same as desktop/acp_backend.ts).
const args = buildAcpArgs({ gate: a.gate, asksage: a.asksage, acpConfig: a.acpConfig });
console.log("-- gated ACP command lucid would exec --");
console.log(`  omp ${args.slice(0, 5).join(" ")} … --append-system-prompt <DELEGATION+BUILD policy>`);
if (args[2] !== a.gate) fail("the security gate is not the first -e extension");
if (args[args.length - 2] !== "--append-system-prompt") fail("policy not appended");
console.log(`  ✓ gate loaded in-process: ${a.gate.split(/[\\/]/).slice(-3).join("/")}`);

// 2a) FAIL-CLOSED — scanner down (kill-the-sidecar). Must return 1 and NOT spawn omp.
const dead = async () => ({ ok: false, reason: "scanner sidecar unavailable: exited code=1" });
const s1 = spy();
const codeDown = await runAcp({ scannerProbe: dead, spawnFn: s1.fn, stderr: () => {} });
if (codeDown !== 1) fail(`expected exit 1 when scanner is down, got ${codeDown}`);
if (s1.calls.length !== 0) fail("omp was spawned despite a dead scanner — NOT fail-closed!");
console.log("\n-- fail-closed: scanner sidecar killed --");
console.log("  ✓ lucid acp refused to start (exit 1); omp never launched → IDE shows 'agent unavailable'");

// 2b) FAIL-CLOSED — gate extension missing.
const missing = await preflight({ gate: "/no/such/security_extension.ts", scannerProbe: async () => ({ ok: true }) });
if (missing.ok) fail("preflight passed with a missing gate extension");
console.log("  ✓ a missing security gate also fails closed");

// 2c) Healthy path: with the scanner reachable + gate present, omp WOULD launch (spy confirms).
const s2 = spy();
const codeOk = await runAcp({ scannerProbe: async () => ({ ok: true }), spawnFn: s2.fn, cwd: "/workspace", env: {} });
if (codeOk !== 0 || s2.calls.length !== 1) fail("expected omp to launch on the healthy path");
if (!s2.calls[0]!.some((x) => x.endsWith("security_extension.ts"))) fail("gate not present on the healthy launch");
console.log("\n-- healthy path: gate present + scanner reachable --");
console.log("  ✓ lucid acp launches the GATED omp (gate -e present), workspace threaded as cwd");

// 3) Informational: probe the REAL sidecar if the venv is provisioned on this machine.
const real = await probeScanner(3000);
console.log(`\n-- live scanner probe on this machine: ${real.ok ? "reachable ✓" : `unreachable (${real.reason}) → would fail closed`}`);

console.log("\ndemo19_lucid_launcher OK");
process.exit(0);
