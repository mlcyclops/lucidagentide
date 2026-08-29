// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/fleet_remote.test.ts - P-PWA-FLEET.1: EDIT-guest fleet controls + mid-turn interjection.
//
// Drives CollabHost + CollabGuest through MOCK transports (no relay, no sockets), proving the slice headless:
//   - the four new guest frames (fleet-prompt / fleet-stop / fleet-answer / interject) reach the host
//     callbacks ONLY from a registered EDIT guest; a view guest is refused with an `error` frame and no
//     callback ever fires (the same fail-closed gate as set-model),
//   - shapes are sanitized host-side (junk scope collapses to undefined; a missing laneId/target or blank
//     text never reaches a callback),
//   - the guest core refuses to SEND any of them while read-only (a view-only phone cannot steer), and
//     emits the exact wire shapes when writable.

import { describe, expect, it } from "bun:test";
import { CollabHost, type HostTransport } from "./host.ts";
import { CollabGuest, type GuestTransport } from "./guest.ts";
import { COLLAB_PROTOCOL_VERSION } from "./frames.ts";
import type { LucidCollabFrame } from "./frames.ts";
import { generateWriteToken } from "./crypto.ts";

function b64url(b: Uint8Array): string { let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }

const HEADER = { sessionId: "s1", title: "Fleet drive", model: "claude-haiku-4-5", hostName: "alice", startedAt: 1000 };

interface Calls {
  prompts: { laneId: string; text: string }[];
  stops: string[];
  answers: { laneId: string; allow: boolean; scope: "once" | "session" | undefined }[];
  notes: { target: string; text: string }[];
}

/** Captures every frame the host sends + lets a test inject guest frames (a hello, then write frames). */
class HostMock implements HostTransport {
  onOpen?: () => void;
  onFrame?: (frame: LucidCollabFrame, fromPeer: number) => void;
  onControl?: (msg: { t: "peer-joined" | "peer-left"; peer: number }) => void;
  onClose?: (reason: string, willReconnect: boolean) => void;
  sent: { frame: LucidCollabFrame; targetPeer: number }[] = [];
  connect(): void { this.onOpen?.(); }
  send(frame: LucidCollabFrame, targetPeer = 0): void { this.sent.push({ frame, targetPeer }); }
  close(): void {}
  hello(peer: number, name: string, token?: string): void { this.onFrame?.({ t: "hello", protocol: COLLAB_PROTOCOL_VERSION, name, ...(token ? { writeToken: token } : {}) }, peer); }
  guest(peer: number, frame: LucidCollabFrame): void { this.onFrame?.(frame, peer); }
  reset(): void { this.sent = []; }
}
function newHost(t: HostMock, token: Uint8Array, calls: Calls): CollabHost {
  const host = new CollabHost(t, {
    header: HEADER,
    writeToken: token,
    allowGuestWrite: true,
    onGuestFleetPrompt: (laneId, text) => calls.prompts.push({ laneId, text }),
    onGuestFleetStop: (laneId) => calls.stops.push(laneId),
    onGuestFleetAnswer: (laneId, allow, scope) => calls.answers.push({ laneId, allow, scope }),
    onGuestInterject: (target, text) => calls.notes.push({ target, text }),
  });
  host.start();
  return host;
}

const newCalls = (): Calls => ({ prompts: [], stops: [], answers: [], notes: [] });

describe("CollabHost fleet frames (P-PWA-FLEET.1)", () => {
  it("routes an EDIT guest's fleet-prompt/stop/answer/interject to the callbacks", () => {
    const t = new HostMock();
    const token = generateWriteToken();
    const calls = newCalls();
    newHost(t, token, calls);
    t.hello(5, "editor", b64url(token));
    t.reset();

    t.guest(5, { t: "fleet-prompt", laneId: "l1", text: "build it" });
    t.guest(5, { t: "fleet-stop", laneId: "l1" });
    t.guest(5, { t: "fleet-answer", laneId: "l1", allow: true, scope: "session" });
    t.guest(5, { t: "interject", target: "master", text: "check in please" });

    expect(calls.prompts).toEqual([{ laneId: "l1", text: "build it" }]);
    expect(calls.stops).toEqual(["l1"]);
    expect(calls.answers).toEqual([{ laneId: "l1", allow: true, scope: "session" }]);
    expect(calls.notes).toEqual([{ target: "master", text: "check in please" }]);
    expect(t.sent.filter((s) => s.targetPeer === 5 && s.frame.t === "error")).toHaveLength(0);
  });

  it("refuses a VIEW guest's fleet frames with an error frame (no callback ever fires)", () => {
    const t = new HostMock();
    const calls = newCalls();
    newHost(t, generateWriteToken(), calls);
    t.hello(6, "watcher"); // no token -> view only
    t.reset();

    t.guest(6, { t: "fleet-prompt", laneId: "l1", text: "build it" });
    t.guest(6, { t: "fleet-stop", laneId: "l1" });
    t.guest(6, { t: "fleet-answer", laneId: "l1", allow: true, scope: "session" });
    t.guest(6, { t: "interject", target: "master", text: "steer" });

    expect(calls.prompts).toEqual([]);
    expect(calls.stops).toEqual([]);
    expect(calls.answers).toEqual([]);
    expect(calls.notes).toEqual([]);
    expect(t.sent.filter((s) => s.targetPeer === 6 && s.frame.t === "error")).toHaveLength(4); // each refused loudly, read-only stays read-only
  });

  it("sanitizes shapes fail-closed: junk scope/allow collapse; empty lane/target/text never lands", () => {
    const t = new HostMock();
    const token = generateWriteToken();
    const calls = newCalls();
    newHost(t, token, calls);
    t.hello(5, "editor", b64url(token));
    t.reset();

    // junk scope -> undefined; non-boolean allow -> false (never a truthy coercion)
    t.guest(5, { t: "fleet-answer", laneId: "l1", allow: "yes" as unknown as boolean, scope: "forever" as unknown as "once" });
    expect(calls.answers).toEqual([{ laneId: "l1", allow: false, scope: undefined }]);

    t.guest(5, { t: "fleet-prompt", laneId: "", text: "x" });
    t.guest(5, { t: "fleet-prompt", laneId: "l1", text: "   " });
    t.guest(5, { t: "fleet-stop", laneId: "" });
    t.guest(5, { t: "interject", target: "", text: "x" });
    t.guest(5, { t: "interject", target: "master", text: " " });
    expect(calls.prompts).toEqual([]);
    expect(calls.stops).toEqual([]);
    expect(calls.notes).toEqual([]);
  });
});

/** The slice of CollabSocket the guest needs; delivers host frames + records what the guest sends. */
class GuestMock implements GuestTransport {
  onOpen?: () => void;
  onFrame?: (frame: LucidCollabFrame, fromPeer: number) => void;
  onClose?: (reason: string, willReconnect: boolean) => void;
  sent: LucidCollabFrame[] = [];
  connect(): void { this.onOpen?.(); }
  send(frame: LucidCollabFrame): void { this.sent.push(frame); }
  close(): void {}
  host(frame: LucidCollabFrame): void { this.onFrame?.(frame, 0); }
}

describe("CollabGuest fleet methods (P-PWA-FLEET.1)", () => {
  it("refuses to send while read-only; sends the exact wire shapes when writable", () => {
    const t = new GuestMock();
    const guest = new CollabGuest(t, { name: "phone" });
    guest.start();
    t.host({ t: "welcome", protocol: COLLAB_PROTOCOL_VERSION, header: HEADER, transcript: [], participants: [], readOnly: true });
    const before = t.sent.length;
    expect(guest.fleetPrompt("l1", "x")).toBe(false);
    expect(guest.fleetStop("l1")).toBe(false);
    expect(guest.fleetAnswer("l1", true, "once")).toBe(false);
    expect(guest.interject("master", "x")).toBe(false);
    expect(t.sent.length).toBe(before); // nothing left the phone

    // an EDIT welcome flips readOnly off - now every send goes out, host-bound
    t.host({ t: "welcome", protocol: COLLAB_PROTOCOL_VERSION, header: HEADER, transcript: [], participants: [], readOnly: false });
    expect(guest.fleetPrompt("l1", "do it")).toBe(true);
    expect(guest.fleetAnswer("l1", false)).toBe(true);
    expect(guest.interject("lane-2", "note")).toBe(true);
    expect(guest.fleetStop("l1")).toBe(true);
    expect(t.sent.slice(before)).toEqual([
      { t: "fleet-prompt", laneId: "l1", text: "do it" },
      { t: "fleet-answer", laneId: "l1", allow: false },
      { t: "interject", target: "lane-2", text: "note" },
      { t: "fleet-stop", laneId: "l1" },
    ]);
  });

  it("refuses an empty laneId/target/blank text without sending", () => {
    const t = new GuestMock();
    const guest = new CollabGuest(t, { name: "phone" });
    guest.start();
    t.host({ t: "welcome", protocol: COLLAB_PROTOCOL_VERSION, header: HEADER, transcript: [], participants: [], readOnly: false });
    const before = t.sent.length;
    expect(guest.fleetPrompt("", "x")).toBe(false);
    expect(guest.fleetPrompt("l1", "  ")).toBe(false);
    expect(guest.fleetStop("")).toBe(false);
    expect(guest.fleetAnswer("", true)).toBe(false);
    expect(guest.interject("", "x")).toBe(false);
    expect(guest.interject("master", " ")).toBe(false);
    expect(t.sent.length).toBe(before);
  });
});
