// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/signaling.ts — P-COLLAB.8 (ADR-0194): the WebRTC signaling protocol.
//
// WebRTC gives an encrypted (DTLS) P2P DataChannel with NAT traversal (ICE/STUN) - already in the Electron
// build (Chromium). The one thing it needs is a tiny SIGNALING handshake: the offerer's SDP offer + the
// answerer's SDP answer + each side's trickled ICE candidates have to reach the other peer. That exchange
// rides an existing channel (the collab relay), then the peers connect DIRECTLY and the relay sees nothing
// more of the session. Crucially, the collab frames sent over the DataChannel are STILL E2E-sealed with the
// room key (crypto.ts), so a relay that MITM'd the signaling would broker a channel it cannot read.
//
// PURE + DOM-free: SDP/ICE are carried as plain data shapes (structurally what RTCPeerConnection emits +
// accepts), so this module is importable anywhere and unit-testable without a browser. The RTCPeerConnection
// itself lives in the renderer-side transport (webrtc_transport.ts), which is not in the no-DOM root program.

/** An SDP description - `type` is "offer" | "answer"; `sdp` is the opaque blob. Matches RTCSessionDescriptionInit. */
export interface SdpDescription { type: string; sdp: string }

/** One ICE candidate (trickled as gathered). Matches the plain-data subset of RTCIceCandidateInit. */
export interface IceCandidate { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null; usernameFragment?: string | null }

/** A signaling message exchanged between the two peers over the (untrusted) signaling channel. */
export type SignalMessage =
  | { t: "sdp"; sdp: SdpDescription }
  | { t: "ice"; candidate: IceCandidate }
  | { t: "bye" }; // graceful teardown of the peer connection

/** The transport-agnostic signaling channel the WebRTC transport drives. The real impl routes these through
 *  the collab relay (host<->guest); a test/loopback wires two hubs back-to-back. */
export interface SignalingChannel {
  send(msg: SignalMessage): void;
  onMessage(cb: (msg: SignalMessage) => void): void;
  close(): void;
}

/** Narrowing helpers (kept tiny + pure). */
export const isSdp = (m: SignalMessage): m is { t: "sdp"; sdp: SdpDescription } => m.t === "sdp";
export const isIce = (m: SignalMessage): m is { t: "ice"; candidate: IceCandidate } => m.t === "ice";

/**
 * A minimal in-memory signaling hub for loopback tests / same-process wiring: two `endpoint()`s that deliver
 * each other's messages. NOT the production path (that routes over the relay) - but it lets the WebRTC dance
 * be exercised without a server, and validates that our SignalingChannel shape is sufficient.
 */
export class LoopbackSignaling {
  #a: ((m: SignalMessage) => void) | null = null;
  #b: ((m: SignalMessage) => void) | null = null;
  #closed = false;

  endpoint(side: "a" | "b"): SignalingChannel {
    return {
      send: (msg) => {
        if (this.#closed) return;
        const peer = side === "a" ? this.#b : this.#a;
        // deliver asynchronously, like a real network hop (avoids re-entrancy during negotiation)
        if (peer) queueMicrotask(() => { if (!this.#closed) peer(msg); });
      },
      onMessage: (cb) => { if (side === "a") this.#a = cb; else this.#b = cb; },
      close: () => { this.#closed = true; },
    };
  }
}

/**
 * P-COLLAB.11: a `SignalingChannel` that rides the collab RELAY. The SDP/ICE handshake is carried as
 * `signal` frames over the existing collab transport (which seals + envelopes them), routed to one specific
 * peer. This is what lets `WebRtcTransport`'s signaling reach the other side over the relay we already have -
 * with no extra connection - before the peers go direct P2P. Frame-agnostic (the caller wraps/unwraps the
 * `signal` frame), so this stays DOM-free + unit-testable.
 */
export class RelaySignaling implements SignalingChannel {
  readonly #targetPeer: number;
  readonly #sendSignal: (msg: SignalMessage, targetPeer: number) => void;
  #cb: ((m: SignalMessage) => void) | null = null;
  #closed = false;

  /** `sendSignal` puts a signal on the wire to `targetPeer` (host = 0; a guest is its relay-assigned peer id). */
  constructor(sendSignal: (msg: SignalMessage, targetPeer: number) => void, targetPeer: number) {
    this.#sendSignal = sendSignal;
    this.#targetPeer = targetPeer;
  }

  get peer(): number { return this.#targetPeer; }

  send(msg: SignalMessage): void { if (!this.#closed) this.#sendSignal(msg, this.#targetPeer); }
  onMessage(cb: (m: SignalMessage) => void): void { this.#cb = cb; }
  close(): void { this.#closed = true; this.#cb = null; }

  /** The demux calls this when a `signal` frame from THIS peer arrives over the collab transport. */
  deliver(msg: SignalMessage): void { if (!this.#closed) this.#cb?.(msg); }
}
