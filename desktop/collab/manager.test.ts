// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/manager.test.ts — P-COLLAB.3 (ADR-0192): the backend host lifecycle owner.
//
// Drives CollabManager with a fake relay resolver + a mock transport (no sockets) so start/stop/status,
// the ChatEvent tap, roster reflection, and the fail-closed no-relay refusal are all proven headless.

import { describe, expect, it } from "bun:test";
import { CollabManager, type CollabManagerDeps, type RelayTarget } from "./manager.ts";
import type { HostTransport } from "./host.ts";
import type { LucidCollabFrame } from "./frames.ts";
import type { RelayControlMessage } from "@oh-my-pi/pi-wire";
import { parseShareLink } from "./link.ts";

class MockTransport implements HostTransport {
  onOpen?: () => void;
  onFrame?: (frame: LucidCollabFrame, fromPeer: number) => void;
  onControl?: (msg: RelayControlMessage) => void;
  onClose?: (reason: string, willReconnect: boolean) => void;
  sent: { frame: LucidCollabFrame; targetPeer: number }[] = [];
  closed = false;
  connect(): void { this.onOpen?.(); }
  send(frame: LucidCollabFrame, targetPeer = 0): void { this.sent.push({ frame, targetPeer }); }
  close(): void { this.closed = true; }
  guestHello(peer: number, name: string): void { this.onFrame?.({ t: "hello", protocol: 1, name }, peer); }
  framesOfType(t: string) { return this.sent.filter((s) => s.frame.t === t); }
}

function deps(relay: RelayTarget | null, capture?: { transports: MockTransport[]; wsUrls: string[] }): CollabManagerDeps {
  return {
    resolveRelay: () => relay,
    sessionInfo: () => ({ sessionId: "sess-1", title: "Fix the guard", model: "claude-opus-4-8", hostName: "alice" }),
    makeTransport: ({ wsUrl }) => {
      const t = new MockTransport();
      capture?.transports.push(t);
      capture?.wsUrls.push(wsUrl);
      return t;
    },
    now: () => 1_720_000_000_000,
  };
}

const RELAY: RelayTarget = { wsBase: "wss://relay.local", httpBase: "https://relay.local", label: "relay.local", source: "self-hosted" };

describe("CollabManager (P-COLLAB.3)", () => {
  it("starts a share: mints links, builds the wsUrl, and reports active status", async () => {
    const cap = { transports: [] as MockTransport[], wsUrls: [] as string[] };
    const mgr = new CollabManager(deps(RELAY, cap));
    const st = await mgr.start();

    expect(st.active).toBe(true);
    expect(st.roomId).toBeTruthy();
    expect(st.relayLabel).toBe("relay.local");
    expect(st.relaySource).toBe("self-hosted");
    expect(st.startedAt).toBe(1_720_000_000_000);
    // wsUrl = <wsBase>/r/<roomId>
    expect(cap.wsUrls[0]).toBe(`wss://relay.local/r/${st.roomId}`);
    // the view link is read-only; the full link carries a write token
    expect(parseShareLink(st.viewLink!).writeToken).toBeNull();
    expect(parseShareLink(st.fullLink!).writeToken).not.toBeNull();
    // the browser link wraps the VIEW link (fragment-carried secret)
    expect(st.browserLink).toContain("https://relay.local/#");
    expect(parseShareLink(st.browserLink!).writeToken).toBeNull();
  });

  it("P-REMOTE.2b: a pwaBase relay points the browser link at the PWA, carrying the write token when editing", async () => {
    const pwaRelay: RelayTarget = { wsBase: "wss://relay.run.app", httpBase: "https://relay.run.app", label: "hosted", source: "public", pwaBase: "https://lucid-agent.web.app/remote" };
    // view share (no edit): PWA link, read-only secret
    const view = await new CollabManager(deps(pwaRelay)).start();
    expect(view.browserLink).toContain("https://lucid-agent.web.app/remote/#");
    expect(parseShareLink(view.browserLink!).writeToken).toBeNull();
    // edit share: the PWA link carries the write token so the phone can drive
    const edit = await new CollabManager(deps(pwaRelay)).start({ allowEdit: true });
    expect(edit.browserLink).toContain("https://lucid-agent.web.app/remote/#");
    expect(parseShareLink(edit.browserLink!).writeToken).not.toBeNull();
    // without pwaBase, the browser link stays the legacy relay-host form
    const legacy = await new CollabManager(deps(RELAY)).start({ allowEdit: true });
    expect(legacy.browserLink).toContain("https://relay.local/#");
  });

  it("P-COLLAB.19: an edit share carries BOTH capabilities - the edit browser link AND an always-view-only twin", async () => {
    const pwaRelay: RelayTarget = { wsBase: "wss://relay.run.app", httpBase: "https://relay.run.app", label: "hosted", source: "public", pwaBase: "https://lucid-agent.web.app/remote" };
    const st = await new CollabManager(deps(pwaRelay)).start({ allowEdit: true });
    // same room, different capability: the edit twin drives, the view twin can never write
    expect(parseShareLink(st.browserLink!).writeToken).not.toBeNull();
    expect(parseShareLink(st.browserViewLink!).writeToken).toBeNull();
    expect(parseShareLink(st.browserViewLink!).roomId).toBe(parseShareLink(st.browserLink!).roomId);
    // the relay-path pair discriminates the same way
    expect(parseShareLink(st.fullLink!).writeToken).not.toBeNull();
    expect(parseShareLink(st.viewLink!).writeToken).toBeNull();
  });

  it("refuses to start when no relay is authorized (fail-closed)", async () => {
    const mgr = new CollabManager(deps(null));
    await expect(mgr.start()).rejects.toThrow(/no collaboration relay/i);
    expect(mgr.active).toBe(false);
    expect(mgr.status().active).toBe(false);
  });

  it("taps live ChatEvents into the host, which broadcasts them to guests", async () => {
    const cap = { transports: [] as MockTransport[], wsUrls: [] as string[] };
    const mgr = new CollabManager(deps(RELAY, cap));
    await mgr.start();
    const t = cap.transports[0];
    t.guestHello(5, "bob");

    mgr.tapUserTurn("please refactor");
    mgr.tapEvent({ type: "token", text: "working" });
    mgr.tapEvent({ type: "done", text: "done" });

    expect(t.framesOfType("event").length).toBe(2);
    expect(mgr.status().participantCount).toBe(1);
    expect(mgr.status().participants[0].name).toBe("bob");
    expect(mgr.status().participants[0].access).toBe("view"); // Phase 1
  });

  it("stops cleanly: idle status, transport closed, taps become no-ops", async () => {
    const cap = { transports: [] as MockTransport[], wsUrls: [] as string[] };
    const mgr = new CollabManager(deps(RELAY, cap));
    await mgr.start();
    const t = cap.transports[0];

    const idle = mgr.stop();
    expect(idle.active).toBe(false);
    expect(t.closed).toBe(true);
    expect(mgr.active).toBe(false);

    mgr.tapEvent({ type: "token", text: "late" }); // no throw, no effect
    expect(t.framesOfType("event").length).toBe(0);
  });

  it("restarts into a fresh room when start() is called while already active", async () => {
    const cap = { transports: [] as MockTransport[], wsUrls: [] as string[] };
    const mgr = new CollabManager(deps(RELAY, cap));
    const first = await mgr.start();
    const second = await mgr.start();

    expect(cap.transports.length).toBe(2);
    expect(cap.transports[0].closed).toBe(true); // the first share was torn down
    expect(second.roomId).not.toBe(first.roomId);
    expect(mgr.status().roomId).toBe(second.roomId);
  });
});
