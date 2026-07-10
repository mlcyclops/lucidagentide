// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/prefer_p2p.test.ts — P-COLLAB.16: the WebRTC-preferred / relay-fallback transport.
//
// Transport-agnostic by design, so this proves the whole fallback contract HEADLESSLY (no RTCPeerConnection,
// no relay): starts on the relay, upgrades to P2P when the channel opens, sends each frame once over the
// then-current path, delivers inbound from both paths, and downgrades back to the relay if P2P drops.

import { describe, expect, it } from "bun:test";
import { PreferP2PTransport, type P2PInner } from "./prefer_p2p.ts";
import type { LucidCollabFrame } from "./frames.ts";

/** A controllable stand-in for WebRtcTransport: the test drives open/frame/close by hand. */
function mockP2P() {
  const sent: LucidCollabFrame[] = [];
  let connected = false;
  const inner: P2PInner = {
    connect() { connected = true; },
    send(frame) { sent.push(frame); },
    close() { /* noop */ },
  };
  return {
    inner,
    sent,
    get connected() { return connected; },
    open() { inner.onOpen?.(); },
    deliver(frame: LucidCollabFrame) { inner.onFrame?.(frame, 0); },
    drop() { inner.onClose?.("gone", false); },
  };
}

const frame = (t: string): LucidCollabFrame => ({ t: "event", event: { type: "token", text: t } }) as unknown as LucidCollabFrame;

const tick = () => new Promise<void>((r) => queueMicrotask(r));

describe("PreferP2PTransport", () => {
  it("starts on the relay and fires onOpen without waiting for WebRTC", async () => {
    const p2p = mockP2P();
    const relayed: Array<{ frame: LucidCollabFrame; peer: number }> = [];
    const t = new PreferP2PTransport({ p2p: p2p.inner, targetPeer: 7, relaySend: (frame, peer) => relayed.push({ frame, peer }) });
    let opened = false;
    t.onOpen = () => { opened = true; };

    t.connect();
    expect(p2p.connected).toBe(true); // WebRTC negotiation kicked off in the background
    expect(t.mode).toBe("relay");
    await tick();
    expect(opened).toBe(true); // open immediately - the session never blocks on the DataChannel

    t.send(frame("a"));
    expect(relayed).toEqual([{ frame: frame("a"), peer: 7 }]); // addressed to THIS peer
    expect(p2p.sent).toEqual([]);
  });

  it("upgrades to P2P when the DataChannel opens, then sends peer-to-peer", async () => {
    const p2p = mockP2P();
    const relayed: LucidCollabFrame[] = [];
    const modes: string[] = [];
    const t = new PreferP2PTransport({ p2p: p2p.inner, targetPeer: 3, relaySend: (f) => relayed.push(f), onMode: (m) => modes.push(m) });
    t.connect();
    await tick();

    t.send(frame("relay-1"));       // before the channel opens → relay
    p2p.open();                      // DataChannel opens
    expect(t.mode).toBe("p2p");
    expect(modes).toEqual(["p2p"]);
    t.send(frame("p2p-1"));         // after → direct

    expect(relayed).toEqual([frame("relay-1")]);
    expect(p2p.sent).toEqual([frame("p2p-1")]);
  });

  it("delivers inbound frames from BOTH the relay and the P2P channel, tagged with the peer", async () => {
    const p2p = mockP2P();
    const got: Array<{ type: string; from: number }> = [];
    const t = new PreferP2PTransport({ p2p: p2p.inner, targetPeer: 9, relaySend: () => {} });
    t.onFrame = (f, from) => got.push({ type: (f as { event: { type: string } }).event.type, from });
    t.connect();
    await tick();

    t.relayDeliver(frame("via-relay"), 9);   // coordinator demuxed a relay session frame from peer 9
    p2p.open();
    p2p.deliver(frame("via-p2p"));            // a frame off the DataChannel → tagged with targetPeer
    expect(got).toEqual([{ type: "token", from: 9 }, { type: "token", from: 9 }]);
  });

  it("downgrades back to the relay if the DataChannel drops mid-session", async () => {
    const p2p = mockP2P();
    const relayed: LucidCollabFrame[] = [];
    const modes: string[] = [];
    const t = new PreferP2PTransport({ p2p: p2p.inner, targetPeer: 1, relaySend: (f) => relayed.push(f), onMode: (m) => modes.push(m) });
    t.connect();
    await tick();
    p2p.open();
    t.send(frame("p2p"));           // direct
    p2p.drop();                      // channel dies (e.g. network blip) → back to relay
    expect(t.mode).toBe("relay");
    expect(modes).toEqual(["p2p", "relay"]);
    t.send(frame("relay-again"));   // survives over the relay
    expect(p2p.sent).toEqual([frame("p2p")]);
    expect(relayed).toEqual([frame("relay-again")]);
  });

  it("is inert after close: no sends, no deliveries, closes the P2P side", async () => {
    const p2p = mockP2P();
    let closedInner = false;
    p2p.inner.close = () => { closedInner = true; };
    const relayed: LucidCollabFrame[] = [];
    const got: LucidCollabFrame[] = [];
    let closeReason = "";
    const t = new PreferP2PTransport({ p2p: p2p.inner, targetPeer: 2, relaySend: (f) => relayed.push(f) });
    t.onFrame = (f) => got.push(f);
    t.onClose = (r) => { closeReason = r; };
    t.connect();
    await tick();

    t.close();
    expect(closedInner).toBe(true);
    expect(closeReason).toBe("closed");
    t.send(frame("late"));
    t.relayDeliver(frame("late-in"), 2);
    expect(relayed).toEqual([]);
    expect(got).toEqual([]);
  });
});
