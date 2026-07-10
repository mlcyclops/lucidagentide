// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/fanout_host.test.ts — P-COLLAB.16: one CollabHost fanned out to N per-guest P2P/relay pipes.
//
// Headless (mock guest links, no RTCPeerConnection): proves the fan-out contract - broadcast reaches every
// guest, unicast reaches one, guest frames reach CollabHost tagged with the right peer, relay signal/session
// route to the right pipe, and peer-left tears the pipe down AND tells CollabHost.

import { describe, expect, it } from "bun:test";
import { FanoutHostTransport, type GuestLink } from "./fanout_host.ts";
import type { LucidCollabFrame } from "./frames.ts";
import type { SignalMessage } from "./signaling.ts";

function mockLink(peer: number) {
  const sent: LucidCollabFrame[] = [];
  const signals: SignalMessage[] = [];
  const relayed: LucidCollabFrame[] = [];
  let connected = false;
  let closed = false;
  const link: GuestLink = {
    transport: {
      connect() { connected = true; },
      send(f) { sent.push(f); },
      close() { closed = true; },
    },
    deliverRelay(f) { relayed.push(f); },
    deliverSignal(m) { signals.push(m); },
  };
  return { peer, link, sent, signals, relayed, get connected() { return connected; }, get closed() { return closed; },
    /** simulate a guest frame arriving on this pipe (P2P or relay) */
    emit(f: LucidCollabFrame, from = 0) { link.transport.onFrame?.(f, from); } };
}

const ev = (t: string): LucidCollabFrame => ({ t: "event", event: { type: "token", text: t } }) as unknown as LucidCollabFrame;
const hello = (): LucidCollabFrame => ({ t: "hello", protocol: 1, name: "g" }) as unknown as LucidCollabFrame;

describe("FanoutHostTransport", () => {
  it("broadcasts to every guest and unicasts to one", () => {
    const links = new Map<number, ReturnType<typeof mockLink>>();
    const make = (p: number) => { const m = mockLink(p); links.set(p, m); return m.link; };
    const fan = new FanoutHostTransport({ makeGuest: make });

    fan.onRelayControl({ t: "peer-joined", peer: 3 } as never);
    fan.onRelayControl({ t: "peer-joined", peer: 4 } as never);
    expect(fan.guestCount).toBe(2);
    expect(links.get(3)!.connected).toBe(true); // host is the offerer → each pipe connects

    fan.send(ev("broadcast"), 0);
    expect(links.get(3)!.sent).toEqual([ev("broadcast")]);
    expect(links.get(4)!.sent).toEqual([ev("broadcast")]);

    fan.send(ev("just-3"), 3);
    expect(links.get(3)!.sent).toEqual([ev("broadcast"), ev("just-3")]);
    expect(links.get(4)!.sent).toEqual([ev("broadcast")]); // 4 did NOT get the unicast
  });

  it("tags guest frames off a pipe with that guest's peer id for CollabHost", () => {
    const links = new Map<number, ReturnType<typeof mockLink>>();
    const fan = new FanoutHostTransport({ makeGuest: (p) => { const m = mockLink(p); links.set(p, m); return m.link; } });
    const got: Array<{ t: string; from: number }> = [];
    fan.onFrame = (f, from) => got.push({ t: f.t, from });

    fan.onRelayControl({ t: "peer-joined", peer: 7 } as never);
    links.get(7)!.emit(hello(), 0); // WebRtcTransport delivers fromPeer 0 → fan re-tags with 7
    links.get(7)!.emit(hello(), 7); // an explicit peer id is preserved
    expect(got).toEqual([{ t: "hello", from: 7 }, { t: "hello", from: 7 }]);
  });

  it("routes relay signal + fallback session frames to the right guest pipe (lazily creating it)", () => {
    const links = new Map<number, ReturnType<typeof mockLink>>();
    const fan = new FanoutHostTransport({ makeGuest: (p) => { const m = mockLink(p); links.set(p, m); return m.link; } });

    // No prior peer-joined: a signal from peer 9 lazily creates its pipe.
    fan.onRelaySignal({ t: "ice", candidate: { candidate: "x" } }, 9);
    expect(fan.guestCount).toBe(1);
    expect(links.get(9)!.signals).toHaveLength(1);

    fan.onRelaySession(hello(), 9); // hello arriving over the relay fallback
    expect(links.get(9)!.relayed).toEqual([hello()]);

    fan.onRelaySignal({ t: "ice", candidate: { candidate: "y" } }, 0); // fromPeer 0 (the host itself) → ignored
    expect(fan.guestCount).toBe(1);
  });

  it("tears a pipe down on peer-left AND forwards peer-left to CollabHost", () => {
    const links = new Map<number, ReturnType<typeof mockLink>>();
    const fan = new FanoutHostTransport({ makeGuest: (p) => { const m = mockLink(p); links.set(p, m); return m.link; } });
    const control: string[] = [];
    fan.onControl = (m) => control.push(m.t);

    fan.onRelayControl({ t: "peer-joined", peer: 5 } as never);
    fan.onRelayControl({ t: "peer-left", peer: 5 } as never);
    expect(links.get(5)!.closed).toBe(true);
    expect(fan.guestCount).toBe(0);
    expect(control).toEqual(["peer-left"]); // CollabHost still drops the participant + broadcasts state
  });

  it("close() tears down every pipe and is inert afterward", () => {
    const links = new Map<number, ReturnType<typeof mockLink>>();
    const fan = new FanoutHostTransport({ makeGuest: (p) => { const m = mockLink(p); links.set(p, m); return m.link; } });
    fan.onRelayControl({ t: "peer-joined", peer: 1 } as never);
    fan.onRelayControl({ t: "peer-joined", peer: 2 } as never);

    fan.close();
    expect(links.get(1)!.closed).toBe(true);
    expect(links.get(2)!.closed).toBe(true);
    expect(fan.guestCount).toBe(0);

    fan.send(ev("late"), 0);
    fan.onRelaySession(hello(), 1);
    expect(links.get(1)!.sent).toEqual([]); // nothing after close
  });
});
