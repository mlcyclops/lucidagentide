// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_pcollab3.ts
//
// P-COLLAB.3 (ADR-0192): the backend host LIFECYCLE (CollabManager) - the piece dev.ts wires to the
// /api/collab/* routes + the /api/chat ChatEvent tap. Proven end-to-end offline: a REAL CollabManager mints
// a room over an in-memory relay, a REAL guest CollabSocket joins with the view link, the manager taps live
// ChatEvents through to the guest, status reflects the roster, stop tears it down, and start REFUSES when no
// relay is authorized (fail-closed).
//
// Run with: bun run harness/scripts/demo_pcollab3.ts

import { CollabManager, type RelayTarget } from "../../desktop/collab/manager.ts";
import { CollabSocket, type WebSocketLike } from "../../desktop/collab/relay_client.ts";
import { importRoomKey, packEnvelope, unpackEnvelope } from "../../desktop/collab/crypto.ts";
import { parseShareLink } from "../../desktop/collab/link.ts";
import type { LucidCollabFrame } from "../../desktop/collab/frames.ts";

function fail(m: string): never { console.error(`FAIL: ${m}`); process.exit(1); }
function ok(m: string): void { console.log(`  PASS  ${m}`); }
const tick = () => new Promise((r) => setTimeout(r, 0));
// The real CollabSocket seals/opens asynchronously (WebCrypto) over the mock relay, so poll until the
// expected state holds (bounded) instead of guessing a fixed delay. The library is proven deterministically
// by the unit tests; this only stabilizes the end-to-end demo's cross-socket timing.
async function waitFor(cond: () => boolean, label: string, tries = 300): Promise<void> {
  for (let i = 0; i < tries; i++) { if (cond()) return; await new Promise((r) => setTimeout(r, 2)); }
  fail(`timed out waiting for ${label}`);
}

// ── in-memory relay (same shape as demo_pcollab2) ─────────────────────────────
class MockSocket implements WebSocketLike {
  binaryType = ""; readyState = 0;
  onopen: ((e?: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e?: unknown) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  constructor(private relay: MockRelay, public role: "host" | "guest", public peer = 0) {}
  send(data: Uint8Array): void { this.relay.route(this, data); }
  close(): void { this.readyState = 3; }
  _open(): void { this.readyState = 1; this.onopen?.(); }
  deliver(bytes: Uint8Array): void {
    try { const s = new TextDecoder("utf-8", { fatal: true }).decode(bytes); JSON.parse(s); this.onmessage?.({ data: s }); }
    catch { this.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }); }
  }
}
class MockRelay {
  host: MockSocket | null = null;
  guests = new Map<number, MockSocket>();
  #next = 1;
  connect(role: "host" | "guest"): MockSocket {
    if (role === "host") { const s = new MockSocket(this, "host"); this.host = s; queueMicrotask(() => s._open()); return s; }
    const peer = this.#next++;
    const s = new MockSocket(this, "guest", peer);
    this.guests.set(peer, s);
    queueMicrotask(() => { this.host?.deliver(new TextEncoder().encode(JSON.stringify({ t: "peer-joined", peer })) as unknown as Uint8Array); s._open(); });
    return s;
  }
  route(from: MockSocket, envelope: Uint8Array): void {
    const { peerId: target, sealed } = unpackEnvelope(envelope);
    if (from.role === "host") {
      const out = packEnvelope(0, sealed);
      if (target === 0) for (const g of this.guests.values()) g.deliver(out);
      else this.guests.get(target)?.deliver(out);
    } else {
      this.host?.deliver(packEnvelope(from.peer, sealed));
    }
  }
}

console.log("P-COLLAB.3 demo - the backend host lifecycle (CollabManager)\n");

const relay = new MockRelay();
const RELAY: RelayTarget = { wsBase: "wss://relay.local", httpBase: "https://relay.local", label: "relay.local (self-hosted)", source: "self-hosted" };

// [1] the manager starts a share over the (in-memory) relay
const mgr = new CollabManager({
  resolveRelay: () => RELAY,
  sessionInfo: () => ({ sessionId: "sess-42", title: "Harden the token check", model: "claude-opus-4-8", hostName: "alice" }),
  makeTransport: ({ wsUrl, key }) => new CollabSocket({ wsUrl, role: "host", key, wsFactory: () => relay.connect("host") }),
  now: () => 1_720_000_000_000,
});
const started = await mgr.start();
await tick();
if (!started.active || !started.viewLink || !started.fullLink) fail("share did not start");
ok(`manager started a share on ${started.relayLabel} (room ${started.roomId!.slice(0, 8)}…) + minted a view + full link`);

// [2] a guest joins with the VIEW link
const view = parseShareLink(started.viewLink);
const guestKey = await importRoomKey(view.key);
const guest = new CollabSocket({ wsUrl: "wss://relay.local/r/x", role: "guest", key: guestKey, wsFactory: () => relay.connect("guest") });
const inbox: LucidCollabFrame[] = [];
guest.onFrame = (f) => inbox.push(f);
guest.onOpen = () => guest.send({ t: "hello", protocol: 1, name: "bob" }, 0);
guest.connect();
await waitFor(() => inbox.some((f) => f.t === "welcome") && mgr.status().participantCount === 1, "the guest welcome + roster");
const welcome = inbox.find((f) => f.t === "welcome") as Extract<LucidCollabFrame, { t: "welcome" }> | undefined;
if (!welcome || welcome.header.title !== "Harden the token check" || !welcome.readOnly) fail("guest welcome wrong / not read-only");
if (mgr.status().participantCount !== 1) fail("manager status should show 1 participant");
ok(`guest joined view-only; manager status shows ${mgr.status().participantCount} participant, welcome header = "${welcome.header.title}"`);

// [3] the manager taps live ChatEvents through to the guest (the /api/chat tap)
mgr.tapUserTurn("please tighten it");
mgr.tapEvent({ type: "token", text: "Working…" });
mgr.tapEvent({ type: "usage", used: 40, size: 200, cost: 0.01 });
mgr.tapEvent({ type: "done", text: "Hardened + tested." });
await waitFor(() => inbox.filter((f) => f.t === "event").length >= 3, "3 tapped events");
const events = inbox.filter((f) => f.t === "event");
if (events.length !== 3) fail(`guest expected 3 tapped events, got ${events.length}`);
ok(`manager tapped 3 live ChatEvents through to the guest end-to-end (the /api/chat passthrough)`);

// [4] stop tears it down
mgr.stop("host ended the session");
await waitFor(() => !mgr.active && inbox.some((f) => f.t === "bye"), "the bye on stop");
if (mgr.active || !inbox.some((f) => f.t === "bye")) fail("stop should end the share + send bye");
ok("manager stopped the share; the guest received bye and status went idle");

// [5] fail-closed: start with NO authorized relay throws
const noRelay = new CollabManager({ resolveRelay: () => null, sessionInfo: () => ({ sessionId: "s", title: "t", model: "m", hostName: "h" }), makeTransport: () => { throw new Error("should not build a transport"); }, now: () => 0 });
let refused = false;
try { await noRelay.start(); } catch { refused = true; }
if (!refused || noRelay.active) fail("start must fail closed when no relay is authorized");
ok("fail-closed: with no relay configured (no self-hosted URL, public opt-in off), start() REFUSES");

console.log("\nP-COLLAB.3 demo complete - the backend host lifecycle is proven; the Share panel UI + guest join/render + guest-write are the next slice.");
process.exit(0); // the mock guest socket is intentionally left open; exit cleanly now every assertion passed
