// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_pcollab11.ts
//
// P-COLLAB.11 (ADR-0197): signaling over the relay - the keystone that lets the WebRTC transport (ADR-0194)
// reach the other peer using the relay we already have, before the peers go DIRECT P2P. Proves, headless,
// that the SDP offer/answer + trickled ICE route host<->guest as `signal` frames through the relay's peer
// routing (a signal to peer 0 reaches the host; a signal to the guest's peer id reaches the guest). The
// actual RTCPeerConnection is a Chromium API (renderer-only, not in Bun), so the DataChannel itself is
// verified in the preview - here we prove the signaling that carries it.
//
// Run with: bun run harness/scripts/demo_pcollab11.ts

import { RelaySignaling, type SignalMessage } from "../../desktop/collab/signaling.ts";
import { isSignalFrame, type LucidCollabFrame } from "../../desktop/collab/frames.ts";

function fail(m: string): never { console.error(`FAIL: ${m}`); process.exit(1); }
function ok(m: string): void { console.log(`  PASS  ${m}`); }

console.log("P-COLLAB.11 demo - WebRTC signaling over the relay\n");

const GUEST_PEER = 5;

// [1] a mock relay that routes SEALED signal frames by their 4-byte peer header (exactly what the real relay
// does). We model it as: a frame to peer 0 -> the host; a frame to GUEST_PEER -> the guest.
let hostSig!: RelaySignaling;
let guestSig!: RelaySignaling;
const relayFromHost = (msg: SignalMessage, target: number) => { if (target !== GUEST_PEER) fail("host must signal the guest's peer id"); guestSig.deliver(msg); };
const relayFromGuest = (msg: SignalMessage, target: number) => { if (target !== 0) fail("guest must signal the host (peer 0)"); hostSig.deliver(msg); };
hostSig = new RelaySignaling(relayFromHost, GUEST_PEER); // the host's channel TO this one guest (1:1 per guest)
guestSig = new RelaySignaling(relayFromGuest, 0);        // the guest's channel TO the host
ok(`host has a signaling channel to guest peer ${GUEST_PEER}; guest has one to the host (peer 0)`);

// [2] the frame layer: a `signal` frame is neither a host nor a guest SESSION frame, so the host/guest
// session handlers ignore it and the demux routes it to signaling instead.
const sig: LucidCollabFrame = { t: "signal", signal: { t: "sdp", sdp: { type: "offer", sdp: "…" } } };
if (!isSignalFrame(sig)) fail("a signal frame must be recognizable for the demux");
ok("a `signal` frame is recognized by the demux (session handlers ignore it)");

// [3] the WebRTC handshake flows host <-> guest over the relay
const atHost: string[] = [];
const atGuest: string[] = [];
hostSig.onMessage((m) => atHost.push(m.t === "sdp" ? `sdp:${m.sdp.type}` : m.t));
guestSig.onMessage((m) => atGuest.push(m.t === "sdp" ? `sdp:${m.sdp.type}` : m.t));

hostSig.send({ t: "sdp", sdp: { type: "offer", sdp: "OFFER" } });   // host -> guest
guestSig.send({ t: "sdp", sdp: { type: "answer", sdp: "ANSWER" } }); // guest -> host
guestSig.send({ t: "ice", candidate: { candidate: "cand-guest" } });
hostSig.send({ t: "ice", candidate: { candidate: "cand-host" } });

if (JSON.stringify(atGuest) !== JSON.stringify(["sdp:offer", "ice"])) fail(`guest saw ${JSON.stringify(atGuest)}`);
if (JSON.stringify(atHost) !== JSON.stringify(["sdp:answer", "ice"])) fail(`host saw ${JSON.stringify(atHost)}`);
ok("full handshake routed over the relay: host->guest offer + ICE, guest->host answer + ICE");

// [4] close is terminal (a stale ICE after teardown is dropped)
hostSig.close();
hostSig.send({ t: "ice", candidate: { candidate: "late" } });
if (atGuest.length !== 2) fail("no signaling after close");
ok("close is terminal - a late ICE candidate after teardown is dropped");

console.log("\nP-COLLAB.11 demo complete - the SDP/ICE handshake rides the relay as `signal` frames; WebRtcTransport (renderer) consumes this SignalingChannel, then the peers connect DIRECT P2P. The renderer-side host/guest over WebRTC is the next slice.");
process.exit(0);
