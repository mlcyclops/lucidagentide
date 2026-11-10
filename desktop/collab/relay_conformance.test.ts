// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/relay_conformance.test.ts: ADR-0534 phase B, the collab broker's wire protocol, proven against ONE
// broker started as a deployment starts it (a separate process on a free port, configured by environment only).
// Without LUCID_TEST_COLLAB_RELAY_BIN that is `bun run tools/relay/serve.ts`; with it, that binary run as
// `<bin> collab` (native/lucid-relay). The same scenarios as relay_server.test.ts, relay_auth_gate.test.ts and
// relay_presence.test.ts, driven through real sockets, the real CollabSocket / CollabHost / CollabGuest, a local
// RS256 JWKS for the Firebase gate and a local stand-in for the metadata server and Firestore.
//
//   bun test desktop/collab/relay_conformance.test.ts
//   LUCID_TEST_COLLAB_RELAY_BIN=native/lucid-relay/target/release/lucid-relay.exe bun test desktop/collab/relay_conformance.test.ts

import { afterEach, describe, expect, it } from "bun:test";
import { generateKeyPairSync, sign as signRsa, type KeyObject } from "node:crypto";
import net from "node:net";
import { join } from "node:path";
import { CollabSocket } from "./relay_client.ts";
import { CollabHost } from "./host.ts";
import { CollabGuest } from "./guest.ts";
import { generateRoomKey, importRoomKey } from "./crypto.ts";
import { generateRoomId } from "./link.ts";
import { hashRelayRoomId } from "./relay_presence.ts";

const BIN = process.env.LUCID_TEST_COLLAB_RELAY_BIN || undefined;
const SERVE_TS = join(import.meta.dir, "..", "..", "tools", "relay", "serve.ts");
const PROJECT = "lucid-conformance";

// Real-clock polling is the sanctioned exception here (ts-no-test-timers), as in relay_server.test.ts: these tests
// drive REAL WebSockets through a broker in ANOTHER PROCESS, which no fake clock reaches, and every wait targets a
// named observable condition, never a tuned duration.
async function waitFor(cond: () => boolean | Promise<boolean>, label: string, tries = 600): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (await cond()) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 5);
    await promise;
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const address = s.address();
  const port = address && typeof address === "object" ? address.port : 0;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}

// ── The broker under test ──────────────────────────────────────────────────────────────────────────────────

interface Broker {
  port: number;
  ws: (path: string) => string;
  http: (path: string) => string;
  lines: string[];
  health(): Promise<{ ok: boolean; service: string; rooms: number; peers: number }>;
  stop(): Promise<void>;
}

const BROKER_ENV = /^(HOST|PORT|TLS_CERT|TLS_KEY|MAX_ROOMS|MAX_PEERS_PER_ROOM|MAX_FRAME_BYTES|IDLE_TIMEOUT_SEC|RELAY_.*)$/;
const brokers: Broker[] = [];
const servers: { stop(close?: boolean): unknown }[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) { try { s.close(); } catch { /* gone */ } }
  for (const b of brokers.splice(0)) await b.stop();
  for (const s of servers.splice(0)) s.stop(true);
});

async function startBroker(extra: Record<string, string> = {}): Promise<Broker> {
  const port = await freePort();
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(env)) if (BROKER_ENV.test(k)) delete env[k];
  Object.assign(env, { HOST: "127.0.0.1", PORT: String(port), ...extra });
  const cmd = BIN ? [BIN, "collab"] : [process.execPath, "run", SERVE_TS];
  const proc = Bun.spawn(cmd, { env, stdout: "pipe", stderr: "pipe" });
  const lines: string[] = [];
  const listening = Promise.withResolvers<null>();
  void (async () => {
    const decoder = new TextDecoder();
    let buffered = "";
    for await (const chunk of proc.stdout) {
      buffered += decoder.decode(chunk, { stream: true });
      for (let i = buffered.indexOf("\n"); i >= 0; i = buffered.indexOf("\n")) {
        const line = buffered.slice(0, i).replace(/\r$/, "");
        buffered = buffered.slice(i + 1);
        lines.push(line);
        if (line.includes("LUCID collab relay listening on")) listening.resolve(null);
      }
    }
  })();
  const exited = await Promise.race([listening.promise, proc.exited.then((code) => ({ code }))]);
  if (exited) throw new Error(`the broker exited with ${exited.code}: ${await new Response(proc.stderr).text()}`);
  const b: Broker = {
    port,
    ws: (path) => `ws://127.0.0.1:${port}${path}`,
    http: (path) => `http://127.0.0.1:${port}${path}`,
    lines,
    health: async () => (await fetch(`http://127.0.0.1:${port}/healthz`)).json() as Promise<{ ok: boolean; service: string; rooms: number; peers: number }>,
    stop: async () => { proc.kill(); await proc.exited; },
  };
  brokers.push(b);
  return b;
}

const rooms = async (b: Broker) => (await b.health()).rooms;

interface TestConn { ws: WebSocket; strings: string[]; binaries: Uint8Array[]; close: { code: number; reason: string } | null }

/** A raw socket that records every frame and its close; resolves at open, or at a refusal before open. */
function dial(url: string): Promise<TestConn> {
  const { promise, resolve } = Promise.withResolvers<TestConn>();
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  sockets.push(ws);
  const conn: TestConn = { ws, strings: [], binaries: [], close: null };
  ws.onopen = () => resolve(conn);
  ws.onmessage = (ev) => {
    if (typeof ev.data === "string") conn.strings.push(ev.data);
    else conn.binaries.push(new Uint8Array(ev.data as ArrayBuffer));
  };
  ws.onclose = (ev) => { conn.close = { code: ev.code, reason: ev.reason }; resolve(conn); };
  return promise;
}

function envelope(target: number, payload: number[]): Uint8Array {
  const out = new Uint8Array(4 + payload.length);
  new DataView(out.buffer).setUint32(0, target, false);
  out.set(payload, 4);
  return out;
}

const said = (c: TestConn, t: string) => c.strings.some((s) => s.includes(`"${t}"`));

/** The value at a path through parsed JSON, or undefined where the path leaves objects and arrays. */
function at(value: unknown, ...path: (string | number)[]): unknown {
  let cur = value;
  for (const k of path) cur = cur && typeof cur === "object" ? Reflect.get(cur, k) : undefined;
  return cur;
}

/** The keys of the object at a path, or none. */
function keysAt(value: unknown, ...path: (string | number)[]): string[] {
  const v = at(value, ...path);
  return v && typeof v === "object" ? Object.keys(v) : [];
}

// ── A local RS256 JWKS and Firebase-shaped ID tokens ───────────────────────────────────────────────────────

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const { privateKey: rogueKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "conformance-kid";
const jwk = { ...(publicKey.export({ format: "jwk" }) as Record<string, string>), kid: KID, alg: "RS256", use: "sig" };

function mint(claims: Record<string, unknown>, key: KeyObject = privateKey): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    aud: PROJECT, iss: `https://securetoken.google.com/${PROJECT}`, email_verified: true, iat: now - 60, exp: now + 3600,
    firebase: { sign_in_provider: "google.com" }, ...claims,
  };
  const head = Buffer.from(JSON.stringify({ alg: "RS256", kid: KID, typ: "JWT" })).toString("base64url");
  const input = `${head}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  return `${input}.${signRsa("sha256", Buffer.from(input), key).toString("base64url")}`;
}

const tokens = {
  premium: () => mint({ sub: "u-prem", email: "p@x.io", premium: true }),
  admin: () => mint({ sub: "u-admin", email: "a@x.io", admin: true }),
  guest: () => mint({ sub: "u-guest", email: "g@x.io", premium: true }),
  unentitled: () => mint({ sub: "u-none", email: "n@x.io" }),
  expired: () => mint({ sub: "u-prem", email: "p@x.io", premium: true, exp: Math.floor(Date.now() / 1000) - 3600 }),
  rogue: () => mint({ sub: "u-prem", email: "p@x.io", premium: true }, rogueKey),
};
const authFrame = (token: string) => JSON.stringify({ t: "auth", token });

function jwksServer(): string {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response(JSON.stringify({ keys: [jwk] }), { headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" } }),
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}/keys`;
}

async function gated(extra: Record<string, string> = {}): Promise<Broker> {
  return startBroker({ RELAY_AUTH: "firebase", RELAY_FIREBASE_PROJECT: PROJECT, RELAY_JWKS_URL: jwksServer(), ...extra });
}

/** Dial, authenticate, and wait for auth-ok. */
async function signIn(b: Broker, path: string, token: string): Promise<TestConn> {
  const c = await dial(b.ws(path));
  c.ws.send(authFrame(token));
  await waitFor(() => said(c, "auth-ok") || c.close !== null, `auth on ${path}`);
  expect(c.close).toBeNull();
  return c;
}

// ── Scenarios ──────────────────────────────────────────────────────────────────────────────────────────────

describe(`collab broker conformance (${BIN ? `external: ${BIN}` : "bun run tools/relay/serve.ts"})`, () => {
  it("carries a full host and guest session end to end: hello, welcome, events, bye", async () => {
    const b = await startBroker();
    const key = await importRoomKey(generateRoomKey());
    const wsUrl = b.ws(`/r/${generateRoomId()}`);
    const host = new CollabHost(new CollabSocket({ wsUrl, role: "host", key }), { header: { sessionId: "s1", title: "Live over the broker", model: "m", hostName: "alice", startedAt: 1000 } });
    host.start();
    const events: string[] = [];
    let ended = "";
    const guest = new CollabGuest(new CollabSocket({ wsUrl, role: "guest", key }), { name: "bob" }, { onEvent: (e) => events.push(e.type), onEnd: (r) => (ended = r) });
    guest.start();
    await waitFor(() => guest.view().phase === "live", "guest to go live");
    expect(guest.view().header?.title).toBe("Live over the broker");
    await waitFor(() => host.participantCount === 1, "host to see the guest");
    host.pushEvent({ type: "token", text: "working" });
    host.pushEvent({ type: "done", text: "done" });
    await waitFor(() => events.length >= 2, "two live events");
    expect(events).toEqual(["token", "done"]);
    host.stop("host ended the session");
    await waitFor(() => guest.view().phase === "ended", "guest to end");
    expect(["host ended the session", "room closed"]).toContain(ended);
  });

  it("routes by peer id: header rewritten to the sender, unicast and broadcast, runts dropped, peer-left and room-closed", async () => {
    const b = await startBroker();
    const host = await dial(b.ws("/r/route?role=host"));
    await waitFor(async () => (await rooms(b)) === 1, "the room");
    const g1 = await dial(b.ws("/r/route?role=guest"));
    const g2 = await dial(b.ws("/r/route?role=guest"));
    await waitFor(() => host.strings.length === 2, "two peer-joined");
    expect(host.strings).toEqual(['{"t":"peer-joined","peer":1}', '{"t":"peer-joined","peer":2}']);
    expect(await b.health()).toEqual({ ok: true, service: "lucid-collab-relay", rooms: 1, peers: 3 });

    g2.ws.send(envelope(99, [4, 2])); // a guest's target is ignored: always to the host, tagged with its peer id
    await waitFor(() => host.binaries.length === 1, "guest frame at the host");
    expect([...host.binaries[0]!]).toEqual([0, 0, 0, 2, 4, 2]);
    host.ws.send(envelope(2, [7])); // unicast to peer 2 only
    host.ws.send(new Uint8Array([1, 2])); // a runt: dropped
    host.ws.send(envelope(0, [9])); // broadcast
    await waitFor(() => g2.binaries.length === 2 && g1.binaries.length === 1, "unicast and broadcast");
    expect(g2.binaries.map((x) => [...x])).toEqual([[0, 0, 0, 0, 7], [0, 0, 0, 0, 9]]);
    expect(g1.binaries.map((x) => [...x])).toEqual([[0, 0, 0, 0, 9]]);
    host.ws.send("not a control frame"); // ignored
    g1.ws.close();
    await waitFor(() => host.strings.includes('{"t":"peer-left","peer":1}'), "peer-left");
    host.ws.close();
    await waitFor(() => g2.close !== null, "room closed for the guest");
    expect(g2.strings).toContain('{"t":"room-closed"}');
    expect(g2.close).toEqual({ code: 4001, reason: "room closed" });
    await waitFor(async () => (await rooms(b)) === 0, "the room gone");
  });

  it("fails closed: a guest to a missing room (4004), a second host (4009), and the room survives the refused duplicate", async () => {
    const b = await startBroker();
    const key = await importRoomKey(generateRoomKey());
    const closes: { reason: string; willReconnect: boolean }[] = [];
    const sock = new CollabSocket({ wsUrl: b.ws(`/r/${generateRoomId()}`), role: "guest", key });
    sock.onClose = (reason, willReconnect) => closes.push({ reason, willReconnect });
    sock.connect();
    await waitFor(() => closes.length > 0, "the 4004 refusal");
    expect(closes[0]).toEqual({ reason: "no such room", willReconnect: false });

    const host = await dial(b.ws("/r/anon?role=host"));
    const guest = await dial(b.ws("/r/anon?role=guest"));
    await waitFor(() => said(host, "peer-joined"), "guest joined");
    const dup = await dial(b.ws("/r/anon?role=host"));
    await waitFor(() => dup.close !== null, "dup refused");
    expect(dup.close).toEqual({ code: 4009, reason: "a host is already connected for this room" });
    host.ws.send(envelope(0, [5, 5]));
    await waitFor(() => guest.binaries.length === 1, "forwarding survives");
    expect([...guest.binaries[0]!.subarray(4)]).toEqual([5, 5]);
    expect(guest.close).toBeNull();
    expect(host.strings.some((s) => s.includes("auth-ok"))).toBe(false);
  });

  it("answers HTTP as serve.ts does: /healthz, the /relay prefix, 404, 400, 426", async () => {
    const b = await startBroker();
    const health = await fetch(b.http("/healthz"));
    expect([health.status, health.headers.get("content-type"), await health.json()]).toEqual([200, "application/json", { ok: true, service: "lucid-collab-relay", rooms: 0, peers: 0 }]);
    expect(await (await fetch(b.http("/relay/healthz"))).json()).toMatchObject({ service: "lucid-collab-relay" });
    const root = await fetch(b.http("/"));
    expect([root.status, await root.text()]).toEqual([404, "not a relay room"]);
    const nested = await fetch(b.http("/r/a/b?role=host"));
    expect([nested.status, await nested.text()]).toEqual([404, "not a relay room"]);
    const badRole = await fetch(b.http("/r/abc?role=admin"));
    expect([badRole.status, await badRole.text()]).toEqual([400, "role must be host|guest"]);
    const noUpgrade = await fetch(b.http("/relay/r/abc?role=host"));
    expect([noUpgrade.status, await noUpgrade.text()]).toEqual([426, "expected a websocket upgrade"]);
    const viaPrefix = await dial(b.ws("/relay/r/prefixed?role=host"));
    expect(viaPrefix.close).toBeNull();
    await waitFor(async () => (await rooms(b)) === 1, "a room opened through the /relay prefix");
  });

  it("serves the stale-invite forwarding page at / only when RELAY_PWA_REDIRECT is set", async () => {
    const b = await startBroker({ RELAY_PWA_REDIRECT: "https://lucid-agent.web.app/remote/" });
    const res = await fetch(b.http("/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain('"https://lucid-agent.web.app/remote"');
    expect(html).toContain("location.hash");
    expect(html).toContain("location.replace");
    expect((await fetch(b.http("/healthz"))).status).toBe(200);
  });

  it("answers the exact keepalive with a pong on the same socket and ignores any other string", async () => {
    const b = await startBroker();
    const key = await importRoomKey(generateRoomKey());
    const ctrl: { t: string }[] = [];
    const host = new CollabSocket({ wsUrl: b.ws("/r/keepalive"), role: "host", key, keepaliveMs: 10 });
    host.onControl = (m) => { ctrl.push(m); };
    host.connect();
    await waitFor(async () => (await rooms(b)) === 1, "the room");
    const guest = await dial(b.ws("/r/keepalive?role=guest"));
    guest.ws.send('{"t":"ping"}');
    guest.ws.send('{"t":"ping","extra":1}');
    await waitFor(() => guest.strings.length > 0, "the pong");
    expect(guest.strings).toEqual(['{"t":"pong"}']);
    await waitFor(() => ctrl.some((m) => m.t === "peer-joined"), "peer-joined at the host");
    expect(ctrl.map((m) => m.t)).not.toContain("pong");
    host.close();
  });

  it("holds its limits: rooms (4029), guests per room (4029), an oversized frame closes its socket unforwarded", async () => {
    const b = await startBroker({ MAX_ROOMS: "1", MAX_PEERS_PER_ROOM: "1", MAX_FRAME_BYTES: "1024" });
    const host = await dial(b.ws("/r/one?role=host"));
    await waitFor(async () => (await rooms(b)) === 1, "the room");
    const second = await dial(b.ws("/r/two?role=host"));
    await waitFor(() => second.close !== null, "room capacity");
    expect(second.close).toEqual({ code: 4029, reason: "relay is at room capacity" });
    const g1 = await dial(b.ws("/r/one?role=guest"));
    const g2 = await dial(b.ws("/r/one?role=guest"));
    await waitFor(() => g2.close !== null, "room full");
    expect(g2.close).toEqual({ code: 4029, reason: "room is full" });
    expect(g1.close).toBeNull();
    g1.ws.send(new Uint8Array(4096));
    await waitFor(() => g1.close !== null, "the oversized frame refused");
    // What a client relies on: the sender's socket closes, the host stays and hears it left, nothing was forwarded.
    // The code itself differs (Bun drops the connection, 1006; the Rust broker sends 1009 "message too big").
    expect(BIN ? [1009] : [1006, 1009]).toContain(g1.close!.code);
    await waitFor(() => host.strings.includes('{"t":"peer-left","peer":1}'), "peer-left at the host");
    expect(host.binaries).toEqual([]);
    expect(host.close).toBeNull();
  });
});

describe(`collab broker conformance, the identity gate (${BIN ? "external" : "Bun"})`, () => {
  it("first-frame auth, auth-ok, then rooms and opaque forwarding as before", async () => {
    const b = await gated();
    const host = await signIn(b, "/r/room-1?role=host", tokens.premium());
    expect(await rooms(b)).toBe(1);
    const guest = await signIn(b, "/r/room-1?role=guest", tokens.guest());
    await waitFor(() => said(host, "peer-joined"), "peer-joined");
    guest.ws.send(envelope(0, [9, 8, 7, 6]));
    await waitFor(() => host.binaries.length === 1, "guest frame");
    expect([...host.binaries[0]!]).toEqual([0, 0, 0, 1, 9, 8, 7, 6]);
    host.ws.send(envelope(0, [1, 2]));
    await waitFor(() => guest.binaries.length === 1, "host frame");
    expect([...guest.binaries[0]!]).toEqual([0, 0, 0, 0, 1, 2]);
    expect(host.strings[0]).toBe('{"t":"auth-ok"}');
  });

  it("refuses before auth: binary, a non-auth string and a keepalive (4401), and reaps silence at the deadline", async () => {
    const b = await gated({ RELAY_AUTH_DEADLINE_MS: "200" });
    for (const frame of [envelope(0, [1]), JSON.stringify({ t: "hello" }), '{"t":"ping"}']) {
      const c = await dial(b.ws("/r/x?role=host"));
      c.ws.send(frame);
      await waitFor(() => c.close !== null, "the refusal");
      expect(c.close!.code).toBe(4401);
      expect(c.strings).toEqual([]);
    }
    const silent = await dial(b.ws("/r/x?role=host"));
    await waitFor(() => silent.close !== null, "the deadline");
    expect(silent.close!.code).toBe(4401);
    expect(silent.close!.reason).toContain("deadline");
    expect(await rooms(b)).toBe(0);
  });

  it("maps verdicts to close codes: expired or forged 4401, signed in but unentitled 4403, an unreachable JWKS 4401", async () => {
    const b = await gated();
    for (const [token, code] of [[tokens.expired(), 4401], [tokens.rogue(), 4401], [tokens.unentitled(), 4403], ["not-a-jwt", 4401]] as const) {
      const c = await dial(b.ws("/r/x?role=host"));
      c.ws.send(authFrame(token));
      await waitFor(() => c.close !== null, `close ${code}`);
      expect(c.close!.code).toBe(code);
    }
    expect(await rooms(b)).toBe(0);
    const dead = await startBroker({ RELAY_AUTH: "firebase", RELAY_FIREBASE_PROJECT: PROJECT, RELAY_JWKS_URL: `http://127.0.0.1:${await freePort()}/keys` });
    const c = await dial(dead.ws("/r/x?role=host"));
    c.ws.send(authFrame(tokens.premium()));
    await waitFor(() => c.close !== null, "fail closed");
    expect(c.close!.code).toBe(4401);
  });

  it("bounds rooms per account and sign-ins per minute (4429)", async () => {
    const b = await gated({ RELAY_MAX_ROOMS_PER_USER: "1" });
    await signIn(b, "/r/quota-a?role=host", tokens.premium());
    const second = await dial(b.ws("/r/quota-b?role=host"));
    second.ws.send(authFrame(tokens.premium()));
    await waitFor(() => second.close !== null, "room quota");
    expect(second.close!.code).toBe(4429);

    const r = await gated({ RELAY_MAX_CONNECTS_PER_MINUTE: "2", RELAY_MAX_ROOMS_PER_USER: "10" });
    await signIn(r, "/r/r1?role=host", tokens.premium());
    await signIn(r, "/r/r2?role=host", tokens.premium());
    const third = await dial(r.ws("/r/r3?role=host"));
    third.ws.send(authFrame(tokens.premium()));
    await waitFor(() => third.close !== null, "rate refusal");
    expect(third.close!.code).toBe(4429);
    expect(await rooms(r)).toBe(2);
  });

  it("the same account re-claims its room and guests never notice; another account gets 4009", async () => {
    const b = await gated();
    const host1 = await signIn(b, "/r/rc?role=host", tokens.premium());
    const guest = await signIn(b, "/r/rc?role=guest", tokens.guest());
    const other = await dial(b.ws("/r/rc?role=host"));
    other.ws.send(authFrame(tokens.admin()));
    await waitFor(() => other.close !== null, "another account refused");
    expect(other.close!.code).toBe(4009);
    const host2 = await signIn(b, "/r/rc?role=host", tokens.premium());
    await waitFor(() => host1.close !== null, "the stale socket retired");
    expect(host1.close).toEqual({ code: 4009, reason: "replaced by a newer connection from the same account" });
    await waitFor(() => said(host2, "peer-joined"), "roster resent");
    host2.ws.send(envelope(0, [7, 7]));
    await waitFor(() => guest.binaries.length === 1, "delivery through the new socket");
    expect(guest.close).toBeNull();
    expect(await rooms(b)).toBe(1);
  });

  it("holds a dropped host's room in grace for its owner, and kicks the guests (4001) when the grace runs out", async () => {
    const b = await gated({ RELAY_RECLAIM_GRACE_MS: "5000" });
    const host1 = await signIn(b, "/r/g?role=host", tokens.premium());
    const guest = await signIn(b, "/r/g?role=guest", tokens.guest());
    host1.ws.close();
    await waitFor(async () => (await b.health()).peers === 1, "the host gone, the room held");
    expect(await rooms(b)).toBe(1);
    const host2 = await signIn(b, "/r/g?role=host", tokens.premium());
    await waitFor(() => said(host2, "peer-joined"), "roster resent");
    host2.ws.send(envelope(0, [3, 1]));
    await waitFor(() => guest.binaries.length === 1, "delivery resumes");

    const short = await gated({ RELAY_RECLAIM_GRACE_MS: "40" });
    const h = await signIn(short, "/r/gx?role=host", tokens.premium());
    const g = await signIn(short, "/r/gx?role=guest", tokens.guest());
    h.ws.close();
    await waitFor(() => g.close !== null, "the guest kicked");
    expect(g.close!.code).toBe(4001);
    await waitFor(async () => (await rooms(short)) === 0, "the room gone");
  });

  it("a real CollabSocket host signs in with authToken", async () => {
    const b = await gated();
    const key = await importRoomKey(generateRoomKey());
    const opens: number[] = [];
    const premium = tokens.premium();
    const host = new CollabSocket({ wsUrl: b.ws("/r/e2e"), role: "host", key, authToken: () => premium, keepaliveMs: 0 });
    host.onOpen = () => opens.push(Date.now());
    host.connect();
    await waitFor(() => opens.length === 1, "open after auth-ok");
    expect(await rooms(b)).toBe(1);
    host.close();
  });
});

describe(`collab broker conformance, metadata-only presence (${BIN ? "external" : "Bun"})`, () => {
  it("writes the exact schema through the token and Firestore endpoints, never the raw room id", async () => {
    interface Recorded { url: string; method: string; headers: Headers; body: string }
    const recorded: Recorded[] = [];
    const fake = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        recorded.push({ url: req.url, method: req.method, headers: req.headers, body: await req.text() });
        if (new URL(req.url).pathname === "/token") return Response.json({ access_token: "ephemeral-adc-token", expires_in: 3600 });
        return new Response("{}");
      },
    });
    servers.push(fake);
    const origin = `http://127.0.0.1:${fake.port}`;
    const b = await gated({
      RELAY_TELEMETRY: "firestore", RELAY_FIRESTORE_PROJECT: "test-project", RELAY_FIRESTORE_DATABASE: "presence-db",
      RELAY_METADATA_TOKEN_URL: `${origin}/token`, RELAY_FIRESTORE_URL: origin,
    });
    await waitFor(() => b.lines.some((l) => l.includes("relay telemetry: metadata-only Firestore presence enabled")), "the telemetry summary line");
    const roomId = "raw-room-id-must-never-leave-memory";
    const host = await signIn(b, `/r/${roomId}?role=host`, tokens.admin());
    const guest = await signIn(b, `/r/${roomId}?role=guest`, tokens.guest());
    guest.ws.send('{"t":"ping"}');
    await waitFor(() => guest.strings.includes('{"t":"pong"}'), "the pong");
    guest.ws.close();
    await waitFor(() => said(host, "peer-left"), "peer-left");
    host.ws.close();
    const writes = () => recorded.filter((r) => r.method === "PATCH");
    const status = (r: Recorded): unknown => at(JSON.parse(r.body), "fields", "status", "stringValue");
    await waitFor(() => writes().some((w) => status(w) === "closed"), "the closed snapshot");

    const last = writes().at(-1)!;
    const body: unknown = JSON.parse(last.body);
    expect(keysAt(body)).toEqual(["fields"]);
    expect(keysAt(body, "fields").sort()).toEqual([
      "closedAt", "createdAt", "expireAt", "geo", "guestActiveCount", "guestJoinCount", "guestPeakCount", "heartbeatCount", "host", "lastSeenAt", "participants", "status",
    ]);
    expect(keysAt(body, "fields", "host", "mapValue", "fields").sort()).toEqual(["admin", "effectivePremium", "email", "premium", "uid"]);
    expect(keysAt(body, "fields", "participants", "arrayValue", "values", 0, "mapValue", "fields").sort()).toEqual([
      "admin", "effectivePremium", "email", "joinedAt", "lastSeenAt", "leftAt", "premium", "role", "uid",
    ]);
    expect(body).toMatchObject({
      fields: {
        guestActiveCount: { integerValue: "0" }, guestPeakCount: { integerValue: "1" }, guestJoinCount: { integerValue: "1" }, heartbeatCount: { integerValue: "1" },
        geo: { mapValue: { fields: { status: { stringValue: "unavailable" } } } },
      },
    });
    expect(writes().map(status)).toContain("active");
    expect(last.body).not.toContain(roomId);
    expect(new URL(last.url).pathname).toBe(`/v1/projects/test-project/databases/presence-db/documents/remote_sessions/${encodeURIComponent(await hashRelayRoomId(roomId))}`);
    expect(last.headers.get("authorization")).toBe("Bearer ephemeral-adc-token");
    expect(recorded.find((r) => r.method === "GET")?.headers.get("metadata-flavor")).toBe("Google");
  });
});
