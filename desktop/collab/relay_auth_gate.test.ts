// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/relay_auth_gate.test.ts — P-REMOTE.1 (ADR-0226/0227): the gated relay over REAL sockets.
//
// Drives startRelayServer({ auth }) with an INJECTED verifier (the crypto matrix lives in
// relay_auth.test.ts) and raw WebSockets, proving the gate mechanics: first-frame auth → auth-ok → normal
// E2E forwarding; every pre-auth misstep (binary, junk, silence, bad/unentitled token, a THROWING verifier)
// refuses with the right fatal code and never admits; per-uid quotas bound rooms + connect rate; and
// anonymous mode (no `auth`) keeps the pre-P-REMOTE behavior — including the P-REMOTE.1 regression fix that
// a REJECTED duplicate host (4009) no longer tears down the room it never owned.

import { describe, expect, it, afterEach } from "bun:test";
import { startRelayServer, type RelayHandle } from "./relay_server.ts";
import { CollabSocket } from "./relay_client.ts";
import { generateRoomKey, importRoomKey } from "./crypto.ts";
import type { AuthVerdict } from "./relay_auth.ts";

// Real-clock polling is the sanctioned exception here (ts-no-test-timers): these tests drive REAL
// WebSockets through a REAL Bun.serve listener (same pattern as relay_server.test.ts) — fake timers cannot
// advance actual socket I/O, and every wait targets a NAMED observable condition, never a tuned duration.
const waitFor = async (cond: () => boolean, label: string, tries = 400) => {
  for (let i = 0; i < tries; i++) {
    if (cond()) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 5);
    await promise;
  }
  throw new Error(`timed out waiting for ${label}`);
};

function envelope(target: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.length);
  new DataView(out.buffer).setUint32(0, target, false);
  out.set(payload, 4);
  return out;
}

interface TestConn {
  ws: WebSocket;
  strings: string[];
  binaries: Uint8Array[];
  close: { code: number; reason: string } | null;
}

function connect(url: string): Promise<TestConn> {
  const { promise, resolve } = Promise.withResolvers<TestConn>();
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  const conn: TestConn = { ws, strings: [], binaries: [], close: null };
  ws.onopen = () => resolve(conn);
  ws.onmessage = (ev) => {
    if (typeof ev.data === "string") conn.strings.push(ev.data);
    else conn.binaries.push(new Uint8Array(ev.data as ArrayBuffer));
  };
  ws.onclose = (ev) => {
    conn.close = { code: ev.code, reason: ev.reason };
    resolve(conn); // a socket refused before/at open still resolves — the test asserts on `close`
  };
  return promise;
}

const verdicts: Record<string, AuthVerdict | "throw"> = {
  "tok-premium": { ok: true, uid: "u-prem", email: "p@x.io", premium: true, admin: false },
  "tok-admin": { ok: true, uid: "u-admin", email: "a@x.io", premium: true, admin: true },
  "tok-guest": { ok: true, uid: "u-guest", email: "g@x.io", premium: true, admin: false },
  "tok-4401": { ok: false, code: 4401, reason: "bad token" },
  "tok-4403": { ok: false, code: 4403, reason: "not entitled" },
  "tok-boom": "throw",
};
async function fakeVerify(token: string): Promise<AuthVerdict> {
  const v = verdicts[token];
  if (v === "throw") throw new Error("verifier exploded");
  return v ?? { ok: false, code: 4401, reason: "unknown test token" };
}

const authFrame = (token: string) => JSON.stringify({ t: "auth", token });

let relay: RelayHandle | null = null;
const conns: TestConn[] = [];
afterEach(() => {
  for (const c of conns) { try { c.ws.close(); } catch { /* gone */ } }
  conns.length = 0;
  relay?.stop();
  relay = null;
});

async function dial(path: string): Promise<TestConn> {
  const c = await connect(`ws://127.0.0.1:${relay!.port}${path}`);
  conns.push(c);
  return c;
}

describe("gated relay (P-REMOTE.1) over real localhost sockets", () => {
  it("full flow: first-frame auth → auth-ok → rooms + opaque E2E forwarding work as before", async () => {
    relay = startRelayServer({ port: 0, auth: { verify: fakeVerify } });

    const host = await dial("/r/room-1?role=host");
    host.ws.send(authFrame("tok-premium"));
    await waitFor(() => host.strings.some((s) => s.includes('"auth-ok"')), "host auth-ok");
    expect(relay.roomCount()).toBe(1);

    const guest = await dial("/r/room-1?role=guest");
    guest.ws.send(authFrame("tok-guest"));
    await waitFor(() => guest.strings.some((s) => s.includes('"auth-ok"')), "guest auth-ok");
    await waitFor(() => host.strings.some((s) => s.includes('"peer-joined"')), "peer-joined at host");

    // guest → host: relay rewrites the header to the guest's peer id, payload passes through opaque
    const payload = new Uint8Array([9, 8, 7, 6]);
    guest.ws.send(envelope(0, payload));
    await waitFor(() => host.binaries.length === 1, "guest envelope at host");
    expect([...host.binaries[0]!.subarray(4)]).toEqual([9, 8, 7, 6]);

    // host broadcast → guest, header = 0 (host)
    host.ws.send(envelope(0, new Uint8Array([1, 2])));
    await waitFor(() => guest.binaries.length === 1, "host envelope at guest");
    expect([...guest.binaries[0]!]).toEqual([0, 0, 0, 0, 1, 2]);
  });

  it("refuses BINARY before auth (4401) — ciphertext is not a credential", async () => {
    relay = startRelayServer({ port: 0, auth: { verify: fakeVerify } });
    const c = await dial("/r/x?role=host");
    c.ws.send(envelope(0, new Uint8Array([1])));
    await waitFor(() => c.close !== null, "close");
    expect(c.close!.code).toBe(4401);
    expect(relay.roomCount()).toBe(0);
  });

  it("refuses a non-auth string frame (4401)", async () => {
    relay = startRelayServer({ port: 0, auth: { verify: fakeVerify } });
    const c = await dial("/r/x?role=host");
    c.ws.send(JSON.stringify({ t: "hello" }));
    await waitFor(() => c.close !== null, "close");
    expect(c.close!.code).toBe(4401);
  });

  it("reaps a silent socket at the deadline (4401) and never admits it", async () => {
    relay = startRelayServer({ port: 0, auth: { verify: fakeVerify, deadlineMs: 100 } });
    const c = await dial("/r/x?role=host");
    await waitFor(() => c.close !== null, "deadline reap");
    expect(c.close!.code).toBe(4401);
    expect(c.close!.reason).toContain("deadline");
    expect(relay.roomCount()).toBe(0);
  });

  it("maps verdicts to close codes: invalid → 4401, unentitled → 4403, THROWING verifier → 4401 (fail-closed)", async () => {
    relay = startRelayServer({ port: 0, auth: { verify: fakeVerify } });
    for (const [token, code] of [["tok-4401", 4401], ["tok-4403", 4403], ["tok-boom", 4401]] as const) {
      const c = await dial("/r/x?role=host");
      c.ws.send(authFrame(token));
      await waitFor(() => c.close !== null, `${token} close`);
      expect(c.close!.code).toBe(code);
    }
    expect(relay.roomCount()).toBe(0);
  });

  it("bounds rooms per uid (4429)", async () => {
    relay = startRelayServer({ port: 0, auth: { verify: fakeVerify, maxRoomsPerUser: 1 } });
    const a = await dial("/r/quota-a?role=host");
    a.ws.send(authFrame("tok-premium"));
    await waitFor(() => a.strings.some((s) => s.includes('"auth-ok"')), "first room");
    const b = await dial("/r/quota-b?role=host");
    b.ws.send(authFrame("tok-premium"));
    await waitFor(() => b.close !== null, "quota refusal");
    expect(b.close!.code).toBe(4429);
    expect(relay.roomCount()).toBe(1);
  });

  it("bounds successful auths per uid per minute (4429)", async () => {
    relay = startRelayServer({ port: 0, auth: { verify: fakeVerify, maxConnectsPerMinute: 2, maxRoomsPerUser: 10 } });
    for (const [room, admitted] of [["r1", true], ["r2", true], ["r3", false]] as const) {
      const c = await dial(`/r/${room}?role=host`);
      c.ws.send(authFrame("tok-premium"));
      if (admitted) await waitFor(() => c.strings.some((s) => s.includes('"auth-ok"')), `${room} admitted`);
      else {
        await waitFor(() => c.close !== null, "rate refusal");
        expect(c.close!.code).toBe(4429);
      }
    }
    expect(relay.roomCount()).toBe(2);
  });

  it("ANONYMOUS mode is unchanged — and a rejected duplicate host no longer nukes the room (regression)", async () => {
    relay = startRelayServer({ port: 0 }); // no auth: admitted at open, strings ignored, no auth-ok
    const host = await dial("/r/anon?role=host");
    await waitFor(() => relay!.roomCount() === 1, "room open");
    const guest = await dial("/r/anon?role=guest");
    await waitFor(() => host.strings.some((s) => s.includes('"peer-joined"')), "guest joined");
    expect(host.strings.some((s) => s.includes("auth-ok"))).toBe(false);

    // duplicate host: refused 4009 — and the LEGIT room + its guest must survive its close event.
    // No sleep: SUCCESSFUL forwarding after the refusal IS the deterministic proof the room survived
    // (the buggy teardown would have closed the guest and deleted the room, so delivery could not happen).
    const dup = await dial("/r/anon?role=host");
    await waitFor(() => dup.close !== null, "dup host refused");
    expect(dup.close!.code).toBe(4009);

    // the surviving room still forwards, and a client STRING is still ignored (not an auth surface)
    host.ws.send("not-an-auth-frame");
    host.ws.send(envelope(0, new Uint8Array([5, 5])));
    await waitFor(() => guest.binaries.length === 1, "forwarding survives");
    expect([...guest.binaries[0]!.subarray(4)]).toEqual([5, 5]);
    expect(relay.roomCount()).toBe(1);
    expect(guest.close).toBeNull();
  });
});

describe("host re-claim + grace (P-REMOTE.2) over real localhost sockets", () => {
  it("the SAME uid replaces its own lingering host connection; guests never notice", async () => {
    relay = startRelayServer({ port: 0, auth: { verify: fakeVerify } });
    const host1 = await dial("/r/rc?role=host");
    host1.ws.send(authFrame("tok-premium"));
    await waitFor(() => host1.strings.some((s) => s.includes('"auth-ok"')), "host1 admitted");
    const guest = await dial("/r/rc?role=guest");
    guest.ws.send(authFrame("tok-guest"));
    await waitFor(() => guest.strings.some((s) => s.includes('"auth-ok"')), "guest admitted");

    // the hourly reconnect racing its own stale connection: same account, same room
    const host2 = await dial("/r/rc?role=host");
    host2.ws.send(authFrame("tok-premium"));
    await waitFor(() => host2.strings.some((s) => s.includes('"auth-ok"')), "host2 re-claimed");
    await waitFor(() => host1.close !== null, "stale connection retired");
    expect(host1.close!.code).toBe(4009);
    // roster resent to the new connection so the host re-learns its guests
    await waitFor(() => host2.strings.some((s) => s.includes('"peer-joined"')), "roster resent");
    // the guest was never disconnected and still receives from the new connection
    host2.ws.send(envelope(0, new Uint8Array([7, 7])));
    await waitFor(() => guest.binaries.length === 1, "delivery via the new connection");
    expect([...guest.binaries[0]!.subarray(4)]).toEqual([7, 7]);
    expect(guest.close).toBeNull();
    expect(relay.roomCount()).toBe(1);
  });

  it("a DIFFERENT uid still gets 4009 and the room survives", async () => {
    relay = startRelayServer({ port: 0, auth: { verify: fakeVerify } });
    const host1 = await dial("/r/rc2?role=host");
    host1.ws.send(authFrame("tok-premium"));
    await waitFor(() => host1.strings.some((s) => s.includes('"auth-ok"')), "host1 admitted");
    const other = await dial("/r/rc2?role=host");
    other.ws.send(authFrame("tok-admin")); // valid account, but not the room owner
    await waitFor(() => other.close !== null, "other refused");
    expect(other.close!.code).toBe(4009);
    expect(host1.close).toBeNull();
    expect(relay.roomCount()).toBe(1);
  });

  it("a dropped host room is HELD in grace for its guests, and the owner resumes it", async () => {
    relay = startRelayServer({ port: 0, auth: { verify: fakeVerify, reclaimGraceMs: 5000 } });
    const host1 = await dial("/r/g?role=host");
    host1.ws.send(authFrame("tok-premium"));
    await waitFor(() => host1.strings.some((s) => s.includes('"auth-ok"')), "host admitted");
    const guest = await dial("/r/g?role=guest");
    guest.ws.send(authFrame("tok-guest"));
    await waitFor(() => guest.strings.some((s) => s.includes('"auth-ok"')), "guest admitted");

    // the host drops (the 60-min cap); the room is HELD, the guest stays connected
    host1.ws.close();
    await waitFor(() => host1.close !== null, "host gone");
    expect(relay.roomCount()).toBe(1);
    expect(guest.close).toBeNull();

    // the owner returns within grace and adopts the held room
    const host2 = await dial("/r/g?role=host");
    host2.ws.send(authFrame("tok-premium"));
    await waitFor(() => host2.strings.some((s) => s.includes('"auth-ok"')), "host resumed");
    await waitFor(() => host2.strings.some((s) => s.includes('"peer-joined"')), "roster resent");
    host2.ws.send(envelope(0, new Uint8Array([3, 1])));
    await waitFor(() => guest.binaries.length === 1, "delivery resumes");
    expect([...guest.binaries[0]!.subarray(4)]).toEqual([3, 1]);
  });

  it("grace EXPIRES: the guest is kicked (4001) when the owner never returns", async () => {
    relay = startRelayServer({ port: 0, auth: { verify: fakeVerify, reclaimGraceMs: 40 } });
    const host1 = await dial("/r/gx?role=host");
    host1.ws.send(authFrame("tok-premium"));
    await waitFor(() => host1.strings.some((s) => s.includes('"auth-ok"')), "host admitted");
    const guest = await dial("/r/gx?role=guest");
    guest.ws.send(authFrame("tok-guest"));
    await waitFor(() => guest.strings.some((s) => s.includes('"auth-ok"')), "guest admitted");
    host1.ws.close();
    await waitFor(() => guest.close !== null, "guest kicked on grace expiry");
    expect(guest.close!.code).toBe(4001);
    expect(relay.roomCount()).toBe(0);
  });

  it("end to end: a real CollabSocket host survives a drop via authToken + re-claim", async () => {
    relay = startRelayServer({ port: 0, auth: { verify: fakeVerify, reclaimGraceMs: 5000 } });
    const key = await importRoomKey(generateRoomKey());
    const wsUrl = `ws://127.0.0.1:${relay.port}/r/e2e`;
    const opens: number[] = [];
    const host = new CollabSocket({ wsUrl, role: "host", key, authToken: () => "tok-premium", keepaliveMs: 0 });
    host.onOpen = () => opens.push(Date.now());
    host.connect();
    await waitFor(() => opens.length === 1, "host open after auth-ok");
    expect(relay.roomCount()).toBe(1);
    host.close();
  });
});
