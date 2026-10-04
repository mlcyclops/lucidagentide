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

// ── P-REMOTE.16 (ADR-0431): the settled-seq cursor (`hello.since`) + welcome merge ──────────────────────

type Hello = Extract<LucidCollabFrame, { t: "hello" }>;
const hellos = (t: MockTransport): Hello[] => t.sent.filter((s) => s.frame.t === "hello").map((s) => s.frame as Hello);

describe("CollabGuest since cursor (P-REMOTE.16)", () => {
  it("a fresh hello carries NO since; after a welcome the next hello carries the highest settled seq", () => {
    const t = new MockTransport();
    const g = new CollabGuest(t, { name: "bob" });
    g.start();
    expect(hellos(t)[0]!.since).toBeUndefined();
    expect(g.since()).toBe(0);
    t.host({ ...welcome(), transcript: [{ role: "user", text: "a", seq: 1 }, { role: "assistant", text: "b", seq: 2 }, { role: "assistant", text: "half", seq: 3, live: true }] });
    expect(g.since()).toBe(2); // the live turn never counts as settled
    t.drop("cap", true);
    t.connect(); // the socket reopened: a new hello
    expect(hellos(t)[1]!.since).toBe(2);
  });

  it("done / no-response / user-turn with a seq advance the cursor; token events and seq-less frames do not", () => {
    const t = new MockTransport();
    const seqs: (number | undefined)[] = [];
    const g = new CollabGuest(t, { name: "bob" }, { onEvent: (_e, seq) => seqs.push(seq), onUserTurn: (_t, _f, seq) => seqs.push(seq) });
    g.start();
    t.host(welcome());
    t.host({ t: "event", event: { type: "token", text: "x" }, seq: 4 });
    expect(g.since()).toBe(0);
    t.host({ t: "event", event: { type: "done", text: "xy" }, seq: 4 });
    expect(g.since()).toBe(4);
    t.host({ t: "user-turn", text: "next", from: "alice", seq: 5 });
    expect(g.since()).toBe(5);
    t.host({ t: "event", event: { type: "no-response", model: "m" }, seq: 6 });
    expect(g.since()).toBe(6);
    t.host({ t: "event", event: { type: "done", text: "old host" } }); // no seq: cursor untouched
    expect(g.since()).toBe(6);
    expect(seqs).toEqual([4, 4, 5, 6, undefined]);
    // the folded done carries its seq into the view transcript
    expect(g.view().transcript.at(-1)).toEqual({ role: "assistant", text: "old host" });
    expect(g.view().transcript.at(-2)).toEqual({ role: "assistant", text: "xy", seq: 4 });
    t.connect();
    expect(hellos(t).at(-1)!.since).toBe(6);
  });

  it("a welcome echoing since MERGES: keeps older turns, replaces newer ones, appends the replay", () => {
    const t = new MockTransport();
    const g = new CollabGuest(t, { name: "bob" });
    g.start();
    t.host({ ...welcome(), transcript: [{ role: "user", text: "a", seq: 1 }, { role: "assistant", text: "b", seq: 2 }] });
    t.host({ t: "event", event: { type: "done", text: "partial" }, seq: 3 }); // folded locally with seq 3: superseded
    t.host({ ...welcome(), since: 2, transcript: [{ role: "assistant", text: "full three", seq: 3 }, { role: "user", text: "d", seq: 4 }] });
    expect(g.view().transcript).toEqual([
      { role: "user", text: "a", seq: 1 },
      { role: "assistant", text: "b", seq: 2 },
      { role: "assistant", text: "full three", seq: 3 },
      { role: "user", text: "d", seq: 4 },
    ]);
    expect(g.since()).toBe(4);
  });

  it("a welcome WITHOUT since replaces everything, cursor included", () => {
    const t = new MockTransport();
    const g = new CollabGuest(t, { name: "bob" });
    g.seedSince(40);
    g.start();
    expect(hellos(t)[0]!.since).toBe(40);
    t.host({ ...welcome(), transcript: [{ role: "user", text: "fresh", seq: 7 }] });
    expect(g.view().transcript).toEqual([{ role: "user", text: "fresh", seq: 7 }]);
    expect(g.since()).toBe(7); // an older host's full window resets the cursor to what it actually sent
  });

  it("seedSince preloads the cursor before start, only ever moves it up, and ignores junk", () => {
    const t = new MockTransport();
    const g = new CollabGuest(t, { name: "bob" });
    g.seedSince(12);
    g.seedSince(5);
    g.seedSince(NaN);
    g.seedSince(-3);
    g.seedSince(Infinity);
    expect(g.since()).toBe(12);
    g.start();
    expect(hellos(t)[0]!.since).toBe(12);
    const fresh = new CollabGuest(new MockTransport(), { name: "bob" });
    fresh.seedSince(0);
    expect(fresh.since()).toBe(0);
  });
});
