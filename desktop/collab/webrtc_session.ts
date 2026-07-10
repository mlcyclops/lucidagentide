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
import { generateRoomKey, importRoomKey } from "./crypto.ts";

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
