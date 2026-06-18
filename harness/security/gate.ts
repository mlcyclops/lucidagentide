// harness/security/gate.ts
//
// The quarantine gate. Consumes scanner output and decides block/allow.
//
// FAIL-CLOSED LAW (CLAUDE.md #3): `scanAndDecide` treats ANY failure to obtain a
// valid scan result as BLOCK. This is the keystone safety property, proven on
// day one by gate.failclosed.test.ts (kill the sidecar mid-run -> block).
//
// The gate decision is pure and in-process. The scanner it consumes may be
// out-of-process (the Python sidecar); the gate that ACTS on the result may not
// (CLAUDE.md invariant #4).

import type { Finding, Severity, TrustLabel } from "../contracts.ts";
import { ScannerClient, ScanUnavailableError } from "./scanner_client.ts";

const SEVERITY_RANK: Record<Severity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export interface GatePolicy {
  /** Findings at or above this severity block. Default: "high". */
  blockAtOrAbove: Severity;
}

export const DEFAULT_POLICY: GatePolicy = { blockAtOrAbove: "high" };

export interface GateDecision {
  block: boolean;
  reason: string;
  trustLabel: TrustLabel;
  findings: Finding[];
  /** True when the decision was forced by a missing/failed scan, not findings. */
  failClosed: boolean;
}

/** Pure: turn findings into a decision. No I/O. */
export function decideFromFindings(findings: Finding[], policy: GatePolicy = DEFAULT_POLICY): GateDecision {
  if (findings.length === 0) {
    return { block: false, reason: "clean", trustLabel: "trusted", findings, failClosed: false };
  }
  const threshold = SEVERITY_RANK[policy.blockAtOrAbove];
  const top = findings.reduce((m, f) => Math.max(m, SEVERITY_RANK[f.severity]), 0);
  if (top >= threshold) {
    return {
      block: true,
      reason: `quarantined: ${findings.length} finding(s), max severity exceeds ${policy.blockAtOrAbove}`,
      trustLabel: "quarantined",
      findings,
      failClosed: false,
    };
  }
  // Findings present but below the block threshold: allow, but mark suspicious.
  return {
    block: false,
    reason: `suspicious: ${findings.length} sub-threshold finding(s)`,
    trustLabel: "suspicious",
    findings,
    failClosed: false,
  };
}

/** The fail-closed seam: scan text and decide. ANY scan failure -> BLOCK. */
export async function scanAndDecide(
  client: ScannerClient,
  text: string,
  policy: GatePolicy = DEFAULT_POLICY,
): Promise<GateDecision> {
  try {
    const resp = await client.scan(text);
    return decideFromFindings(resp.findings, policy);
  } catch (err) {
    // Fail closed. Scan unavailable == unscanned == quarantine. NEVER pass.
    const why = err instanceof ScanUnavailableError ? err.message : String(err);
    return {
      block: true,
      reason: `fail-closed: scan unavailable (${why})`,
      trustLabel: "quarantined",
      findings: [],
      failClosed: true,
    };
  }
}

// ── omp pre-hook seam (full wiring is P2.4). Shape confirmed in ADR-0003:
//    `pi.on("tool_call", handler)` may return `{ block, reason }`. We scan the
//    stringified tool input and block fail-closed. Typed loosely here to avoid
//    coupling Increment 0 to omp's internal hook types ahead of P2.4. ─────────
export interface ToolCallLike {
  toolName: string;
  input: Record<string, unknown>;
}

export function makeQuarantineHook(client: ScannerClient, policy: GatePolicy = DEFAULT_POLICY) {
  return async (event: ToolCallLike): Promise<{ block: boolean; reason?: string }> => {
    const text = JSON.stringify(event.input ?? {});
    const decision = await scanAndDecide(client, text, policy);
    return decision.block ? { block: true, reason: decision.reason } : { block: false };
  };
}
