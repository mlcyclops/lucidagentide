// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/omp/shared_scanner.ts
//
// P-SCANLIVE.3 (ADR-0605, issue #632): the ONE scanner sidecar an omp process runs for LUCID's extensions.
//
// The field report: one held fleet lane (a single long-lived `omp acp` process) had 145
// `scanner-sidecar/server.py` children. omp runs an extension's factory once for every session it binds
// the extension to. Every ACP session/new, load and fork imports the extension again, and omp's loader
// re-evaluates the whole module graph on each import (a `?mtime=` tag on the entry and on every relative
// import), so module-level state is NOT per process. Every subagent rebinds the parent's imported factory.
// `mcp_result_gate.ts` started a client inside its factory (one sidecar per session and per subagent) and
// `security_extension.ts` one per module evaluation (one per session); nothing stopped either when its
// session ended.
//
// So the client lives in a process-global slot keyed by a registry symbol, which is the same symbol in every
// evaluation of this module, and every extension takes it from here. One client and one sidecar for the life
// of the process, stopped when the process exits.
//
// FAIL-CLOSED (invariant #3) is unchanged: a dead shared sidecar makes every scan throw, and every gate maps
// the throw to a block. A sidecar that dies is respawned by the next scan after the ADR-0571 backoff, for
// every extension at once, and its exit is reported on stderr (the desktop keeps it in lucid-acp.log).

import { ScannerClient } from "../security/scanner_client.ts";
import { writeStderrNotice } from "./stderr_notice.ts";

const SLOT = Symbol.for("lucid.omp.sharedScanner");
const slots = globalThis as unknown as Record<symbol, ScannerClient | undefined>;

/** The process's scanner client for the omp extensions, created and started on first use. */
export function sharedScanner(): ScannerClient {
  const existing = slots[SLOT];
  if (existing) return existing;
  // P-SCANLIVE.1 (ADR-0571): a sidecar that dies is respawned by the next scan; until then scans fail
  // closed. The exit goes to stderr because the scanner's own exit code and stderr are otherwise the only
  // record of WHY it died.
  const client = new ScannerClient({
    onExit: (e) => writeStderrNotice(
      `\n🛡️  [LucidAgentIDE] scanner sidecar exited (${e.reason}); tool calls fail closed until the first scan after ${e.restartInMs}ms restarts it${e.stderrTail ? `. stderr: ${e.stderrTail.slice(-500).replace(/\s*\n\s*/g, " | ")}` : ""}\n`,
    ),
  });
  client.start();
  slots[SLOT] = client;
  process.once("exit", () => client.stop());
  return client;
}

/** Test-only: stop the process's client and forget it, so the next sharedScanner() starts a fresh one. */
export function _resetSharedScannerForTest(): void {
  slots[SLOT]?.stop();
  delete slots[SLOT];
}
