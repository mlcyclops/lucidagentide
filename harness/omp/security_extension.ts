// harness/omp/security_extension.ts
//
// Load this into a real omp session to put the Lucid Agent IDE security gate in
// front of every tool call:
//
//   omp -e harness/omp/security_extension.ts --model <model> "..."
//
// It scans every string in each tool_call (bash command, write content, custom
// tool args, …) through the Python Unicode scanner and BLOCKS the call when the
// content is quarantined — fail-closed if the scanner is unavailable. This is the
// same gate the test suite proves; here it runs inside the live agent.
//
// Intentionally omp-import-free (typed `any`) so it loads under any omp version —
// it only depends on our own scanner/gate/notification modules.

import { ScannerClient } from "../security/scanner_client.ts";
import { DEFAULT_POLICY, scanAndDecide } from "../security/gate.ts";
import { buildNotification, summarizeNotification } from "../security/notification.ts";

const scanner = new ScannerClient();
scanner.start();
process.on("exit", () => scanner.stop());
process.on("SIGINT", () => {
  scanner.stop();
  process.exit(130);
});

/** Collect every string value in a tool_call event (skip metadata keys). */
function collectStrings(value: unknown, skip: ReadonlySet<string> = new Set(["type", "toolCallId"])): string {
  const parts: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") parts.push(v);
    else if (Array.isArray(v)) for (const x of v) walk(x);
    else if (v && typeof v === "object") for (const [k, val] of Object.entries(v)) if (!skip.has(k)) walk(val);
  };
  walk(value);
  return parts.join("\n");
}

// omp extensions are `(pi) => void` and register handlers via pi.on(...).
export default function securityExtension(pi: any): void {
  pi.on("tool_call", async (event: any) => {
    const toolName: string = event?.toolName ?? "tool";
    const text = collectStrings(event);
    const decision = await scanAndDecide(scanner, text, DEFAULT_POLICY);
    if (!decision.block) return; // allow

    const notification = buildNotification({
      source: toolName,
      trustLabel: decision.trustLabel,
      findings: decision.findings,
      blocked: `tool_call:${toolName}`,
      reason: decision.reason,
      failClosed: decision.failClosed,
    });
    process.stderr.write(`\n🛡️  [LucidAgentIDE] ${summarizeNotification(notification)}\n`);
    return { block: true, reason: `Blocked by LucidAgentIDE security gate: ${decision.reason}` };
  });
}
