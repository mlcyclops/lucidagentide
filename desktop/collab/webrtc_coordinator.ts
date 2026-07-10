// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/webrtc_coordinator.ts — P-COLLAB.16 (ADR-0201): the production WebRTC swap-in.
//
// This is the piece that actually flips a live share onto peer-to-peer. It connects a relay `CollabSocket` and
// uses it for THREE things: (1) the WebRTC SIGNALING handshake (SDP/ICE, carried as `signal` frames), (2) relay
// CONTROL (peer join/leave), and (3) a FALLBACK path for the session frames themselves when a DataChannel can't
// be established (NAT without TURN). The session runs over the relay immediately and transparently UPGRADES to
// a direct DataChannel per guest the moment ICE completes - see PreferP2PTransport.
//
// The composition, so `CollabHost` / `CollabGuest` stay UNCHANGED:
//   host:  relay socket ──demux──▶ FanoutHostTransport ──per guest──▶ PreferP2PTransport{ WebRtcTransport, relay }
//                                          ▲                                     └─ RelaySignaling (SDP/ICE)
//                                   CollabHost drives it
//   guest: relay socket ──demux──▶ PreferP2PTransport{ WebRtcTransport, relay } ◀── CollabGuest drives it
//                                          └─ RelaySignaling (SDP/ICE to host peer 0)
//
// RENDERER-ONLY (WebRtcTransport → RTCPeerConnection): never import from the no-DOM harness/root program.
// Verified in the preview (webrtc_session.ts `webrtcRelaySelfTest`), not `bun test`. The two pure building
// blocks it composes - PreferP2PTransport + FanoutHostTransport - ARE unit-tested headless.

import { CollabSocket, type WebSocketFactory } from "./relay_client.ts";
import { CollabHost, type HostStartOpts } from "./host.ts";
import { CollabGuest, type GuestCallbacks, type GuestStartOpts } from "./guest.ts";
import { WebRtcTransport } from "./webrtc_transport.ts";
import { PreferP2PTransport } from "./prefer_p2p.ts";
import { FanoutHostTransport, type GuestLink } from "./fanout_host.ts";
import { RelaySignaling, type SignalMessage } from "./signaling.ts";
import { isSignalFrame, type LucidCollabFrame } from "./frames.ts";

/** The host on the relay is always peer 0 (relay_server tags host→guest frames with sender 0). */
const HOST_PEER = 0;

export interface WebRtcCoordinatorBase {
  /** `wss://host[:port]/r/<roomId>` (no query) - the relay used for signaling + control + fallback. */
  wsUrl: string;
  key: CryptoKey;
  /** STUN/TURN for cross-NAT; omit for same-LAN/VPN. */
  iceServers?: RTCIceServer[];
  /** Injected for the self-test's loopback relay; defaults to the ambient WebSocket. */
  wsFactory?: WebSocketFactory;
  onLog?: (msg: string, detail?: unknown) => void;
}

export interface WebRtcHostCoordinatorOpts extends WebRtcCoordinatorBase { host: HostStartOpts }
export interface WebRtcGuestCoordinatorOpts extends WebRtcCoordinatorBase { guest: GuestStartOpts; callbacks?: GuestCallbacks }

export interface WebRtcHostCoordinator { host: CollabHost; socket: CollabSocket; fanout: FanoutHostTransport; close(): void }
export interface WebRtcGuestCoordinator { guest: CollabGuest; socket: CollabSocket; transport: PreferP2PTransport; close(): void }

/**
 * Host side: one `CollabHost` fanned out to a per-guest `PreferP2PTransport` (WebRTC + relay fallback), with the
 * relay socket demuxed into signaling / control / fallback-session. Returns the live host + a `close()`.
 */
export function webrtcHostCoordinator(opts: WebRtcHostCoordinatorOpts): WebRtcHostCoordinator {
  const socket = new CollabSocket({ wsUrl: opts.wsUrl, role: "host", key: opts.key, wsFactory: opts.wsFactory, onLog: opts.onLog });

  // Build a fresh P2P+relay pipe for each guest the fan-out asks for. The host is the OFFERER, so this pipe's
  // WebRtcTransport makes the offer on connect(); until the DataChannel is up, frames ride the relay.
  const makeGuest = (peer: number): GuestLink => {
    const signaling = new RelaySignaling((msg: SignalMessage, tp: number) => socket.send({ t: "signal", signal: msg }, tp), peer);
    const webrtc = new WebRtcTransport({ role: "host", key: opts.key, signaling, iceServers: opts.iceServers, onLog: opts.onLog });
    const transport = new PreferP2PTransport({ p2p: webrtc, targetPeer: peer, relaySend: (f, tp) => socket.send(f, tp) });
    return { transport, deliverRelay: (f, from) => transport.relayDeliver(f, from), deliverSignal: (m) => signaling.deliver(m) };
  };
  const fanout = new FanoutHostTransport({ makeGuest });
  const host = new CollabHost(fanout, opts.host);
  host.start(); // wires fanout.onFrame / onControl (guest frames + peer-left reach CollabHost through the fan-out)

  // Demux the relay socket: signals → the guest's signaling, control → the fan-out, everything else → the
  // guest's relay-fallback inbound. `fromPeer` is the guest's relay peer id (relay tags guest→host frames).
  socket.onControl = (msg) => fanout.onRelayControl(msg);
  socket.onFrame = (frame, fromPeer) => {
    if (isSignalFrame(frame)) fanout.onRelaySignal(frame.signal, fromPeer);
    else fanout.onRelaySession(frame, fromPeer);
  };
  socket.onClose = (reason, willReconnect) => { if (!willReconnect) host.stop(`relay closed: ${reason}`); };
  socket.connect();

  return { host, socket, fanout, close: () => { try { host.stop("closed"); } catch { /* */ } try { socket.close(); } catch { /* */ } } };
}

/**
 * Guest side: one `CollabGuest` over a `PreferP2PTransport` to the host (WebRTC + relay fallback). The relay
 * socket is demuxed into signaling (to the host) vs the relay-fallback session inbound.
 */
export function webrtcGuestCoordinator(opts: WebRtcGuestCoordinatorOpts): WebRtcGuestCoordinator {
  const socket = new CollabSocket({ wsUrl: opts.wsUrl, role: "guest", key: opts.key, wsFactory: opts.wsFactory, onLog: opts.onLog });

  // The guest is the ANSWERER; its signaling target is the host (peer 0). The relay fallback also goes to 0.
  const signaling = new RelaySignaling((msg: SignalMessage) => socket.send({ t: "signal", signal: msg }, HOST_PEER), HOST_PEER);
  const webrtc = new WebRtcTransport({ role: "guest", key: opts.key, signaling, iceServers: opts.iceServers, onLog: opts.onLog });
  const transport = new PreferP2PTransport({ p2p: webrtc, targetPeer: HOST_PEER, relaySend: (f) => socket.send(f, HOST_PEER) });
  const guest = new CollabGuest(transport, opts.guest, opts.callbacks ?? {});
  guest.start(); // wires transport.onFrame/onOpen + connect(); sends hello over the relay at once, upgrades to P2P

  socket.onFrame = (frame, fromPeer) => {
    if (isSignalFrame(frame)) signaling.deliver(frame.signal);
    else transport.relayDeliver(frame, fromPeer);
  };
  // room-closed surfaces as a terminal socket close → tell the guest the share ended.
  socket.onClose = (reason, willReconnect) => { if (!willReconnect) guest.leave(`relay closed: ${reason}`); };
  socket.connect();

  return { guest, socket, transport, close: () => { try { guest.leave("closed"); } catch { /* */ } try { socket.close(); } catch { /* */ } } };
}

export type { LucidCollabFrame };
