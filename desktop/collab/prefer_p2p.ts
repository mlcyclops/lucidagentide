// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/prefer_p2p.ts — P-COLLAB.16 (ADR-0201): WebRTC-preferred transport with a relay fallback.
//
// A drop-in transport (the same interface CollabHost/CollabGuest drive) that carries the session over a direct
// WebRTC DataChannel WHEN it is up, and over the relay otherwise. The design avoids any "try P2P, time out,
// fall back" fragility: it STARTS on the relay (available immediately, so the session works at once) and
// TRANSPARENTLY UPGRADES to the DataChannel the moment it opens - and DOWNGRADES back to the relay if the
// DataChannel drops. Each frame is sent exactly once over the then-current path, so there are no duplicates.
//
// Transport-agnostic (the P2P side + the relay send are injected), so it is fully unit-testable without a real
// RTCPeerConnection or relay. The renderer coordinator (webrtc_coordinator/session) wires the real
// WebRtcTransport + the relay CollabSocket into it.

import type { LucidCollabFrame } from "./frames.ts";

/** The slice of a P2P transport (e.g. WebRtcTransport) this wrapper drives. */
export interface P2PInner {
  onOpen?: () => void;
  onFrame?: (frame: LucidCollabFrame, fromPeer: number) => void;
  onClose?: (reason: string, willReconnect: boolean) => void;
  connect(): void;
  send(frame: LucidCollabFrame, targetPeer?: number): void;
  close(): void;
}

export interface PreferP2POpts {
  /** The direct-P2P transport (WebRtcTransport in production; a mock in tests). */
  p2p: P2PInner;
  /** The peer this transport talks to (a guest's relay peer id on the host; `0` = the host on the guest). */
  targetPeer: number;
  /** Send a frame over the RELAY, addressed to `targetPeer`. */
  relaySend: (frame: LucidCollabFrame, targetPeer: number) => void;
  /** Observability: fires when the active path changes. */
  onMode?: (mode: "relay" | "p2p") => void;
}

export class PreferP2PTransport {
  onOpen?: () => void;
  onFrame?: (frame: LucidCollabFrame, fromPeer: number) => void;
  onControl?: (msg: unknown) => void; // unused (relay control is handled by the coordinator)
  onClose?: (reason: string, willReconnect: boolean) => void;

  readonly #opts: PreferP2POpts;
  #mode: "relay" | "p2p" = "relay";
  #closed = false;

  constructor(opts: PreferP2POpts) { this.#opts = opts; }

  /** The active path right now. */
  get mode(): "relay" | "p2p" { return this.#mode; }

  connect(): void {
    if (this.#closed) return;
    const p = this.#opts.p2p;
    // Upgrade to P2P when the DataChannel opens; drop back to the relay if it later closes.
    p.onOpen = () => { if (this.#closed || this.#mode === "p2p") return; this.#mode = "p2p"; this.#opts.onMode?.("p2p"); };
    p.onFrame = (frame) => { if (!this.#closed) this.onFrame?.(frame, this.#opts.targetPeer); };
    p.onClose = () => { if (this.#closed || this.#mode !== "p2p") return; this.#mode = "relay"; this.#opts.onMode?.("relay"); };
    p.connect(); // start WebRTC negotiation in the background
    // The relay is available immediately, so we are "open" right away - the session never waits on WebRTC.
    queueMicrotask(() => { if (!this.#closed) this.onOpen?.(); });
  }

  send(frame: LucidCollabFrame, _targetPeer = 0): void {
    if (this.#closed) return;
    if (this.#mode === "p2p") this.#opts.p2p.send(frame, this.#opts.targetPeer);
    else this.#opts.relaySend(frame, this.#opts.targetPeer);
  }

  /** The coordinator calls this when a SESSION frame for this peer arrived over the RELAY socket. */
  relayDeliver(frame: LucidCollabFrame, fromPeer: number): void {
    if (!this.#closed) this.onFrame?.(frame, fromPeer);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try { this.#opts.p2p.close(); } catch { /* already gone */ }
    this.onClose?.("closed", false);
  }
}
