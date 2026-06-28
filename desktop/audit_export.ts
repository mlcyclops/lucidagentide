// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/audit_export.ts
//
// P-ENT.2 (ADR-0069): the security audit EXPORT SEAM. Turns every security DECISION — scanner block
// (security_log), exec gate (ADR-0066), egress gate (ADR-0062), loop block (ADR-0067), approve/dismiss —
// into one canonical, versioned, OCSF-aligned `SecurityEvent`, and dispatches it to pluggable SINKS.
//
// The PUBLIC seam ships: the canonical event + the OCSF mapper + the `Sink` interface + the dispatcher +
// the append-only FILE sink (~/.omp/lucid-audit.jsonl, OCSF lines a SOC can ingest). The per-SIEM network
// CONNECTORS (Splunk HEC, syslog/CEF, Elastic, AWS Security Lake, Azure Sentinel, GCP Chronicle, Tenable)
// are private-repo IP (ADR-A011) — they implement the SAME `Sink` interface.
//
// FAIL-SAFE, not fail-open: a dead/slow sink NEVER throws into a turn — delivery is best-effort, wrapped
// twice (per-sink + per-dispatch). Security DECISIONS stay fail-closed regardless; logging is
// observability, not the gate. METADATA ONLY — never raw scanned content (the existing audit rule).
// v1 maps EXISTING records into the export schema; it adds NO contracts.ts EventName values (invariant #8).

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, hostname } from "node:os";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { managedConfig, type ManagedLogging } from "./managed_config.ts";

export const SECURITY_EVENT_SCHEMA = 1;

export type SecurityCategory = "scanner" | "exec" | "egress" | "loop" | "approval";
export type SecurityDecision = "block" | "allow" | "prompt";
export type SecuritySeverity = "info" | "low" | "medium" | "high" | "critical";

/** The single canonical security event. Metadata ONLY — never raw scanned content. */
export interface SecurityEvent {
  schemaVersion: number;
  id: string;
  ts: string; // RFC3339
  category: SecurityCategory;
  type: string; // e.g. scanner_block · exec_decision · egress_decision · loop_block · approval
  severity: SecuritySeverity;
  decision: SecurityDecision;
  tool?: string;
  reason?: string;
  tier?: string; // RiskTier when relevant (exec / loop)
  sessionId?: string;
  runId?: string;
  host: string;
  identity?: string; // attribution identity (email | workstation)
  orgName?: string;
}

/** What the caller supplies; the dispatcher fills id/ts/host/identity/orgName/schemaVersion. */
export type SecurityEventInput =
  Omit<SecurityEvent, "schemaVersion" | "id" | "ts" | "host" | "identity" | "orgName">
  & Partial<Pick<SecurityEvent, "identity" | "orgName">>;

// ── OCSF normalization ───────────────────────────────────────────────────────────────────────────────
// OCSF (Open Cybersecurity Schema Framework) is the common denominator that re-maps cleanly to Splunk,
// Elastic ECS, AWS Security Lake, Azure Sentinel, and GCP Chronicle. We emit the "Detection Finding"
// class (category Findings) — a vendor-neutral shape; private connectors are thin field re-maps.

const OCSF_SEVERITY: Record<SecuritySeverity, number> = { info: 1, low: 2, medium: 3, high: 4, critical: 5 };
// OCSF disposition: 1 Allowed · 2 Blocked · others map to a prompt/escalation.
const OCSF_DISPOSITION: Record<SecurityDecision, number> = { allow: 1, block: 2, prompt: 13 /* "Pending" */ };
const OCSF_ACTIVITY: Record<SecurityDecision, number> = { block: 1 /* Create */, allow: 1, prompt: 1 };

/** Map a SecurityEvent to an OCSF Detection Finding (class_uid 2004, category_uid 2). Pure. */
export function toOcsf(ev: SecurityEvent): Record<string, unknown> {
  const sevId = OCSF_SEVERITY[ev.severity];
  const classUid = 2004; // Detection Finding
  const activityId = OCSF_ACTIVITY[ev.decision];
  return {
    // ── OCSF required core ──
    category_uid: 2, // Findings
    class_uid: classUid,
    type_uid: classUid * 100 + activityId, // class_uid*100 + activity_id
    activity_id: activityId,
    severity_id: sevId,
    status_id: ev.decision === "block" ? 1 : 2, // 1 New / 2 In Progress (coarse)
    disposition_id: OCSF_DISPOSITION[ev.decision],
    time: Date.parse(ev.ts) || 0, // epoch ms
    message: ev.reason ?? ev.type,
    metadata: {
      version: "1.1.0",
      product: { name: "LucidAgentIDE", vendor_name: "TechLead 187 LLC", feature: { name: "security-gate" } },
      uid: ev.id,
      log_name: "lucid-audit",
    },
    finding_info: { uid: ev.id, title: `${ev.category}:${ev.decision}`, types: [ev.type] },
    // ── enrichment (namespaced so a connector can lift or drop it) ──
    observables: [
      ...(ev.tool ? [{ name: "tool", type: "Resource", value: ev.tool }] : []),
      ...(ev.identity ? [{ name: "actor", type: "User", value: ev.identity }] : []),
    ],
    device: { hostname: ev.host, ...(ev.orgName ? { org: { name: ev.orgName } } : {}) },
    unmapped: {
      lucid_schema: ev.schemaVersion,
      category: ev.category,
      decision: ev.decision,
      ...(ev.tier ? { tier: ev.tier } : {}),
      ...(ev.sessionId ? { session_id: ev.sessionId } : {}),
      ...(ev.runId ? { run_id: ev.runId } : {}),
    },
  };
}

// ── sinks ──────────────────────────────────────────────────────────────────────────────────────────--
export interface SinkStatus {
  name: string;
  type: string;
  delivered: number;
  failed: number;
  lastError?: string;
  lastDeliveryTs?: string;
}

/** A delivery target. `deliver` MUST be best-effort and MUST NOT throw — the dispatcher also guards, but
 *  a sink that throws would only hurt itself; security decisions never depend on logging succeeding. */
export interface Sink {
  readonly name: string;
  readonly type: string;
  deliver(ocsf: Record<string, unknown>, ev: SecurityEvent): void;
  status(): SinkStatus;
}

/** The public append-only FILE sink: one OCSF JSON line per event at ~/.omp/lucid-audit.jsonl. */
export class FileSink implements Sink {
  readonly name = "file";
  readonly type = "file";
  private delivered = 0;
  private failed = 0;
  private lastError?: string;
  private lastDeliveryTs?: string;
  constructor(private readonly path = join(homedir(), ".omp", "lucid-audit.jsonl")) {}
  deliver(ocsf: Record<string, unknown>, _ev: SecurityEvent): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, JSON.stringify(ocsf) + "\n");
      this.delivered++; this.lastDeliveryTs = new Date().toISOString(); this.lastError = undefined;
    } catch (e) {
      this.failed++; this.lastError = String((e as Error)?.message ?? e).slice(0, 200);
    }
  }
  status(): SinkStatus { return { name: this.name, type: this.type, delivered: this.delivered, failed: this.failed, lastError: this.lastError, lastDeliveryTs: this.lastDeliveryTs }; }
}

// ── dispatcher ─────────────────────────────────────────────────────────────────────────────────────--
/** Maps each event to OCSF once and fans it out to all sinks, fail-safe. A ring buffer keeps the most
 *  recent events for the in-app dashboard (metadata only). Never throws. */
export class AuditDispatcher {
  private sinks: Sink[] = [];
  private ring: SecurityEvent[] = [];
  private static readonly RING_MAX = 500;

  setSinks(sinks: Sink[]): void { this.sinks = sinks; }
  sinkStatuses(): SinkStatus[] { return this.sinks.map((s) => { try { return s.status(); } catch { return { name: s.name, type: s.type, delivered: 0, failed: 0, lastError: "status() threw" }; } }); }
  recent(limit = 100): SecurityEvent[] { return this.ring.slice(-limit).reverse(); }

  /** Build the full event, dispatch it to every sink, and ring-buffer it. NEVER throws. */
  emit(input: SecurityEventInput): SecurityEvent | null {
    try {
      const mc = managedConfig().config;
      const ev: SecurityEvent = {
        schemaVersion: SECURITY_EVENT_SCHEMA,
        id: Snowflake.next(),
        ts: new Date().toISOString(),
        host: hostname(),
        orgName: input.orgName ?? (typeof mc?.orgName === "string" ? mc.orgName : undefined),
        identity: input.identity,
        ...input,
      };
      this.ring.push(ev);
      if (this.ring.length > AuditDispatcher.RING_MAX) this.ring.splice(0, this.ring.length - AuditDispatcher.RING_MAX);
      const ocsf = toOcsf(ev);
      for (const s of this.sinks) { try { s.deliver(ocsf, ev); } catch { /* fail-safe: a dead sink never blocks */ } }
      return ev;
    } catch { return null; } // logging must never break a turn
  }
}

/** Choose sinks from the managed logging config (ADR-0068). v1 ships the file sink; a non-"file" managed
 *  sink type is the cue for the private connector (absent here) — we still keep the local file audit. */
export function sinksFor(logging?: ManagedLogging): Sink[] {
  if (logging?.enabled === false) return [];
  // The file sink is always present (local audit + dashboard source); network connectors are private.
  return [new FileSink()];
}

// ── module singleton ─────────────────────────────────────────────────────────────────────────────────
export const audit = new AuditDispatcher();
audit.setSinks(sinksFor(managedConfig().config?.logging));

/** The one call site the rest of the app uses. Best-effort + fail-safe; returns the event or null. */
export function emitSecurityEvent(input: SecurityEventInput): SecurityEvent | null { return audit.emit(input); }
