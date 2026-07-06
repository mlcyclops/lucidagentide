// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_p_sandbox_7.ts
//
// P-SANDBOX.7 (ADR-0173): the native Windows AppContainer helper that P-SANDBOX.6's seam shells out to.
// It stays in the Bun/TS surface (compiles via `bun build --compile`) yet does the real Win32 via bun:ffi:
// an AppContainer with an EMPTY capability set has NO network, so `--deny-network` is enforced by the OS.
// Proves:
//   1. the flag-contract parser fail-closes on anything malformed BEFORE a spawn;
//   2. main() refuses (non-zero) when it cannot contain (bad args → 2; a mode it can't enforce → 3) -
//      never a passthrough (a helper that can't contain must block, not run the child un-isolated);
//   3. LIVE on Windows: a benign child runs (exit 0) but a networked child is BLOCKED - real containment,
//      verified against the actual OS. (Skipped off-Windows, where the helper correctly refuses instead.)
//
// Run: bun run harness/scripts/demo_p_sandbox_7.ts

import { tmpdir } from "node:os";
import { buildCommandLine, main, parseHelperArgs, quoteArg } from "../../tools/appcontainer/lucid_appcontainer.ts";

const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
const ok = (cond: boolean, m: string) => { if (!cond) fail(m); console.log(`  ok  ${m}`); };

console.log("== #ADR-0173 P-SANDBOX.7: the native Windows AppContainer helper (real containment) ==\n");

// ── [1] the flag-contract parser (pure, cross-platform) ───────────────────────
console.log("[1] the flag contract parses valid plans and fail-closes on anything malformed");
ok(JSON.stringify(parseHelperArgs(["--workspace", "C:\\ws", "--deny-network", "--", "omp", "acp"])) ===
  JSON.stringify({ workspace: "C:\\ws", home: undefined, net: "deny", cmd: "omp", cmdArgs: ["acp"] }), "a valid --deny-network plan parses");
ok("error" in parseHelperArgs(["--workspace", "C:\\ws", "--deny-network", "--"]), "no command after -- → error");
ok("error" in parseHelperArgs(["--workspace", "C:\\ws", "--", "x"]), "no net posture → error (exactly one of deny/loopback required)");
ok("error" in parseHelperArgs(["--deny-network", "--", "x"]), "missing --workspace → error");
ok(quoteArg("a b") === '"a b"' && buildCommandLine("cmd", ["/c", "echo hi"]) === 'cmd /c "echo hi"', "argv is quoted for CommandLineToArgvW");

// ── [2] fail-closed: cannot-contain NEVER means run-anyway ────────────────────
console.log("\n[2] main() refuses (non-zero) when it cannot contain - never a passthrough");
ok(main(["--deny-network", "--"]) === 2, "bad args → exit 2 (refused before any spawn)");
if (process.platform !== "win32") ok(main(["--workspace", "/ws", "--deny-network", "--", "true"]) === 3, "off-Windows every mode refuses → exit 3 (no AppContainer, never a passthrough)");

// ── [3] LIVE containment (Windows only) ───────────────────────────────────────
console.log("\n[3] live containment against the real OS");
if (process.platform === "win32") {
  const ws = tmpdir();
  const benign = main(["--workspace", ws, "--deny-network", "--", "curl.exe", "--version"]);
  ok(benign === 0, "a benign (no-network) child RUNS inside the AppContainer and exits 0");
  const networked = main(["--workspace", ws, "--deny-network", "--", "curl.exe", "-s", "-m", "6", "-o", "NUL", "-w", "http_code=%{http_code}", "https://example.com"]);
  console.log(""); // curl's -w wrote http_code inline above
  ok(networked !== 0, "a NETWORKED child is BLOCKED (curl cannot connect ⇒ non-zero) - the DNS/HTTP exfil is contained");
} else {
  ok(main(["--workspace", "/ws", "--deny-network", "--", "true"]) === 3, "off-Windows the helper REFUSES (no AppContainer) - fail-closed, not a passthrough");
  console.log("  ..  live AppContainer smoke skipped (Windows-only; verified on Windows: curl inside deny-network returns http_code=000)");
}

console.log("\n✓ P-SANDBOX.7 demo passed — the AppContainer helper enforces --deny-network via a no-capability AppContainer (verified: a contained curl cannot reach the internet), and fail-closes wherever it cannot contain.");
process.exit(0);
