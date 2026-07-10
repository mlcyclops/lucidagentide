// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/collab/webrtc_session.ts — P-COLLAB.15 (ADR-0200): run a collab session over a direct WebRTC
// DataChannel (renderer-side).
//
// The existing host/guest run in the BACKEND over the relay WebSocket. WebRTC (ADR-0194) is a Chromium API,
// so a P2P session must run in the RENDERER: this wires a `WebRtcTransport` (the direct DTLS DataChannel) into
// the SAME `CollabHost` / `CollabGuest` the relay path uses - only the pipe differs. Signaling (SDP/ICE) rides
// a `SignalingChannel` (in production, `RelaySignaling` over the relay; here, a loopback for the self-test),
// then the peers connect DIRECT and the relay carries nothing more. Frames stay E2E-sealed over the channel.
//
// RENDERER-ONLY (RTCPeerConnection): never import from the no-DOM harness/root program. Verified in the
// preview via `webrtcLoopbackSelfTest`, not `bun test`.

import { WebRtcTransport } from "./webrtc_transport.ts";
import { CollabHost, type HostStartOpts } from "./host.ts";
import { CollabGuest, type GuestCallbacks, type GuestStartOpts } from "./guest.ts";
import { LoopbackSignaling, type SignalingChannel } from "./signaling.ts";
import { generateRoomKey, importRoomKey, packEnvelope } from "./crypto.ts";
import type { WebSocketFactory, WebSocketLike } from "./relay_client.ts";
import { webrtcHostCoordinator, webrtcGuestCoordinator } from "./webrtc_coordinator.ts";
import { startP2PHost, startP2PGuest, stopP2PHost, stopP2PGuest, teeEvent, teeUserTurn, p2pHostStatus } from "../renderer/collab_p2p.ts"; // P-COLLAB.17

export interface WebRtcHostOpts { key: CryptoKey; signaling: SignalingChannel; host: HostStartOpts; iceServers?: RTCIceServer[] }
export interface WebRtcGuestOpts { key: CryptoKey; signaling: SignalingChannel; guest: GuestStartOpts; callbacks?: GuestCallbacks; iceServers?: RTCIceServer[] }

/** Drive a `CollabHost` over a direct WebRTC DataChannel (host = the offerer). 1:1 - one per guest peer; the
 *  relay stays the multi-party fan-out. Returns the host + its transport so the caller can push events / stop. */
export function webrtcHost(opts: WebRtcHostOpts): { host: CollabHost; transport: WebRtcTransport } {
  const transport = new WebRtcTransport({ role: "host", key: opts.key, signaling: opts.signaling, iceServers: opts.iceServers });
  const host = new CollabHost(transport, opts.host);
  host.start(); // wires the transport + (via WebRtcTransport.connect) makes the offer
  return { host, transport };
}

/** Drive a `CollabGuest` over a direct WebRTC DataChannel (guest = the answerer). Sends `hello` once the
 *  DataChannel opens; welcome/event/state then flow P2P. */
export function webrtcGuest(opts: WebRtcGuestOpts): { guest: CollabGuest; transport: WebRtcTransport } {
  const transport = new WebRtcTransport({ role: "guest", key: opts.key, signaling: opts.signaling, iceServers: opts.iceServers });
  const guest = new CollabGuest(transport, opts.guest, opts.callbacks ?? {});
  guest.start(); // wires the transport; sends hello on the DataChannel open
  return { guest, transport };
}

async function waitFor(cond: () => boolean, label: string, ms = 6000): Promise<void> {
  const deadline = ms / 15;
  for (let i = 0; i < deadline; i++) { if (cond()) return; await new Promise((r) => setTimeout(r, 15)); }
  throw new Error(`timed out waiting for ${label}`);
}

/**
 * A self-contained proof that the RENDERER-side WebRTC session stack works end-to-end with the REAL classes:
 * a host + guest, sharing a room key, connect over a direct DTLS DataChannel (signaling looped back in-process,
 * standing in for the relay), the guest gets its E2E `welcome`, and a host `ChatEvent` broadcast arrives P2P.
 * Returns a plain result so a diagnostics caller (or the preview) can assert it. Never throws.
 */
export async function webrtcLoopbackSelfTest(): Promise<{ ok: boolean; detail: string }> {
  if (typeof RTCPeerConnection === "undefined") return { ok: false, detail: "no RTCPeerConnection in this build" };
  let g: { guest: CollabGuest } | null = null;
  let h: { host: CollabHost } | null = null;
  try {
    const raw = generateRoomKey();
    const hostKey = await importRoomKey(raw);
    const guestKey = await importRoomKey(raw);
    const hub = new LoopbackSignaling();
    const events: string[] = [];
    let welcomed = false;

    const gs = webrtcGuest({ key: guestKey, signaling: hub.endpoint("b"), guest: { name: "bob" }, callbacks: { onWelcome: () => { welcomed = true; }, onEvent: (e) => events.push(e.type) } });
    const hs = webrtcHost({ key: hostKey, signaling: hub.endpoint("a"), host: { header: { sessionId: "s", title: "WebRTC P2P self-test", model: "m", hostName: "host", startedAt: 1 } } });
    g = gs; h = hs;

    await waitFor(() => welcomed && gs.guest.view().phase === "live", "the guest welcome over the DataChannel");
    const title = gs.guest.view().header?.title;

    hs.host.pushEvent({ type: "token", text: "hello over P2P" });
    hs.host.pushEvent({ type: "done", text: "done" });
    await waitFor(() => events.includes("token") && events.includes("done"), "the broadcast events over the DataChannel");

    const ok = title === "WebRTC P2P self-test" && hs.host.participantCount === 1;
    return { ok, detail: `welcome title="${title}", participants=${hs.host.participantCount}, events=${JSON.stringify(events)}` };
  } catch (e) {
    return { ok: false, detail: String((e as Error)?.message ?? e) };
  } finally {
    try { g?.guest.leave("self-test done"); } catch { /* */ }
    try { h?.host.stop("self-test done"); } catch { /* */ }
  }
}

// ── the PRODUCTION-path self-test (P-COLLAB.16) ────────────────────────────────

/** An in-memory stand-in for a relay socket, so the self-test drives the REAL CollabSocket without a server. */
class LoopbackWs implements WebSocketLike {
  binaryType = "blob";
  readyState = 0; // CONNECTING
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  peerId = 0;
  toHub: (data: Uint8Array) => void = () => {};
  closedByHub: () => void = () => {};
  #closed = false;
  send(data: Uint8Array): void { if (!this.#closed) this.toHub(data); }
  close(): void { if (this.#closed) return; this.#closed = true; this.readyState = 3; this.closedByHub(); this.onclose?.({ code: 1000, reason: "closed" }); }
  open(): void { this.readyState = 1; this.onopen?.(); }
  deliverBin(u: Uint8Array): void { if (!this.#closed) this.onmessage?.({ data: u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) }); }
  deliverStr(s: string): void { if (!this.#closed) this.onmessage?.({ data: s }); }
}

/** A faithful in-memory copy of relay_server's routing (host = peer 0; guests 1,2,…; broadcast/unicast; the
 *  peer-joined control), so the coordinator's REAL CollabSocket + demux run with no network. Test-only. */
class LoopbackRelayHub {
  #host: LoopbackWs | null = null;
  #guests = new Map<number, LoopbackWs>();
  #seq = 1;
  factory(): WebSocketFactory {
    return (url: string) => {
      const role = /role=host/.test(url) ? "host" : "guest";
      const ws = new LoopbackWs();
      if (role === "host") {
        this.#host = ws;
        ws.toHub = (data) => this.#fromHost(data);
        ws.closedByHub = () => { this.#host = null; };
        queueMicrotask(() => ws.open());
      } else {
        const peerId = this.#seq++;
        ws.peerId = peerId;
        this.#guests.set(peerId, ws);
        ws.toHub = (data) => this.#fromGuest(peerId, data);
        ws.closedByHub = () => { if (this.#guests.delete(peerId)) this.#host?.deliverStr(JSON.stringify({ t: "peer-left", peer: peerId })); };
        queueMicrotask(() => { ws.open(); this.#host?.deliverStr(JSON.stringify({ t: "peer-joined", peer: peerId })); });
      }
      return ws as unknown as WebSocketLike;
    };
  }
  #fromHost(bytes: Uint8Array): void {
    const target = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false);
    const sealed = bytes.subarray(4);
    const out = packEnvelope(0, sealed); // relay rewrites the header to the sender (host = 0)
    if (target === 0) for (const g of this.#guests.values()) g.deliverBin(out);
    else this.#guests.get(target)?.deliverBin(out);
  }
  #fromGuest(peerId: number, bytes: Uint8Array): void {
    const sealed = bytes.subarray(4); // guest→host is always tagged with the guest's own peer id
    this.#host?.deliverBin(packEnvelope(peerId, sealed));
  }
}

/**
 * The PRODUCTION-path proof (ADR-0201): the REAL `webrtcHostCoordinator` + `webrtcGuestCoordinator` - CollabSocket,
 * the signaling/control/fallback demux, the per-guest fan-out, and a real WebRTC DataChannel - run over an
 * in-memory relay (no server). Asserts the guest gets its E2E `welcome` and a host broadcast, and reports which
 * path carried it (`p2p` once the DataChannel upgrades, else the relay `fallback`). Never throws.
 */
export async function webrtcRelaySelfTest(): Promise<{ ok: boolean; detail: string }> {
  if (typeof RTCPeerConnection === "undefined") return { ok: false, detail: "no RTCPeerConnection in this build" };
  let host: ReturnType<typeof webrtcHostCoordinator> | null = null;
  let guest: ReturnType<typeof webrtcGuestCoordinator> | null = null;
  try {
    const raw = generateRoomKey();
    const hostKey = await importRoomKey(raw);
    const guestKey = await importRoomKey(raw);
    const hub = new LoopbackRelayHub();
    const wsFactory = hub.factory();
    const wsUrl = "wss://loopback/r/selftest";

    const events: string[] = [];
    let welcomed = false;
    host = webrtcHostCoordinator({ wsUrl, key: hostKey, wsFactory, host: { header: { sessionId: "s", title: "WebRTC relay self-test", model: "m", hostName: "host", startedAt: 1 } } });
    guest = webrtcGuestCoordinator({ wsUrl, key: guestKey, wsFactory, guest: { name: "bob" }, callbacks: { onWelcome: () => { welcomed = true; }, onEvent: (e) => events.push(e.type) } });

    await waitFor(() => welcomed && guest!.guest.view().phase === "live", "the guest welcome over the relay coordinator");
    const title = guest.guest.view().header?.title;

    host.host.pushEvent({ type: "token", text: "hi" });
    host.host.pushEvent({ type: "done", text: "done" });
    await waitFor(() => events.includes("token") && events.includes("done"), "the broadcast over the relay coordinator");
    // Give ICE a beat to complete so we can report whether it upgraded to a direct DataChannel.
    await new Promise((r) => setTimeout(r, 400));
    const path = guest.transport.mode === "p2p" ? "p2p (direct DataChannel)" : "relay (fallback)";

    const ok = title === "WebRTC relay self-test" && host.fanout.guestCount === 1 && welcomed;
    return { ok, detail: `welcome title="${title}", guests=${host.fanout.guestCount}, events=${JSON.stringify(events)}, path=${path}` };
  } catch (e) {
    return { ok: false, detail: String((e as Error)?.message ?? e) };
  } finally {
    try { guest?.close(); } catch { /* */ }
    try { host?.close(); } catch { /* */ }
  }
}

/**
 * P-COLLAB.17 proof: the RENDERER P2P MODULE (`collab_p2p.ts`) end-to-end - `startP2PHost` mints the room +
 * links, `startP2PGuest` parses the minted view link + joins, the host's teed ChatEvents reach the guest, and
 * the DataChannel upgrades. Runs over the in-memory loopback relay (no server) so it is deterministic + not
 * subject to backend polling / reachability. Proves the toggle's actual code path, not just the engine.
 */
export async function webrtcP2PModuleSelfTest(): Promise<{ ok: boolean; detail: string }> {
  if (typeof RTCPeerConnection === "undefined") return { ok: false, detail: "no RTCPeerConnection in this build" };
  try {
    const hub = new LoopbackRelayHub();
    const wsFactory = hub.factory();
    const events: string[] = [];
    let welcomed = false;
    let title = "";

    const status = await startP2PHost({
      relayWsBase: "wss://loopback", relayHttpBase: "https://loopback", relayLabel: "loopback", relaySource: "embedded",
      header: { sessionId: "s", title: "P2P module self-test", model: "m", hostName: "host" },
      allowEdit: false, ice: null, wsFactory,
    });
    const res = startP2PGuest({
      link: status.viewLink, guestName: "bob", ice: null, wsFactory,
      callbacks: { onWelcome: (w) => { welcomed = true; title = w.header.title; }, onEvent: (e) => events.push(e.type) },
    });
    if (!res.ok) return { ok: false, detail: `guest start failed: ${res.error}` };

    await waitFor(() => welcomed, "the guest welcome via the P2P module over the loopback relay");
    teeUserTurn("hi over the module");
    teeEvent({ type: "token", text: "yo" });
    teeEvent({ type: "done", text: "done" });
    await waitFor(() => events.includes("token") && events.includes("done"), "the teed events reaching the guest");
    await new Promise((r) => setTimeout(r, 350)); // let ICE settle so we can report the path

    const ok = welcomed && title === "P2P module self-test" && p2pHostStatus()?.participantCount === 1;
    return { ok, detail: `welcome title="${title}", guests=${p2pHostStatus()?.participantCount}, events=${JSON.stringify(events)}, viewLink="${status.viewLink.slice(0, 30)}…"` };
  } catch (e) {
    return { ok: false, detail: String((e as Error)?.message ?? e) };
  } finally {
    try { stopP2PGuest(); } catch { /* */ }
    try { stopP2PHost(); } catch { /* */ }
  }
}
