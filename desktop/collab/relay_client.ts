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
//
// P-REMOTE.16 (ADR-0431): the socket stays alive until the caller closes it. Three mechanisms, all transport
// level so the host/guest protocol above only ever sees `onOpen` (and re-hellos there):
//   - LIVENESS: the relay answers the `{"t":"ping"}` keepalive with `{"t":"pong"}` (consumed here, never
//     surfaced). Once a pong has been seen, two missed round-trips (+ grace) mean the socket is half-open (a
//     phone NAT or a cloud drop that never delivers a close) and it is replaced.
//   - PLANNED ROTATION: before the hosted relay's 60-min WebSocket cap the socket is replaced on purpose
//     (`maxConnectionMs`, jittered), so the cap never lands on a live socket.
//   - RESUME: the PWA/desktop calls `resume(hiddenMs)` on visibility/online/pageshow; a long absence rotates
//     at once, a short one probes with a ping and rotates only if nothing comes back.
// A replacement is MAKE-BEFORE-BREAK wherever the relay admits a second socket (a guest is a fresh peer; a
// gated host replaces its own socket at the relay): the new one dials + authenticates while the old keeps
// delivering, outbound frames buffer meanwhile and flush BEHIND the caller's re-hello, and a replacement that
// never becomes ready is dropped with the old socket kept. An anonymous host (the relay would refuse a
// duplicate) breaks first and takes the ordinary retry path.

import { open, seal, packEnvelope, unpackEnvelope } from "./crypto.ts";
import type { LucidCollabFrame } from "./frames.ts";
import type { RelayControlMessage } from "@oh-my-pi/pi-wire";

// P-REMOTE.6 (ADR-0227): the 4403 close-reason, exported so the PWA's unentitled→Subscribe detector
// (remote_entitlement.ts) matches the EXACT wire string the socket surfaces — single-sourced, never drifts.
export const RELAY_NOT_ENTITLED_REASON = "signed in but not entitled to remote access";

/** Relay close codes that are terminal - reconnecting would loop forever, so we surface + stop. */
const FATAL_CLOSE_REASONS: Record<number, string> = {
  4001: "room closed",
  4004: "no such room",
  4009: "a host is already connected for this room",
  4029: "room is full",
  // P-REMOTE.1/.2 (ADR-0226/0227) — identity-gate refusals. All terminal: the token we JUST presented was
  // refused, so retrying with another token from the same provider would loop; the caller surfaces sign-in.
  4401: "relay refused authentication (sign in again)",
  4403: RELAY_NOT_ENTITLED_REASON,
  4429: "relay per-user quota exceeded",
};

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
/** Client keepalive cadence — comfortably under the relay's 120s idle ceiling AND Cloud Run's idle
 *  accounting. The frame is a STRING; a P-REMOTE.16 relay answers it with a pong, an older one ignores it, so
 *  it works against gated and anonymous relays alike. */
const KEEPALIVE_MS = 45_000;
const KEEPALIVE_FRAME = JSON.stringify({ t: "ping" });
/** P-REMOTE.16 (ADR-0431): the relay's answer to the keepalive. Consumed here, never surfaced as control. */
const KEEPALIVE_PONG_T = "pong";
/** Liveness slack on top of two missed keepalive round-trips before a silent socket counts as half-open. */
const LIVENESS_GRACE_MS = 5_000;
/** Planned rotation cadence: under the hosted relay's 60-min cap, jittered so phones do not rotate in lockstep. */
const MAX_CONNECTION_MS = 55 * 60_000;
const MAX_CONNECTION_JITTER_MS = 2 * 60_000;
/** A replacement that is not ready (open, or `auth-ok` when gated) within this long is abandoned. */
const ROTATE_TIMEOUT_MS = 15_000;
/** resume(): a probe ping with no inbound inside this window means the socket is half-open. */
const PROBE_MS = 4_000;
/** resume(): hidden at least this long = assume the OS/NAT dropped the socket and rotate without probing. */
const SUSPEND_ROTATE_MS = 30_000;
/** Max sealed envelopes buffered while a reconnect is pending; overflow is dropped (bounded memory). */
const MAX_PENDING_SENDS = 256;
const WS_OPEN = 1; // WebSocket.OPEN — hard-coded so the mock socket needn't mirror the class constant.

/** The minimal WebSocket surface the client drives - the global `WebSocket` satisfies it, and so does a mock. */
export interface WebSocketLike {
  binaryType: string;
  readyState: number;
  send(data: Uint8Array | string): void;
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
  /** P-REMOTE.2 (ADR-0226/0227): token provider for an identity-gated relay (RELAY_AUTH=firebase). Called
   *  on EVERY (re)connect — so the hourly Cloud-Run reconnect always presents a FRESH Firebase ID token —
   *  and the socket sends `{"t":"auth","token"}` as its FIRST frame, holding all traffic until the relay
   *  answers `auth-ok`. Returning null is TERMINAL ("sign in"), never an unauthenticated retry loop. */
  authToken?: () => Promise<string | null> | string | null;
  /** Keepalive cadence in ms; 0 disables. Default 45s (under the relay's 120s idle ceiling). */
  keepaliveMs?: number;
  /** P-REMOTE.16 (ADR-0431): replace the socket on purpose after this long (jittered +-2 min), ahead of the
   *  hosted relay's 60-min cap. 0 disables. Default 55 min. Only armed where the swap can be
   *  make-before-break (a guest, or a gated host); an anonymous host has no cap to dodge. */
  maxConnectionMs?: number;
  /** Optional debug sink (kept dependency-free — no omp logger import). */
  onLog?: (msg: string, detail?: unknown) => void;
}

/** Test knobs, accepted alongside the public options (never read from config). */
export interface CollabSocketKnobs {
  /** Spreads retry backoff and the rotation moment; nominally 0..1 (the rotation clamps it there), defaults
   *  to a fixed value for determinism. Tests push it below 0 to make a retry immediate. */
  jitter?: () => number;
  /** Monotonic-enough clock for liveness bookkeeping; defaults to Date.now. */
  now?: () => number;
  rotateTimeoutMs?: number;
  probeMs?: number;
}

/** A make-before-break replacement that is dialing (or authenticating) and is not yet `#ws`. */
interface Rotation {
  ws: WebSocketLike;
  timer: ReturnType<typeof setTimeout>;
  reason: string;
}

/** Unhook a socket we are done with, so a late close/message from it can never reach the state machine. */
function detach(ws: WebSocketLike): void {
  ws.onopen = null;
  ws.onmessage = null;
  ws.onerror = null;
  ws.onclose = null;
}

function isAuthOk(data: string): boolean {
  try {
    const msg: unknown = JSON.parse(data);
    return typeof msg === "object" && msg !== null && "t" in msg && msg.t === "auth-ok";
  } catch {
    return false;
  }
}

/**
 * A single relay-room connection. Seals every outbound frame, opens every inbound one, and reconnects on
 * transient drops. Callers wire the four callbacks, then call {@link connect}.
 */
export class CollabSocket {
  /** Fires after every successful (re)connect, INCLUDING a make-before-break rotation: callers re-hello here. */
  onOpen?: () => void;
  /** A decrypted peer frame arrived (with the relay-assigned sender peer id). */
  onFrame?: (frame: LucidCollabFrame, fromPeer: number) => void;
  /** A relay control message arrived (peer join/leave, room closed). The keepalive pong is never surfaced. */
  onControl?: (msg: RelayControlMessage) => void;
  /** Terminal or transient close. `willReconnect` is true only for a transient drop that will retry. A
   *  rotation that succeeds never fires this - the caller only sees the next onOpen. */
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
  /** Envelopes sealed while not ready (disconnected, authenticating, or mid-rotation), flushed on the next open. */
  #pendingSends: Uint8Array[] = [];
  /** Jitter is injectable so tests are deterministic; defaults to a fixed midpoint (crypto RNG is not used
   *  here - the value only spreads reconnect storms, it is not a secret). */
  readonly #jitter: () => number;
  readonly #now: () => number;
  readonly #rotateTimeoutMs: number;
  readonly #probeMs: number;
  /** True only between becomeOpen() and the next close/reconnect/rotation start. In gated mode this is NOT
   *  set until `auth-ok`, so a frame whose async seal() resolves after the socket opens but before auth still
   *  buffers (never leaks unauthenticated bytes onto the wire). */
  #ready = false;
  #keepalive: ReturnType<typeof setInterval> | undefined; // portable across Bun (Timer) and the browser (number)
  // --- P-REMOTE.16 (ADR-0431): liveness + rotation state ---
  /** Clock reading of the last inbound message (string or binary) on the live socket. */
  #lastInbound = 0;
  /** Sticky: this instance has seen a pong, so silence is evidence (an older relay never answers). */
  #pongCapable = false;
  #rotation: Rotation | null = null;
  /** A rotation that failed with the old socket kept; the next keepalive tick tries again. */
  #rotateRetry: string | null = null;
  #rotationTimer: ReturnType<typeof setTimeout> | undefined;
  #probeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(opts: CollabSocketOptions & CollabSocketKnobs) {
    this.#opts = opts;
    this.#mkSocket = opts.wsFactory ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike);
    this.#jitter = opts.jitter ?? (() => 1); // midpoint of the 0.75..1.25 spread
    this.#now = opts.now ?? Date.now;
    this.#rotateTimeoutMs = opts.rotateTimeoutMs ?? ROTATE_TIMEOUT_MS;
    this.#probeMs = opts.probeMs ?? PROBE_MS;
  }

  get isOpen(): boolean {
    return this.#ws?.readyState === WS_OPEN;
  }

  /** True once a FATAL close (bad key / terminal relay code) or an explicit close() has stopped the client for
   *  good — a resume nudge is then a no-op and the caller must build a fresh socket to reconnect. */
  get isClosed(): boolean {
    return this.#closed;
  }

  /** Force an immediate reconnect (e.g. the phone tab resumed from an OS suspend that silently dropped the
   *  socket). No-op if closed, already open, already connecting, or mid-rotation; otherwise it cancels the
   *  backoff wait and reopens NOW, so resume is snappy instead of waiting out the exponential delay. */
  reconnectNow(): void {
    if (this.#closed || this.#ws || this.#rotation) return;
    this.#clearRetry();
    this.#attempt = 0;
    this.#openSocket();
  }

  /** P-REMOTE.16 (ADR-0431): the tab/app came back (visibilitychange → visible, `online`, `pageshow`).
   *  `hiddenMs` is how long it was away (0 = unknown/none). Disconnected → reconnect now. Away long enough
   *  for the OS/NAT to have dropped the socket → rotate at once. Otherwise probe: one ping, and rotate only
   *  if nothing comes back in time (a relay that never answered a ping is never probed into a rotation). */
  resume(hiddenMs = 0): void {
    if (this.#closed || this.#rotation) return;
    if (!this.#ws) { this.reconnectNow(); return; }
    if (!this.#ready) return; // a connect/auth handshake is in flight; its own deadline or close decides
    if (hiddenMs >= SUSPEND_ROTATE_MS) { this.#rotate("resumed after suspend"); return; }
    this.#probe();
  }

  connect(): void {
    if (this.#ws || this.#retryTimer || this.#rotation) return;
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
        if (ws && ws.readyState === WS_OPEN && this.#ready) {
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
    const hadActivity = this.#ws !== null || this.#retryTimer !== undefined || this.#rotation !== null;
    this.#clearRetry();
    const wasClosed = this.#closed;
    // Tear down AFTER the pending send chain drains, so a frame sent immediately before close() is not lost.
    this.#sendChain = this.#sendChain.then(() => {
      this.#closed = true;
      this.#stopTimers();
      this.#abortRotation();
      this.#pendingSends.length = 0;
      const ws = this.#ws;
      this.#ws = null;
      this.#ready = false;
      if (ws) {
        try { ws.close(1000); } catch { /* already closing */ }
      }
    });
    if (hadActivity && !wasClosed) this.onClose?.("closed", false);
  }

  /** First connect / backoff retry: the dialed socket IS the live one from the start (as before). */
  #openSocket(): void {
    this.#ws = this.#dial();
  }

  /** Create + wire one socket. It belongs to nobody yet: the caller makes it `#ws` (connect / retry) or
   *  `#rotation.ws` (a make-before-break replacement), and every handler dispatches on which it is. The
   *  gated handshake lives here so both paths share it: token fetched FRESH, sent as the first frame, and
   *  the socket counts as ready only on `auth-ok` (anonymous: on open). */
  #dial(): WebSocketLike {
    const ws = this.#mkSocket(`${this.#opts.wsUrl}?role=${this.#opts.role}`);
    ws.binaryType = "arraybuffer";
    let awaitingAuth = false;
    let ready = false;
    const settle = (): void => { ready = true; this.#onDialReady(ws); };
    ws.onopen = () => {
      if (!this.#tracks(ws)) return;
      if (!this.#opts.authToken) { settle(); return; }
      void this.#fetchToken().then((token) => {
        if (!this.#tracks(ws)) return; // superseded while fetching
        if (!token) { this.#onNoToken(ws); return; }
        awaitingAuth = true;
        try { ws.send(JSON.stringify({ t: "auth", token })); } catch { /* the paired close handles it */ }
      });
    };
    ws.onmessage = (event) => {
      if (!this.#tracks(ws)) return;
      if (ready) { this.#handleMessage(event.data); return; }
      // Gated handshake completion is consumed HERE - the caller sees a normal open, same as anonymous.
      // Nothing else can arrive before admission (the relay refuses any other first exchange with 4401).
      if (awaitingAuth && typeof event.data === "string" && isAuthOk(event.data)) {
        awaitingAuth = false;
        settle();
      }
    };
    ws.onerror = () => { /* the paired close carries the actionable state */ };
    ws.onclose = (event) => this.#onDialClose(ws, event.code, event.reason);
    return ws;
  }

  /** Is this socket still one we care about (live, or the replacement being dialed)? */
  #tracks(ws: WebSocketLike): boolean {
    return this.#ws === ws || this.#rotation?.ws === ws;
  }

  async #fetchToken(): Promise<string | null> {
    try {
      return await this.#opts.authToken!();
    } catch (err) {
      this.#opts.onLog?.("collab: token provider failed", String(err));
      return null;
    }
  }

  #onDialReady(ws: WebSocketLike): void {
    if (this.#ws === ws) { this.#becomeOpen(ws); return; }
    if (this.#rotation?.ws === ws) this.#finishRotation(ws);
  }

  #onNoToken(ws: WebSocketLike): void {
    if (this.#rotation?.ws === ws) { this.#failRotation("no token"); return; }
    if (this.#ws === ws) this.#failFatal("the relay requires sign-in but no token is available");
  }

  #onDialClose(ws: WebSocketLike, code: number, reason: string): void {
    if (this.#rotation?.ws === ws) { this.#failRotation(`closed before ready (code ${code})`); return; }
    if (this.#ws !== ws) return; // detached or superseded
    this.#stopTimers();
    this.#ready = false;
    this.#ws = null;
    if (this.#rotation) {
      // The live socket went while its replacement is still dialing. A gated host sees exactly this: the
      // relay answers its own re-claim with a 4009 on the OLD socket, which is expected, not fatal. The
      // rotation's outcome decides: adopt the replacement, or fall back to the ordinary retry path.
      this.#opts.onLog?.("collab: live socket closed mid-rotation, waiting for the replacement", { code });
      return;
    }
    this.#handleClose(code, reason);
  }

  /** The socket is usable: arm keepalive + rotation, tell the caller, then flush the buffer behind it. */
  #becomeOpen(ws: WebSocketLike): void {
    this.#attempt = 0;
    this.#ready = true;
    this.#rotateRetry = null;
    this.#lastInbound = this.#now();
    this.#startKeepalive(ws);
    this.#armRotation(ws);
    this.onOpen?.();
    this.#flushPending(ws);
  }

  /** Frames buffered across a gap go out BEHIND whatever the caller enqueued from onOpen (the guest's
   *  re-hello), so a host that insists on hello-first never refuses them as coming from an unknown peer. */
  #flushPending(ws: WebSocketLike): void {
    if (this.#pendingSends.length === 0) return;
    const batch = this.#pendingSends;
    this.#pendingSends = [];
    this.#sendChain = this.#sendChain
      .then(() => {
        if (this.#closed) return;
        if (this.#ws !== ws || !this.#ready || ws.readyState !== WS_OPEN) {
          this.#pendingSends.unshift(...batch); // the socket went again first; keep them for the next open
          return;
        }
        for (const envelope of batch) ws.send(envelope);
      })
      .catch((err: unknown) => this.#opts.onLog?.("collab: flush failed", String(err)));
  }

  #startKeepalive(ws: WebSocketLike): void {
    this.#stopKeepalive();
    const ms = this.#opts.keepaliveMs ?? KEEPALIVE_MS;
    if (ms <= 0) return;
    this.#keepalive = setInterval(() => {
      if (this.#ws !== ws || ws.readyState !== WS_OPEN) return;
      try { ws.send(KEEPALIVE_FRAME); } catch { /* the paired close handles it */ }
      if (this.#rotation) return;
      if (this.#rotateRetry) {
        const reason = this.#rotateRetry;
        this.#rotateRetry = null;
        this.#rotate(reason);
        return;
      }
      // Liveness: only once this relay has proven it answers pings; a silent relay is never mistaken for a
      // dead socket. Two missed round-trips plus grace, measured on inbound of ANY kind.
      if (this.#pongCapable && this.#now() - this.#lastInbound > 2 * ms + LIVENESS_GRACE_MS) {
        this.#rotate("keepalive timeout");
      }
    }, ms);
  }

  #stopKeepalive(): void {
    clearInterval(this.#keepalive);
    this.#keepalive = undefined;
  }

  /** Any inbound message on the live socket is proof of life: it feeds liveness and settles a probe. */
  #noteInbound(): void {
    this.#lastInbound = this.#now();
    this.#clearProbe();
  }

  #armRotation(ws: WebSocketLike): void {
    this.#clearRotationTimer();
    const max = this.#opts.maxConnectionMs ?? MAX_CONNECTION_MS;
    if (max <= 0 || !this.#canMakeBeforeBreak()) return;
    const spread = Math.min(MAX_CONNECTION_JITTER_MS, Math.floor(max / 2));
    const j = Math.min(1, Math.max(0, this.#jitter()));
    const delay = Math.max(1, max + Math.round((j - 0.5) * 2 * spread));
    this.#rotationTimer = setTimeout(() => {
      this.#rotationTimer = undefined;
      if (this.#ws === ws && this.#ready) this.#rotate("planned reconnect before relay cap");
    }, delay);
  }

  #clearRotationTimer(): void {
    if (this.#rotationTimer !== undefined) {
      clearTimeout(this.#rotationTimer);
      this.#rotationTimer = undefined;
    }
  }

  #clearProbe(): void {
    if (this.#probeTimer !== undefined) {
      clearTimeout(this.#probeTimer);
      this.#probeTimer = undefined;
    }
  }

  /** Everything tied to the live socket's lifetime (not the retry timer, not an in-flight rotation). */
  #stopTimers(): void {
    this.#stopKeepalive();
    this.#clearRotationTimer();
    this.#clearProbe();
  }

  /** A guest is a fresh peer either way, and a gated host REPLACES its own live socket at the relay (same
   *  uid). An anonymous host would be refused as a duplicate (4009), so it has to break before it makes. */
  #canMakeBeforeBreak(): boolean {
    return this.#opts.role === "guest" || this.#opts.authToken !== undefined;
  }

  /** resume(): a cheap liveness check for a socket that may have died silently while the tab was hidden. */
  #probe(): void {
    const ws = this.#ws;
    if (!ws || this.#probeTimer !== undefined) return;
    try {
      ws.send(KEEPALIVE_FRAME);
    } catch {
      this.#rotate("probe send failed");
      return;
    }
    if (!this.#pongCapable) return; // an unanswering relay: the keepalive/close paths still apply as before
    this.#probeTimer = setTimeout(() => {
      this.#probeTimer = undefined;
      if (this.#ws === ws && this.#ready) this.#rotate("probe timeout");
    }, this.#probeMs);
  }

  /** Replace the live socket (see the header). Outbound frames buffer for the duration either way. */
  #rotate(reason: string): void {
    if (this.#closed || this.#rotation || !this.#ws || !this.#ready) return;
    this.#clearProbe();
    this.#opts.onLog?.(`collab: rotating socket (${reason})`);
    if (!this.#canMakeBeforeBreak()) {
      // Break-before-make: drop the socket ourselves and take the ordinary retry path, without waiting on
      // a close event a dead socket may never deliver.
      const old = this.#ws;
      this.#stopTimers();
      this.#ready = false;
      this.#ws = null;
      detach(old);
      try { old.close(1000); } catch { /* already closing */ }
      this.#handleClose(1000, reason);
      return;
    }
    this.#ready = false; // buffer sends until the replacement (or, on failure, the survivor) is confirmed
    const ws = this.#dial();
    this.#rotation = {
      ws,
      reason,
      timer: setTimeout(() => this.#failRotation("timed out"), this.#rotateTimeoutMs),
    };
  }

  /** The replacement is ready: retire the old socket (if it is still around), swap, and go through the
   *  normal open path so the caller re-hellos and the buffer flushes behind that. */
  #finishRotation(next: WebSocketLike): void {
    const rotation = this.#rotation!;
    clearTimeout(rotation.timer);
    this.#rotation = null;
    if (this.#closed) {
      detach(next);
      try { next.close(1000); } catch { /* already closing */ }
      return;
    }
    const old = this.#ws;
    if (old) {
      detach(old);
      try { old.close(1000); } catch { /* already closing */ }
    }
    this.#stopTimers();
    this.#ws = next;
    this.#opts.onLog?.(`collab: socket rotated (${rotation.reason})`);
    this.#becomeOpen(next);
  }

  /** The replacement never became ready: drop it. With the old socket still live, keep using it and try
   *  again on the next keepalive tick; with the old one gone meanwhile, fall back to the retry path. */
  #failRotation(why: string): void {
    const rotation = this.#rotation;
    if (!rotation) return;
    clearTimeout(rotation.timer);
    this.#rotation = null;
    detach(rotation.ws);
    try { rotation.ws.close(1000); } catch { /* already closing */ }
    if (this.#closed) return;
    const survivor = this.#ws;
    if (survivor) {
      this.#opts.onLog?.(`collab: rotation failed, keeping the current socket (${why})`);
      this.#rotateRetry = rotation.reason;
      this.#ready = true;
      this.#flushPending(survivor);
      return;
    }
    this.#opts.onLog?.(`collab: rotation failed with no live socket, reconnecting (${why})`);
    this.onClose?.(`connection lost, replacement ${why}`, true);
    this.#scheduleRetry();
  }

  #abortRotation(): void {
    const rotation = this.#rotation;
    if (!rotation) return;
    clearTimeout(rotation.timer);
    this.#rotation = null;
    detach(rotation.ws);
    try { rotation.ws.close(1000); } catch { /* already closing */ }
  }

  /** Inbound on the LIVE socket (a replacement only reaches here once it has been swapped in). */
  #handleMessage(data: unknown): void {
    this.#noteInbound();
    // STRING → a JSON relay-control frame (never sealed; the relay authors these).
    if (typeof data === "string") {
      try {
        const msg = JSON.parse(data) as { t?: string };
        if (msg.t === KEEPALIVE_PONG_T) { this.#pongCapable = true; return; } // consumed, never surfaced
        this.onControl?.(msg as RelayControlMessage);
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
    // Delivered unless the client has stopped for good: a frame the relay handed us just before a rotation
    // swap (or a drop) was legitimately received and is delivered in arrival order, never silently lost.
    this.#recvChain = this.#recvChain
      .then(async () => {
        if (this.#closed) return;
        let frame: LucidCollabFrame;
        try {
          frame = await open(this.#opts.key, sealed);
        } catch {
          this.#failFatal("bad key or corrupted frame"); // wrong key / tamper → never reconnect
          return;
        }
        if (this.#closed) return;
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
    this.#stopTimers();
    this.#abortRotation();
    this.#pendingSends.length = 0;
    const ws = this.#ws;
    this.#ws = null;
    this.#ready = false;
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
