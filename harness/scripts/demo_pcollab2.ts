// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_pcollab2.ts
//
// P-COLLAB.2 (ADR-0192): the relay CLIENT + the view-only broadcast HOST, proven end-to-end offline. An
// in-memory relay routes opaque envelopes between a REAL host CollabSocket (driven by a REAL CollabHost) and
// a REAL guest CollabSocket - no network, no UI - so the whole live path is exercised:
//   [1] the host opens a room; a guest connects with a VIEW link and sends `hello`,
//   [2] the host answers with a unicast `welcome` (header + replayed transcript + roster) - decrypted E2E,
//   [3] the host broadcasts live ChatEvents; the guest renders them; a second guest joins mid-stream and its
//       welcome reflects the folded context fill,
//   [4] view-only is enforced host-side even for a full-token guest (Phase 1), and `stop` sends `bye`.
// The relay only ever sees ciphertext (it routes by the 4-byte plaintext peer header alone).
//
// Run with: bun run harness/scripts/demo_pcollab2.ts

import { CollabSocket, type WebSocketLike } from "../../desktop/collab/relay_client.ts";
import { CollabHost } from "../../desktop/collab/host.ts";
import { generateRoomKey, generateWriteToken, importRoomKey, packEnvelope, unpackEnvelope } from "../../desktop/collab/crypto.ts";
import { generateRoomId, formatShareLink, parseShareLink } from "../../desktop/collab/link.ts";
import type { LucidCollabFrame } from "../../desktop/collab/frames.ts";

function fail(m: string): never { console.error(`FAIL: ${m}`); process.exit(1); }
function ok(m: string): void { console.log(`  PASS  ${m}`); }
const tick = () => new Promise((r) => setTimeout(r, 0));
// The real CollabSockets seal/open asynchronously (WebCrypto) across the mock relay, so a single macrotask
// is not enough to settle a cross-socket hop. Poll until the expected state holds (bounded) - deterministic
// without hard-coding a delay. The library itself is proven deterministically by the unit tests.
async function waitFor(cond: () => boolean, label: string, tries = 300): Promise<void> {
  for (let i = 0; i < tries; i++) { if (cond()) return; await new Promise((r) => setTimeout(r, 2)); }
  fail(`timed out waiting for ${label}`);
}

// ── an in-memory relay: routes opaque envelopes, rewriting the header to the SENDER's peer id ────────────
class MockSocket implements WebSocketLike {
  binaryType = ""; readyState = 0;
  onopen: ((e?: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e?: unknown) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  constructor(private relay: MockRelay, private role: "host" | "guest") {}
  send(data: Uint8Array): void { this.relay.fromClient(this, data); }
  close(): void { this.readyState = 3; }
  _open(): void { this.readyState = 1; this.onopen?.(); }
  _deliver(bytes: Uint8Array): void { this.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }); }
  get _role() { return this.role; }
}
class MockRelay {
  host: MockSocket | null = null;
  guests = new Map<number, MockSocket>();
  #nextPeer = 1;
  connect(role: "host" | "guest"): MockSocket {
    const s = new MockSocket(this, role);
    if (role === "host") this.host = s;
    else {
      const peer = this.#nextPeer++;
      this.guests.set(peer, s);
      (s as any)._peer = peer;
      // tell the host a peer joined (relay control), then let the guest's own hello register it
      queueMicrotask(() => this.host && this.host._deliver(strFrame({ t: "peer-joined", peer })));
    }
    queueMicrotask(() => s._open());
    return s;
  }
  fromClient(from: MockSocket, envelope: Uint8Array): void {
    const { peerId: target, sealed } = unpackEnvelope(envelope);
    if (from._role === "host") {
      // host → guest(s); rewrite header to sender peer 0 (host)
      const out = packEnvelope(0, sealed);
      if (target === 0) for (const g of this.guests.values()) g._deliver(out);
      else this.guests.get(target)?._deliver(out);
    } else {
      // guest → host; tag with the guest's assigned peer id
      const peer = (from as any)._peer as number;
      this.host?._deliver(packEnvelope(peer, sealed));
    }
  }
}
// relay control frames arrive as STRING messages
function strFrame(obj: unknown): Uint8Array { return new TextEncoder().encode(JSON.stringify(obj)) as unknown as Uint8Array; }
// deliver a string (not binary) — MockSocket._deliver sends binary; add a string path
(MockSocket.prototype as any)._deliver = function (this: MockSocket, bytes: Uint8Array) {
  // control frames are UTF-8 JSON that parse; peer frames are sealed (won't parse) → send as binary
  try { const s = new TextDecoder("utf-8", { fatal: true }).decode(bytes); JSON.parse(s); this.onmessage?.({ data: s }); }
  catch { this.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }); }
};

console.log("P-COLLAB.2 demo - the relay client + the view-only broadcast host\n");

// [1] host opens a room
const relay = new MockRelay();
const roomId = generateRoomId();
const rawKey = generateRoomKey();
const token = generateWriteToken();
const viewLink = formatShareLink(roomId, rawKey);            // read-only invite
const fullLink = formatShareLink(roomId, rawKey, token);     // full invite
const hostKey = await importRoomKey(rawKey);

const hostSock = new CollabSocket({ wsUrl: `wss://relay.local/r/${roomId}`, role: "host", key: hostKey, wsFactory: () => relay.connect("host") });
const host = new CollabHost(hostSock, {
  header: { sessionId: "sess-1", title: "Refactor the auth guard", model: "claude-opus-4-8", hostName: "alice", startedAt: 1000 },
  writeToken: token, // held, but guest-write stays OFF in Phase 1
});
host.start();
host.pushUserTurn("Can you tighten the token check?");
host.pushEvent({ type: "done", text: "Sure - I hardened it and added a test." });
await tick();
ok(`host opened room ${roomId.slice(0, 8)}… and recorded one prior turn`);

// [2] a guest joins with the VIEW link and sends hello; expects a welcome
const gView = parseShareLink(viewLink);
const guestKey = await importRoomKey(gView.key);
const guestSock = new CollabSocket({ wsUrl: `wss://relay.local/r/${roomId}`, role: "guest", key: guestKey, wsFactory: () => relay.connect("guest") });
const inbox: LucidCollabFrame[] = [];
guestSock.onFrame = (f) => inbox.push(f);
guestSock.onOpen = () => guestSock.send({ t: "hello", protocol: 1, name: "bob" }, 0);
guestSock.connect();
await waitFor(() => inbox.some((f) => f.t === "welcome"), "the guest's welcome");

const welcome = inbox.find((f) => f.t === "welcome") as Extract<LucidCollabFrame, { t: "welcome" }> | undefined;
if (!welcome) fail("guest never received a welcome");
if (welcome.header.title !== "Refactor the auth guard") fail("welcome header wrong");
if (!welcome.readOnly) fail("Phase 1 view link must be read-only");
if (welcome.transcript.length !== 2) fail(`expected 2 replayed turns, got ${welcome.transcript.length}`);
ok(`guest joined + got an E2E welcome (readOnly=${welcome.readOnly}, ${welcome.transcript.length} turns replayed) - relay saw only ciphertext`);

// [3] host broadcasts live events; guest renders them
host.pushEvent({ type: "token", text: "Refactoring…" });
host.pushEvent({ type: "usage", used: 60, size: 200, cost: 0.01 });
host.pushEvent({ type: "done", text: "Done." });
await waitFor(() => inbox.filter((f) => f.t === "event").length >= 3, "3 broadcast events");
const events = inbox.filter((f) => f.t === "event");
if (events.length !== 3) fail(`guest expected 3 live events, got ${events.length}`);
ok(`host broadcast 3 live ChatEvents; the guest opened all 3 end-to-end`);

// a second guest joins mid-stream; its welcome reflects the folded context fill (60/200 = 30%)
const g2 = new CollabSocket({ wsUrl: `wss://relay.local/r/${roomId}`, role: "guest", key: guestKey, wsFactory: () => relay.connect("guest") });
const inbox2: LucidCollabFrame[] = [];
g2.onFrame = (f) => inbox2.push(f);
g2.onOpen = () => g2.send({ t: "hello", protocol: 1, name: "carol" }, 0);
g2.connect();
await waitFor(() => host.participantCount === 2 && [...inbox2].some((f) => f.t === "state" && f.contextPct === 30), "the 2nd guest's state with the folded context fill");
const state2 = [...inbox2].reverse().find((f) => f.t === "state") as Extract<LucidCollabFrame, { t: "state" }> | undefined;
if (host.participantCount !== 2) fail(`host should see 2 guests, saw ${host.participantCount}`);
if (!state2 || state2.contextPct !== 30) fail(`late joiner should see contextPct 30, saw ${state2?.contextPct}`);
ok(`a 2nd guest joined mid-stream; roster=2 and its state shows the folded context fill (${state2.contextPct}%)`);

// [4] view-only is enforced even for a FULL-token guest in Phase 1
const gFull = parseShareLink(fullLink);
if (!gFull.writeToken) fail("full link should carry a write token");
const g3 = new CollabSocket({ wsUrl: `wss://relay.local/r/${roomId}`, role: "guest", key: await importRoomKey(gFull.key), wsFactory: () => relay.connect("guest") });
const inbox3: LucidCollabFrame[] = [];
g3.onFrame = (f) => inbox3.push(f);
let tokenB64 = ""; { let bin = ""; for (const b of gFull.writeToken) bin += String.fromCharCode(b); tokenB64 = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
g3.onOpen = () => g3.send({ t: "hello", protocol: 1, name: "mallory", writeToken: tokenB64 }, 0);
g3.connect();
await waitFor(() => inbox3.some((f) => f.t === "welcome"), "the full-token guest's welcome");
const w3 = inbox3.find((f) => f.t === "welcome") as Extract<LucidCollabFrame, { t: "welcome" }> | undefined;
if (!w3 || !w3.readOnly) fail("Phase 1: a full-token guest must STILL be read-only (guest-write is off)");
ok("fail-closed: a guest presenting a valid write token is STILL read-only in Phase 1 (guest-write is P-COLLAB.3)");

// stop → bye
host.stop("host ended the session");
await waitFor(() => inbox.some((f) => f.t === "bye"), "the bye on stop");
if (!inbox.some((f) => f.t === "bye")) fail("guests should receive bye on stop");
ok("host stopped the share; every guest received a bye");

console.log("\nP-COLLAB.2 demo complete - the relay client + view-only host are proven end-to-end; the Share panel UI + guest join/render + guest-write are P-COLLAB.3.");
process.exit(0); // the mock guest sockets are intentionally left open; exit cleanly now every assertion passed
