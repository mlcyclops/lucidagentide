// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/relay_client_auth.test.ts — P-REMOTE.2 (ADR-0226/0227): the CLIENT side of the identity
// gate, headless over a mock socket. Proves the handshake ordering (auth frame FIRST, all traffic held until
// `auth-ok`), a FRESH token per reconnect, terminal handling of a null token and of the 4401/4403/4429
// refusals (no retry storm against a gate), the keepalive cadence, and that anonymous mode is byte-identical.

import { describe, expect, it } from "bun:test";
import { CollabSocket, type WebSocketLike } from "./relay_client.ts";
import { generateRoomKey, importRoomKey } from "./crypto.ts";

// Real-clock polling (ts-no-test-timers exception): CollabSocket's auth handshake is genuinely async
// (awaits the token provider); every wait targets a NAMED observable condition with a tight bound.
const waitFor = async (cond: () => boolean, label: string, tries = 200) => {
  for (let i = 0; i < tries; i++) {
    if (cond()) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 5);
    await promise;
  }
  throw new Error(`timed out waiting for ${label}`);
};

class MockWS implements WebSocketLike {
  binaryType = "";
  readyState = 0;
  sent: (Uint8Array | string)[] = [];
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  send(data: Uint8Array | string): void { this.sent.push(data); }
  close(code?: number): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code: code ?? 1000, reason: "" });
  }
  open(): void { this.readyState = 1; this.onopen?.(); }
  serverSay(s: string): void { this.onmessage?.({ data: s }); }
  serverDrop(code: number, reason = ""): void { this.readyState = 3; this.onclose?.({ code, reason }); }
  strings(): string[] { return this.sent.filter((d): d is string => typeof d === "string"); }
  binaries(): Uint8Array[] { return this.sent.filter((d): d is Uint8Array => typeof d !== "string"); }
}

async function rig(opts: {
  tokens?: (string | null)[];
  keepaliveMs?: number;
  anonymous?: boolean;
}) {
  const key = await importRoomKey(generateRoomKey());
  const sockets: MockWS[] = [];
  let tokenCalls = 0;
  const events: { opens: number; closes: { reason: string; willReconnect: boolean }[] } = { opens: 0, closes: [] };
  const sock = new CollabSocket({
    wsUrl: "ws://relay.test/r/room",
    role: "host",
    key,
    wsFactory: () => { const m = new MockWS(); sockets.push(m); return m; },
    jitter: () => -1.5, // drives the retry delay to 0 so reconnects are immediate + deterministic
    keepaliveMs: opts.keepaliveMs ?? 0,
    ...(opts.anonymous ? {} : { authToken: () => { const t = opts.tokens?.[tokenCalls] ?? null; tokenCalls++; return t; } }),
  });
  sock.onOpen = () => events.opens++;
  sock.onClose = (reason, willReconnect) => events.closes.push({ reason, willReconnect });
  return { sock, sockets, events, tokenCalls: () => tokenCalls, key };
}

describe("CollabSocket identity handshake (P-REMOTE.2)", () => {
  it("sends the auth frame FIRST and holds all traffic until auth-ok", async () => {
    const { sock, sockets, events } = await rig({ tokens: ["tok-1"] });
    sock.send({ t: "bye", reason: "queued before connect" } as never); // seals into the reconnect buffer
    sock.connect();
    const ws = sockets[0]!;
    ws.open();
    await waitFor(() => ws.sent.length >= 1, "auth frame on the wire");
    expect(typeof ws.sent[0]).toBe("string");
    expect(JSON.parse(ws.sent[0] as string)).toEqual({ t: "auth", token: "tok-1" });
    expect(ws.binaries().length).toBe(0); // the queued envelope is HELD
    expect(events.opens).toBe(0);

    ws.serverSay(JSON.stringify({ t: "auth-ok" }));
    await waitFor(() => ws.binaries().length === 1, "held envelope flushed after auth-ok");
    expect(events.opens).toBe(1);
  });

  it("fetches a FRESH token on every reconnect (the hourly re-verify)", async () => {
    const { sock, sockets, tokenCalls } = await rig({ tokens: ["t1", "t2"] });
    sock.connect();
    sockets[0]!.open();
    await waitFor(() => sockets[0]!.strings().length === 1, "first auth");
    sockets[0]!.serverSay(JSON.stringify({ t: "auth-ok" }));
    sockets[0]!.serverDrop(1006); // transient drop (the 60-min cap looks like this)
    await waitFor(() => sockets.length === 2, "reconnect socket");
    sockets[1]!.open();
    await waitFor(() => sockets[1]!.strings().length === 1, "second auth");
    expect(JSON.parse(sockets[1]!.strings()[0]!)).toEqual({ t: "auth", token: "t2" });
    expect(tokenCalls()).toBe(2);
  });

  it("a null token is TERMINAL (sign in), never an unauthenticated retry loop", async () => {
    const { sock, sockets, events } = await rig({ tokens: [null] });
    sock.connect();
    sockets[0]!.open();
    await waitFor(() => events.closes.length === 1, "terminal close");
    expect(events.closes[0]).toEqual({ reason: "the relay requires sign-in but no token is available", willReconnect: false });
    expect(sockets.length).toBe(1); // no reconnect attempt
  });

  it("treats 4401 / 4403 / 4429 as fatal — no retry storm against the gate", async () => {
    for (const code of [4401, 4403, 4429]) {
      const { sock, sockets, events } = await rig({ tokens: ["tok"] });
      sock.connect();
      sockets[0]!.open();
      await waitFor(() => sockets[0]!.strings().length === 1, "auth sent");
      sockets[0]!.serverDrop(code);
      await waitFor(() => events.closes.length === 1, `close for ${code}`);
      expect(events.closes[0]!.willReconnect).toBe(false);
      expect(sockets.length).toBe(1);
    }
  });

  it("keepalive pings ride as ignorable strings under the idle ceiling, and stop on close", async () => {
    const { sock, sockets } = await rig({ anonymous: true, keepaliveMs: 10 });
    sock.connect();
    sockets[0]!.open();
    await waitFor(() => sockets[0]!.strings().filter((s) => s.includes("ping")).length >= 2, "two pings");
    expect(JSON.parse(sockets[0]!.strings()[0]!)).toEqual({ t: "ping" });
    sock.close();
    await waitFor(() => sockets[0]!.readyState === 3, "socket closed");
    const after = sockets[0]!.strings().length;
    // 3x the cadence with zero new pings = the interval was cleared, not just unlucky timing
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 35);
    await promise;
    expect(sockets[0]!.strings().length).toBe(after);
  });

  it("anonymous mode is unchanged: opens immediately, first wire bytes are the sealed envelope", async () => {
    const { sock, sockets, events } = await rig({ anonymous: true });
    sock.send({ t: "bye", reason: "queued" } as never);
    sock.connect();
    sockets[0]!.open();
    await waitFor(() => sockets[0]!.sent.length >= 1, "flush");
    expect(events.opens).toBe(1);
    expect(typeof sockets[0]!.sent[0]).not.toBe("string"); // no auth frame, envelope first
  });
});
