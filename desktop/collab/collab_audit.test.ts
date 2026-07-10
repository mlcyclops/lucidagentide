// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/collab_audit.test.ts — P-COLLAB.18 (ADR-0204): the live-collab audit trail.
//
// Proves the contract that makes this SAFE: the right EventName is emitted, the payload is metadata-only
// (a hostile/renderer-supplied key/link/content field is NEVER logged), an unknown action is refused
// fail-closed (nothing emitted), and a broken sink never throws (a share is never broken by its audit).

import { describe, expect, it } from "bun:test";
import type { TelemetryEvent } from "../../harness/telemetry/events.ts";
import {
  recordCollabShareStarted, recordCollabShareStopped, recordCollabGuestJoined, recordCollabGuestLeft,
  recordCollabAudit, isCollabAuditAction,
} from "./collab_audit.ts";

function collector() {
  const events: TelemetryEvent[] = [];
  return { sink: (e: TelemetryEvent) => events.push(e), events };
}

describe("collab_audit — the record functions", () => {
  it("emits collab_share_started with metadata only (transport/access/roomId/relaySource)", () => {
    const c = collector();
    recordCollabShareStarted({ transport: "relay", access: "edit", roomId: "abc123", relaySource: "self-hosted" }, c.sink);
    expect(c.events).toHaveLength(1);
    const e = c.events[0]!;
    expect(e.event).toBe("collab_share_started");
    expect(e.transport).toBe("relay");
    expect(e.access).toBe("edit");
    expect(e.roomId).toBe("abc123");
    expect(e.relaySource).toBe("self-hosted");
    // the envelope carries the invariant-#8 ids
    expect(typeof e.event_id).toBe("string");
    expect(typeof e.run_id).toBe("string");
    expect(e.session_id).toBe("gui");
  });

  it("share_stopped / guest_joined / guest_left map to their events; a guest name is sanitized", () => {
    const c = collector();
    recordCollabShareStopped({ transport: "direct-p2p", access: "view" }, c.sink);
    recordCollabGuestJoined({ transport: "direct-p2p", access: "edit", guest: "  Bob\nSmith  " }, c.sink);
    recordCollabGuestLeft({ transport: "relay", roomId: "r1" }, c.sink);
    expect(c.events.map((e) => e.event)).toEqual(["collab_share_stopped", "collab_guest_joined", "collab_guest_left"]);
    expect(c.events[1]!.guest).toBe("Bob Smith"); // control chars stripped, whitespace collapsed + trimmed
  });
});

describe("collab_audit — the renderer P2P dispatcher (closed action set, fail-closed)", () => {
  it("dispatches a known action to its event and returns true", () => {
    const c = collector();
    expect(recordCollabAudit("guest_joined", { transport: "direct-p2p", access: "view", roomId: "r2", guest: "Ann" }, c.sink)).toBe(true);
    expect(c.events).toHaveLength(1);
    expect(c.events[0]!.event).toBe("collab_guest_joined");
    expect(c.events[0]!.guest).toBe("Ann");
  });

  it("REFUSES an unknown action fail-closed — returns false, emits nothing (no off-enum event)", () => {
    const c = collector();
    expect(recordCollabAudit("share_started; DROP", { transport: "relay" }, c.sink)).toBe(false);
    expect(recordCollabAudit("collab_share_started", {}, c.sink)).toBe(false); // the raw EventName is NOT an action
    expect(recordCollabAudit(42 as unknown, {}, c.sink)).toBe(false);
    expect(c.events).toHaveLength(0);
    expect(isCollabAuditAction("share_started")).toBe(true);
    expect(isCollabAuditAction("nope")).toBe(false);
  });

  it("NEVER logs renderer-supplied fields outside the whitelist (no key/link/content leak)", () => {
    const c = collector();
    recordCollabAudit("share_started", {
      transport: "direct-p2p", access: "edit",
      key: "SECRET-ROOM-KEY", link: "wss://r/room.SECRET", prompt: "user content", roomId: "r3",
      __proto__: { polluted: true },
    } as unknown, c.sink);
    const e = c.events[0]!;
    expect(Object.keys(e).sort()).toEqual(["access", "event", "event_id", "roomId", "run_id", "session_id", "transport", "ts"]);
    expect(e.key).toBeUndefined();
    expect(e.link).toBeUndefined();
    expect(e.prompt).toBeUndefined();
    expect(e.transport).toBe("direct-p2p");
  });

  it("defaults an unspecified/invalid transport to direct-p2p (the route is the P2P path)", () => {
    const c = collector();
    recordCollabAudit("guest_left", { transport: "nonsense" } as unknown, c.sink);
    expect(c.events[0]!.transport).toBe("direct-p2p");
  });

  it("is best-effort: a throwing sink never propagates (a share is never broken by its audit)", () => {
    const boom = () => { throw new Error("disk full"); };
    expect(() => recordCollabShareStarted({ transport: "relay", access: "view" }, boom)).not.toThrow();
    expect(recordCollabAudit("guest_joined", { transport: "direct-p2p" }, boom)).toBe(true); // still reports dispatched
  });
});
