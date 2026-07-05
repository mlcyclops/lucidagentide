// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/egress_audit.ts — P-SANDBOX.3 (ADR-0167): the audit sink for the mediated-egress proxy.
//
// P-SANDBOX.2 gave the proxy an in-memory event log (observable by tests) but nothing durable. This
// closes the loop: a BLOCKED subprocess reach-out (a denied `gethostbyname` / CONNECT — the DNS-TXT
// exfil the whole epic targets) now emits a canonical desktop SecurityEvent (category `egress`) into the
// SAME audit / OCSF pipeline (audit_export.ts, ADR-0069) that P-REPORT.10's network reach-outs use — so
// the reach-out that ADR-0157 said "didn't exist as a visible event" is finally on the audit trail and
// exportable to the org's SIEM.
//
// Deliberately NOT a new contracts.ts EventName (invariant #8): the desktop SecurityEvent `type` is a
// free string, so this reuses the P-SANDBOX.1 / P-REPORT.10 precedent and touches no frozen enum. It is
// also NOT a `recordBlock` (security_log.ts): those are user-APPROVABLE live gate blocks, but a
// subprocess reach-out already happened and is not releasable — the audit-only channel is the correct
// home, exactly as P-REPORT.10 chose for `git fetch` / `gh` reach-outs.
//
// Deduped by host so a hostile package hammering `gethostbyname` in a loop can't flood the SIEM: the
// FIRST block per host is emitted (with the reason); repeats are counted in-memory only. The sink is
// stateful (the dedupe set), so callers create ONE per proxy lifetime.

import { egressBlockAudit } from "../harness/runs/egress_proxy.ts";
import type { ProxyEvent } from "../harness/runs/egress_proxy.ts";
import { emitSecurityEvent, type SecurityEventInput } from "./audit_export.ts";

/** Build a deduped audit sink for the proxy's `onEvent`. Denied reach-outs → one SecurityEvent per host
 *  (category `egress`, decision `block`, high severity). Allowed reach-outs and repeats emit nothing.
 *  `emit` is injectable (default the real dispatcher) so the dedupe logic is unit-tested without disk. */
export function egressAuditSink(emit: (e: SecurityEventInput) => void = emitSecurityEvent): (e: ProxyEvent) => void {
  const seen = new Set<string>();
  return (ev: ProxyEvent) => {
    const a = egressBlockAudit(ev);
    if (!a) return; // allowed reach-out — normal traffic, not an audit event
    if (seen.has(a.host)) return; // already reported this host this session — don't flood the SIEM
    seen.add(a.host);
    try {
      emit({ category: "egress", type: a.type, decision: "block", severity: "high", tool: a.tool, reason: a.reason });
    } catch {
      /* auditing must never break mediation — a dead sink still leaves the reach-out DENIED */
    }
  };
}
