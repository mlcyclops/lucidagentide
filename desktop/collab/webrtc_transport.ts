// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/webrtc_transport.ts — P-COLLAB.8 (ADR-0194): the WebRTC DataChannel transport.
//
// A drop-in for CollabSocket: it implements the SAME transport interface that CollabHost / CollabGuest drive
// ({ onOpen, onFrame, onClose, connect, send, close }), but instead of a relay WebSocket it opens a DIRECT,
// DTLS-encrypted, NAT-traversing WebRTC DataChannel between the two peers. Only the tiny signaling handshake
// (SDP offer/answer + trickled ICE) rides the relay (via the injected SignalingChannel); once the channel is
// up the session flows peer-to-peer and the relay sees nothing more.
//
// Frames are STILL E2E-sealed with the room key (crypto.ts) before hitting the DataChannel - so even a relay
// that MITM'd the signaling would broker a channel it cannot read (defense-in-depth on top of DTLS). Roles
// are fixed (host = offerer, guest = answerer), so there is no negotiation glare and no perfect-negotiation
// dance is needed.
//
// RENDERER-ONLY: RTCPeerConnection is a Chromium API (not in Bun), so this file must never be imported by the
// no-DOM harness/root program - it is verified live in the preview, not with `bun test`.

import { open, seal } from "./crypto.ts";
import type { LucidCollabFrame } from "./frames.ts";
import type { SignalingChannel } from "./signaling.ts";

const DATA_CHANNEL_LABEL = "lucid-collab";
// A public STUN server only helps discover the public IP:port for NAT hole-punching; it never sees session
// content. Empty by default (LAN/VPN needs no STUN); the caller passes STUN/TURN for cross-NAT.
const DEFAULT_ICE_SERVERS: RTCIceServer[] = [];

export interface WebRtcTransportOpts {
  /** host = offerer (creates the DataChannel), guest = answerer (receives it). */
  role: "host" | "guest";
  /** The room key - frames are E2E-sealed with it over the DataChannel (defense-in-depth vs a MITM relay). */
  key: CryptoKey;
  /** Carries SDP + ICE to the other peer (the real impl routes this over the collab relay). */
  signaling: SignalingChannel;
  /** STUN/TURN for cross-NAT; omit for same-LAN/VPN (host candidates suffice). */
  iceServers?: RTCIceServer[];
  onLog?: (msg: string, detail?: unknown) => void;
}

export class WebRtcTransport {
  onOpen?: () => void;
  onFrame?: (frame: LucidCollabFrame, fromPeer: number) => void;
  onClose?: (reason: string, willReconnect: boolean) => void;

  readonly #opts: WebRtcTransportOpts;
  #pc: RTCPeerConnection | null = null;
  #dc: RTCDataChannel | null = null;
  #closed = false;
  #haveRemote = false;
  /** ICE candidates that arrived before the remote description was set (must be applied after). */
  #pendingIce: RTCIceCandidateInit[] = [];
  /** Sealed frames queued while the DataChannel is still connecting. */
  #pendingSends: Uint8Array[] = [];
  #sendChain: Promise<void> = Promise.resolve();
  #recvChain: Promise<void> = Promise.resolve();

  constructor(opts: WebRtcTransportOpts) {
    this.#opts = opts;
  }

  get isOpen(): boolean {
    return this.#dc?.readyState === "open";
  }

  connect(): void {
    if (this.#pc || this.#closed) return;
    const pc = new RTCPeerConnection({ iceServers: this.#opts.iceServers ?? DEFAULT_ICE_SERVERS });
    this.#pc = pc;

    pc.onicecandidate = (e) => {
      const c = e.candidate;
      if (c) this.#opts.signaling.send({ t: "ice", candidate: { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex, usernameFragment: c.usernameFragment } });
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === "failed" || s === "disconnected") this.#fail(`peer connection ${s}`);
    };

    if (this.#opts.role === "host") {
      const dc = pc.createDataChannel(DATA_CHANNEL_LABEL, { ordered: true });
      this.#wireChannel(dc);
      // Fixed roles → the host always makes the offer.
      void this.#makeOffer();
    } else {
      pc.ondatachannel = (e) => { if (e.channel.label === DATA_CHANNEL_LABEL) this.#wireChannel(e.channel); };
    }

    this.#opts.signaling.onMessage((msg) => void this.#onSignal(msg));
  }

  /** Seal + send a frame over the DataChannel (queued until it opens). `targetPeer` is ignored (P2P is 1:1). */
  send(frame: LucidCollabFrame, _targetPeer = 0): void {
    this.#sendChain = this.#sendChain
      .then(async () => {
        if (this.#closed) return;
        const sealed = await seal(this.#opts.key, frame);
        const dc = this.#dc;
        if (dc && dc.readyState === "open") dc.send(toArrayBuffer(sealed));
        else this.#pendingSends.push(sealed);
      })
      .catch((err) => this.#opts.onLog?.("webrtc: send failed", String(err)));
  }

  close(): void {
    if (this.#closed) { this.#teardown(); return; }
    try { this.#opts.signaling.send({ t: "bye" }); } catch { /* channel gone */ }
    this.#closed = true;
    this.#teardown();
    this.onClose?.("closed", false);
  }

  // ── internals ────────────────────────────────────────────────────────────

  async #makeOffer(): Promise<void> {
    const pc = this.#pc;
    if (!pc) return;
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.#opts.signaling.send({ t: "sdp", sdp: { type: offer.type, sdp: offer.sdp ?? "" } });
    } catch (err) { this.#fail(`offer failed: ${String(err)}`); }
  }

  async #onSignal(msg: { t: "sdp"; sdp: { type: string; sdp: string } } | { t: "ice"; candidate: RTCIceCandidateInit } | { t: "bye" }): Promise<void> {
    if (this.#closed) return;
    const pc = this.#pc;
    if (!pc) return;
    if (msg.t === "bye") { this.#fail("peer left"); return; }
    if (msg.t === "ice") {
      // Buffer candidates that beat the remote description; apply the rest immediately.
      if (!this.#haveRemote) this.#pendingIce.push(msg.candidate);
      else await pc.addIceCandidate(msg.candidate).catch((e) => this.#opts.onLog?.("webrtc: addIceCandidate", String(e)));
      return;
    }
    // sdp
    try {
      await pc.setRemoteDescription(msg.sdp as RTCSessionDescriptionInit);
      this.#haveRemote = true;
      for (const c of this.#pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => { /* stale candidate */ });
      if (msg.sdp.type === "offer") {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.#opts.signaling.send({ t: "sdp", sdp: { type: answer.type, sdp: answer.sdp ?? "" } });
      }
    } catch (err) { this.#fail(`sdp failed: ${String(err)}`); }
  }

  #wireChannel(dc: RTCDataChannel): void {
    this.#dc = dc;
    dc.binaryType = "arraybuffer";
    dc.onopen = () => {
      for (const s of this.#pendingSends.splice(0)) { try { dc.send(toArrayBuffer(s)); } catch { /* closing */ } }
      this.onOpen?.();
    };
    dc.onmessage = (ev) => this.#onData(ev.data);
    dc.onclose = () => this.#fail("data channel closed");
    dc.onerror = () => { /* the close event carries the actionable state */ };
  }

  #onData(data: unknown): void {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data instanceof Uint8Array ? data : null;
    if (!bytes) return;
    this.#recvChain = this.#recvChain
      .then(async () => {
        if (this.#closed) return;
        let frame: LucidCollabFrame;
        try { frame = await open(this.#opts.key, bytes); }
        catch { this.#fail("bad key or corrupted frame"); return; } // fail-closed on tamper / wrong key
        this.onFrame?.(frame, 0);
      })
      .catch((err) => this.#opts.onLog?.("webrtc: frame handler failed", String(err)));
  }

  /** Terminal failure - never reconnect here (a fresh connect() would re-signal). */
  #fail(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#teardown();
    this.onClose?.(reason, false);
  }

  #teardown(): void {
    this.#pendingSends.length = 0;
    this.#pendingIce.length = 0;
    try { this.#dc?.close(); } catch { /* already closed */ }
    try { this.#pc?.close(); } catch { /* already closed */ }
    try { this.#opts.signaling.close(); } catch { /* already closed */ }
    this.#dc = null;
    this.#pc = null;
  }
}

// A DataChannel `send` accepts a plain ArrayBuffer cleanly; TS 6's stricter typed-array generics make a bare
// `Uint8Array` (ArrayBufferLike-backed) not match the send overloads. Copy out the exact bytes (frames are
// tiny). Also handles a subarray view (nonzero byteOffset) correctly.
function toArrayBuffer(u: Uint8Array): ArrayBuffer {
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}
