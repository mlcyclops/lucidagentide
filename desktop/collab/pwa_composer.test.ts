// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/pwa_composer.test.ts — P-REMOTE.8 (ADR-0229): the PWA guest composer + live reconnect status.
// Drives CollabGuest + CollabHost through MOCK transports (no relay, no sockets), plus the pure pwa_view
// status renderer, so all three fixes are proven headless:
//   - the stale "connection lost - retrying" banner CLEARS the moment a live host frame lands after a drop,
//   - statusLabel shows a reconnecting phase as WAIT (amber), and Live once recovered,
//   - a guest can send image attachments with a prompt (incl. an image-only message), edit-gated, and the
//     host forwards them to onGuestPrompt.

import { describe, expect, it } from "bun:test";
import { CollabHost, type HostTransport } from "./host.ts";
import { CollabGuest, type GuestTransport, type GuestView } from "./guest.ts";
import { COLLAB_PROTOCOL_VERSION } from "./frames.ts";
import type { LucidCollabFrame, WelcomeFrame } from "./frames.ts";
import { statusLabel } from "./pwa_view.ts";
import { generateWriteToken } from "./crypto.ts";

function b64url(b: Uint8Array): string { let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }

const HEADER = { sessionId: "s1", title: "Pair", model: "claude-opus-4-8", hostName: "alice", startedAt: 1000 };
const IMG_A = "data:image/png;base64,QUJD"; // "ABC"
const IMG_B = "data:image/jpeg;base64,REVG"; // "DEF"

function welcome(readOnly: boolean): WelcomeFrame {
  return { t: "welcome", protocol: COLLAB_PROTOCOL_VERSION, header: HEADER, transcript: [], participants: [], readOnly };
}

/** The slice of CollabSocket the guest needs; the guest wires onOpen/onFrame/onClose in start(). */
class GuestMock implements GuestTransport {
  onOpen?: () => void;
  onFrame?: (frame: LucidCollabFrame, fromPeer: number) => void;
  onClose?: (reason: string, willReconnect: boolean) => void;
  sent: LucidCollabFrame[] = [];
  connect(): void { this.onOpen?.(); }
  send(frame: LucidCollabFrame): void { this.sent.push(frame); }
  close(): void {}
  host(frame: LucidCollabFrame): void { this.onFrame?.(frame, 0); }
  drop(reason: string, willReconnect: boolean): void { this.onClose?.(reason, willReconnect); }
  reopen(): void { this.onOpen?.(); } // relay reconnect: socket reopens -> guest re-sends hello
}

class HostMock implements HostTransport {
  onOpen?: () => void;
  onFrame?: (frame: LucidCollabFrame, fromPeer: number) => void;
  onControl?: (msg: { t: "peer-joined" | "peer-left"; peer: number }) => void;
  onClose?: (reason: string, willReconnect: boolean) => void;
  connect(): void { this.onOpen?.(); }
  send(): void {}
  close(): void {}
  hello(peer: number, name: string, token?: string): void { this.onFrame?.({ t: "hello", protocol: COLLAB_PROTOCOL_VERSION, name, ...(token ? { writeToken: token } : {}) }, peer); }
  guest(peer: number, frame: LucidCollabFrame): void { this.onFrame?.(frame, peer); }
}

describe("CollabGuest reconnect status (P-REMOTE.8)", () => {
  it("clears the stale retry note when a fresh welcome lands after a transient drop", () => {
    const t = new GuestMock();
    const guest = new CollabGuest(t, { name: "phone" });
    guest.start();
    t.host(welcome(false));
    expect(guest.view().phase).toBe("live");

    t.drop("code 1006", true); // transient: willReconnect
    expect(guest.view().phase).toBe("reconnecting");
    expect(guest.view().note).toContain("1006");

    t.reopen();          // socket back -> guest re-sends hello
    t.host(welcome(false)); // host re-syncs
    expect(guest.view().phase).toBe("live");
    expect(guest.view().note).toBeNull(); // the banner is gone
  });

  it("clears the retry note on the next live event even without a fresh welcome (resumed stream)", () => {
    const t = new GuestMock();
    const guest = new CollabGuest(t, { name: "phone" });
    guest.start();
    t.host(welcome(false));
    t.drop("code 1006", true);
    expect(guest.view().note).toContain("1006");

    t.host({ t: "event", event: { type: "token", text: "hi" } } as LucidCollabFrame);
    expect(guest.view().phase).toBe("live");
    expect(guest.view().note).toBeNull();
  });

  it("keeps a terminal error/bye note (only the transient reconnect note is auto-cleared)", () => {
    const t = new GuestMock();
    const guest = new CollabGuest(t, { name: "phone" });
    guest.start();
    t.host(welcome(false));
    t.host({ t: "error", message: "protocol mismatch" });
    expect(guest.view().note).toBe("protocol mismatch");
    // a later live event does NOT wipe a genuine error note (it wasn't a reconnect note)
    t.host({ t: "event", event: { type: "token", text: "x" } } as LucidCollabFrame);
    expect(guest.view().note).toBe("protocol mismatch");
  });
});

describe("statusLabel reconnect tone (P-REMOTE.8)", () => {
  const base: GuestView = { phase: "live", header: HEADER, transcript: [], participants: [], model: "m", contextPct: null, readOnly: false, options: null, note: null };
  it("renders a reconnecting phase as WAIT, not ended", () => {
    const s = statusLabel({ ...base, phase: "reconnecting", note: "connection lost - retrying (code 1006)" });
    expect(s.tone).toBe("wait");
    expect(s.text).toContain("1006");
  });
  it("renders Live once recovered (note cleared)", () => {
    expect(statusLabel({ ...base, phase: "live", note: null }).tone).toBe("live");
  });
  it("still renders a terminal note as ended", () => {
    expect(statusLabel({ ...base, phase: "ended", note: "the host ended the session" }).tone).toBe("ended");
  });
});

describe("CollabGuest image attachments (P-REMOTE.8)", () => {
  function liveGuest(readOnly: boolean): { t: GuestMock; guest: CollabGuest } {
    const t = new GuestMock();
    const guest = new CollabGuest(t, { name: "phone" });
    guest.start();
    t.host(welcome(readOnly));
    t.sent = [];
    return { t, guest };
  }

  it("sends images alongside the prompt text", () => {
    const { t, guest } = liveGuest(false);
    expect(guest.sendPrompt("look at this", [IMG_A, IMG_B])).toBe(true);
    expect(t.sent).toEqual([{ t: "prompt", text: "look at this", images: [IMG_A, IMG_B] }]);
  });

  it("allows an image-only message (empty text + at least one image)", () => {
    const { t, guest } = liveGuest(false);
    expect(guest.sendPrompt("", [IMG_A])).toBe(true);
    expect(t.sent[0]).toEqual({ t: "prompt", text: "", images: [IMG_A] });
  });

  it("refuses an empty message (no text, no images) and a text-only still works", () => {
    const { t, guest } = liveGuest(false);
    expect(guest.sendPrompt("", [])).toBe(false);
    expect(t.sent).toEqual([]);
    expect(guest.sendPrompt("hi")).toBe(true);
    expect(t.sent[0]).toEqual({ t: "prompt", text: "hi" }); // no images key when none attached
  });

  it("refuses images (like any write) when read-only", () => {
    const { t, guest } = liveGuest(true);
    expect(guest.sendPrompt("", [IMG_A])).toBe(false);
    expect(t.sent).toEqual([]);
  });
});

describe("CollabHost forwards guest prompt images (P-REMOTE.8)", () => {
  it("passes a guest's images to onGuestPrompt for an EDIT guest, incl. image-only", () => {
    const t = new HostMock();
    const token = generateWriteToken();
    const prompts: { text: string; images?: string[] }[] = [];
    const host = new CollabHost(t, {
      header: HEADER, writeToken: token, allowGuestWrite: true,
      onGuestPrompt: (text, _g, images) => prompts.push({ text, images }),
    });
    host.start();
    t.hello(5, "editor", b64url(token));

    t.guest(5, { t: "prompt", text: "see this", images: [IMG_A] });
    t.guest(5, { t: "prompt", text: "", images: [IMG_B] }); // image-only
    expect(prompts).toEqual([{ text: "see this", images: [IMG_A] }, { text: "", images: [IMG_B] }]);
  });

  it("does NOT forward a view guest's prompt (with or without images)", () => {
    const t = new HostMock();
    const token = generateWriteToken();
    const prompts: string[] = [];
    const host = new CollabHost(t, { header: HEADER, writeToken: token, allowGuestWrite: true, onGuestPrompt: (text) => prompts.push(text) });
    host.start();
    t.hello(6, "watcher"); // no token -> view only
    t.guest(6, { t: "prompt", text: "run this", images: [IMG_A] });
    expect(prompts).toEqual([]); // refused read-only, never reached the host session
  });
});
