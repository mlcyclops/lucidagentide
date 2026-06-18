// harness/hooks/quarantine_hook.ts
//
// The quarantine gate as a real omp `pre`-hook on tool_call (P2.4). Registered
// as an extension; runs IN-PROCESS inside omp's runtime (invariant #4). It scans
// the tool's input and returns `{ block, reason }` when the content is
// quarantined — so blocked content provably cannot reach the tool's execute().
// Fail-closed (invariant #3): any scan failure blocks.
//
// ExtensionFactory shape confirmed in ADR-0003 (hooks are extensions calling
// `pi.on("tool_call", handler)`); the exact type is derived from the SDK option
// so this stays aligned with the installed omp version.

import type { createAgentSession } from "@oh-my-pi/pi-coding-agent";
import type { ScannerClient } from "../security/scanner_client.ts";
import { DEFAULT_POLICY, scanAndDecide, type GatePolicy } from "../security/gate.ts";
import { buildNotification, type QuarantineNotification } from "../security/notification.ts";
import type { Telemetry } from "../telemetry/events.ts";

type SessionOpts = NonNullable<Parameters<typeof createAgentSession>[0]>;
type ExtensionFactory = NonNullable<SessionOpts["extensions"]>[number];

export interface QuarantineHookOptions {
  scanner: ScannerClient;
  gatePolicy?: GatePolicy;
  telemetry?: Telemetry;
  /** Invoked with the notification payload whenever a tool call is blocked. */
  onBlock?: (n: QuarantineNotification) => void;
  /** Tool names exempt from scanning (e.g. trusted read-only tools). */
  exempt?: ReadonlySet<string>;
}

/** Build the quarantine extension. Scan tool inputs; block when quarantined. */
export function makeQuarantineExtension(opts: QuarantineHookOptions): ExtensionFactory {
  const policy = opts.gatePolicy ?? DEFAULT_POLICY;
  return (pi) => {
    pi.on("tool_call", async (event) => {
      const ev = event as { toolName?: string; input?: Record<string, unknown> };
      const toolName = ev.toolName ?? "unknown";
      if (opts.exempt?.has(toolName)) return;

      const text = JSON.stringify(ev.input ?? {});
      const decision = await scanAndDecide(opts.scanner, text, policy);
      if (!decision.block) return; // allow

      const blocked = `tool_call:${toolName}`;
      opts.telemetry?.emit("tool_call_blocked", {
        tool: toolName,
        reason: decision.reason,
        fail_closed: decision.failClosed,
        trust_label: decision.trustLabel,
      });
      opts.onBlock?.(
        buildNotification({
          source: toolName,
          trustLabel: decision.trustLabel,
          findings: decision.findings,
          blocked,
          reason: decision.reason,
          failClosed: decision.failClosed,
        }),
      );
      return { block: true, reason: decision.reason };
    });
  };
}
