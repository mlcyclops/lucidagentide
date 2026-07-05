// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/runs/egress_proxy.test.ts — P-SANDBOX.2 (ADR-0166).
//
// Over-tests the security keystone: the subprocess-egress decision (only an explicit `allow` passes;
// prompt / unparseable / thrown-decision all DENY — fail-closed, invariant #3), the DNS wire handling
// (QNAME parse + REFUSED reply that kills a `gethostbyname` exfil), and the live proxy on loopback
// (DNS deny ⇒ REFUSED without touching the upstream; DNS allow ⇒ forwarded; CONNECT deny ⇒ 403;
// CONNECT allow ⇒ tunnelled; kill-the-proxy ⇒ nothing resolves/connects). The decision brain is
// injected so the pure tests never touch disk; the socket tests use only 127.0.0.1.

import { afterEach, expect, test } from "bun:test";
import { createSocket } from "node:dgram";
import { connect as tcpConnect, createServer as createTcpServer, type Server as TcpServer } from "node:net";
import {
  buildRefusal,
  decideEgress,
  defaultDecide,
  egressBlockAudit,
  EgressProxy,
  ensureEgressProxy,
  hostFromAbsoluteUri,
  normalizeHost,
  parseDnsQuestion,
  stopEgressProxy,
  type DecideFn,
  type ProxyEvent,
} from "./egress_proxy.ts";

// ── the decision keystone (pure, injected brain) ───────────────────────────────────────────────────

const allowOnly = (hosts: string[]): DecideFn => (host) => ({ verdict: hosts.includes(host) ? "allow" : "prompt", via: "test" });

test("only an explicit allow verdict passes — a prompt verdict DENIES (still-prompt heuristics extend to DNS)", () => {
  const decide = allowOnly(["pypi.org"]);
  expect(decideEgress("pypi.org", decide).action).toBe("allow");
  // a foreign-ccTLD / not-approved host comes back as `prompt` from the brain → we cannot prompt a libc
  // call mid-syscall, so it is a REFUSAL (this is exactly the DNS-TXT exfil target).
  const d = decideEgress("s0m3b64.attacker.cn", decide);
  expect(d.action).toBe("deny");
  expect(d.reason).toBe("prompt-not-auto-allowed");
});

test("an unparseable host is DENIED (fail-closed, never resolved)", () => {
  for (const bad of ["", "   ", "has space", "a/b", "\x00"]) {
    const d = decideEgress(bad, allowOnly([]));
    expect(d.action).toBe("deny");
    expect(d.reason).toBe("unparseable-host");
  }
});

test("a decision that THROWS is DENIED (fail-closed — a broken brain never means resolve)", () => {
  const boom: DecideFn = () => { throw new Error("brain down"); };
  const d = decideEgress("pypi.org", boom);
  expect(d.action).toBe("deny");
  expect(d.reason).toBe("decision-error");
  expect(d.via).toBe("fail-closed");
});

test("host is normalized before deciding: port stripped, IPv6 unbracketed, lowercased, root dot dropped", () => {
  expect(normalizeHost("PyPI.org:443")).toBe("pypi.org");
  expect(normalizeHost("[2001:db8::1]:443")).toBe("2001:db8::1");
  expect(normalizeHost("example.com.")).toBe("example.com");
  expect(normalizeHost("Example.COM")).toBe("example.com");
  expect(normalizeHost("bad host")).toBe("");
  expect(normalizeHost("a/b")).toBe("");
  // the decision sees the normalized host, so an allow-list keyed on the bare host matches a host:port target
  expect(decideEgress("pypi.org:443", allowOnly(["pypi.org"])).action).toBe("allow");
});

test("defaultDecide reuses the real egress brain and always returns a well-formed verdict (no throw)", () => {
  const d = decideEgress("localhost", defaultDecide);
  expect(["allow", "deny"]).toContain(d.action);
  expect(d.host).toBe("localhost");
});

// ── DNS wire format ────────────────────────────────────────────────────────────────────────────────

/** Minimal DNS A-query for `name` (ID 0x1234, RD=1, one question). */
function dnsQuery(name: string, id = 0x1234): Uint8Array {
  const labels = name.split(".").filter(Boolean);
  const body: number[] = [];
  for (const l of labels) { body.push(l.length); for (const ch of l) body.push(ch.charCodeAt(0)); }
  body.push(0, 0, 1, 0, 1); // root, QTYPE=A, QCLASS=IN
  return Uint8Array.from([id >> 8, id & 0xff, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0, ...body]);
}

test("parseDnsQuestion reads the QNAME; malformed/truncated → '' (⇒ deny)", () => {
  expect(parseDnsQuestion(dnsQuery("example.com"))).toBe("example.com");
  expect(parseDnsQuestion(dnsQuery("a.b.c.pypi.org"))).toBe("a.b.c.pypi.org");
  expect(parseDnsQuestion(new Uint8Array(5))).toBe(""); // shorter than a header
  expect(parseDnsQuestion(Uint8Array.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0xc0, 0x0c]))).toBe(""); // compression pointer
});

test("buildRefusal echoes the header/question with QR=1, RCODE=5 (REFUSED), zero answers", () => {
  const q = dnsQuery("attacker.cn", 0xbeef);
  const r = buildRefusal(q);
  expect(r[0]).toBe(0xbe); // ID preserved
  expect(r[1]).toBe(0xef);
  expect((r[2]! & 0x80) !== 0).toBe(true); // QR = response
  expect(r[3]! & 0x0f).toBe(5); // RCODE = REFUSED
  expect(r[6]).toBe(0); expect(r[7]).toBe(0); // ANCOUNT = 0
});

test("hostFromAbsoluteUri pulls the host from a proxied absolute-URI request line", () => {
  expect(hostFromAbsoluteUri("GET http://evil.example/path HTTP/1.1")).toBe("evil.example");
  expect(hostFromAbsoluteUri("GET /relative HTTP/1.1")).toBe("");
});

// ── P-SANDBOX.3 audit fields (the block → SecurityEvent mapping) ─────────────────────────────────────

test("egressBlockAudit maps a DENY to audit fields per channel; an ALLOW → null (audit records refusals)", () => {
  const deny = (channel: "dns" | "connect", host: string): ProxyEvent => ({ channel, decision: { action: "deny", host, reason: "prompt-not-auto-allowed", via: "allow-all" } });
  const dns = egressBlockAudit(deny("dns", "attacker.cn"));
  expect(dns).toEqual({ type: "dns_query_blocked", tool: "subprocess-dns", host: "attacker.cn", reason: "subprocess DNS to attacker.cn denied (prompt-not-auto-allowed)" });
  const con = egressBlockAudit(deny("connect", "evil.example"));
  expect(con?.type).toBe("subprocess_egress_blocked");
  expect(con?.tool).toBe("subprocess-connect");
  expect(egressBlockAudit({ channel: "dns", decision: { action: "allow", host: "pypi.org", reason: "allowed", via: "whitelist" } })).toBeNull();
});

// ── the live proxy on loopback ───────────────────────────────────────────────────────────────────────

let proxy: EgressProxy | null = null;
const servers: TcpServer[] = [];
afterEach(async () => {
  if (proxy) { await proxy.stop(); proxy = null; }
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
});

/** Send one UDP datagram and resolve with the first reply (or reject on timeout). */
function udpRoundTrip(port: number, msg: Uint8Array, timeoutMs = 2000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const c = createSocket("udp4");
    const t = setTimeout(() => { c.close(); reject(new Error("udp timeout")); }, timeoutMs);
    c.once("message", (m) => { clearTimeout(t); c.close(); resolve(m); });
    c.once("error", (e) => { clearTimeout(t); reject(e); });
    c.send(msg, port, "127.0.0.1");
  });
}

test("DNS: a DENIED query gets REFUSED and the upstream is NEVER contacted", async () => {
  let upstreamHits = 0;
  const upstream = createSocket("udp4");
  await new Promise<void>((r) => upstream.bind(0, "127.0.0.1", () => r()));
  upstream.on("message", () => { upstreamHits++; });
  const upstreamPort = upstream.address().port;

  proxy = new EgressProxy({ decide: allowOnly([]), upstream: { host: "127.0.0.1", port: upstreamPort } });
  const ep = await proxy.start();
  const reply = await udpRoundTrip(ep.dnsPort, dnsQuery("secret.attacker.cn"));
  expect(reply[3]! & 0x0f).toBe(5); // REFUSED
  await new Promise((r) => setTimeout(r, 100));
  expect(upstreamHits).toBe(0); // exfil channel never reached the real resolver
  expect(proxy.events.at(-1)?.decision.action).toBe("deny");
  upstream.close();
});

test("DNS: an ALLOWED query is forwarded to the upstream and the answer relayed back verbatim", async () => {
  const upstream = createSocket("udp4");
  await new Promise<void>((r) => upstream.bind(0, "127.0.0.1", () => r()));
  const marker = Uint8Array.from([0x12, 0x34, 0x81, 0x80, 0, 1, 0, 1, 0, 0, 0, 0, 0xde, 0xad, 0xbe, 0xef]);
  upstream.on("message", (_m, rinfo) => upstream.send(marker, rinfo.port, rinfo.address));
  const upstreamPort = upstream.address().port;

  proxy = new EgressProxy({ decide: allowOnly(["pypi.org"]), upstream: { host: "127.0.0.1", port: upstreamPort } });
  const ep = await proxy.start();
  const reply = await udpRoundTrip(ep.dnsPort, dnsQuery("pypi.org"));
  expect(Uint8Array.from(reply)).toEqual(marker);
  expect(proxy.events.at(-1)?.decision.action).toBe("allow");
  upstream.close();
});

/** Read the first chunk a TCP peer sends after we write `send`. */
function connectExpect(port: number, send: string, timeoutMs = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = tcpConnect({ host: "127.0.0.1", port }, () => s.write(send));
    const t = setTimeout(() => { s.destroy(); reject(new Error("tcp timeout")); }, timeoutMs);
    s.once("data", (d) => { clearTimeout(t); const out = d.toString("latin1"); s.destroy(); resolve(out); });
    s.once("error", (e) => { clearTimeout(t); reject(e); });
  });
}

test("CONNECT: a DENIED target is refused with 403, no tunnel opened", async () => {
  proxy = new EgressProxy({ decide: allowOnly([]) });
  const ep = await proxy.start();
  const resp = await connectExpect(ep.httpPort, "CONNECT evil.cn:443 HTTP/1.1\r\n\r\n");
  expect(resp).toContain("403 Forbidden");
  expect(proxy.events.at(-1)?.decision.action).toBe("deny");
});

test("CONNECT: a plain (non-CONNECT) proxied request is rejected — only tunnels are mediated (fail-closed)", async () => {
  proxy = new EgressProxy({ decide: allowOnly(["evil.example"]) });
  const ep = await proxy.start();
  const resp = await connectExpect(ep.httpPort, "GET http://evil.example/x HTTP/1.1\r\n\r\n");
  expect(resp).toContain("405");
});

test("CONNECT: an ALLOWED target tunnels through to the destination (200 + relayed bytes)", async () => {
  // a fake destination that greets on connect
  const dest = createTcpServer((sock) => sock.write("UPSTREAM_HELLO"));
  servers.push(dest);
  const destPort = await new Promise<number>((r) => dest.listen(0, "127.0.0.1", () => r((dest.address() as { port: number }).port)));

  proxy = new EgressProxy({ decide: allowOnly(["127.0.0.1"]) });
  const ep = await proxy.start();
  const got = await new Promise<string>((resolve, reject) => {
    const s = tcpConnect({ host: "127.0.0.1", port: ep.httpPort }, () => s.write(`CONNECT 127.0.0.1:${destPort} HTTP/1.1\r\n\r\n`));
    let buf = "";
    const t = setTimeout(() => { s.destroy(); reject(new Error("tunnel timeout")); }, 3000);
    s.on("data", (d) => { buf += d.toString("latin1"); if (buf.includes("UPSTREAM_HELLO")) { clearTimeout(t); s.destroy(); resolve(buf); } });
    s.once("error", (e) => { clearTimeout(t); reject(e); });
  });
  expect(got).toContain("200 Connection Established");
  expect(got).toContain("UPSTREAM_HELLO");
});

test("kill-the-proxy: after stop() the endpoint is gone and nothing resolves or connects (fail-closed)", async () => {
  proxy = new EgressProxy({ decide: allowOnly(["pypi.org"]) });
  const ep = await proxy.start();
  expect(proxy.running()).toBe(true);
  await proxy.stop();
  expect(proxy.running()).toBe(false);
  expect(proxy.endpoint()).toBeNull();
  await expect(udpRoundTrip(ep.dnsPort, dnsQuery("pypi.org"), 400)).rejects.toThrow(); // no resolver answers
  await expect(connectExpect(ep.httpPort, "CONNECT pypi.org:443 HTTP/1.1\r\n\r\n", 400)).rejects.toThrow();
  proxy = null; // already stopped
});

test("the shared singleton starts once and exposes a loopback endpoint; stop clears it", async () => {
  const ep1 = await ensureEgressProxy();
  const ep2 = await ensureEgressProxy();
  expect(ep1).not.toBeNull();
  expect(ep2).toEqual(ep1); // idempotent — same running instance
  expect(ep1!.host).toBe("127.0.0.1");
  expect(ep1!.httpProxyUrl).toBe(`http://127.0.0.1:${ep1!.httpPort}`);
  await stopEgressProxy();
  const ep3 = await ensureEgressProxy(); // comes back up fresh
  expect(ep3).not.toBeNull();
  await stopEgressProxy();
});
