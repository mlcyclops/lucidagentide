// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/guest.test.ts — P-COLLAB.4 (ADR-0192): the read-only guest protocol.
//
// Drives CollabGuest through a MOCK transport (no relay, no sockets) so the hello handshake, welcome/event/
// state/bye/error handling, view-only stance, and fail-closed end conditions are all proven headless.

import { describe, expect, it } from "bun:test";
import { CollabGuest, type GuestTransport } from "./guest.ts";
import { COLLAB_PROTOCOL_VERSION } from "./frames.ts";
import type { LucidCollabFrame, WelcomeFrame } from "./frames.ts";
import { generateWriteToken } from "./crypto.ts";

class MockTransport implements GuestTransport {
  onOpen?: () => void;
  onFrame?: (frame: LucidCollabFrame, fromPeer: number) => void;
  onClose?: (reason: string, willReconnect: boolean) => void;
  sent: { frame: LucidCollabFrame; targetPeer: number }[] = [];
  closed = false;
  connect(): void { this.onOpen?.(); }
  send(frame: LucidCollabFrame, targetPeer = 0): void { this.sent.push({ frame, targetPeer }); }
  close(): void { this.closed = true; }
  // helpers: deliver a host frame (fromPeer 0 = the host)
  host(frame: LucidCollabFrame): void { this.onFrame?.(frame, 0); }
  drop(reason: string, willReconnect: boolean): void { this.onClose?.(reason, willReconnect); }
}

const HEADER = { sessionId: "s1", title: "Fix the guard", model: "claude-opus-4-8", hostName: "alice", startedAt: 1000 };
function welcome(readOnly = true): WelcomeFrame {
  return { t: "welcome", protocol: COLLAB_PROTOCOL_VERSION, header: HEADER, transcript: [{ role: "user", text: "hi" }], participants: [{ peerId: 1, name: "bob", role: "guest", access: "view" }], readOnly };
}
function b64url(b: Uint8Array): string { let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }

describe("CollabGuest (P-COLLAB.4)", () => {
  it("sends a hello (to the host) on connect with the current protocol + name", () => {
    const t = new MockTransport();
    new CollabGuest(t, { name: "bob" }).start();
    expect(t.sent.length).toBe(1);
    expect(t.sent[0].targetPeer).toBe(0);
    const h = t.sent[0].frame as Extract<LucidCollabFrame, { t: "hello" }>;
    expect(h.t).toBe("hello");
    expect(h.protocol).toBe(COLLAB_PROTOCOL_VERSION);
    expect(h.name).toBe("bob");
    expect(h.writeToken).toBeUndefined(); // view link → no token
  });

  it("includes the base64url write token in hello when joined from a full link", () => {
    const token = generateWriteToken();
    const t = new MockTransport();
    new CollabGuest(t, { name: "bob", writeToken: token }).start();
    const h = t.sent[0].frame as Extract<LucidCollabFrame, { t: "hello" }>;
    expect(h.writeToken).toBe(b64url(token));
  });

  it("applies a welcome: header, transcript, roster, read-only, and goes live", () => {
    const t = new MockTransport();
    let live: WelcomeFrame | null = null;
    const g = new CollabGuest(t, { name: "bob" }, { onWelcome: (w) => (live = w) });
    g.start();
    t.host(welcome(true));

    expect(live).not.toBeNull();
    const v = g.view();
    expect(v.phase).toBe("live");
    expect(v.header?.title).toBe("Fix the guard");
    expect(v.transcript.map((x) => x.text)).toEqual(["hi"]);
    expect(v.participants[0].name).toBe("bob");
    expect(v.readOnly).toBe(true);
  });

  it("streams live events in order and folds done/usage into the view", () => {
    const t = new MockTransport();
    const events: string[] = [];
    const g = new CollabGuest(t, { name: "bob" }, { onEvent: (e) => events.push(e.type) });
    g.start();
    t.host(welcome());
    t.host({ t: "event", event: { type: "token", text: "hi" } });
    t.host({ t: "event", event: { type: "usage", used: 50, size: 200, cost: 0 } });
    t.host({ t: "event", event: { type: "done", text: "all done" } });

    expect(events).toEqual(["token", "usage", "done"]);
    const v = g.view();
    expect(v.contextPct).toBe(25); // 50/200
    expect(v.transcript.at(-1)).toEqual({ role: "assistant", text: "all done" });
  });

  it("refreshes roster/model/context on a state frame", () => {
    const t = new MockTransport();
    const g = new CollabGuest(t, { name: "bob" });
    g.start();
    t.host(welcome());
    t.host({ t: "state", participants: [{ peerId: 1, name: "bob", role: "guest", access: "view" }, { peerId: 2, name: "carol", role: "guest", access: "view" }], model: "claude-sonnet-5", contextPct: 40 });
    const v = g.view();
    expect(v.participants.length).toBe(2);
    expect(v.model).toBe("claude-sonnet-5");
    expect(v.contextPct).toBe(40);
  });

  it("ends on bye (host stopped) and reports the reason; further frames are ignored", () => {
    const t = new MockTransport();
    let endReason = "";
    const g = new CollabGuest(t, { name: "bob" }, { onEnd: (r) => (endReason = r) });
    g.start();
    t.host(welcome());
    t.host({ t: "bye", reason: "host ended the session" });

    expect(endReason).toBe("host ended the session");
    expect(g.view().phase).toBe("ended");
    const before = g.view().transcript.length;
    t.host({ t: "event", event: { type: "token", text: "late" } }); // ignored after end
    expect(g.view().transcript.length).toBe(before);
  });

  it("surfaces a host error frame (e.g. protocol mismatch) without ending the join", () => {
    const t = new MockTransport();
    let err = "";
    const g = new CollabGuest(t, { name: "bob" }, { onError: (m) => (err = m) });
    g.start();
    t.host({ t: "error", message: "protocol mismatch: host speaks v1, guest sent v99" });
    expect(err).toContain("protocol mismatch");
    expect(g.view().note).toContain("protocol mismatch");
  });

  it("goes reconnecting on a transient drop, then ends on a fatal drop", () => {
    const t = new MockTransport();
    const g = new CollabGuest(t, { name: "bob" });
    g.start();
    t.host(welcome());

    t.drop("connection lost", true);
    expect(g.view().phase).toBe("reconnecting");

    t.drop("bad key or corrupted frame", false);
    expect(g.view().phase).toBe("ended");
    expect(g.view().note).toContain("bad key");
  });

  it("only ever sends a hello - never a prompt/abort (Phase 1 view-only)", () => {
    const t = new MockTransport();
    const g = new CollabGuest(t, { name: "bob" });
    g.start();
    t.host(welcome());
    t.host({ t: "event", event: { type: "token", text: "hi" } });
    // the guest emitted exactly one frame ever: the hello
    expect(t.sent.length).toBe(1);
    expect(t.sent[0].frame.t).toBe("hello");
  });

  it("leave() closes the transport and ends idempotently", () => {
    const t = new MockTransport();
    const g = new CollabGuest(t, { name: "bob" });
    g.start();
    t.host(welcome());
    g.leave();
    expect(t.closed).toBe(true);
    expect(g.view().phase).toBe("ended");
    g.leave(); // no throw, no double-close effect
    expect(g.view().phase).toBe("ended");
  });

  // P-COLLAB.12: guest-write (only meaningful with EDIT access).
  it("sendPrompt/abort are refused (no frame) when read-only", () => {
    const t = new MockTransport();
    const g = new CollabGuest(t, { name: "bob" });
    g.start();
    t.host(welcome(true)); // readOnly
    expect(g.readOnly).toBe(true);
    expect(g.sendPrompt("do a thing")).toBe(false);
    expect(g.abort()).toBe(false);
    expect(t.sent.filter((s) => s.frame.t === "prompt" || s.frame.t === "abort").length).toBe(0);
  });

  it("sendPrompt/abort send a guest frame to the host (peer 0) when EDIT access", () => {
    const t = new MockTransport();
    const g = new CollabGuest(t, { name: "bob" });
    g.start();
    t.host(welcome(false)); // readOnly:false -> edit
    expect(g.readOnly).toBe(false);
    expect(g.sendPrompt("refactor it")).toBe(true);
    expect(g.abort()).toBe(true);
    const prompt = t.sent.find((s) => s.frame.t === "prompt")!;
    expect(prompt.targetPeer).toBe(0);
    expect((prompt.frame as any).text).toBe("refactor it");
    expect(t.sent.some((s) => s.frame.t === "abort" && s.targetPeer === 0)).toBe(true);
    // an empty prompt is not sent
    expect(g.sendPrompt("   ")).toBe(false);
  });
});
