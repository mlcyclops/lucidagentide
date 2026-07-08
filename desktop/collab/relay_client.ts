// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/relay_client.ts — P-COLLAB.2 (ADR-0192): the egress-gated WebSocket relay client.
//
// LUCID extends omp's collab transport, never forks it (invariant #1): this mirrors omp's CollabSocket wire
// contract exactly - connect to `wss://host/r/<roomId>?role=host|guest`, `binaryType=arraybuffer`, send a
// plaintext `[4B BE peerId][sealed]` envelope (peer 0 = broadcast from the host), receive a STRING message as
// a JSON relay-control frame (peer-joined / peer-left / room-closed) and a BINARY message as a sealed envelope.
// Fatal relay close codes (room gone / host conflict / room full) and any decryption failure NEVER reconnect
// (fail-closed, invariant #3); transient drops retry with jittered exponential backoff. The room key never
// leaves the client, so the relay only ever sees opaque bytes.
//
// Two deliberate deltas from omp's copy: (1) it seals with LUCID's own `crypto.ts` + `LucidCollabFrame`, and
// (2) the WebSocket constructor is INJECTABLE (`opts.wsFactory`) so the whole client is testable headless with
// a mock socket - the default factory is the global `WebSocket` (present in Bun, Electron main, and renderer).
// The connection itself is network egress: the caller (the host, P-COLLAB.2) resolves + authorizes the relay
// URL against LUCID's egress policy BEFORE constructing this - a bare public-relay URL is opt-in, not default.

import { open, seal, packEnvelope, unpackEnvelope } from "./crypto.ts";
import type { LucidCollabFrame } from "./frames.ts";
import type { RelayControlMessage } from "@oh-my-pi/pi-wire";

/** Relay close codes that are terminal - reconnecting would loop forever, so we surface + stop. */
const FATAL_CLOSE_REASONS: Record<number, string> = {
  4001: "room closed",
  4004: "no such room",
  4009: "a host is already connected for this room",
  4029: "room is full",
};

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
/** Max sealed envelopes buffered while a reconnect is pending; overflow is dropped (bounded memory). */
const MAX_PENDING_SENDS = 256;
const WS_OPEN = 1; // WebSocket.OPEN — hard-coded so the mock socket needn't mirror the class constant.

/** The minimal WebSocket surface the client drives - the global `WebSocket` satisfies it, and so does a mock. */
export interface WebSocketLike {
  binaryType: string;
  readyState: number;
  send(data: Uint8Array): void;
  close(code?: number): void;
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
}
export type WebSocketFactory = (url: string) => WebSocketLike;

export interface CollabSocketOptions {
  /** `wss://host[:port]/r/<roomId>` — no query, no fragment (the client appends `?role=`). */
  wsUrl: string;
  role: "host" | "guest";
  key: CryptoKey;
  /** Injected for tests / non-DOM hosts; defaults to the ambient global `WebSocket`. */
  wsFactory?: WebSocketFactory;
  /** Optional debug sink (kept dependency-free — no omp logger import). */
  onLog?: (msg: string, detail?: unknown) => void;
}

/**
 * A single relay-room connection. Seals every outbound frame, opens every inbound one, and reconnects on
 * transient drops. Callers wire the four callbacks, then call {@link connect}.
 */
export class CollabSocket {
  /** Fires after every successful (re)connect. */
  onOpen?: () => void;
  /** A decrypted peer frame arrived (with the relay-assigned sender peer id). */
  onFrame?: (frame: LucidCollabFrame, fromPeer: number) => void;
  /** A relay control message arrived (peer join/leave, room closed). */
  onControl?: (msg: RelayControlMessage) => void;
  /** Terminal or transient close. `willReconnect` is true only for a transient drop that will retry. */
  onClose?: (reason: string, willReconnect: boolean) => void;

  readonly #opts: CollabSocketOptions;
  readonly #mkSocket: WebSocketFactory;
  #ws: WebSocketLike | null = null;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #attempt = 0;
  /** Terminal state: intentional close() or a fatal failure. Cleared by connect(). */
  #closed = false;
  /** Serializes seal() so frames hit the wire in send() order. */
  #sendChain: Promise<void> = Promise.resolve();
  /** Serializes open() so frames are delivered in arrival order. */
  #recvChain: Promise<void> = Promise.resolve();
  /** Envelopes sealed while disconnected, flushed on the next open. */
  #pendingSends: Uint8Array[] = [];
  /** Jitter is injectable so tests are deterministic; defaults to a fixed midpoint (crypto RNG is not used
   *  here - the value only spreads reconnect storms, it is not a secret). */
  #jitter: () => number;

  constructor(opts: CollabSocketOptions & { jitter?: () => number }) {
    this.#opts = opts;
    this.#mkSocket = opts.wsFactory ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike);
    this.#jitter = opts.jitter ?? (() => 1); // midpoint of the 0.75..1.25 spread
  }

  get isOpen(): boolean {
    return this.#ws?.readyState === WS_OPEN;
  }

  connect(): void {
    if (this.#ws || this.#retryTimer) return;
    this.#closed = false;
    this.#attempt = 0;
    this.#openSocket();
  }

  /** Seal + enqueue a frame. `targetPeer` 0 broadcasts (host→all); a peer id unicasts (host→that guest). */
  send(frame: LucidCollabFrame, targetPeer = 0): void {
    this.#sendChain = this.#sendChain
      .then(async () => {
        if (this.#closed) return;
        const sealed = await seal(this.#opts.key, frame);
        const envelope = packEnvelope(targetPeer, sealed);
        const ws = this.#ws;
        if (ws && ws.readyState === WS_OPEN) {
          ws.send(envelope);
          return;
        }
        if (this.#pendingSends.length >= MAX_PENDING_SENDS) {
          this.#opts.onLog?.("collab: dropping frame, reconnect buffer full", { t: frame.t });
          return;
        }
        this.#pendingSends.push(envelope);
      })
      .catch((err: unknown) => this.#opts.onLog?.("collab: send failed", String(err)));
  }

  /** Intentional close: clears retries, suppresses reconnect, but FLUSHES any already-queued frame first (a
   *  final `bye` enqueued right before close must still reach the wire). A later connect() starts fresh. */
  close(): void {
    const hadActivity = this.#ws !== null || this.#retryTimer !== undefined;
    this.#clearRetry();
    const wasClosed = this.#closed;
    // Tear down AFTER the pending send chain drains, so a frame sent immediately before close() is not lost.
    this.#sendChain = this.#sendChain.then(() => {
      this.#closed = true;
      this.#pendingSends.length = 0;
      const ws = this.#ws;
      this.#ws = null;
      if (ws) {
        try { ws.close(1000); } catch { /* already closing */ }
      }
    });
    if (hadActivity && !wasClosed) this.onClose?.("closed", false);
  }

  #openSocket(): void {
    const ws = this.#mkSocket(`${this.#opts.wsUrl}?role=${this.#opts.role}`);
    ws.binaryType = "arraybuffer";
    this.#ws = ws;
    ws.onopen = () => {
      if (this.#ws !== ws) return;
      this.#attempt = 0;
      for (const envelope of this.#pendingSends) ws.send(envelope);
      this.#pendingSends.length = 0;
      this.onOpen?.();
    };
    ws.onmessage = (event) => {
      if (this.#ws !== ws) return;
      this.#handleMessage(ws, event.data);
    };
    ws.onerror = () => { /* the paired close carries the actionable state */ };
    ws.onclose = (event) => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      this.#handleClose(event.code, event.reason);
    };
  }

  #handleMessage(ws: WebSocketLike, data: unknown): void {
    // STRING → a JSON relay-control frame (never sealed; the relay authors these).
    if (typeof data === "string") {
      try {
        this.onControl?.(JSON.parse(data) as RelayControlMessage);
      } catch {
        this.#opts.onLog?.("collab: ignoring malformed control message");
      }
      return;
    }
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data instanceof Uint8Array ? data : null;
    if (!bytes) return;
    let peerId: number;
    let sealed: Uint8Array;
    try {
      ({ peerId, sealed } = unpackEnvelope(bytes));
    } catch {
      return; // runt envelope; ignore
    }
    this.#recvChain = this.#recvChain
      .then(async () => {
        if (this.#ws !== ws) return;
        let frame: LucidCollabFrame;
        try {
          frame = await open(this.#opts.key, sealed);
        } catch {
          this.#failFatal("bad key or corrupted frame"); // wrong key / tamper → never reconnect
          return;
        }
        if (this.#ws !== ws) return;
        this.onFrame?.(frame, peerId);
      })
      .catch((err: unknown) => this.#opts.onLog?.("collab: frame handler failed", String(err)));
  }

  #handleClose(code: number, reason: string): void {
    if (this.#closed) return;
    const fatalReason = FATAL_CLOSE_REASONS[code];
    if (fatalReason !== undefined) {
      this.#closed = true;
      this.#pendingSends.length = 0;
      this.onClose?.(fatalReason, false);
      return;
    }
    this.onClose?.(reason || `connection lost (code ${code})`, true);
    this.#scheduleRetry();
  }

  /** Decryption failure: wrong key or a corrupted frame. Terminal - never reconnect (fail-closed). */
  #failFatal(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearRetry();
    this.#pendingSends.length = 0;
    const ws = this.#ws;
    this.#ws = null;
    if (ws) {
      try { ws.close(1000); } catch { /* already closing */ }
    }
    this.onClose?.(reason, false);
  }

  #scheduleRetry(): void {
    const base = Math.min(BACKOFF_BASE_MS * 2 ** this.#attempt, BACKOFF_MAX_MS);
    this.#attempt++;
    const delay = base * (0.75 + this.#jitter() * 0.5);
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      if (this.#closed) return;
      this.#openSocket();
    }, delay);
  }

  #clearRetry(): void {
    if (this.#retryTimer !== undefined) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = undefined;
    }
  }
}
