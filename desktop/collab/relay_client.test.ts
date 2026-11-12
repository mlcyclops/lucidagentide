// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/relay_client.test.ts — P-COLLAB.2 (ADR-0192): the relay WebSocket client.
//
// Drives CollabSocket with a MOCK WebSocket (injected wsFactory) so the wire contract is proven headless:
// the `?role=` connect URL, seal→send after open, receive→open→onFrame, JSON control, and fail-closed on a
// bad-key frame (terminal close, no reconnect).
//
// P-REMOTE.16 (ADR-0431): liveness + rotation. The mock's close() deliberately emits NO close event (a dead
// socket never does); a late close is emitted explicitly where the test wants one. Real-clock polling is the
// sanctioned exception here (ts-no-test-timers, same as relay_client_auth.test.ts): Bun has no fake
// setTimeout/setInterval, the client's keepalive, rotation deadline and probe are genuine timers, so they are
// injected TINY and every positive wait targets a NAMED observable condition; the liveness clock itself is
// injected. The few "nothing happened" checks wait a couple of periods past the deadline they negate.

import { describe, expect, it } from "bun:test";
import { CollabSocket, type WebSocketLike } from "./relay_client.ts";
import { importRoomKey, generateRoomKey, seal, open, packEnvelope, unpackEnvelope } from "./crypto.ts";
import type { LucidCollabFrame } from "./frames.ts";

class MockWS implements WebSocketLike {
  static last: MockWS | undefined;
  binaryType = "";
  readyState = 0; // CONNECTING
  url: string;
  sent: (Uint8Array | string)[] = [];
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  closedWith: number | undefined;

  constructor(url: string) { this.url = url; MockWS.last = this; }
  send(data: Uint8Array | string): void { this.sent.push(data); }
  close(code?: number): void { this.closedWith = code; this.readyState = 3; }
  open(): void { this.readyState = 1; this.onopen?.(); }
  emitBinary(bytes: Uint8Array): void { this.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }); }
  emitString(s: string): void { this.onmessage?.({ data: s }); }
  emitClose(code: number, reason = ""): void { this.readyState = 3; this.onclose?.({ code, reason }); }
  strings(): string[] { return this.sent.filter((d): d is string => typeof d === "string"); }
  binaries(): Uint8Array[] { return this.sent.filter((d): d is Uint8Array => typeof d !== "string"); }
}

const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};
/** Lets the seal/open chains settle. WebCrypto runs off-thread in Bun, so a single macrotask is a race (the
 *  pre-existing 1-in-6 flake in this file); a short real wait is the deterministic choice. */
const flush = (): Promise<void> => sleep(20);
const waitFor = async (cond: () => boolean, label: string, tries = 200) => {
  for (let i = 0; i < tries; i++) {
    if (cond()) return;
    await sleep(5);
  }
  throw new Error(`timed out waiting for ${label}`);
};

describe("CollabSocket (P-COLLAB.2)", () => {
  it("connects with the ?role= query and arraybuffer binary type", async () => {
    const key = await importRoomKey(generateRoomKey());
    const sock = new CollabSocket({ wsUrl: "wss://relay.example/r/room1", role: "host", key, wsFactory: (u) => new MockWS(u) });
    sock.connect();
    expect(MockWS.last!.url).toBe("wss://relay.example/r/room1?role=host");
    expect(MockWS.last!.binaryType).toBe("arraybuffer");
  });

  it("seals and sends a frame as a [4B peer][sealed] envelope once open", async () => {
    const key = await importRoomKey(generateRoomKey());
    const sock = new CollabSocket({ wsUrl: "wss://r/r/x", role: "host", key, wsFactory: (u) => new MockWS(u) });
    sock.connect();
    const ws = MockWS.last!;
    ws.open();
    sock.send({ t: "bye", reason: "done" }, 0);
    await flush();
    expect(ws.binaries().length).toBe(1);
    expect(ws.binaries()[0]!.byteLength).toBeGreaterThan(4 + 12); // header + IV + ciphertext
  });

  it("buffers sends made before open and flushes them on connect", async () => {
    const key = await importRoomKey(generateRoomKey());
    const sock = new CollabSocket({ wsUrl: "wss://r/r/x", role: "host", key, wsFactory: (u) => new MockWS(u) });
    sock.connect();
    const ws = MockWS.last!;
    sock.send({ t: "bye", reason: "queued" }); // before open
    await flush();
    expect(ws.binaries().length).toBe(0);
    ws.open();
    await flush();
    expect(ws.binaries().length).toBe(1);
  });

  it("opens an inbound envelope and delivers the frame with its sender peer id", async () => {
    const raw = generateRoomKey();
    const key = await importRoomKey(raw);
    const got: { frame: LucidCollabFrame; peer: number }[] = [];
    const sock = new CollabSocket({ wsUrl: "wss://r/r/x", role: "guest", key, wsFactory: (u) => new MockWS(u) });
    sock.onFrame = (frame, peer) => got.push({ frame, peer });
    sock.connect();
    MockWS.last!.open();

    const frame: LucidCollabFrame = { t: "error", message: "hi" };
    const envelope = packEnvelope(42, await seal(key, frame));
    MockWS.last!.emitBinary(envelope);
    await flush();

    expect(got.length).toBe(1);
    expect(got[0].peer).toBe(42);
    expect(got[0].frame).toEqual(frame);
  });

  it("parses a string message as a JSON relay-control frame", async () => {
    const key = await importRoomKey(generateRoomKey());
    const ctrl: unknown[] = [];
    const sock = new CollabSocket({ wsUrl: "wss://r/r/x", role: "host", key, wsFactory: (u) => new MockWS(u) });
    sock.onControl = (m) => ctrl.push(m);
    sock.connect();
    MockWS.last!.open();
    MockWS.last!.emitString(JSON.stringify({ t: "peer-left", peer: 7 }));
    await flush();
    expect(ctrl).toEqual([{ t: "peer-left", peer: 7 }]);
  });

  it("fails closed on a bad-key frame: terminal close, no reconnect", async () => {
    const key = await importRoomKey(generateRoomKey());
    const otherKey = await importRoomKey(generateRoomKey());
    const closes: { reason: string; willReconnect: boolean }[] = [];
    const sock = new CollabSocket({ wsUrl: "wss://r/r/x", role: "guest", key, wsFactory: (u) => new MockWS(u) });
    sock.onClose = (reason, willReconnect) => closes.push({ reason, willReconnect });
    sock.connect();
    MockWS.last!.open();

    // Sealed under the WRONG key → open() throws → fail-closed.
    const bad = packEnvelope(1, await seal(otherKey, { t: "error", message: "x" }));
    MockWS.last!.emitBinary(bad);
    await flush();

    expect(closes.length).toBe(1);
    expect(closes[0].willReconnect).toBe(false);
    expect(MockWS.last!.closedWith).toBe(1000);
  });

  it("marks a fatal relay close code as terminal (no reconnect)", async () => {
    const key = await importRoomKey(generateRoomKey());
    const closes: { reason: string; willReconnect: boolean }[] = [];
    const sock = new CollabSocket({ wsUrl: "wss://r/r/x", role: "guest", key, wsFactory: (u) => new MockWS(u) });
    sock.onClose = (reason, willReconnect) => closes.push({ reason, willReconnect });
    sock.connect();
    MockWS.last!.open();
    MockWS.last!.emitClose(4009); // host conflict
    await flush();
    expect(closes[0]).toEqual({ reason: "a host is already connected for this room", willReconnect: false });
  });
});

// --- P-REMOTE.16 (ADR-0431): liveness, planned rotation, resume -------------------------------------------

const PING = JSON.stringify({ t: "ping" });
const PONG = JSON.stringify({ t: "pong" });
const AUTH_OK = JSON.stringify({ t: "auth-ok" });

async function rig(o: { role?: "host" | "guest"; gated?: boolean; keepaliveMs?: number; maxConnectionMs?: number; jitter?: number } = {}) {
  const key = await importRoomKey(generateRoomKey());
  const sockets: MockWS[] = [];
  const clock = { t: 1_000_000 };
  const events = { opens: 0, closes: [] as { reason: string; willReconnect: boolean }[], control: [] as unknown[], log: [] as string[] };
  const sock = new CollabSocket({
    wsUrl: "ws://relay.test/r/room",
    role: o.role ?? "guest",
    key,
    wsFactory: (u) => { const m = new MockWS(u); sockets.push(m); return m; },
    ...(o.gated ? { authToken: () => `tok-${sockets.length}` } : {}),
    keepaliveMs: o.keepaliveMs ?? 0,
    maxConnectionMs: o.maxConnectionMs ?? 0,
    jitter: () => o.jitter ?? 0.5,
    now: () => clock.t,
    rotateTimeoutMs: 100,
    probeMs: 20,
    onLog: (m) => { events.log.push(m); },
  });
  sock.onOpen = () => { events.opens++; };
  sock.onClose = (reason, willReconnect) => { events.closes.push({ reason, willReconnect }); };
  sock.onControl = (m) => { events.control.push(m); };
  return { sock, sockets, events, clock, key };
}

describe("CollabSocket liveness + rotation (P-REMOTE.16, ADR-0431)", () => {
  it("consumes the relay's pong and never surfaces it as a control message", async () => {
    const { sock, sockets, events } = await rig();
    sock.connect();
    sockets[0]!.open();
    sockets[0]!.emitString(PONG);
    sockets[0]!.emitString(JSON.stringify({ t: "peer-left", peer: 7 }));
    await flush();
    expect(events.control).toEqual([{ t: "peer-left", peer: 7 }]);
  });

  it("rotates a silent socket only once the relay has proven it answers pings", async () => {
    const { sock, sockets, events, clock } = await rig({ keepaliveMs: 10 });
    sock.connect();
    sockets[0]!.open();
    clock.t += 100_000; // far past two missed round-trips - but no pong has ever been seen
    await waitFor(() => sockets[0]!.strings().length >= 3, "three keepalive ticks");
    expect(sockets.length).toBe(1);
    sockets[0]!.emitString(PONG); // from here silence is evidence; the pong itself is fresh inbound
    const pings = sockets[0]!.strings().length;
    await waitFor(() => sockets[0]!.strings().length > pings, "a tick after the pong");
    expect(sockets.length).toBe(1);
    clock.t += 100_000;
    await waitFor(() => sockets.length === 2, "the replacement dial");
    expect(events.log.some((m) => m.includes("keepalive timeout"))).toBe(true);
    expect(sockets[0]!.closedWith).toBeUndefined(); // make-before-break: the old socket is still live
    expect(events.opens).toBe(1);
    sockets[1]!.open();
    expect(sockets[0]!.closedWith).toBe(1000);
    expect(events.opens).toBe(2);
    expect(events.closes).toEqual([]);
  });

  it("planned rotation: dials the replacement, holds sends, swaps make-before-break, fires onOpen once", async () => {
    const { sock, sockets, events, key } = await rig({ maxConnectionMs: 30 });
    sock.connect();
    sockets[0]!.open();
    expect(events.opens).toBe(1);
    await waitFor(() => sockets.length === 2, "the planned replacement dial");
    expect(events.log.some((m) => m.includes("planned reconnect before relay cap"))).toBe(true);
    expect(sockets[0]!.closedWith).toBeUndefined();
    expect(events.opens).toBe(1);
    sock.send({ t: "error", message: "mid-rotation" });
    await flush();
    expect(sockets[0]!.binaries().length).toBe(0); // held: written to neither socket
    expect(sockets[1]!.sent.length).toBe(0);
    sockets[1]!.open();
    expect(sockets[0]!.closedWith).toBe(1000);
    expect(events.opens).toBe(2);
    expect(events.closes).toEqual([]);
    // The retired socket's late close and traffic are inert.
    sockets[0]!.emitClose(1006);
    sockets[0]!.emitString(JSON.stringify({ t: "peer-left", peer: 1 }));
    await flush();
    expect(events.closes).toEqual([]);
    expect(events.control).toEqual([]);
    expect(sockets[1]!.binaries().length).toBe(1); // the held frame flushed on the winner
    const { sealed } = unpackEnvelope(sockets[1]!.binaries()[0]!);
    expect(await open(key, sealed)).toEqual({ t: "error", message: "mid-rotation" });
  });

  it("a replacement that never becomes ready is dropped and the live socket kept (sends resume on it)", async () => {
    const { sock, sockets, events } = await rig();
    sock.connect();
    sockets[0]!.open();
    sock.resume(30_000); // a long absence rotates at once
    expect(sockets.length).toBe(2);
    sockets[1]!.emitClose(1006); // closed before ready
    expect(sockets[1]!.closedWith).toBe(1000);
    expect(sockets[0]!.closedWith).toBeUndefined();
    expect(events.opens).toBe(1);
    expect(events.closes).toEqual([]);
    sock.send({ t: "error", message: "after the failed rotation" });
    await flush();
    expect(sockets[0]!.binaries().length).toBe(1); // the survivor carries traffic again
    sock.resume(30_000);
    expect(sockets.length).toBe(3);
    await waitFor(() => sockets[2]!.closedWith === 1000, "the rotation deadline");
    expect(sockets[0]!.closedWith).toBeUndefined();
    expect(events.log.filter((m) => m.includes("rotation failed, keeping the current socket")).length).toBe(2);
  });

  it("resume(): a short absence probes; an answered probe keeps the socket, an unanswered one rotates", async () => {
    const { sock, sockets, events } = await rig();
    sock.connect();
    sockets[0]!.open();
    sockets[0]!.emitString(PONG); // the relay answers pings, so a probe deadline is meaningful
    sock.resume(1_000);
    expect(sockets[0]!.strings()).toEqual([PING]);
    sockets[0]!.emitString(PONG); // answered
    await sleep(40); // past the probe deadline
    expect(sockets.length).toBe(1);
    sock.resume(1_000);
    expect(sockets[0]!.strings().length).toBe(2);
    await waitFor(() => sockets.length === 2, "the probe-timeout rotation");
    expect(events.log.some((m) => m.includes("probe timeout"))).toBe(true);
    expect(sockets[0]!.closedWith).toBeUndefined();
    sockets[1]!.open();
    expect(sockets[0]!.closedWith).toBe(1000);
    expect(events.opens).toBe(2);
  });

  it("resume(): a relay that never answered a ping is pinged but never probed into a rotation", async () => {
    const { sock, sockets } = await rig();
    sock.connect();
    sockets[0]!.open();
    sock.resume(1_000);
    expect(sockets[0]!.strings()).toEqual([PING]);
    await sleep(40);
    expect(sockets.length).toBe(1);
  });

  it("resume(): disconnected reconnects now; mid-handshake is a no-op", async () => {
    const { sock, sockets, events } = await rig();
    sock.connect();
    sockets[0]!.open();
    sockets[0]!.emitClose(1006); // transient drop: a backoff retry is pending
    expect(events.closes).toEqual([{ reason: "connection lost (code 1006)", willReconnect: true }]);
    sock.resume();
    expect(sockets.length).toBe(2); // the backoff wait was skipped
    sock.resume(60_000); // still CONNECTING: nothing to probe or rotate
    expect(sockets.length).toBe(2);
    expect(sockets[1]!.sent.length).toBe(0);
  });

  it("an anonymous host rotates break-before-make (close, report, retry) and never arms a planned rotation", async () => {
    const { sock, sockets, events } = await rig({ role: "host", jitter: -1.5, maxConnectionMs: 20 });
    sock.connect();
    sockets[0]!.open();
    await sleep(50); // well past maxConnectionMs: no replacement was dialed
    expect(sockets.length).toBe(1);
    sock.resume(30_000);
    expect(sockets[0]!.closedWith).toBe(1000);
    expect(events.closes).toEqual([{ reason: "resumed after suspend", willReconnect: true }]);
    await waitFor(() => sockets.length === 2, "the retry dial");
    sockets[1]!.open();
    expect(events.opens).toBe(2);
  });

  it("a gated host's rotation survives the relay's 4009 on the old socket (its own re-claim)", async () => {
    const { sock, sockets, events } = await rig({ role: "host", gated: true });
    sock.connect();
    sockets[0]!.open();
    await waitFor(() => sockets[0]!.strings().length === 1, "the first auth frame");
    sockets[0]!.emitString(AUTH_OK);
    expect(events.opens).toBe(1);
    sock.resume(30_000);
    expect(sockets.length).toBe(2);
    sockets[1]!.open();
    await waitFor(() => sockets[1]!.strings().length === 1, "the replacement's auth frame");
    expect(JSON.parse(sockets[1]!.strings()[0]!)).toEqual({ t: "auth", token: "tok-2" }); // a FRESH token
    sockets[0]!.emitClose(4009, "replaced by a newer connection from the same account");
    expect(sock.isClosed).toBe(false);
    expect(events.closes).toEqual([]);
    sockets[1]!.emitString(AUTH_OK);
    expect(events.opens).toBe(2);
    sock.send({ t: "error", message: "on the new socket" });
    await flush();
    expect(sockets[1]!.binaries().length).toBe(1);
    expect(sockets[0]!.binaries().length).toBe(0);
  });

  it("a gated host whose old socket died mid-rotation and whose replacement failed takes the retry path", async () => {
    const { sock, sockets, events } = await rig({ role: "host", gated: true, jitter: -1.5 });
    sock.connect();
    sockets[0]!.open();
    await waitFor(() => sockets[0]!.strings().length === 1, "the first auth frame");
    sockets[0]!.emitString(AUTH_OK);
    sock.resume(30_000);
    sockets[0]!.emitClose(4009, "replaced");
    expect(events.closes).toEqual([]);
    sockets[1]!.emitClose(1006); // the replacement never authenticated
    expect(events.closes).toEqual([{ reason: "connection lost, replacement closed before ready (code 1006)", willReconnect: true }]);
    await waitFor(() => sockets.length === 3, "the retry dial");
  });

  it("frames buffered across a gap flush BEHIND what the caller sends from onOpen (hello first)", async () => {
    const { sock, sockets, key } = await rig();
    sock.onOpen = () => sock.send({ t: "error", message: "from onOpen" });
    sock.send({ t: "error", message: "queued while down" });
    await flush();
    sock.connect();
    sockets[0]!.open();
    await flush();
    const frames = await Promise.all(sockets[0]!.binaries().map((b) => open(key, unpackEnvelope(b).sealed)));
    expect(frames.map((f) => (f.t === "error" ? f.message : f.t))).toEqual(["from onOpen", "queued while down"]);
  });
});
