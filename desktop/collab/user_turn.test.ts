// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/user_turn.test.ts — P-COLLAB.15 (ADR-0231): live user-turn mirroring. The host broadcasts
// every user turn (its own + each guest's, attributed by `from`) so all participants see who typed what, in
// order. Driven through MOCK transports (no relay), so proven headless.

import { describe, expect, it } from "bun:test";
import { CollabHost, type HostTransport } from "./host.ts";
import { CollabGuest, type GuestTransport } from "./guest.ts";
import { COLLAB_PROTOCOL_VERSION } from "./frames.ts";
import type { LucidCollabFrame, UserTurnFrame, WelcomeFrame } from "./frames.ts";

const HEADER = { sessionId: "s1", title: "Pair", model: "m", hostName: "alice", startedAt: 1000 };

class HostMock implements HostTransport {
  onOpen?: () => void;
  onFrame?: (frame: LucidCollabFrame, fromPeer: number) => void;
  onControl?: (msg: { t: "peer-joined" | "peer-left"; peer: number }) => void;
  onClose?: (reason: string, willReconnect: boolean) => void;
  sent: { frame: LucidCollabFrame; targetPeer: number }[] = [];
  connect(): void { this.onOpen?.(); }
  send(frame: LucidCollabFrame, targetPeer = 0): void { this.sent.push({ frame, targetPeer }); }
  close(): void {}
  hello(peer: number, name: string): void { this.onFrame?.({ t: "hello", protocol: COLLAB_PROTOCOL_VERSION, name }, peer); }
  userTurns(): UserTurnFrame[] { return this.sent.filter((s): s is { frame: UserTurnFrame; targetPeer: number } => s.frame.t === "user-turn").map((s) => s.frame); }
}

class GuestMock implements GuestTransport {
  onOpen?: () => void;
  onFrame?: (frame: LucidCollabFrame, fromPeer: number) => void;
  onClose?: (reason: string, willReconnect: boolean) => void;
  connect(): void { this.onOpen?.(); }
  send(): void {}
  close(): void {}
  host(frame: LucidCollabFrame): void { this.onFrame?.(frame, 0); }
}

describe("CollabHost broadcasts user turns (P-COLLAB.15)", () => {
  it("broadcasts a host-authored turn attributed to the host name", () => {
    const t = new HostMock();
    const host = new CollabHost(t, { header: HEADER });
    host.start();
    host.pushUserTurn("check the auth guard");
    const turns = t.userTurns();
    expect(turns.length).toBe(1);
    expect(turns[0]).toEqual({ t: "user-turn", text: "check the auth guard", from: "alice" });
    expect(t.sent.find((s) => s.frame.t === "user-turn")!.targetPeer).toBe(0); // broadcast to all
  });

  it("attributes a guest-driven turn to the passed author", () => {
    const t = new HostMock();
    const host = new CollabHost(t, { header: HEADER });
    host.start();
    host.pushUserTurn("tighten it", "bob");
    expect(t.userTurns()[0]).toEqual({ t: "user-turn", text: "tighten it", from: "bob" });
  });

  it("also records the turn in the replay transcript a later joiner receives", () => {
    const t = new HostMock();
    const host = new CollabHost(t, { header: HEADER });
    host.start();
    host.pushUserTurn("earlier question", "bob");
    t.hello(7, "carol"); // a guest joins AFTER the turn
    const welcome = t.sent.find((s) => s.frame.t === "welcome" && s.targetPeer === 7)!.frame as WelcomeFrame;
    expect(welcome.transcript.some((turn) => turn.role === "user" && turn.text === "earlier question")).toBe(true);
  });

  it("does not broadcast once stopped", () => {
    const t = new HostMock();
    const host = new CollabHost(t, { header: HEADER });
    host.start();
    host.stop("ended");
    t.sent = [];
    host.pushUserTurn("too late");
    expect(t.userTurns().length).toBe(0);
  });
});

describe("CollabGuest surfaces user turns (P-COLLAB.15)", () => {
  it("fires onUserTurn for a broadcast user turn (host or another guest)", () => {
    const t = new GuestMock();
    const seen: { text: string; from: string }[] = [];
    const guest = new CollabGuest(t, { name: "carol" }, { onUserTurn: (text, from) => seen.push({ text, from }) });
    guest.start();
    t.host({ t: "welcome", protocol: COLLAB_PROTOCOL_VERSION, header: HEADER, transcript: [], participants: [], readOnly: false });
    t.host({ t: "user-turn", text: "what changed?", from: "alice" });
    t.host({ t: "user-turn", text: "add a test", from: "bob" });
    expect(seen).toEqual([{ text: "what changed?", from: "alice" }, { text: "add a test", from: "bob" }]);
  });
});
