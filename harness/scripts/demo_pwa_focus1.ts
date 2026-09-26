// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_pwa_focus1.ts
//
// P-PWA-FOCUS.1: tap a Process/lane on the phone and that lane becomes the LIVE transcript, not just a status
// card. This drives the REAL CollabHost + REAL CollabGuest objects; the only fake is the transport, an
// in-memory relay that routes a unicast to one peer id and a broadcast to peer 0 exactly like the wire does.
// Every hop is synchronous, so the whole subscription protocol is proven headless and DETERMINISTIC: no
// sockets, no relay process, no phone, no sleeps.
//
// The lane traffic flows through the real `laneEventToChatEvent`, so what is proven is the actual production
// path: a lane engine event -> a chat event -> a lane-scoped push -> the ONE guest that asked for that lane.
//
// The load-bearing guarantee is BANDWIDTH: a fleet of busy lanes must never stream tokens at a phone on
// cellular. So the checks below assert at the WIRE (what frames the transport was asked to send) and not only
// at the guest callbacks - a lane-scoped frame nobody asked for must never be sent at all.
//
// Run with: bun run harness/scripts/demo_pwa_focus1.ts

import { CollabHost, type HostTransport } from "../../desktop/collab/host.ts";
import { CollabGuest, type GuestTransport } from "../../desktop/collab/guest.ts";
import { laneEventToChatEvent } from "../../desktop/collab/lane_event_adapter.ts";
import type { CollabTranscriptTurn, EventFrame, LucidCollabFrame } from "../../desktop/collab/frames.ts";
import type { ChatEvent } from "../../desktop/renderer/chat_events.ts";
import type { LaneEvent } from "../../desktop/fleet_lanes.ts";

let step = 0;
function pass(m: string): void { console.log(`  [${++step}] PASS  ${m}`); }
// A function DECLARATION, not a const arrow: only a declared name carries the `never` return into control
// flow analysis, so `if (!x) fail(...)` narrows `x` below rather than needing a `!` at every use.
function fail(m: string): never { throw new Error(`[${step + 1}] FAIL  ${m}`); }

/** One guest's end of the fake relay. What the guest sends reaches the host tagged with this peer id; what
 *  the host addresses to this peer id (or broadcasts to 0) is delivered here AND tallied, so a check can ask
 *  the wire what actually crossed it instead of trusting a callback that may simply not have fired. */
class GuestPipe implements GuestTransport {
  onOpen?: () => void;
  onFrame?: (frame: LucidCollabFrame, fromPeer: number) => void;
  onClose?: (reason: string, willReconnect: boolean) => void;
  readonly received: LucidCollabFrame[] = [];
  readonly laneFrames: EventFrame[] = [];
  readonly #peerId: number;
  readonly #toHost: (frame: LucidCollabFrame, fromPeer: number) => void;

  constructor(peerId: number, toHost: (frame: LucidCollabFrame, fromPeer: number) => void) {
    this.#peerId = peerId;
    this.#toHost = toHost;
  }

  connect(): void { this.onOpen?.(); }
  send(frame: LucidCollabFrame): void { this.#toHost(frame, this.#peerId); }
  close(): void { /* the demo never tears a pipe down */ }

  deliver(frame: LucidCollabFrame): void {
    this.received.push(frame);
    if (frame.t === "event" && frame.lane !== undefined) this.laneFrames.push(frame);
    this.onFrame?.(frame, 0);
  }
}

/** The in-memory relay: the host's ONE transport, fanning frames out to the per-peer pipes. */
class FakeRelay implements HostTransport {
  onOpen?: () => void;
  onFrame?: (frame: LucidCollabFrame, fromPeer: number) => void;
  onControl?: (m: unknown) => void;
  onClose?: (reason: string, willReconnect: boolean) => void;
  readonly #pipes = new Map<number, GuestPipe>();

  connect(): void { this.onOpen?.(); }
  close(): void { this.#pipes.clear(); }

  send(frame: LucidCollabFrame, targetPeer = 0): void {
    if (targetPeer === 0) { for (const pipe of this.#pipes.values()) pipe.deliver(frame); return; }
    this.#pipes.get(targetPeer)?.deliver(frame);
  }

  /** Put a peer in the room and hand back its pipe (what a CollabGuest is constructed over). */
  attach(peerId: number): GuestPipe {
    const pipe = new GuestPipe(peerId, (frame, fromPeer) => this.onFrame?.(frame, fromPeer));
    this.#pipes.set(peerId, pipe);
    return pipe;
  }

  /** Inject a raw frame from a peer, for the shapes a well-behaved CollabGuest would never send. */
  inject(peerId: number, frame: LucidCollabFrame): void { this.onFrame?.(frame, peerId); }
}

interface LaneSink {
  /** Lane-scoped events, with the lane id they arrived tagged with. */
  events: { lane: string; event: ChatEvent }[];
  /** The replays this guest received when it started watching a lane. */
  syncs: { lane: string; turns: CollabTranscriptTurn[] }[];
  /** The MASTER stream, so a lane event leaking into it is visible rather than silent. */
  masterEvents: ChatEvent[];
}

// The lane engine's bounded per-lane memory, stubbed: what a lane has already SAID, for the replay a guest
// gets the moment it starts watching. Small static string-keyed table, so a Record.
const LANE_REPLAY: Record<string, CollabTranscriptTurn[]> = {
  "lane-1": [
    { role: "user", text: "port the tokenizer to the new lexer" },
    { role: "assistant", text: "read src/lexer.ts, hoisting the switch now" },
  ],
  "lane-2": [{ role: "user", text: "write the 0007 migration" }],
};

console.log("== P-PWA-FOCUS.1: tap a lane, get its conversation (real CollabHost + CollabGuest, fake wire) ==");

const relay = new FakeRelay();
const host = new CollabHost(relay, {
  header: { sessionId: "s1", title: "Refactor the parser", model: "claude-opus-4-8", hostName: "nick@desktop", startedAt: 1000 },
  // The host contract asks the provider for a COPY: a guest must never be handed a reference the lane engine
  // still owns and mutates.
  laneTranscript: (laneId) => (LANE_REPLAY[laneId] ?? []).map((turn) => ({ ...turn })),
});
host.start();
host.pushUserTurn("clean up the tokenizer"); // one master turn, so `welcome` replays a non-empty transcript

const phoneSink: LaneSink = { events: [], syncs: [], masterEvents: [] };
const phonePipe = relay.attach(11);
const phone = new CollabGuest(phonePipe, { name: "nick@phone", writeToken: null }, {
  onEvent: (e) => { phoneSink.masterEvents.push(e); },
  onLaneEvent: (lane, e) => { phoneSink.events.push({ lane, event: e }); },
  onLaneSync: (lane, turns) => { phoneSink.syncs.push({ lane, turns }); },
});
phone.start();

const tabletSink: LaneSink = { events: [], syncs: [], masterEvents: [] };
const tabletPipe = relay.attach(12);
const tablet = new CollabGuest(tabletPipe, { name: "nick@tablet", writeToken: null }, {
  onEvent: (e) => { tabletSink.masterEvents.push(e); },
  onLaneEvent: (lane, e) => { tabletSink.events.push({ lane, event: e }); },
  onLaneSync: (lane, turns) => { tabletSink.syncs.push({ lane, turns }); },
});
tablet.start();

if (phone.view().phase !== "live" || tablet.view().phase !== "live") fail("both guests should be live off their welcome (the pipe is synchronous)");
if (phone.view().transcript.length !== 1) fail("the master replay should carry the one user turn");

// A master context reading, so a later check can prove a LANE's usage does not move this gauge.
host.pushEvent({ type: "usage", used: 8_000, size: 32_000, cost: 0.12 });
if (phone.view().contextPct !== 25) fail(`the master usage should set the gauge to 25, got ${phone.view().contextPct}`);

// One lane's turn, as the engine emits it. All four translate (thinking / tool / token / done).
const LANE_WORK: LaneEvent[] = [
  { type: "thinking", text: "the lexer is the hot path" },
  { type: "tool", name: "read", detail: "src/lexer.ts" },
  { type: "token", text: "hoisting the switch" },
  { type: "done" },
];

const pushLane = (laneId: string, events: LaneEvent[]): void => {
  for (const e of events) {
    const chat = laneEventToChatEvent(e);
    if (chat) host.pushEvent(chat, laneId);
  }
};

// ── [1] the bandwidth guarantee: nobody asked, so nothing is sent ────────────
const phoneWireBefore = phonePipe.received.length;
const tabletWireBefore = tabletPipe.received.length;
pushLane("lane-1", LANE_WORK);
if (host.laneWatched("lane-1")) fail("no guest has sent `watch`, so the host must report lane-1 unwatched");
// Not "no LANE frame" but no frame AT ALL: the guarantee is about bytes leaving the desktop, so it is
// asserted against everything the transport was asked to send, not against a filtered view of it.
if (phonePipe.received.length !== phoneWireBefore || tabletPipe.received.length !== tabletWireBefore) {
  fail(`an unwatched lane must not put a frame on the wire (phone +${phonePipe.received.length - phoneWireBefore}, tablet +${tabletPipe.received.length - tabletWireBefore})`);
}
if (phonePipe.laneFrames.length !== 0 || tabletPipe.laneFrames.length !== 0) fail("no lane-scoped frame should exist at all");
if (phoneSink.events.length !== 0 || tabletSink.events.length !== 0) fail("no lane event should have reached a guest");
pass(`a guest that never sent \`watch\` gets NOTHING: a whole lane turn (${LANE_WORK.length} engine events) put zero frames on the wire, so N idle lanes never stream at a phone on cellular`);

// ── [2] watching a lane is answered with that lane's replay ──────────────────
if (!phone.watch("lane-1")) fail("watch must be accepted: it is a subscription, not a write, so a VIEW guest may send it");
if (!host.laneWatched("lane-1")) fail("the host should now report lane-1 watched");
if (phoneSink.syncs.length !== 1) fail(`a lane watch must be answered with exactly one lane-sync, got ${phoneSink.syncs.length}`);
const sync = phoneSink.syncs[0];
if (!sync || sync.lane !== "lane-1") fail(`the lane-sync must name the lane, got ${sync?.lane}`);
if (sync.turns.length !== 2) fail(`the replay should carry lane-1's two turns, got ${sync.turns.length}`);
if (sync.turns[0]?.text !== "port the tokenizer to the new lexer" || sync.turns[1]?.role !== "assistant") {
  fail(`the replay lost its turns: ${JSON.stringify(sync.turns)}`);
}
if (tabletPipe.received.some((f) => f.t === "lane-sync")) fail("lane-sync is a UNICAST: the other guest must never receive it");
pass("a VIEW-only guest watches lane-1 and the host answers with that lane's replay (2 turns, unicast), so switching to a lane that has been working for ten minutes does not look like an empty conversation");

// ── [3] lane events arrive tagged, and never touch the master ───────────────
const masterTurnsBefore = phone.view().transcript.length;
const masterEventsBefore = phoneSink.masterEvents.length;
const laneEventsBefore = phoneSink.events.length;
pushLane("lane-1", LANE_WORK);
// The adapter deliberately strips `done.text` (the lane has no authoritative reply to hand over), so push a
// raw one to prove the SCOPING itself: even a full authoritative reply on a lane must not append to master.
host.pushEvent({ type: "done", text: "lane-1 finished the port" }, "lane-1");
host.pushEvent({ type: "usage", used: 31_000, size: 32_000, cost: 0.9 }, "lane-1");

const landed = phoneSink.events.slice(laneEventsBefore);
if (landed.length !== LANE_WORK.length + 2) fail(`expected ${LANE_WORK.length + 2} lane events, got ${landed.length}`);
if (landed.some((r) => r.lane !== "lane-1")) fail("every lane event must arrive tagged with its lane id");
const tool = landed.find((r) => r.event.type === "tool")?.event;
if (!tool || tool.type !== "tool" || tool.name !== "read" || tool.detail !== "src/lexer.ts") fail("the tool event lost its payload crossing the adapter + wire");
if (phone.view().transcript.length !== masterTurnsBefore) fail(`a lane's done text must NOT append to the master transcript (grew to ${phone.view().transcript.length})`);
if (phone.view().contextPct !== 25) fail(`a lane's usage must not move the master gauge (moved to ${phone.view().contextPct})`);
if (phoneSink.masterEvents.length !== masterEventsBefore) fail("a lane event must never reach onEvent, the master sink");
if (tabletPipe.laneFrames.length !== 0) fail("the guest watching nothing must still receive no lane frame");
// Control: prove the master stream is SCOPED, not broken, by landing a real master turn right after.
host.pushEvent({ type: "done", text: "the parser refactor is in" });
if (phone.view().transcript.length !== masterTurnsBefore + 1) fail("a MASTER done must still append: lane scoping must not break the master stream");
pass("lane events arrive through onLaneEvent tagged with their lane id, and are absent from the master transcript + the master gauge + onEvent (a lane `done` with text does NOT append to master) while a real master turn still lands");

// ── [4] watching master unsubscribes the lane ───────────────────────────────
const laneFramesAtSwitch = phonePipe.laneFrames.length;
const wireAtSwitch = phonePipe.received.length;
const syncsAtSwitch = phoneSink.syncs.length;
if (!phone.watch("master")) fail("watching master should be accepted");
if (phone.watching() !== "master") fail(`the guest should report watching master, got ${phone.watching()}`);
if (host.laneWatched("lane-1")) fail("switching to master must DROP the lane subscription host-side");
pushLane("lane-1", LANE_WORK);
if (phonePipe.received.length !== wireAtSwitch) fail(`the switch to master should be answered with silence and lane-1 should have stopped, but ${phonePipe.received.length - wireAtSwitch} frames still arrived`);
if (phonePipe.laneFrames.length !== laneFramesAtSwitch) fail(`lane-1 kept streaming after the switch (${phonePipe.laneFrames.length - laneFramesAtSwitch} extra frames)`);
if (phoneSink.syncs.length !== syncsAtSwitch) fail("a master watch must not be answered with a lane-sync");
pass("`watch(\"master\")` unsubscribes: lane-1 keeps working and not one further frame is sent, so backgrounding a lane really does cost nothing");

// ── [5] per-peer subscriptions: no crosstalk between two watchers ───────────
if (!phone.watch("lane-1") || !tablet.watch("lane-2")) fail("both guests should be able to watch their own lane");
const phoneBefore = phoneSink.events.length;
const tabletBefore = tabletSink.events.length;
pushLane("lane-1", [{ type: "token", text: "lane-1 speaking" }]);
pushLane("lane-2", [{ type: "token", text: "lane-2 speaking" }]);
const phoneNew = phoneSink.events.slice(phoneBefore);
const tabletNew = tabletSink.events.slice(tabletBefore);
if (phoneNew.length !== 1 || phoneNew[0]?.lane !== "lane-1") fail(`the phone should have received exactly its own lane: ${JSON.stringify(phoneNew)}`);
if (tabletNew.length !== 1 || tabletNew[0]?.lane !== "lane-2") fail(`the tablet should have received exactly its own lane: ${JSON.stringify(tabletNew)}`);
const phoneText = phoneNew[0]?.event;
const tabletText = tabletNew[0]?.event;
if (!phoneText || phoneText.type !== "token" || phoneText.text !== "lane-1 speaking") fail("the phone's token is not lane-1's");
if (!tabletText || tabletText.type !== "token" || tabletText.text !== "lane-2 speaking") fail("the tablet's token is not lane-2's");
if (tabletSink.syncs.some((s) => s.lane !== "lane-2")) fail("the tablet must only ever have been replayed its own lane");
pass("two guests watching two different lanes each receive only their own lane's events: the subscription is PER PEER, so one phone's focus never leaks another's tokens");

// ── [6] an approval ask is not conversation ─────────────────────────────────
const asks: LaneEvent[] = [
  { type: "permission", summary: "write src/lexer.ts", kind: "write" },
  { type: "auto-approved", summary: "read src/lexer.ts", mode: "session" },
  { type: "status", status: "needs-approval" },
];
for (const ask of asks) {
  if (laneEventToChatEvent(ask) !== null) fail(`a lane \`${ask.type}\` must not translate into conversation: the lane CARD already reports it`);
}
// A blanket null would satisfy the above and prove nothing, so pin the events that ARE conversation.
const spoke = laneEventToChatEvent({ type: "token", text: "still here" });
if (!spoke || spoke.type !== "token" || spoke.text !== "still here") fail("the adapter must still translate a lane's tokens");
const errored = laneEventToChatEvent({ type: "error", message: "the lane crashed" });
if (!errored || errored.type !== "lane-error" || errored.message !== "the lane crashed") fail("a lane error is conversation, on its own variant");
pass("laneEventToChatEvent drops permission / auto-approved / status so an approval ask never double-reports as a transcript line (which would look actionable on a surface that cannot answer it), while tokens and errors still translate");

// ── [7] fail-closed: no hello, no subscription ──────────────────────────────
const ghostPipe = relay.attach(13); // in the room, but with NO CollabGuest, so it never sent a `hello`
relay.inject(13, { t: "watch", target: "lane-3" });
if (host.laneWatched("lane-3")) fail("a watch from a peer that never introduced itself must not subscribe it");
if (ghostPipe.received.length !== 0) fail(`an unintroduced peer must get nothing back, got: ${ghostPipe.received.map((f) => f.t).join(", ")}`);
pushLane("lane-3", LANE_WORK);
if (ghostPipe.received.length !== 0) fail(`an unintroduced peer must not be streamed a lane, got: ${ghostPipe.received.map((f) => f.t).join(", ")}`);
pass("a `watch` from a peer that never sent `hello` is ignored fail-closed: no lane-sync (so a lane's transcript never replays to an unauthenticated peer) and no subscription, so its lane stays silent");

host.stop("demo over");
console.log(`\nP-PWA-FOCUS.1 demo: all ${step} checks passed - a lane streams to exactly the guests that tapped it, replays what it already said, stays out of the master transcript, and costs nothing when nobody is looking.`);
process.exit(0);
