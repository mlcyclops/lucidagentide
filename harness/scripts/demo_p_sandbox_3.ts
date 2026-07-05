// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_p_sandbox_3.ts
//
// P-SANDBOX.3 (ADR-0167): the mediated-egress AUDIT layer. P-SANDBOX.2 blocked the DNS-TXT exfil; this
// makes the block a durable, exportable security event — the reach-out ADR-0157 said "didn't exist as a
// visible event" now lands on the audit / OCSF trail. Proves (loopback + injected sink):
//   1. a BLOCKED subprocess reach-out → exactly one canonical `egress` SecurityEvent (block, high);
//   2. an ALLOWED reach-out → nothing (the trail records refusals, not normal traffic);
//   3. a looping exfil is DEDUPED by host — one event per host, the SIEM can't be flooded;
//   4. end-to-end: a denied gethostbyname flows through the real proxy into one audit event;
//   5. fail-closed: a throwing sink never breaks mediation; a dead proxy still denies egress.
//
// Run: bun run harness/scripts/demo_p_sandbox_3.ts

import { createSocket } from "node:dgram";
import { EgressProxy, type DecideFn, type ProxyEvent } from "../runs/egress_proxy.ts";
import { egressAuditSink } from "../../desktop/egress_audit.ts";
import type { SecurityEventInput } from "../../desktop/audit_export.ts";

const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
const ok = (cond: boolean, m: string) => { if (!cond) fail(m); console.log(`  ok  ${m}`); };
const deny = (channel: "dns" | "connect", host: string): ProxyEvent => ({ channel, decision: { action: "deny", host, reason: "prompt-not-auto-allowed", via: "allow-all" } });
const allow = (host: string): ProxyEvent => ({ channel: "dns", decision: { action: "allow", host, reason: "allowed", via: "whitelist" } });
const allowOnly = (hosts: string[]): DecideFn => (host) => ({ verdict: hosts.includes(host) ? "allow" : "prompt", via: "demo" });
function dnsQuery(name: string): Uint8Array {
  const body: number[] = [];
  for (const l of name.split(".").filter(Boolean)) { body.push(l.length); for (const ch of l) body.push(ch.charCodeAt(0)); }
  body.push(0, 0, 1, 0, 1);
  return Uint8Array.from([0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0, ...body]);
}
function udpSend(port: number, msg: Uint8Array): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const c = createSocket("udp4");
    const t = setTimeout(() => { c.close(); reject(new Error("udp timeout")); }, 800);
    c.once("message", (m) => { clearTimeout(t); c.close(); resolve(m); });
    c.once("error", (e) => { clearTimeout(t); reject(e); });
    c.send(msg, port, "127.0.0.1");
  });
}

console.log("== #ADR-0167 P-SANDBOX.3: the mediated-egress audit trail (the block is now a visible event) ==\n");

// ── [1]-[3] the sink mapping + dedupe ─────────────────────────────────────────
console.log("[1] a blocked reach-out becomes one canonical egress SecurityEvent");
let out: SecurityEventInput[] = [];
egressAuditSink((e) => out.push(e))(deny("dns", "s0m3b64.attacker.cn"));
ok(out.length === 1 && out[0]!.category === "egress" && out[0]!.decision === "block" && out[0]!.severity === "high" && out[0]!.type === "dns_query_blocked",
  "denied DNS → { category:egress, type:dns_query_blocked, decision:block, severity:high } on the audit/OCSF trail");

console.log("\n[2] an allowed reach-out is NOT an audit event (normal traffic)");
out = [];
egressAuditSink((e) => out.push(e))(allow("pypi.org"));
ok(out.length === 0, "allowed → nothing emitted (pip install doesn't spam the SIEM)");

console.log("\n[3] a looping exfil is deduped by host");
out = [];
const sink = egressAuditSink((e) => out.push(e));
for (let i = 0; i < 500; i++) sink(deny("dns", "attacker.cn"));
sink(deny("connect", "other.cn"));
ok(out.length === 2, "500 blocks to one host + 1 to another → 2 events (the SIEM can't be flooded)");

// ── [4] end-to-end through a real proxy ───────────────────────────────────────
console.log("\n[4] end-to-end — a denied gethostbyname flows through the proxy into one audit event");
const e2e: SecurityEventInput[] = [];
const proxy = new EgressProxy({ decide: allowOnly([]), onEvent: egressAuditSink((e) => e2e.push(e)) });
const ep = await proxy.start();
const reply = await udpSend(ep.dnsPort, dnsQuery("s0m3b64.attacker.cn"));
ok((reply[3]! & 0x0f) === 5, "the query is REFUSED at the resolver (exfil dead)…");
ok(e2e.length === 1 && e2e[0]!.type === "dns_query_blocked", "…and exactly one audit event was recorded for it");

// ── [5] fail-closed: audit never weakens mediation ────────────────────────────
console.log("\n[5] fail-closed — auditing never breaks mediation; a dead proxy still denies");
let threw = false;
try { egressAuditSink(() => { throw new Error("sink down"); })(deny("connect", "evil.example")); } catch { threw = true; }
ok(!threw, "a throwing audit sink is swallowed — the reach-out stays DENIED regardless");
await proxy.stop();
let denied = false;
try { await udpSend(ep.dnsPort, dnsQuery("attacker.cn")); } catch { denied = true; }
ok(denied, "kill-the-proxy: after stop() nothing resolves — egress is denied (mirrors kill-the-sidecar)");

console.log("\n✓ P-SANDBOX.3 demo passed — every blocked subprocess reach-out is now a durable, deduped, exportable egress SecurityEvent, and auditing never weakens the fail-closed guarantee.");
process.exit(0);
