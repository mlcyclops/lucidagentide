// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/audit_export.test.ts — P-ENT.2 (ADR-0069): the OCSF mapper, the Sink interface, and the
// fail-safe dispatcher. Two keystones: every source maps to a VALID OCSF event, and a dead/slow sink
// NEVER throws into a turn (logging is observability, not the gate).

import { describe, expect, test } from "bun:test";
import {
  AuditDispatcher, SECURITY_EVENT_SCHEMA, type SecurityEvent, type Sink, type SinkStatus, toOcsf,
} from "./audit_export.ts";

function ev(over: Partial<SecurityEvent> = {}): SecurityEvent {
  return {
    schemaVersion: SECURITY_EVENT_SCHEMA, id: "evt_1", ts: "2026-06-28T00:00:00.000Z",
    category: "exec", type: "exec_decision", severity: "high", decision: "block",
    tool: "rm", reason: "recursive force-delete", tier: "T4", sessionId: "s1", host: "box-1", ...over,
  };
}

describe("toOcsf — every source maps to a valid OCSF Detection Finding", () => {
  const REQUIRED = ["category_uid", "class_uid", "type_uid", "activity_id", "severity_id", "time", "metadata"];
  const sources: SecurityEvent[] = [
    ev({ category: "scanner", type: "scanner_block", decision: "block", severity: "high" }),
    ev({ category: "exec", type: "exec_decision", decision: "allow", severity: "medium" }),
    ev({ category: "egress", type: "egress_decision", decision: "block", severity: "medium", tool: "egress" }),
    ev({ category: "loop", type: "loop_block", decision: "block", severity: "critical", tier: "T4" }),
    ev({ category: "approval", type: "block_approved", decision: "allow", severity: "high", identity: "user" }),
  ];
  for (const s of sources) {
    test(`${s.category}/${s.decision} → OCSF with all required fields`, () => {
      const o = toOcsf(s);
      for (const k of REQUIRED) expect(o[k]).toBeDefined();
      expect(o.category_uid).toBe(2);      // Findings
      expect(o.class_uid).toBe(2004);      // Detection Finding
      expect(o.type_uid).toBe(2004 * 100 + (o.activity_id as number));
      expect((o.metadata as any).product.vendor_name).toBe("TechLead 187 LLC");
      expect((o.unmapped as any).category).toBe(s.category);
    });
  }
  test("severity maps to the OCSF 1-5 scale", () => {
    expect(toOcsf(ev({ severity: "info" })).severity_id).toBe(1);
    expect(toOcsf(ev({ severity: "critical" })).severity_id).toBe(5);
  });
  test("decision maps to an OCSF disposition (allow=1, block=2)", () => {
    expect(toOcsf(ev({ decision: "allow" })).disposition_id).toBe(1);
    expect(toOcsf(ev({ decision: "block" })).disposition_id).toBe(2);
  });
  test("time is epoch ms parsed from the RFC3339 ts", () => {
    expect(toOcsf(ev({ ts: "2026-06-28T00:00:00.000Z" })).time).toBe(Date.parse("2026-06-28T00:00:00.000Z"));
  });
  test("never carries raw content — only the declared metadata keys", () => {
    const o = toOcsf(ev({ reason: "zero-width×2" }));
    expect(JSON.stringify(o)).not.toContain("rawInput");
  });
});

// A sink that always throws — the canonical "dead SIEM" the dispatcher must survive.
class DeadSink implements Sink {
  readonly name = "dead"; readonly type = "splunk";
  deliver(): void { throw new Error("connection refused"); }
  status(): SinkStatus { return { name: this.name, type: this.type, delivered: 0, failed: 1, lastError: "connection refused" }; }
}
// A sink that records what it received.
class MemSink implements Sink {
  readonly name = "mem"; readonly type = "file";
  received: SecurityEvent[] = [];
  deliver(_o: Record<string, unknown>, e: SecurityEvent): void { this.received.push(e); }
  status(): SinkStatus { return { name: this.name, type: this.type, delivered: this.received.length, failed: 0 }; }
}

describe("AuditDispatcher — fail-safe (a dead sink never blocks)", () => {
  test("emit() with ONLY a dead sink returns an event and does NOT throw", () => {
    const d = new AuditDispatcher();
    d.setSinks([new DeadSink()]);
    let out: SecurityEvent | null = null;
    expect(() => { out = d.emit({ category: "exec", type: "exec_decision", decision: "block", severity: "high", tool: "rm" }); }).not.toThrow();
    expect(out).not.toBeNull();
  });

  test("a dead sink doesn't stop a healthy sink from receiving the event", () => {
    const d = new AuditDispatcher();
    const mem = new MemSink();
    d.setSinks([new DeadSink(), mem]); // dead one first
    d.emit({ category: "loop", type: "loop_block", decision: "block", severity: "critical", tier: "T4" });
    expect(mem.received).toHaveLength(1);
    expect(mem.received[0]!.tier).toBe("T4");
  });

  test("the dispatcher fills id / ts / host / schemaVersion", () => {
    const d = new AuditDispatcher();
    const mem = new MemSink();
    d.setSinks([mem]);
    const e = d.emit({ category: "scanner", type: "scanner_block", decision: "block", severity: "high" })!;
    expect(e.id).toBeTruthy();
    expect(e.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(e.host).toBeTruthy();
    expect(e.schemaVersion).toBe(SECURITY_EVENT_SCHEMA);
  });

  test("recent() ring-buffers most-recent-first; sinkStatuses() never throws", () => {
    const d = new AuditDispatcher();
    d.setSinks([new DeadSink(), new MemSink()]);
    d.emit({ category: "exec", type: "exec_decision", decision: "block", severity: "high", tool: "a" });
    d.emit({ category: "exec", type: "exec_decision", decision: "block", severity: "high", tool: "b" });
    expect(d.recent(10).map((e) => e.tool)).toEqual(["b", "a"]);
    expect(() => d.sinkStatuses()).not.toThrow();
    expect(d.sinkStatuses()).toHaveLength(2);
  });
});
