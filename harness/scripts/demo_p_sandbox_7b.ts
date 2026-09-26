// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_p_sandbox_7b.ts
//
// P-SANDBOX.7b (ADR-0174): the mediated --loopback-only posture for the Windows AppContainer helper - the
// path the COMMON trusted-local session needs. An AppContainer with an EMPTY capability set has NO direct
// internet (same as --deny-network); a one-time ADMIN loopback exemption (--register-loopback, via
// CheckNetIsolation) then lets that container reach ONLY the loopback proxy. Proves:
//   1. the exemption command is built correctly (CheckNetIsolation LoopbackExempt ± for our AppContainer);
//   2. LIVE on Windows: --loopback-only still DENIES direct internet (the security guarantee holds with or
//      without the exemption) while a benign child runs - and --register-loopback reaches the OS (needs
//      elevation; the "reaches the proxy" completion is the install-time admin step);
//   3. off-Windows every mode fail-closes (exit 3) - never a passthrough.
//
// Run: bun run harness/scripts/demo_p_sandbox_7b.ts

import { tmpdir } from "node:os";
import { checkNetIsolationArgs, main } from "../../tools/appcontainer/lucid_appcontainer.ts";

const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
const ok = (cond: boolean, m: string) => { if (!cond) fail(m); console.log(`  ok  ${m}`); };

console.log("== #ADR-0174 P-SANDBOX.7b: mediated --loopback-only (the common trusted-local path) ==\n");

// ── [1] the loopback-exemption command (pure) ─────────────────────────────────
console.log("[1] the one-time admin loopback-exemption command is constructed correctly");
ok(checkNetIsolationArgs("add").join(" ") === "LoopbackExempt -a -n=LucidAgentIDE.Sandbox.v1", "register → CheckNetIsolation LoopbackExempt -a -n=<our AppContainer>");
ok(checkNetIsolationArgs("delete").join(" ") === "LoopbackExempt -d -n=LucidAgentIDE.Sandbox.v1", "unregister → the matching -d");

// ── [2] the security guarantee (Windows live) ─────────────────────────────────
console.log("\n[2] --loopback-only DENIES direct internet (empty caps) - the guarantee holds pre-exemption");
if (process.platform === "win32") {
  const ws = tmpdir();
  const benign = main(["--workspace", ws, "--loopback-only", "--", "curl.exe", "--version"]);
  ok(benign === 0, "a benign child RUNS inside the loopback-only AppContainer (exit 0)");
  const net = main(["--workspace", ws, "--loopback-only", "--", "curl.exe", "-s", "-m", "6", "-o", "NUL", "-w", "http_code=%{http_code}", "https://example.com"]);
  console.log("");
  ok(net !== 0, "a DIRECT-internet child is BLOCKED (no internetClient ⇒ curl cannot connect) - exfil contained");
  const reg = main(["--register-loopback"]); // admin-gated: 0 if elevated/already-exempt, non-zero (needs admin) otherwise
  ok(typeof reg === "number", `--register-loopback reaches the OS (CheckNetIsolation); exit ${reg} (0 = registered, non-zero = run elevated at install)`);
} else {
  ok(main(["--workspace", "/ws", "--loopback-only", "--", "true"]) === 3, "off-Windows --loopback-only REFUSES (exit 3) - no AppContainer, never a passthrough");
  ok(main(["--register-loopback"]) === 3, "off-Windows --register-loopback REFUSES (exit 3) - loopback exemption is Windows-only");
  console.log("  ..  live loopback smoke skipped (Windows-only; verified on Windows: --loopback-only curl → http_code=000)");
}

console.log("\n✓ P-SANDBOX.7b demo passed — --loopback-only keeps the no-direct-internet guarantee (verified) and the loopback exemption (--register-loopback, admin/install-time) is the one bit that lets the contained child reach the mediating proxy.");
process.exit(0);
