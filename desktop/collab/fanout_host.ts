// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/fanout_host.ts — P-COLLAB.16 (ADR-0201): the per-guest WebRTC fan-out under one CollabHost.
//
// WebRTC is 1:1 (a DataChannel connects exactly two peers), but a share has ONE `CollabHost` broadcasting to
// MANY guests. This is the adapter that squares them: it implements the `HostTransport` interface `CollabHost`
// already drives (so CollabHost is UNCHANGED), and underneath it keeps one pipe PER GUEST - a `PreferP2PTransport`
// that carries that guest over its own DataChannel, falling back to the relay. A broadcast (`targetPeer === 0`)
// fans out to every guest's pipe; a unicast (welcome/error to a peer) goes to just that guest's pipe.
//
// The per-guest pipe is built by an injected `makeGuest` factory (the coordinator supplies the real
// WebRtcTransport + RelaySignaling + PreferP2PTransport; tests supply mocks), so this class is DOM-free and
// unit-testable without an RTCPeerConnection. The coordinator feeds it relay inbound via onRelay*().

import type { LucidCollabFrame } from "./frames.ts";
import type { SignalMessage } from "./signaling.ts";
import type { RelayControlMessage } from "@oh-my-pi/pi-wire";
import type { HostTransport } from "./host.ts";

/** One guest's pipe: a transport CollabHost's frames go out on + hooks for the coordinator to feed relay in. */
export interface GuestLink {
  /** The per-guest transport (a PreferP2PTransport in production; a mock in tests). */
  transport: {
    onOpen?: () => void;
    onFrame?: (frame: LucidCollabFrame, fromPeer: number) => void;
    onClose?: (reason: string, willReconnect: boolean) => void;
    connect(): void;
    send(frame: LucidCollabFrame, targetPeer?: number): void;
    close(): void;
  };
  /** Route a SESSION frame that arrived over the relay (the fallback inbound path) into this guest's pipe. */
  deliverRelay(frame: LucidCollabFrame, fromPeer: number): void;
  /** Route a WebRTC SIGNAL that arrived over the relay into this guest's signaling. */
  deliverSignal(msg: SignalMessage): void;
}

export interface FanoutHostOpts {
  /** Build the pipe for a newly-seen guest peer (WebRtcTransport + RelaySignaling + PreferP2PTransport). */
  makeGuest: (peer: number) => GuestLink;
}

/**
 * A `HostTransport` that fans one CollabHost out to N per-guest P2P/relay pipes. Guests are created lazily the
 * first time we see them (a relay `peer-joined`, a signal, or a fallback session frame), and torn down on
 * `peer-left`. `peer-left` is still forwarded to CollabHost so it updates the roster + broadcasts state.
 */
export class FanoutHostTransport implements HostTransport {
  onOpen?: () => void;
  onFrame?: (frame: LucidCollabFrame, fromPeer: number) => void;
  onControl?: (msg: RelayControlMessage) => void;
  onClose?: (reason: string, willReconnect: boolean) => void;

  readonly #opts: FanoutHostOpts;
  readonly #guests = new Map<number, GuestLink>();
  #closed = false;

  constructor(opts: FanoutHostOpts) { this.#opts = opts; }

  get guestCount(): number { return this.#guests.size; }

  connect(): void { /* guests are created lazily; the relay socket is connected by the coordinator */ }

  send(frame: LucidCollabFrame, targetPeer = 0): void {
    if (this.#closed) return;
    if (targetPeer === 0) { for (const g of this.#guests.values()) g.transport.send(frame); return; }
    this.#ensure(targetPeer).transport.send(frame);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const g of this.#guests.values()) { try { g.transport.close(); } catch { /* gone */ } }
    this.#guests.clear();
    this.onClose?.("closed", false);
  }

  // ── the coordinator feeds relay inbound through these ──────────────────────

  /** A relay control frame (peer join/leave). Join preps the pipe; leave tears it down + tells CollabHost. */
  onRelayControl(msg: RelayControlMessage): void {
    if (this.#closed) return;
    if (msg.t === "peer-joined") { this.#ensure(msg.peer); return; }
    if (msg.t === "peer-left") {
      const g = this.#guests.get(msg.peer);
      if (g) { try { g.transport.close(); } catch { /* gone */ } this.#guests.delete(msg.peer); }
      this.onControl?.(msg); // CollabHost drops the participant + broadcasts state
    }
  }

  /** A SESSION frame (hello/prompt/abort) that came over the relay - the fallback inbound path for this guest. */
  onRelaySession(frame: LucidCollabFrame, fromPeer: number): void {
    if (this.#closed || fromPeer === 0) return;
    this.#ensure(fromPeer).deliverRelay(frame, fromPeer);
  }

  /** A WebRTC signal that came over the relay from a guest - route it to that guest's signaling. */
  onRelaySignal(msg: SignalMessage, fromPeer: number): void {
    if (this.#closed || fromPeer === 0) return;
    this.#ensure(fromPeer).deliverSignal(msg);
  }

  #ensure(peer: number): GuestLink {
    let g = this.#guests.get(peer);
    if (g) return g;
    g = this.#opts.makeGuest(peer);
    // Guest frames coming off this pipe (P2P or relay) reach CollabHost tagged with THIS guest's peer id.
    g.transport.onFrame = (frame, from) => { if (!this.#closed) this.onFrame?.(frame, from || peer); };
    this.#guests.set(peer, g);
    g.transport.connect(); // host is the offerer → this kicks off WebRTC negotiation for this guest
    return g;
  }
}
