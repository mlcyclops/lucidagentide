// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/relay_server.ts — P-COLLAB.5 (ADR-0192): the OPTIONAL embedded WSS relay.
//
// Lets any LUCID be the relay for its own sessions - no third party, on-brand for the sovereign/air-gapped
// posture. It is a dumb forwarder: it maintains rooms and routes OPAQUE E2E envelopes between the host and its
// guests by peer id. It never holds the room key, so it cannot read or forge session content (the AES-GCM tag
// + wrong-key rejection in crypto.ts guarantee that). Wire-compatible with the relay CLIENT (relay_client.ts):
//   - connect `…/r/<roomId>?role=host|guest`; BINARY frames are `[4B targetPeer][sealed]`; the relay rewrites
//     the header to the SENDER's peer id on delivery (host = peer 0; guests are 1,2,3…). A host frame with
//     targetPeer 0 broadcasts to all guests; a non-zero target unicasts. A guest frame always goes to the host.
//   - STRING frames are relay→client JSON control: `peer-joined`/`peer-left` (to the host), `room-closed`
//     (to guests). Fatal close codes: 4004 no such room, 4009 host already connected, 4029 room full.
//
// SECURITY (the one genuinely new attack surface, so it is guard-railed and OPT-IN, never on by default):
//   - a SEPARATE listener from LUCID's authenticated /api server - this port serves ONLY the relay protocol,
//   - binds `127.0.0.1` by default (localhost; reach a remote guest over a tunnel/VPN); a LAN bind is an
//     explicit caller choice,
//   - HARD LIMITS bound DoS: max rooms, max peers/room, max frame bytes (Bun drops an oversized frame), and an
//     idle timeout,
//   - it only forwards ciphertext - a hostile connection learns nothing and cannot inject a valid frame.

// The relay is a DUMB forwarder: it only ever reads + rewrites the 4-byte plaintext peer header and passes the
// opaque sealed payload through. So it needs neither WebCrypto nor `@oh-my-pi/pi-wire` - the header ops are
// inlined here, which keeps the STANDALONE broker (tools/relay) dependency-free (just Bun + this file).
import type { RelayAuthGate } from "./relay_auth.ts";
import type { RelayPresenceHooks, RelayPresencePrincipal } from "./relay_presence.ts";

const ENVELOPE_HEADER_LENGTH = 4;
/** Prepend a 4-byte big-endian peer id to an opaque sealed payload. */
function packEnvelope(peerId: number, sealed: Uint8Array): Uint8Array {
  const out = new Uint8Array(ENVELOPE_HEADER_LENGTH + sealed.byteLength);
  new DataView(out.buffer).setUint32(0, peerId >>> 0, false);
  out.set(sealed, ENVELOPE_HEADER_LENGTH);
  return out;
}
/** Split a wire envelope into `{ peerId, sealed }`. Throws if it is shorter than the header. */
function unpackEnvelope(buf: Uint8Array): { peerId: number; sealed: Uint8Array } {
  if (buf.byteLength < ENVELOPE_HEADER_LENGTH) throw new Error("envelope too short");
  const peerId = new DataView(buf.buffer, buf.byteOffset, ENVELOPE_HEADER_LENGTH).getUint32(0, false);
  return { peerId, sealed: buf.subarray(ENVELOPE_HEADER_LENGTH) };
}

export interface RelayServerOptions {
  /** 0 lets the OS choose a free port (read it back from the handle). */
  port: number;
  /** Bind address. Default 127.0.0.1 (localhost only). Pass 0.0.0.0 / a LAN IP to expose on a trusted net. */
  hostname?: string;
  maxRooms?: number;
  maxPeersPerRoom?: number;
  /** Max bytes per frame; Bun closes a connection that exceeds it (1009). */
  maxFrameBytes?: number;
  /** Seconds of silence before Bun drops an idle socket (also our keepalive ceiling). */
  idleTimeoutSec?: number;
  /** ADR-0193 (P-COLLAB.6): defense-in-depth policy gate on the bind target. Injected (not a managed_config
   *  import) so relay_server stays pure + testable; the real caller passes the managed authorizeRelayBind.
   *  If it returns `{ok:false}`, startRelayServer THROWS before opening the listener (fail-closed). */
  authorizeBind?: (host: string, port: number) => { ok: boolean; reason?: string };
  /** ADR-0195 (P-COLLAB.9): PEM cert + key to serve `wss://` directly (the standalone broker on a jumpbox).
   *  Omit to serve plain `ws://` (loopback / behind a TLS-terminating reverse proxy). */
  tls?: { cert: string; key: string };
  /** P-REMOTE.1 (ADR-0226/0227): OPTIONAL identity gate for a HOSTED rendezvous. When set, a socket is
   *  admitted to a room only AFTER its first frame `{"t":"auth","token":…}` verifies (4401 invalid /
   *  deadline, 4403 not entitled, 4429 per-user quota). Injected (like `authorizeBind`) so relay_server
   *  stays pure + testable; absent = anonymous mode, byte-identical to pre-P-REMOTE behavior. */
  auth?: RelayAuthGate;
  /** P-REMOTE.7: OPTIONAL metadata-only presence lifecycle. Hooks are invoked only after authenticated
   *  admission and are always fire-and-forget; failures can never refuse or close a socket. */
  presence?: RelayPresenceHooks;
  /** P-REMOTE.4a hardening: when set (a HOSTED relay only), a bare GET `/` serves a tiny page that forwards
   *  the URL fragment to this phone-PWA base (e.g. https://lucid-agent.web.app/remote), so even a STALE
   *  relay-host invite QR (`https://relay/#<room>.<secret>`) opens the app instead of "not a relay room".
   *  Absent (OSS / self-hosted) = unchanged: `/` stays a 404. The invite secret rides the fragment
   *  client-side and never reaches the server. */
  pwaRedirectBase?: string;
  onLog?: (msg: string, detail?: unknown) => void;
}

export interface RelayHandle {
  readonly port: number;
  readonly hostname: string;
  roomCount(): number;
  peerCount(): number;
  stop(): void;
}

const DEFAULTS = {
  hostname: "127.0.0.1",
  maxRooms: 64,
  maxPeersPerRoom: 16,
  maxFrameBytes: 512 * 1024, // 512 KiB - a sealed ChatEvent is tiny; a big one is a red flag
  idleTimeoutSec: 120,
};

type Role = "host" | "guest";
interface SockData {
  roomId: string;
  role: Role;
  peerId: number;
  authed?: boolean;
  authing?: boolean;
  uid?: string;
  userAgent: string;
  presencePrincipal?: RelayPresencePrincipal;
}
interface Room { host: WS | null; hostUid?: string; guests: Map<number, WS>; peerSeq: number; graceTimer?: Timer }
// Minimal structural view of Bun's ServerWebSocket (kept dependency-light + testable).
interface WS {
  data: SockData;
  send(data: string | Uint8Array): number;
  close(code?: number, reason?: string): void;
}

/** P-REMOTE.4a hardening: the fragment-forwarding page served at `/` when a phone-PWA base is configured.
 *  The invite secret lives in the URL fragment (never sent to the server), so a tiny client script reads
 *  `location.hash` and redirects to `<pwaBase>#<room>.<secret>`. `base` is trusted first-party config. */
function pwaRedirectHtml(base: string): string {
  const b = JSON.stringify(base.replace(/\/+$/, ""));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Opening LUCID Remote…</title><style>body{background:#0a0b0f;color:#e8edf5;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;text-align:center;padding:56px 22px}a{color:#2dd4bf;word-break:break-all}</style></head><body><p>Opening LUCID Remote…</p><p><a id="go" href=${b}>Tap here if it doesn't open automatically</a></p><script>(function(){var base=${b};var dest=base+(location.hash||"");var a=document.getElementById("go");if(a)a.href=dest;location.replace(dest);})();</script></body></html>`;
}

/** Start the embedded relay. Returns a handle to inspect + stop it. Throws if the port cannot be bound. */
export function startRelayServer(opts: RelayServerOptions): RelayHandle {
  const cfg = { ...DEFAULTS, ...opts };
  // Fail-closed BEFORE opening the listener: an org policy (or the caller) may forbid this bind entirely.
  const authz = opts.authorizeBind?.(cfg.hostname, cfg.port);
  if (authz && !authz.ok) throw new Error(`relay bind refused: ${authz.reason ?? "not permitted by policy"}`);
  const rooms = new Map<string, Room>();
  const log = (m: string, d?: unknown) => opts.onLog?.(m, d);
  const presence = opts.presence ?? null;

  /** Telemetry is observational only. Catch both a synchronous hook throw and an async rejection. */
  function emitPresence(operation: () => void | Promise<void>): void {
    if (!presence) return;
    try {
      const pending = operation();
      if (pending && typeof pending.then === "function") void pending.catch(() => undefined);
    } catch { /* presence can never affect relay traffic */ }
  }

  const jsonCtrl = (obj: unknown): string => JSON.stringify(obj);

  // --- P-REMOTE.1 (ADR-0226/0227): the OPTIONAL identity gate. Absent "auth" = anonymous mode, unchanged. ---
  const auth = opts.auth ?? null;
  const authDeadlineMs = auth?.deadlineMs ?? 5000;
  const maxRoomsPerUser = auth?.maxRoomsPerUser ?? 4;
  const maxConnectsPerMinute = auth?.maxConnectsPerMinute ?? 30;
  const reclaimGraceMs = auth?.reclaimGraceMs ?? 30_000;

  /** Kick every guest + delete the room. Shared by the host-close path and the grace-expiry timer. */
  function teardownRoom(roomId: string, room: Room): void {
    if (room.graceTimer) { clearTimeout(room.graceTimer); room.graceTimer = undefined; }
    for (const g of room.guests.values()) { try { g.send(jsonCtrl({ t: "room-closed" })); } catch { /* gone */ } try { g.close(4001, "room closed"); } catch { /* gone */ } }
    emitPresence(() => presence!.hostClosed(roomId));
    rooms.delete(roomId);
    log("relay: room closed");
  }
  const authTimers = new Map<WS, Timer>();
  const recentConnects = new Map<string, number[]>(); // uid → successful-auth timestamps within the window

  /** Room admission — at open() in anonymous mode, after the verified auth frame in gated mode. */
  function admit(ws: WS): boolean {
    const { roomId, role } = ws.data;
    if (role === "host") {
      const existing = rooms.get(roomId);
      if (existing?.host) {
        // P-REMOTE.2 (ADR-0226): identity-based RE-CLAIM. The Cloud Run 60-min cap (or a NAT) can drop a
        // host whose stale socket the relay has not reaped yet; the SAME authenticated uid replaces its own
        // socket instead of tripping 4009. Adopt FIRST so the stale socket's close() sees room.host !== it
        // and cannot tear the room down. Anonymous mode keeps the hard refusal (no identity to prove).
        if (auth && ws.data.uid && existing.hostUid === ws.data.uid) {
          const stale = existing.host;
          existing.host = ws;
          try { stale.close(4009, "replaced by a newer connection from the same account"); } catch { /* gone */ }
          for (const peer of existing.guests.keys()) ws.send(jsonCtrl({ t: "peer-joined", peer }));
          if (ws.data.presencePrincipal) emitPresence(() => presence!.hostReclaimed(roomId, ws.data.presencePrincipal!));
          log("relay: host re-claimed room (live socket replaced)");
          return true;
        }
        ws.close(4009, "a host is already connected for this room");
        return false;
      }
      if (existing && !existing.host) {
        // A hostless room only exists inside the gated re-claim GRACE window; only its owner resumes it.
        if (auth && ws.data.uid && existing.hostUid === ws.data.uid) {
          if (existing.graceTimer) { clearTimeout(existing.graceTimer); existing.graceTimer = undefined; }
          existing.host = ws;
          for (const peer of existing.guests.keys()) ws.send(jsonCtrl({ t: "peer-joined", peer }));
          if (ws.data.presencePrincipal) emitPresence(() => presence!.hostReclaimed(roomId, ws.data.presencePrincipal!));
          log("relay: host re-claimed room (within grace)");
          return true;
        }
        ws.close(4009, "this room is reserved for its host");
        return false;
      }
      if (!existing && rooms.size >= cfg.maxRooms) { ws.close(4029, "relay is at room capacity"); return false; }
      if (ws.data.uid) {
        let held = 0;
        for (const r of rooms.values()) if (r.hostUid === ws.data.uid) held++;
        if (held >= maxRoomsPerUser) { ws.close(4429, "per-user room quota reached"); return false; }
      }
      const room = existing ?? { host: null, guests: new Map<number, WS>(), peerSeq: 1 };
      room.host = ws;
      room.hostUid = ws.data.uid;
      rooms.set(roomId, room);
      if (ws.data.presencePrincipal) emitPresence(() => presence!.hostStarted(roomId, ws.data.presencePrincipal!));
      log("relay: host opened room");
      return true;
    }
    // guest
    const room = rooms.get(roomId);
    if (!room?.host) { ws.close(4004, "no such room"); return false; }
    if (room.guests.size >= cfg.maxPeersPerRoom) { ws.close(4029, "room is full"); return false; }
    const peerId = room.peerSeq++;
    ws.data.peerId = peerId;
    room.guests.set(peerId, ws);
    room.host.send(jsonCtrl({ t: "peer-joined", peer: peerId }));
    if (ws.data.presencePrincipal) emitPresence(() => presence!.guestJoined(roomId, peerId, ws.data.presencePrincipal!));
    log("relay: guest joined", { peerId });
    return true;
  }

  /** Pre-auth traffic: the ONLY acceptable frame is `{"t":"auth","token":…}`; anything else is 4401.
   *  Every failure path REFUSES — a dead verifier can never admit (CLAUDE.md invariant #3). Identities are
   *  never logged here (counts/codes only); they belong to the gated telemetry plane (P-REMOTE.7). */
  function handlePreAuthFrame(ws: WS, message: string | Uint8Array | ArrayBuffer): void {
    if (typeof message !== "string") { ws.close(4401, "authenticate first"); return; }
    if (ws.data.authing) return; // a verification is already in flight; drop extras
    let token = "";
    try {
      const frame = JSON.parse(message) as { t?: unknown; token?: unknown };
      if (frame.t !== "auth" || typeof frame.token !== "string" || frame.token.length === 0) {
        ws.close(4401, "expected an auth frame");
        return;
      }
      token = frame.token;
    } catch {
      ws.close(4401, "expected an auth frame");
      return;
    }
    ws.data.authing = true;
    void auth!.verify(token)
      .then((verdict) => {
        ws.data.authing = false;
        if (!verdict.ok) {
          log("relay: auth refused", { code: verdict.code });
          ws.close(verdict.code, verdict.reason);
          return;
        }
        const t = Date.now();
        if (recentConnects.size > 4096) {
          for (const [uid, arr] of recentConnects) {
            const live = arr.filter((s) => t - s < 60_000);
            if (live.length === 0) recentConnects.delete(uid); else recentConnects.set(uid, live);
          }
        }
        const stamps = (recentConnects.get(verdict.uid) ?? []).filter((s) => t - s < 60_000);
        stamps.push(t);
        recentConnects.set(verdict.uid, stamps);
        if (stamps.length > maxConnectsPerMinute) { ws.close(4429, "per-user connect rate exceeded"); return; }
        const timer = authTimers.get(ws);
        if (timer) { clearTimeout(timer); authTimers.delete(ws); }
        ws.data.authed = true;
        ws.data.uid = verdict.uid;
        ws.data.presencePrincipal = {
          uid: verdict.uid,
          email: verdict.email,
          admin: verdict.admin,
          premium: verdict.premium,
          effectivePremium: verdict.premium || verdict.admin,
          userAgent: ws.data.userAgent,
        };
        if (admit(ws)) ws.send(jsonCtrl({ t: "auth-ok" }));
      })
      .catch((e) => {
        ws.data.authing = false;
        log("relay: auth refused", { code: 4401, error: String((e as Error)?.message ?? e) });
        try { ws.close(4401, "verification unavailable"); } catch { /* gone */ }
      });
  }

  const server = Bun.serve<SockData>({
    port: cfg.port,
    hostname: cfg.hostname,
    ...(cfg.tls ? { tls: { cert: cfg.tls.cert, key: cfg.tls.key } } : {}),
    fetch(req, srv) {
      const url = new URL(req.url);
      // A Firebase Hosting rewrite (P-REMOTE.7 workaround: Hosting invokes Cloud Run internally, bypassing a
      // broken public run.app edge) forwards the FULL path, e.g. `/relay/r/<id>`. Strip an optional `/relay`
      // prefix so both the direct run.app path and the Hosting-fronted path resolve identically.
      const pathname = url.pathname === "/relay" ? "/" : url.pathname.replace(/^\/relay(?=\/)/, "");
      // ADR-0195 (P-COLLAB.9): an ops health probe for the standalone broker (load balancers / k8s). It
      // exposes only aggregate counts - never a roomId, key, or any session bytes.
      if (pathname === "/healthz") {
        let peers = 0; for (const r of rooms.values()) peers += r.guests.size + (r.host ? 1 : 0);
        return new Response(JSON.stringify({ ok: true, service: "lucid-collab-relay", rooms: rooms.size, peers }), { headers: { "content-type": "application/json" } });
      }
      // P-REMOTE.4a hardening: a phone that opens the BROWSER (relay-host) invite hits `/#<room>.<secret>`;
      // the fragment stays client-side, so the server sees a bare GET `/`. When a PWA base is configured
      // (hosted relay only) forward it to the phone PWA, so even a STALE relay-host QR opens the app instead
      // of "not a relay room". Unset (OSS / self-hosted) = unchanged.
      if (pathname === "/" && cfg.pwaRedirectBase) {
        return new Response(pwaRedirectHtml(cfg.pwaRedirectBase), { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      const m = pathname.match(/^\/r\/([^/]+)$/);
      if (!m) return new Response("not a relay room", { status: 404 });
      const role = url.searchParams.get("role");
      if (role !== "host" && role !== "guest") return new Response("role must be host|guest", { status: 400 });
      const roomId = decodeURIComponent(m[1]!);
      // The request user-agent is useful for ephemeral operations diagnostics but is never passed to the
      // Firestore serializer. Bun supplies no client address here and telemetry never inspects one.
      const userAgent = req.headers.get("user-agent") ?? "";
      const ok = srv.upgrade(req, { data: { roomId, role, peerId: 0, userAgent } });
      return ok ? undefined : new Response("expected a websocket upgrade", { status: 426 });
    },
    websocket: {
      maxPayloadLength: cfg.maxFrameBytes,
      idleTimeout: cfg.idleTimeoutSec,
      open(ws: WS) {
        if (auth) {
          // Gated mode: NOT admitted yet. The first frame must authenticate within the deadline (4401).
          ws.data.authed = false;
          authTimers.set(ws, setTimeout(() => {
            authTimers.delete(ws);
            try { ws.close(4401, "authentication deadline"); } catch { /* gone */ }
          }, authDeadlineMs));
          return;
        }
        admit(ws);
      },
      message(ws: WS, message: string | Uint8Array | ArrayBuffer) {
        if (auth && !ws.data.authed) { handlePreAuthFrame(ws, message); return; }
        // The client's exact keepalive frame is the only client string with telemetry meaning. It remains
        // otherwise ignored (there is no response and no new control-plane behavior).
        if (typeof message === "string") {
          if (message === '{"t":"ping"}') {
            emitPresence(() => presence!.activity(ws.data.roomId, ws.data.role, ws.data.peerId, "heartbeat"));
          }
          return;
        }
        const room = rooms.get(ws.data.roomId);
        if (!room) return;
        const bytes = message instanceof ArrayBuffer ? new Uint8Array(message) : message;
        let target: number;
        let sealed: Uint8Array;
        try {
          ({ peerId: target, sealed } = unpackEnvelope(bytes));
        } catch {
          return; // runt envelope
        }
        emitPresence(() => presence!.activity(ws.data.roomId, ws.data.role, ws.data.peerId, "binary"));
        if (ws.data.role === "host") {
          const out = packEnvelope(0, sealed); // header = sender (host = peer 0)
          if (target === 0) { for (const g of room.guests.values()) g.send(out); }
          else room.guests.get(target)?.send(out);
        } else {
          // guest → host, tagged with the guest's peer id (ignore whatever target it wrote)
          room.host?.send(packEnvelope(ws.data.peerId, sealed));
        }
      },
      close(ws: WS) {
        const timer = authTimers.get(ws);
        if (timer) { clearTimeout(timer); authTimers.delete(ws); }
        const room = rooms.get(ws.data.roomId);
        if (!room) return;
        if (ws.data.role === "host") {
          // Only the socket that OWNS the room tears it down. A rejected duplicate host (4009) or a
          // never-admitted gated socket must not nuke the legit room (pre-existing bug, fixed in P-REMOTE.1).
          if (room.host !== ws) return;
          // P-REMOTE.2: in gated mode a dropped host's room with live guests enters a GRACE window so the
          // hourly reconnect is invisible to guests; the owning uid re-claims, expiry tears down as before.
          if (auth && room.hostUid && reclaimGraceMs > 0 && room.guests.size > 0) {
            room.host = null;
            const roomId = ws.data.roomId;
            room.graceTimer = setTimeout(() => {
              const r = rooms.get(roomId);
              if (r && !r.host) teardownRoom(roomId, r);
            }, reclaimGraceMs);
            emitPresence(() => presence!.hostGrace(roomId));
            log("relay: host dropped, holding room for re-claim");
            return;
          }
          teardownRoom(ws.data.roomId, room);
        } else {
          if (room.guests.delete(ws.data.peerId)) {
            emitPresence(() => presence!.guestLeft(ws.data.roomId, ws.data.peerId));
            try { room.host?.send(jsonCtrl({ t: "peer-left", peer: ws.data.peerId })); } catch { /* host gone */ }
          }
        }
      },
    },
  });

  return {
    port: server.port ?? cfg.port,
    hostname: cfg.hostname,
    roomCount: () => rooms.size,
    peerCount: () => { let n = 0; for (const r of rooms.values()) n += r.guests.size + (r.host ? 1 : 0); return n; },
    stop: () => {
      // Record a terminal snapshot before Bun closes sockets. Duplicate close callbacks are harmless because
      // the presence reducer treats an already-closed/missing session as a no-op.
      for (const roomId of rooms.keys()) emitPresence(() => presence!.hostClosed(roomId));
      server.stop(true);
      for (const r of rooms.values()) clearTimeout(r.graceTimer);
      rooms.clear();
      for (const t of authTimers.values()) clearTimeout(t);
      authTimers.clear();
    },
  };
}
