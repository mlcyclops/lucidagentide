// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/share_dock.test.ts — P-SHARE.1 (ADR-0232): the pure geometry + persistence of the floating
// Share dock (placement, on-screen clamping, edge-snap beside the rails / to the right frame, state round-trip,
// roster summary, per-section collapse).

import { describe, expect, it } from "bun:test";
import {
  defaultShape, clampToViewport, snapDecision, loadDockState, saveDockState, participantSummary, isCollapsed,
  orderBindAddresses, redactShareSnapshot, JOIN_DOCK_KEY,
  DOCK_MIN_W, DOCK_MIN_H, type DockStorage, type DockState,
} from "./share_dock.ts";

type Fam = "IPv4" | "IPv6";
type Kind = "loopback" | "lan" | "vpn" | "other";
function addr(address: string, family: Fam, kind: Kind): { address: string; family: Fam; kind: Kind } {
  return { address, family, kind };
}

const VW = 1440, VH = 900;
function memStorage(seed?: Record<string, string>): DockStorage {
  const m = new Map<string, string>(Object.entries(seed ?? {}));
  return { get: (k) => m.get(k) ?? null, set: (k, v) => { m.set(k, v); } };
}

describe("defaultShape / clampToViewport (P-SHARE.1)", () => {
  it("places the dock bottom-right, fully on-screen, at least the minimum size", () => {
    const s = defaultShape(VW, VH);
    expect(s.w).toBeGreaterThanOrEqual(DOCK_MIN_W);
    expect(s.h).toBeGreaterThanOrEqual(DOCK_MIN_H);
    expect(s.x + s.w).toBeLessThanOrEqual(VW);
    expect(s.y + s.h).toBeLessThanOrEqual(VH);
    expect(s.x).toBeGreaterThan(VW / 2); // right half
  });

  it("clamps an oversized / off-screen shape back on-screen", () => {
    const c = clampToViewport({ x: 5000, y: -200, w: 99999, h: 99999 }, VW, VH);
    expect(c.x).toBeGreaterThanOrEqual(0);
    expect(c.y).toBeGreaterThanOrEqual(0);
    expect(c.x + c.w).toBeLessThanOrEqual(VW);
    expect(c.y + c.h).toBeLessThanOrEqual(VH);
  });

  it("never shrinks below the minimum even in a tiny viewport", () => {
    const c = clampToViewport({ x: 0, y: 0, w: 50, h: 50 }, VW, VH);
    expect(c.w).toBe(DOCK_MIN_W);
    expect(c.h).toBe(DOCK_MIN_H);
  });
});

describe("snapDecision (P-SHARE.1)", () => {
  const railW = 56;
  it("snaps to the right frame when the right edge nears it", () => {
    const r = snapDecision({ x: VW - 380, y: 300, w: 360, h: 400 }, VW, VH, railW);
    expect(r.side).toBe("right");
    expect(r.shape.x + r.shape.w).toBeLessThanOrEqual(VW);
    expect(r.shape.x + r.shape.w).toBeGreaterThan(VW - 40); // flush right
  });
  it("snaps beside the rails (not under them) when the left edge nears the rail column", () => {
    const r = snapDecision({ x: railW + 10, y: 300, w: 360, h: 400 }, VW, VH, railW);
    expect(r.side).toBe("left");
    expect(r.shape.x).toBeGreaterThanOrEqual(railW); // beside, never under the rails
  });
  it("stays floating in the middle", () => {
    const r = snapDecision({ x: 600, y: 300, w: 360, h: 400 }, VW, VH, railW);
    expect(r.side).toBe("float");
  });
});

describe("loadDockState / saveDockState (P-SHARE.1)", () => {
  it("round-trips shape, minimized, side, and collapsed", () => {
    const store = memStorage();
    const state: DockState = { shape: { x: 100, y: 120, w: 360, h: 420 }, minimized: true, side: "left", collapsed: { "sec-relay": true } };
    saveDockState(store, state);
    const back = loadDockState(store, VW, VH);
    expect(back.minimized).toBe(true);
    expect(back.side).toBe("left");
    expect(back.collapsed).toEqual({ "sec-relay": true });
    expect(back.shape.w).toBe(360);
  });
  it("falls back to the default on absent or corrupt data", () => {
    expect(loadDockState(memStorage(), VW, VH).side).toBe("float");
    expect(loadDockState(memStorage({ "lucid.shareDock.v1": "{not json" }), VW, VH).minimized).toBe(false);
  });
  it("clamps a restored shape to the CURRENT (smaller) viewport", () => {
    const store = memStorage();
    saveDockState(store, { shape: { x: 1300, y: 800, w: 400, h: 500 }, minimized: false, side: "float", collapsed: {} });
    const back = loadDockState(store, 800, 600); // smaller screen since save
    expect(back.shape.x + back.shape.w).toBeLessThanOrEqual(800);
    expect(back.shape.y + back.shape.h).toBeLessThanOrEqual(600);
  });
  it("saving never throws even when storage is broken", () => {
    const broken: DockStorage = { get: () => null, set: () => { throw new Error("quota"); } };
    expect(() => saveDockState(broken, { shape: defaultShape(VW, VH), minimized: false, side: "float", collapsed: {} })).not.toThrow();
  });
});

describe("participantSummary (P-SHARE.1)", () => {
  it("counts + normalizes access, keeping the email name", () => {
    const s = participantSummary([{ name: "nick@x.com", access: "edit" }, { name: " bob ", access: "view" }, { name: "", access: "weird" }]);
    expect(s.count).toBe(3);
    expect(s.people[0]).toEqual({ name: "nick@x.com", access: "edit" });
    expect(s.people[1]!.name).toBe("bob");
    expect(s.people[2]).toEqual({ name: "guest", access: "view" }); // blank name + unknown access default safely
  });
  it("handles an empty / null roster", () => {
    expect(participantSummary(null).count).toBe(0);
    expect(participantSummary([]).people).toEqual([]);
  });
});

describe("keyed dock persistence (P-COLLAB.20)", () => {
  it("the share dock and the join dock persist independently under their own keys", () => {
    const storage = memStorage();
    const share: DockState = { shape: { x: 900, y: 300, w: 400, h: 500 }, minimized: false, side: "right", collapsed: {} };
    const join: DockState = { shape: { x: 80, y: 200, w: 360, h: 420 }, minimized: true, side: "left", collapsed: {} };
    saveDockState(storage, share);                      // default key (share)
    saveDockState(storage, join, JOIN_DOCK_KEY);        // join key
    expect(loadDockState(storage, VW, VH).shape.x).toBe(900);
    expect(loadDockState(storage, VW, VH, JOIN_DOCK_KEY).shape.x).toBe(80);
    expect(loadDockState(storage, VW, VH, JOIN_DOCK_KEY).minimized).toBe(true);
    expect(loadDockState(storage, VW, VH).minimized).toBe(false);
  });

  it("an absent key falls back to the CUSTOM fallback shape, clamped; a stored state beats it", () => {
    const storage = memStorage();
    const fb = { x: 68, y: 500, w: 372, h: 460 };
    const fresh = loadDockState(storage, VW, VH, JOIN_DOCK_KEY, fb);
    expect(fresh.shape.x).toBe(68); // bottom-left placement honored
    const offscreen = loadDockState(storage, 800, 600, JOIN_DOCK_KEY, { x: 9999, y: 9999, w: 372, h: 460 });
    expect(offscreen.shape.x + offscreen.shape.w).toBeLessThanOrEqual(800); // clamped on-screen
    saveDockState(storage, { shape: { x: 300, y: 100, w: 400, h: 400 }, minimized: false, side: "float", collapsed: {} }, JOIN_DOCK_KEY);
    expect(loadDockState(storage, VW, VH, JOIN_DOCK_KEY, fb).shape.x).toBe(300); // stored beats fallback
  });
});

describe("orderBindAddresses (P-SHARE.2)", () => {
  it("puts a routable LAN IPv4 first (the default) and sinks loopback to the bottom", () => {
    // the exact order the backend returns today (loopback first) - see the screenshot in the ask
    const ordered = orderBindAddresses([
      addr("127.0.0.1", "IPv4", "loopback"), addr("::1", "IPv6", "loopback"),
      addr("192.168.254.123", "IPv4", "lan"), addr("fe80::4cee", "IPv6", "lan"),
    ]);
    expect(ordered.map((a) => a.address)).toEqual(["192.168.254.123", "fe80::4cee", "127.0.0.1", "::1"]);
    expect(ordered[0]!.kind).toBe("lan"); // the DEFAULT is guest-routable, never loopback
  });

  it("orders IPv4 before IPv6 within each group (routable before loopback)", () => {
    const ordered = orderBindAddresses([
      addr("::1", "IPv6", "loopback"), addr("127.0.0.1", "IPv4", "loopback"),
      addr("fe80::1", "IPv6", "vpn"), addr("10.0.0.2", "IPv4", "vpn"),
    ]);
    expect(ordered.map((a) => a.address)).toEqual(["10.0.0.2", "fe80::1", "127.0.0.1", "::1"]);
  });

  it("is stable within a group, doesn't mutate the input, and handles empty", () => {
    const input = [addr("192.168.0.5", "IPv4", "lan"), addr("192.168.0.9", "IPv4", "lan")];
    const snapshot = input.map((a) => a.address);
    expect(orderBindAddresses(input).map((a) => a.address)).toEqual(["192.168.0.5", "192.168.0.9"]);
    expect(input.map((a) => a.address)).toEqual(snapshot); // input untouched
    expect(orderBindAddresses([])).toEqual([]);
  });
});

describe("redactShareSnapshot (P-SHARE.2)", () => {
  const relay = { wsBase: "wss://relay.example/r", label: "relay", source: "self-hosted" };
  const serve = { running: false, addresses: [addr("192.168.0.5", "IPv4", "lan")] };

  it("drops the TURN credential (a secret) but keeps preferDirect / iceUrls / turnUsername", () => {
    const snap = redactShareSnapshot(relay, serve, { preferDirect: true, iceUrls: ["stun:x"], turnUsername: "u", turnCredential: "SECRET-TURN-CRED" });
    expect(snap.p2pCfg?.turnCredential).toBeUndefined();
    expect(snap.p2pCfg).toEqual({ preferDirect: true, iceUrls: ["stun:x"], turnUsername: "u" });
    expect(JSON.stringify(snap)).not.toContain("SECRET-TURN-CRED"); // never written to disk
  });

  it("passes the non-secret relay + serve through and holds ONLY {relay, serve, p2pCfg} (no link / room id)", () => {
    const snap = redactShareSnapshot(relay, serve, null);
    expect(snap.relay).toEqual(relay);
    expect(snap.serve).toEqual(serve);
    expect(snap.p2pCfg).toBeNull();
    expect(Object.keys(snap).sort()).toEqual(["p2pCfg", "relay", "serve"]);
  });

  it("tolerates a null relay (no relay configured yet)", () => {
    expect(redactShareSnapshot(null, serve, null).relay).toBeNull();
  });
});

describe("isCollapsed (P-SHARE.1)", () => {
  it("uses the default when the user hasn't chosen, and the stored choice when they have", () => {
    expect(isCollapsed({}, "sec-relay", true)).toBe(true);
    expect(isCollapsed({}, "sec-invite", false)).toBe(false);
    expect(isCollapsed({ "sec-relay": false }, "sec-relay", true)).toBe(false); // user expanded a default-collapsed one
    expect(isCollapsed({ "sec-invite": true }, "sec-invite", false)).toBe(true); // user collapsed a default-open one
  });
});
