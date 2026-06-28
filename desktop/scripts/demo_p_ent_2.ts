// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/scripts/demo_p_ent_2.ts
//
// Increment P-ENT.2 (ADR-0069) — the security audit EXPORT SEAM. Every security decision (scanner block,
// exec gate, egress gate, loop block, approve/dismiss) becomes ONE canonical, versioned, OCSF-aligned
// SecurityEvent dispatched to pluggable sinks. Two keystones proven here: each source maps to a VALID
// OCSF event, and a DEAD sink never throws into a turn (logging is observability, not the gate).

import { AuditDispatcher, type SecurityEvent, type Sink, type SinkStatus, toOcsf } from "../audit_export.ts";

const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
const ok = (m: string): void => console.log(`   ${m} ✓`);

console.log("== P-ENT.2 — OCSF security audit export seam ==");

// 1. Every source → a valid OCSF Detection Finding.
const sources: [string, SecurityEvent][] = ([
  ["scanner", { category: "scanner", type: "scanner_block", decision: "block", severity: "high" }],
  ["exec", { category: "exec", type: "exec_decision", decision: "allow", severity: "medium" }],
  ["egress", { category: "egress", type: "egress_decision", decision: "block", severity: "medium" }],
  ["loop", { category: "loop", type: "loop_block", decision: "block", severity: "critical", tier: "T4" }],
  ["approval", { category: "approval", type: "block_approved", decision: "allow", severity: "high" }],
] as const).map(([n, p]) => [n, { schemaVersion: 1, id: "e", ts: "2026-06-28T00:00:00.000Z", host: "h", ...p }]);
for (const [name, ev] of sources) {
  const o = toOcsf(ev);
  for (const k of ["category_uid", "class_uid", "type_uid", "severity_id", "time", "metadata"]) if (o[k] === undefined) fail(`${name} OCSF missing ${k}`);
  if (o.category_uid !== 2 || o.class_uid !== 2004) fail(`${name} wrong OCSF class`);
}
ok("each source (scanner/exec/egress/loop/approval) maps to a valid OCSF Detection Finding");
if ((toOcsf(sources[0]![1]) as any).metadata.product.vendor_name !== "TechLead 187 LLC") fail("vendor metadata");
ok("OCSF carries vendor-neutral product metadata (vendor_name TechLead 187 LLC)");

// 2. Fail-safe dispatcher — a dead sink never throws, and a healthy sink still gets the event.
class DeadSink implements Sink { name = "dead"; type = "splunk"; deliver(): void { throw new Error("connection refused"); } status(): SinkStatus { return { name: this.name, type: this.type, delivered: 0, failed: 1 }; } }
class MemSink implements Sink { name = "mem"; type = "file"; got: SecurityEvent[] = []; deliver(_o: Record<string, unknown>, e: SecurityEvent): void { this.got.push(e); } status(): SinkStatus { return { name: this.name, type: this.type, delivered: this.got.length, failed: 0 }; } }

const d = new AuditDispatcher();
const mem = new MemSink();
d.setSinks([new DeadSink(), mem]); // dead one first
let threw = false;
try { d.emit({ category: "exec", type: "exec_decision", decision: "block", severity: "high", tool: "rm" }); } catch { threw = true; }
if (threw) fail("a dead sink threw out of emit() — would break a turn");
ok("a dead/slow SIEM sink NEVER throws into a turn (fail-safe, not fail-open)");
if (mem.got.length !== 1) fail("the healthy sink didn't receive the event");
ok("a dead sink doesn't stop a healthy sink from receiving the event");

// 3. The dispatcher fills the canonical envelope (id/ts/host/schemaVersion) + ring-buffers for the dashboard.
const e = d.emit({ category: "scanner", type: "scanner_block", decision: "block", severity: "high" })!;
if (!e.id || !e.ts || !e.host || e.schemaVersion !== 1) fail("dispatcher didn't fill the envelope");
if (d.recent(10)[0]!.type !== "scanner_block") fail("ring buffer is not most-recent-first");
ok("the dispatcher stamps id/ts/host/schemaVersion + ring-buffers events for the in-app dashboard");

console.log("demo-P-ENT.2 OK");
process.exit(0);
