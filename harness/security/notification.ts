// harness/security/notification.ts
//
// The user-facing notification payload for a blocked/quarantined event (PRD
// "Required notification behavior"): the user must see source, trust label,
// severity, finding type(s), what changed, what is blocked, and handles to the
// raw-vs-sanitized views — BEFORE any privileged execution proceeds.

import type { Finding, Severity, TrustLabel } from "../contracts.ts";

const SEVERITY_RANK: Record<Severity, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };

export interface QuarantineNotification {
  source: string;
  trustLabel: TrustLabel;
  maxSeverity: Severity;
  findingTypes: string[];
  findingCount: number;
  /** True when the sanitized derivative differs from the raw original. */
  changed: boolean;
  /** What action is being prevented (e.g. "tool_call:bash"). */
  blocked: string;
  reason: string;
  failClosed: boolean;
  /** Opaque handles to fetch raw vs sanitized for a diff view (no raw inline). */
  rawHandle?: string;
  sanitizedHandle?: string;
}

function maxSeverity(findings: Finding[], failClosed: boolean): Severity {
  if (failClosed) return "critical";
  let top: Severity = "info";
  for (const f of findings) if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[top]) top = f.severity;
  return top;
}

export interface NotificationInput {
  source: string;
  trustLabel: TrustLabel;
  findings: Finding[];
  blocked: string;
  reason: string;
  failClosed: boolean;
  changed?: boolean;
  rawHandle?: string;
  sanitizedHandle?: string;
}

export function buildNotification(input: NotificationInput): QuarantineNotification {
  const findingTypes = [...new Set(input.findings.map((f) => f.type))];
  return {
    source: input.source,
    trustLabel: input.trustLabel,
    maxSeverity: maxSeverity(input.findings, input.failClosed),
    findingTypes,
    findingCount: input.findings.length,
    changed: input.changed ?? false,
    blocked: input.blocked,
    reason: input.reason,
    failClosed: input.failClosed,
    rawHandle: input.rawHandle,
    sanitizedHandle: input.sanitizedHandle,
  };
}

/** A one-line, raw-content-free summary safe to show in a terminal/log. */
export function summarizeNotification(n: QuarantineNotification): string {
  const types = n.findingTypes.length ? n.findingTypes.join(",") : n.failClosed ? "scan-unavailable" : "none";
  return `[BLOCKED ${n.blocked}] source=${n.source} trust=${n.trustLabel} severity=${n.maxSeverity} findings=${types}`;
}
