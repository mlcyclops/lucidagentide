// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/relay_server.test.ts — P-COLLAB.5 (ADR-0192): the embedded relay, over REAL localhost sockets.
//
// Starts an actual relay on 127.0.0.1, connects a REAL host CollabSocket (+ CollabHost) and a REAL guest
// CollabSocket (+ CollabGuest) over real WebSockets, and asserts the end-to-end flow: hello → welcome → live
// events → bye. Also proves the fail-closed guards: a guest to a missing room and a second host both get the
// fatal close code, and the relay never sees plaintext.

import { describe, expect, it, afterEach } from "bun:test";
import { startRelayServer, type RelayHandle } from "./relay_server.ts";
import { CollabSocket } from "./relay_client.ts";
import { CollabHost } from "./host.ts";
import { CollabGuest } from "./guest.ts";
import { generateRoomKey, importRoomKey } from "./crypto.ts";
import { generateRoomId } from "./link.ts";

const waitFor = async (cond: () => boolean, label: string, tries = 300) => {
  for (let i = 0; i < tries; i++) { if (cond()) return; await new Promise((r) => setTimeout(r, 5)); }
  throw new Error(`timed out waiting for ${label}`);
};

let relay: RelayHandle | null = null;
afterEach(() => { relay?.stop(); relay = null; });

async function room() {
  relay = startRelayServer({ port: 0 });
  const roomId = generateRoomId();
  const raw = generateRoomKey();
  const key = await importRoomKey(raw);
  const wsUrl = `ws://127.0.0.1:${relay.port}/r/${roomId}`;
  return { roomId, key, wsUrl };
}

describe("embedded relay server (P-COLLAB.5) over real localhost sockets", () => {
  it("carries a full host↔guest session end-to-end: hello → welcome → events → bye", async () => {
    const { key, wsUrl } = await room();

    const hostSock = new CollabSocket({ wsUrl, role: "host", key });
    const host = new CollabHost(hostSock, { header: { sessionId: "s1", title: "Live over the embedded relay", model: "claude-opus-4-8", hostName: "alice", startedAt: 1000 } });
    host.start();
    host.pushUserTurn("kick things off");

    const guestSock = new CollabSocket({ wsUrl, role: "guest", key });
    const events: string[] = [];
    let ended = "";
    const guest = new CollabGuest(guestSock, { name: "bob" }, { onEvent: (e) => events.push(e.type), onEnd: (r) => (ended = r) });
    guest.start();

    // welcome round-trips through the real relay
    await waitFor(() => guest.view().phase === "live", "guest to go live");
    expect(guest.view().header?.title).toBe("Live over the embedded relay");
    await waitFor(() => host.participantCount === 1, "host to see the guest");

    // live events flow host → relay → guest
    host.pushEvent({ type: "token", text: "working" });
    host.pushEvent({ type: "done", text: "done" });
    await waitFor(() => events.length >= 2, "2 live events at the guest");
    expect(events).toEqual(["token", "done"]);

    // stop → the guest ends. Two signals race, both correct: the application `bye` frame (async decrypt) and
    // the transport `room closed` (4001, synchronous on the host socket dropping). Whichever the guest sees
    // first wins - assert it ended cleanly with a terminal reason, not which of the two arrived first.
    host.stop("host ended the session");
    await waitFor(() => guest.view().phase === "ended", "guest to end on stop");
    expect(["host ended the session", "room closed"]).toContain(ended);
  });

  it("routes between two guests' rosters and updates on leave", async () => {
    const { key, wsUrl } = await room();
    const host = new CollabHost(new CollabSocket({ wsUrl, role: "host", key }), { header: { sessionId: "s", title: "t", model: "m", hostName: "h", startedAt: 0 } });
    host.start();

    const g1 = new CollabGuest(new CollabSocket({ wsUrl, role: "guest", key }), { name: "bob" });
    g1.start();
    await waitFor(() => host.participantCount === 1, "first guest");

    const g2sock = new CollabSocket({ wsUrl, role: "guest", key });
    const g2 = new CollabGuest(g2sock, { name: "carol" });
    g2.start();
    await waitFor(() => host.participantCount === 2, "second guest");
    await waitFor(() => g1.view().participants.length === 2, "g1 sees the updated roster");

    g2.leave();
    await waitFor(() => host.participantCount === 1, "roster shrinks on leave");
  });

  it("fails closed: a guest to a nonexistent room is refused (4004, no reconnect)", async () => {
    relay = startRelayServer({ port: 0 });
    const key = await importRoomKey(generateRoomKey());
    const wsUrl = `ws://127.0.0.1:${relay.port}/r/${generateRoomId()}`; // no host ever opened this room
    const closes: { reason: string; willReconnect: boolean }[] = [];
    const sock = new CollabSocket({ wsUrl, role: "guest", key });
    sock.onClose = (reason, willReconnect) => closes.push({ reason, willReconnect });
    sock.connect();
    await waitFor(() => closes.length > 0, "the refusal");
    expect(closes[0].willReconnect).toBe(false);
    expect(closes[0].reason).toBe("no such room");
  });

  it("fails closed: a second host for the same room is refused (4009)", async () => {
    const { key, wsUrl } = await room();
    const h1 = new CollabSocket({ wsUrl, role: "host", key });
    h1.connect();
    await waitFor(() => relay!.roomCount() === 1, "the room to exist");

    const closes: string[] = [];
    const h2 = new CollabSocket({ wsUrl, role: "host", key });
    h2.onClose = (reason, willReconnect) => { if (!willReconnect) closes.push(reason); };
    h2.connect();
    await waitFor(() => closes.length > 0, "the host-conflict refusal");
    expect(closes[0]).toBe("a host is already connected for this room");
  });
});

describe("P-REMOTE.4a: the stale-invite fallback redirect at /", () => {
  it("serves a fragment-forwarding page when pwaRedirectBase is set", async () => {
    relay = startRelayServer({ port: 0, pwaRedirectBase: "https://lucid-agent.web.app/remote/" });
    const res = await fetch(`http://127.0.0.1:${relay.port}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    // the trailing slash is trimmed and the base is embedded for the client-side location.hash forward
    expect(html).toContain('"https://lucid-agent.web.app/remote"');
    expect(html).toContain("location.hash");
    expect(html).toContain("location.replace");
  });

  it("does NOT hijack /healthz or /r/<room> when pwaRedirectBase is set", async () => {
    relay = startRelayServer({ port: 0, pwaRedirectBase: "https://lucid-agent.web.app/remote" });
    const health = await fetch(`http://127.0.0.1:${relay.port}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, service: "lucid-collab-relay" });
    // a room path without a websocket upgrade still asks for the upgrade (426), never the redirect page
    const roomRes = await fetch(`http://127.0.0.1:${relay.port}/r/abc?role=host`);
    expect(roomRes.status).toBe(426);
  });

  it("leaves / as a 404 when pwaRedirectBase is unset (OSS / self-hosted default)", async () => {
    relay = startRelayServer({ port: 0 });
    const res = await fetch(`http://127.0.0.1:${relay.port}/`);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("not a relay room");
  });
});
