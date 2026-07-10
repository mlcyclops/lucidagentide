// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/collab_p2p.ts — P-COLLAB.17 (ADR-0202): the renderer-side P2P share/join lifecycle.
//
// When the "prefer direct connection" toggle is on, a share runs PEER-TO-PEER over WebRTC instead of relaying
// every frame through the broker. RTCPeerConnection is renderer-only, so - unlike the relay path (hosted in the
// backend) - the host + guest must live in the RENDERER. This module owns that: it mints the room client-side
// (link.ts/crypto.ts are pure), stands up the proven `webrtcHostCoordinator` / `webrtcGuestCoordinator`
// (P-COLLAB.16), and exposes a tiny surface (`teeEvent`/`teeUserTurn`, status, teardown) that app.ts drives.
//
// The relay is still used for SIGNALING + as the automatic fallback (PreferP2PTransport), so P2P degrades to
// exactly the relay behaviour when a DataChannel can't be formed. One host + one guest at a time, mirroring the
// backend's single-share model. Fail-closed: no authorized relay endpoint -> no share (same as the relay path).

import { webrtcHostCoordinator, webrtcGuestCoordinator } from "../collab/webrtc_coordinator.ts";
import { generateRoomId, formatRelayLink, formatShareLink, formatBrowserLink, parseShareLink } from "../collab/link.ts";
import { generateRoomKey, generateWriteToken, importRoomKey } from "../collab/crypto.ts";
import type { ChatEvent } from "./chat_events.ts";
import type { CollabParticipant, CollabSessionHeader } from "../collab/frames.ts";
import type { GuestCallbacks } from "../collab/guest.ts";
import type { WebSocketFactory } from "../collab/relay_client.ts";

/** STUN/TURN config as stored in settings; `iceUrls` are stun:/turn: URLs, creds only used by TURN. */
export interface IceConfig { iceUrls: string[]; turnUsername?: string; turnCredential?: string }

/** Build the RTCIceServer[] the transports take. Empty when no URLs (LAN/VPN host candidates suffice). */
export function buildIceServers(cfg: IceConfig | null | undefined): RTCIceServer[] {
  const urls = (cfg?.iceUrls ?? []).map((u) => u.trim()).filter(Boolean);
  if (!urls.length) return [];
  const server: RTCIceServer = { urls };
  if (cfg?.turnUsername) server.username = cfg.turnUsername;
  if (cfg?.turnCredential) server.credential = cfg.turnCredential;
  return [server];
}

// ── host ───────────────────────────────────────────────────────────────────

export interface P2PHostStatus {
  active: true;
  roomId: string;
  fullLink: string;
  viewLink: string;
  browserLink: string;
  relayLabel: string;
  relaySource: string;
  startedAt: number;
  allowEdit: boolean;
  participantCount: number;
  participants: CollabParticipant[];
}

export interface StartP2PHostOpts {
  relayWsBase: string;
  relayHttpBase: string;
  relayLabel: string;
  relaySource: string;
  header: Omit<CollabSessionHeader, "startedAt">;
  allowEdit: boolean;
  ice: IceConfig | null;
  /** An EDIT guest's prompt/abort - app.ts runs these through the host's OWN composer (gate + approvals fire). */
  onGuestPrompt?: (text: string, guest: CollabParticipant) => void;
  onGuestAbort?: (guest: CollabParticipant) => void;
  /** P-COLLAB.18: a guest joined/left this direct-P2P share (host-authoritative audit hook). */
  onParticipant?: (kind: "join" | "leave", guest: CollabParticipant) => void;
  /** Test-only: inject the relay socket (an in-memory loopback for the self-test). Defaults to the real WebSocket. */
  wsFactory?: WebSocketFactory;
}

let host: { coord: ReturnType<typeof webrtcHostCoordinator>; meta: Omit<P2PHostStatus, "participantCount" | "participants" | "active"> } | null = null;

/** True when a P2P share is the current host (so app.ts reads status from here, not the backend). */
export function p2pHostActive(): boolean { return host !== null; }

/** Tee one live ChatEvent into the P2P share (no-op when not P2P-hosting). */
export function teeEvent(e: ChatEvent): void { host?.coord.host.pushEvent(e); }
/** Record a local user turn into the P2P replay transcript (no-op when not P2P-hosting). */
export function teeUserTurn(text: string): void { host?.coord.host.pushUserTurn(text); }

/** Mint a room + stand up the renderer host coordinator. Returns the share status (links + roster). */
export async function startP2PHost(opts: StartP2PHostOpts): Promise<P2PHostStatus> {
  stopP2PHost();
  const roomId = generateRoomId();
  const rawKey = generateRoomKey();
  const token = generateWriteToken();
  const key = await importRoomKey(rawKey);
  const startedAt = Date.now();

  const wsUrl = `${opts.relayWsBase.replace(/\/+$/, "")}/r/${roomId}`;
  const coord = webrtcHostCoordinator({
    wsUrl,
    key,
    iceServers: buildIceServers(opts.ice),
    wsFactory: opts.wsFactory,
    host: {
      header: { ...opts.header, startedAt },
      writeToken: token,
      allowGuestWrite: opts.allowEdit,
      onGuestPrompt: opts.onGuestPrompt,
      onGuestAbort: opts.onGuestAbort,
      onParticipant: opts.onParticipant,
    },
  });

  const meta = {
    roomId,
    fullLink: formatRelayLink(opts.relayWsBase, roomId, rawKey, token),
    viewLink: formatRelayLink(opts.relayWsBase, roomId, rawKey),
    browserLink: formatBrowserLink(opts.relayHttpBase, formatShareLink(roomId, rawKey)),
    relayLabel: opts.relayLabel,
    relaySource: opts.relaySource,
    startedAt,
    allowEdit: opts.allowEdit,
  };
  host = { coord, meta };
  return p2pHostStatus()!;
}

/** The current P2P host status (links + live roster from the fan-out), or null when not P2P-hosting. */
export function p2pHostStatus(): P2PHostStatus | null {
  if (!host) return null;
  return {
    active: true,
    ...host.meta,
    participantCount: host.coord.host.participantCount,
    participants: host.coord.host.participants(),
  };
}

/** End the P2P share (idempotent). */
export function stopP2PHost(): void {
  host?.coord.close();
  host = null;
}

// ── guest ──────────────────────────────────────────────────────────────────

let guest: { coord: ReturnType<typeof webrtcGuestCoordinator> } | null = null;

export function p2pGuestActive(): boolean { return guest !== null; }

/**
 * Join a share PEER-TO-PEER: parse the invite (which must carry the relay endpoint), then run the renderer
 * guest coordinator. `guestName` labels this watcher; `callbacks` receive welcome/event/state/error/bye.
 * Returns `{ok:false, error}` on a bad link or a missing endpoint (fail-closed) without throwing.
 */
export function startP2PGuest(opts: { link: string; guestName: string; ice: IceConfig | null; callbacks: GuestCallbacks; wsFactory?: WebSocketFactory }): { ok: boolean; error?: string } {
  stopP2PGuest();
  let parsed;
  try { parsed = parseShareLink(opts.link); }
  catch (e) { return { ok: false, error: String((e as Error)?.message ?? "invalid link") }; }
  if (!parsed.relay) return { ok: false, error: "this invite doesn't carry a relay endpoint - ask the host for a full link" };

  // Import synchronously-ish: crypto import is async, so kick it off and wire the coordinator once ready. The
  // coordinator's own transport buffers `hello` until the socket opens, so there is no lost-frame race.
  const wsUrl = `${parsed.relay.replace(/\/+$/, "")}/r/${parsed.roomId}`;
  void importRoomKey(parsed.key).then((key) => {
    if (guest) return; // a newer join superseded us
    const coord = webrtcGuestCoordinator({
      wsUrl,
      key,
      iceServers: buildIceServers(opts.ice),
      wsFactory: opts.wsFactory,
      guest: { name: opts.guestName || "guest", writeToken: parsed.writeToken ?? undefined },
      callbacks: opts.callbacks,
    });
    guest = { coord };
  }).catch((e) => opts.callbacks.onError?.(String((e as Error)?.message ?? e)));
  return { ok: true };
}

/** P-COLLAB.12: an EDIT guest drives the host over the direct link. No-op (returns false) when view-only. */
export function p2pGuestSendPrompt(text: string): boolean { return guest?.coord.guest.sendPrompt(text) ?? false; }
export function p2pGuestAbort(): boolean { return guest?.coord.guest.abort() ?? false; }

/** Leave the P2P share (idempotent). */
export function stopP2PGuest(): void {
  guest?.coord.close();
  guest = null;
}

/** Parsed relay endpoint of an invite (for the managed authorize-connect check), or null if it carries none. */
export function p2pLinkEndpoint(link: string): string | null {
  try { return parseShareLink(link).relay; } catch { return null; }
}
