// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/sandbox_status.ts — P-SANDBOX.5 (ADR-0169): the live runtime-sandbox status for the Security panel.
//
// P-SANDBOX.1-.4 built the runtime execution boundary (bwrap / Seatbelt / disclosed passthrough), the
// mediated-egress proxy, and its audit trail — all correct, but INVISIBLE to the user: nothing in the
// Security panel said whether THIS session's exec is actually runtime-isolated, or what subprocess
// reach-outs the proxy refused. This module is the small GUI-owned store that makes it visible:
//
//   - `setSandboxState` is called by the omp spawn (acp_backend.resolveSandboxPlan) with the resolved
//     backend + isolation + disclosure + managed-block + mediated-proxy state for the current session.
//   - `recordEgressBlockView` is called by the egress audit sink (egress_audit.ts) for each DISTINCT
//     blocked subprocess reach-out (already host-deduped upstream), kept in a bounded ring.
//   - `sandboxStatus()` is merged into `/api/security` so `securityHtml` can render the "Runtime sandbox"
//     section (desktop/renderer/sandbox_panel.ts).
//
// Metadata only (invariant: never raw scanned content) — a backend name, a boolean, a host, a reason.

export type SandboxBackendName = "bwrap" | "seatbelt" | "noop";

/** The resolved runtime-sandbox posture for the current omp session. `backend` is null only when the
 *  resolution REFUSED (managed require-isolation with no backend) — then `execBlocked` carries why. */
export interface SandboxState {
  backend: SandboxBackendName | null;
  /** true ⇒ real OS-level containment (bwrap/Seatbelt); false ⇒ disclosed passthrough or blocked. */
  isolated: boolean;
  /** true ⇒ the disclosed, un-isolated passthrough is in use (the loud "not runtime-isolated" state). */
  disclosed: boolean;
  platform: string;
  /** Non-null ⇒ exec is fail-closed BLOCKED for this session (managed policy requires isolation, none). */
  execBlocked: string | null;
  /** true ⇒ subprocess egress is routed through the mediated loopback proxy this session (ADR-0166). */
  proxied: boolean;
  /** ISO timestamp of when this state was resolved. */
  at: string;
}

/** One blocked subprocess reach-out, as shown in the panel (already host-deduped by the audit sink). */
export interface EgressBlockView {
  host: string;
  channel: string; // "dns" | "connect"
  type: string; // dns_query_blocked | subprocess_egress_blocked
  reason: string;
  at: string; // ISO
}

export interface SandboxStatus {
  state: SandboxState | null;
  egressBlocks: EgressBlockView[];
}

const MAX_EGRESS = 50; // a bounded ring — the audit sink dedupes by host, so this is per-host, not per-call.

let current: SandboxState | null = null;
const blocks: EgressBlockView[] = [];

/** Record the runtime-sandbox posture resolved at the omp spawn. Overwrites the prior state (a respawn
 *  re-resolves), so the panel always reflects the LIVE session. */
export function setSandboxState(s: SandboxState): void {
  current = s;
}

/** Append a blocked subprocess reach-out (newest first), bounded. Callers already host-dedupe upstream. */
export function recordEgressBlockView(b: EgressBlockView): void {
  blocks.unshift(b);
  while (blocks.length > MAX_EGRESS) blocks.pop();
}

/** The snapshot merged into `/api/security`. A COPY of the ring so callers can't mutate the store. */
export function sandboxStatus(): SandboxStatus {
  return { state: current, egressBlocks: [...blocks] };
}

/** Clear the store (tests, and a full teardown). */
export function resetSandboxStatus(): void {
  current = null;
  blocks.length = 0;
}
