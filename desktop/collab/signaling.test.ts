// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/signaling.test.ts — P-COLLAB.8 (ADR-0194): the pure signaling protocol.
//
// The RTCPeerConnection transport is renderer-only (verified in the preview), but the signaling shapes + the
// loopback hub are DOM-free and unit-testable here.

import { describe, expect, it } from "bun:test";
import { LoopbackSignaling, RelaySignaling, isIce, isSdp, type SignalMessage } from "./signaling.ts";
import { isHostFrame, isGuestFrame, isSignalFrame, type LucidCollabFrame } from "./frames.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("signaling (P-COLLAB.8)", () => {
  it("narrows sdp / ice messages", () => {
    const sdp: SignalMessage = { t: "sdp", sdp: { type: "offer", sdp: "v=0..." } };
    const ice: SignalMessage = { t: "ice", candidate: { candidate: "candidate:1 ...", sdpMid: "0", sdpMLineIndex: 0 } };
    expect(isSdp(sdp)).toBe(true);
    expect(isIce(sdp)).toBe(false);
    expect(isIce(ice)).toBe(true);
    expect(isSdp({ t: "bye" })).toBe(false);
  });

  it("LoopbackSignaling delivers each endpoint's messages to the other (async)", async () => {
    const hub = new LoopbackSignaling();
    const a = hub.endpoint("a");
    const b = hub.endpoint("b");
    const gotA: SignalMessage[] = [];
    const gotB: SignalMessage[] = [];
    a.onMessage((m) => gotA.push(m));
    b.onMessage((m) => gotB.push(m));

    a.send({ t: "sdp", sdp: { type: "offer", sdp: "o" } });
    b.send({ t: "sdp", sdp: { type: "answer", sdp: "a" } });
    b.send({ t: "ice", candidate: { candidate: "c" } });
    expect(gotA.length).toBe(0); // delivery is async (a real network hop) - not re-entrant
    await tick();

    expect(gotB).toEqual([{ t: "sdp", sdp: { type: "offer", sdp: "o" } }]); // a -> b
    expect(gotA.map((m) => m.t)).toEqual(["sdp", "ice"]); // b -> a, in order
  });

  it("stops delivering after close (both directions)", async () => {
    const hub = new LoopbackSignaling();
    const a = hub.endpoint("a");
    const b = hub.endpoint("b");
    const gotB: SignalMessage[] = [];
    b.onMessage((m) => gotB.push(m));
    a.close();
    a.send({ t: "bye" });
    await tick();
    expect(gotB.length).toBe(0);
  });
});

describe("SignalFrame narrowing (P-COLLAB.11)", () => {
  it("a signal frame is neither a host nor a guest session frame", () => {
    const sig: LucidCollabFrame = { t: "signal", signal: { t: "sdp", sdp: { type: "offer", sdp: "o" } } };
    expect(isSignalFrame(sig)).toBe(true);
    expect(isHostFrame(sig)).toBe(false); // so the guest's session handler ignores it
    expect(isGuestFrame(sig)).toBe(false); // so the host's session handler ignores it
    // session frames are not signal frames
    expect(isSignalFrame({ t: "event", event: { type: "token", text: "x" } })).toBe(false);
    expect(isHostFrame({ t: "welcome", protocol: 1, header: { sessionId: "s", title: "t", model: "m", hostName: "h", startedAt: 0 }, transcript: [], participants: [], readOnly: true })).toBe(true);
  });
});

describe("RelaySignaling — WebRTC signaling over the relay (P-COLLAB.11)", () => {
  it("routes the SDP/ICE handshake host<->guest by peer id (the relay routing)", () => {
    const GUEST_PEER = 7;
    // A mock relay frame-router: a signal to peer 0 reaches the host; a signal to GUEST_PEER reaches the guest.
    let host!: RelaySignaling;
    let guest!: RelaySignaling;
    host = new RelaySignaling((msg, target) => { expect(target).toBe(GUEST_PEER); guest.deliver(msg); }, GUEST_PEER);
    guest = new RelaySignaling((msg, target) => { expect(target).toBe(0); host.deliver(msg); }, 0);

    const atHost: SignalMessage[] = [];
    const atGuest: SignalMessage[] = [];
    host.onMessage((m) => atHost.push(m));
    guest.onMessage((m) => atGuest.push(m));

    // host offers -> guest; guest answers + trickles ICE -> host
    host.send({ t: "sdp", sdp: { type: "offer", sdp: "OFFER" } });
    guest.send({ t: "sdp", sdp: { type: "answer", sdp: "ANSWER" } });
    guest.send({ t: "ice", candidate: { candidate: "cand-1" } });
    host.send({ t: "ice", candidate: { candidate: "cand-2" } });

    expect(atGuest).toEqual([{ t: "sdp", sdp: { type: "offer", sdp: "OFFER" } }, { t: "ice", candidate: { candidate: "cand-2" } }]);
    expect(atHost).toEqual([{ t: "sdp", sdp: { type: "answer", sdp: "ANSWER" } }, { t: "ice", candidate: { candidate: "cand-1" } }]);
  });

  it("stops sending + delivering after close", () => {
    const sent: SignalMessage[] = [];
    const s = new RelaySignaling((m) => sent.push(m), 0);
    const got: SignalMessage[] = [];
    s.onMessage((m) => got.push(m));
    s.close();
    s.send({ t: "bye" });        // no send after close
    s.deliver({ t: "bye" });     // no deliver after close
    expect(sent.length).toBe(0);
    expect(got.length).toBe(0);
  });
});
