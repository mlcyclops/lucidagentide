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
interface SockData { roomId: string; role: Role; peerId: number }
interface Room { host: WS | null; guests: Map<number, WS>; peerSeq: number }
// Minimal structural view of Bun's ServerWebSocket (kept dependency-light + testable).
interface WS {
  data: SockData;
  send(data: string | Uint8Array): number;
  close(code?: number, reason?: string): void;
}

/** Start the embedded relay. Returns a handle to inspect + stop it. Throws if the port cannot be bound. */
export function startRelayServer(opts: RelayServerOptions): RelayHandle {
  const cfg = { ...DEFAULTS, ...opts };
  // Fail-closed BEFORE opening the listener: an org policy (or the caller) may forbid this bind entirely.
  const authz = opts.authorizeBind?.(cfg.hostname, cfg.port);
  if (authz && !authz.ok) throw new Error(`relay bind refused: ${authz.reason ?? "not permitted by policy"}`);
  const rooms = new Map<string, Room>();
  const log = (m: string, d?: unknown) => opts.onLog?.(m, d);

  const jsonCtrl = (obj: unknown): string => JSON.stringify(obj);

  const server = Bun.serve<SockData>({
    port: cfg.port,
    hostname: cfg.hostname,
    ...(cfg.tls ? { tls: { cert: cfg.tls.cert, key: cfg.tls.key } } : {}),
    fetch(req, srv) {
      const url = new URL(req.url);
      // ADR-0195 (P-COLLAB.9): an ops health probe for the standalone broker (load balancers / k8s). It
      // exposes only aggregate counts - never a roomId, key, or any session bytes.
      if (url.pathname === "/healthz") {
        let peers = 0; for (const r of rooms.values()) peers += r.guests.size + (r.host ? 1 : 0);
        return new Response(JSON.stringify({ ok: true, service: "lucid-collab-relay", rooms: rooms.size, peers }), { headers: { "content-type": "application/json" } });
      }
      const m = url.pathname.match(/^\/r\/([^/]+)$/);
      if (!m) return new Response("not a relay room", { status: 404 });
      const role = url.searchParams.get("role");
      if (role !== "host" && role !== "guest") return new Response("role must be host|guest", { status: 400 });
      const roomId = decodeURIComponent(m[1]!);
      const ok = srv.upgrade(req, { data: { roomId, role, peerId: 0 } });
      return ok ? undefined : new Response("expected a websocket upgrade", { status: 426 });
    },
    websocket: {
      maxPayloadLength: cfg.maxFrameBytes,
      idleTimeout: cfg.idleTimeoutSec,
      open(ws: WS) {
        const { roomId, role } = ws.data;
        if (role === "host") {
          const existing = rooms.get(roomId);
          if (existing?.host) { ws.close(4009, "a host is already connected for this room"); return; }
          if (!existing && rooms.size >= cfg.maxRooms) { ws.close(4029, "relay is at room capacity"); return; }
          const room = existing ?? { host: null, guests: new Map(), peerSeq: 1 };
          room.host = ws;
          rooms.set(roomId, room);
          log("relay: host opened room", { roomId });
          return;
        }
        // guest
        const room = rooms.get(roomId);
        if (!room?.host) { ws.close(4004, "no such room"); return; }
        if (room.guests.size >= cfg.maxPeersPerRoom) { ws.close(4029, "room is full"); return; }
        const peerId = room.peerSeq++;
        ws.data.peerId = peerId;
        room.guests.set(peerId, ws);
        room.host.send(jsonCtrl({ t: "peer-joined", peer: peerId }));
        log("relay: guest joined", { roomId, peerId });
      },
      message(ws: WS, message: string | Uint8Array | ArrayBuffer) {
        // Control frames only flow relay→client; a client STRING is unexpected - ignore it.
        if (typeof message === "string") return;
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
        const room = rooms.get(ws.data.roomId);
        if (!room) return;
        if (ws.data.role === "host") {
          for (const g of room.guests.values()) { try { g.send(jsonCtrl({ t: "room-closed" })); } catch { /* gone */ } try { g.close(4001, "room closed"); } catch { /* gone */ } }
          rooms.delete(ws.data.roomId);
          log("relay: host left, room closed", { roomId: ws.data.roomId });
        } else {
          if (room.guests.delete(ws.data.peerId)) {
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
    stop: () => { server.stop(true); rooms.clear(); },
  };
}
