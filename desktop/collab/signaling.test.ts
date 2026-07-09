// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/signaling.test.ts — P-COLLAB.8 (ADR-0194): the pure signaling protocol.
//
// The RTCPeerConnection transport is renderer-only (verified in the preview), but the signaling shapes + the
// loopback hub are DOM-free and unit-testable here.

import { describe, expect, it } from "bun:test";
import { LoopbackSignaling, isIce, isSdp, type SignalMessage } from "./signaling.ts";

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
