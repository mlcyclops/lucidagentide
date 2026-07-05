// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/egress_audit.test.ts — P-SANDBOX.3 (ADR-0167).
//
// The mediated-egress audit sink: a BLOCKED subprocess reach-out becomes exactly one canonical `egress`
// SecurityEvent per host (deduped so a looping exfil can't flood the SIEM); an ALLOWED reach-out emits
// nothing; a throwing sink never propagates (auditing must not break mediation). Plus an end-to-end
// pass through a real proxy, and the kill-the-proxy fail-closed guarantee (proxy dead ⇒ egress denied).

import { afterEach, expect, test } from "bun:test";
import { createSocket } from "node:dgram";
import { egressAuditSink } from "./egress_audit.ts";
import { EgressProxy, type DecideFn, type ProxyEvent } from "../harness/runs/egress_proxy.ts";
import type { SecurityEventInput } from "./audit_export.ts";

const deny = (channel: "dns" | "connect", host: string): ProxyEvent => ({ channel, decision: { action: "deny", host, reason: "prompt-not-auto-allowed", via: "allow-all" } });
const allow = (host: string): ProxyEvent => ({ channel: "dns", decision: { action: "allow", host, reason: "allowed", via: "whitelist" } });

test("a blocked reach-out emits one canonical egress SecurityEvent (category/decision/severity)", () => {
  const out: SecurityEventInput[] = [];
  egressAuditSink((e) => out.push(e))(deny("dns", "attacker.cn"));
  expect(out).toHaveLength(1);
  expect(out[0]).toMatchObject({ category: "egress", type: "dns_query_blocked", decision: "block", severity: "high", tool: "subprocess-dns" });
  expect(out[0]!.reason).toContain("attacker.cn");
});

test("an ALLOWED reach-out emits nothing (the audit trail records refusals, not normal traffic)", () => {
  const out: SecurityEventInput[] = [];
  egressAuditSink((e) => out.push(e))(allow("pypi.org"));
  expect(out).toHaveLength(0);
});

test("repeats for the same host are deduped — a looping gethostbyname can't flood the SIEM", () => {
  const out: SecurityEventInput[] = [];
  const sink = egressAuditSink((e) => out.push(e));
  for (let i = 0; i < 100; i++) sink(deny("dns", "attacker.cn"));
  sink(deny("dns", "other.cn")); // a DIFFERENT host is still reported
  expect(out).toHaveLength(2);
  expect(out.map((e) => e.tool)).toEqual(["subprocess-dns", "subprocess-dns"]);
});

test("a throwing emit never propagates — auditing must not break mediation (the reach-out stays denied)", () => {
  const sink = egressAuditSink(() => { throw new Error("sink down"); });
  expect(() => sink(deny("connect", "evil.example"))).not.toThrow();
});

// ── end-to-end: a real proxy wired to the sink ───────────────────────────────────────────────────────

let proxy: EgressProxy | null = null;
afterEach(async () => { if (proxy) { await proxy.stop(); proxy = null; } });

const allowOnly = (hosts: string[]): DecideFn => (host) => ({ verdict: hosts.includes(host) ? "allow" : "prompt", via: "test" });
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

test("end-to-end: a denied DNS query flows through the proxy into exactly one audit event", async () => {
  const out: SecurityEventInput[] = [];
  proxy = new EgressProxy({ decide: allowOnly([]), onEvent: egressAuditSink((e) => out.push(e)) });
  const ep = await proxy.start();
  const reply = await udpSend(ep.dnsPort, dnsQuery("s0m3b64.attacker.cn"));
  expect(reply[3]! & 0x0f).toBe(5); // REFUSED
  expect(out).toHaveLength(1);
  expect(out[0]!.type).toBe("dns_query_blocked");
});

test("kill-the-proxy: after stop() the proxy resolves nothing (egress denied, fail-closed)", async () => {
  proxy = new EgressProxy({ decide: allowOnly(["pypi.org"]) });
  const ep = await proxy.start();
  await proxy.stop();
  await expect(udpSend(ep.dnsPort, dnsQuery("pypi.org"))).rejects.toThrow(); // no resolver answers ⇒ denied
  proxy = null;
});
