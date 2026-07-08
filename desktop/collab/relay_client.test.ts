// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/relay_client.test.ts — P-COLLAB.2 (ADR-0192): the relay WebSocket client.
//
// Drives CollabSocket with a MOCK WebSocket (injected wsFactory) so the wire contract is proven headless:
// the `?role=` connect URL, seal→send after open, receive→open→onFrame, JSON control, and fail-closed on a
// bad-key frame (terminal close, no reconnect).

import { describe, expect, it } from "bun:test";
import { CollabSocket, type WebSocketLike } from "./relay_client.ts";
import { importRoomKey, generateRoomKey, seal, packEnvelope } from "./crypto.ts";
import type { LucidCollabFrame } from "./frames.ts";

class MockWS implements WebSocketLike {
  static last: MockWS | undefined;
  binaryType = "";
  readyState = 0; // CONNECTING
  url: string;
  sent: Uint8Array[] = [];
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  closedWith: number | undefined;

  constructor(url: string) { this.url = url; MockWS.last = this; }
  send(data: Uint8Array): void { this.sent.push(data); }
  close(code?: number): void { this.closedWith = code; this.readyState = 3; }
  open(): void { this.readyState = 1; this.onopen?.(); }
  emitBinary(bytes: Uint8Array): void { this.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }); }
  emitString(s: string): void { this.onmessage?.({ data: s }); }
  emitClose(code: number, reason = ""): void { this.readyState = 3; this.onclose?.({ code, reason }); }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

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
    expect(ws.sent.length).toBe(1);
    expect(ws.sent[0].byteLength).toBeGreaterThan(4 + 12); // header + IV + ciphertext
  });

  it("buffers sends made before open and flushes them on connect", async () => {
    const key = await importRoomKey(generateRoomKey());
    const sock = new CollabSocket({ wsUrl: "wss://r/r/x", role: "host", key, wsFactory: (u) => new MockWS(u) });
    sock.connect();
    const ws = MockWS.last!;
    sock.send({ t: "bye", reason: "queued" }); // before open
    await flush();
    expect(ws.sent.length).toBe(0);
    ws.open();
    await flush();
    expect(ws.sent.length).toBe(1);
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
