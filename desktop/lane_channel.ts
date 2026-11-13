// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/lane_channel.ts - LH-03 (ADR-0544): the engine's half of a held lane's channel (harness/omp/engine_channel.ts).
//
// The engine knows the channel key of every held lane it runs: the ones it launched, and the ones it reattached
// from their holder records (a key minted by an engine that is gone). A request is the lane's when its MAC verifies
// under one lane's key over this exact method, path and query, time and body, its time is inside the window and
// its nonce is new. Such a request opens CHANNEL_ROUTES only, and only where every name it gives for its speaker
// (a `target`, a `from`, a `session`) is that lane. Its reply carries the proof the lane's side checks before it
// trusts it. ADR-0544 as amended by the 2026-11-12 review.

import { CHANNEL_MAC_HEADER, CHANNEL_NONCE_HEADER, CHANNEL_PROOF_HEADER, CHANNEL_TIME_HEADER, CHANNEL_WINDOW_MS, channelProof, channelRequestMac, isChannelKey, isChannelNonce, isChannelTime } from "../harness/omp/engine_channel.ts";
import { tokenValid } from "./origin_guard.ts";

/** Where a route's request names who is speaking, and what that name must be: the lane's id, or the omp session
 *  the lane runs. A request that leaves the name out is refused like one that names another lane. */
export interface ChannelSpeaker { in: "query" | "body"; field: string; is: "lane" | "session" }

/** The routes a held lane's channel opens, each with its speaker (null: the route names none). The first group is
 *  the channel itself (the notes drain, check-in, the checkout gate and claims, the beat); the rest are listed as
 *  lane-safe: they act for whoever calls and name no other session. Left out on purpose: /api/git/exec (only a
 *  contained agent uses the git broker, and a held lane is a fleet lane, which runs the real git) and
 *  /api/sandbox/grant (it changes the master's sandbox). */
export const CHANNEL_ROUTES: Readonly<Record<string, ChannelSpeaker | null>> = {
  "/api/interject/pending": { in: "query", field: "target", is: "lane" },
  "/api/checkout/peers": { in: "query", field: "target", is: "lane" },
  "/api/checkout/gate": { in: "query", field: "target", is: "lane" },
  "/api/checkout/write": { in: "query", field: "target", is: "lane" },
  "/api/checkin": { in: "body", field: "from", is: "lane" },
  "/api/checkin/reply": { in: "query", field: "target", is: "lane" }, // its `from` is the peer being waited on
  "/api/agent/beat": { in: "body", field: "session", is: "session" },
  "/api/judgment/trace": { in: "body", field: "target", is: "lane" },
  "/api/tool/meta": null,
  "/api/kb/retrieve": null, "/api/kg/recall": null, "/api/kg/retain": null,
  "/api/fleet/status": null,
  "/api/preview/shot": null, "/api/preview/open": null, "/api/preview/inspect": null, "/api/preview/act": null,
  "/api/browser/open": null, "/api/browser/capture": null, "/api/browser/scroll": null, "/api/browser/close": null,
  "/api/browser/shot": null, "/api/browser/click": null, "/api/browser/type": null, "/api/browser/drag": null,
  "/api/browser/keys": null, "/api/browser/snapshot": null, "/api/browser/act": null,
  "/api/creator/design/manifest": null, "/api/creator/design/ops": null, "/api/creator/design/ops/result": null,
  "/api/creator/drift/status": null, "/api/creator/drift/call": null, "/api/creator/drift/library": null,
  "/api/creator/openfilm/look": null, "/api/creator/openfilm/render": null, "/api/creator/openfilm/job": null,
};

/** A request that authenticated as one held lane. `mac` is what the reply's proof is bound to. */
export interface ChannelRequest { readonly laneId: string; readonly key: string; readonly mac: string; readonly body: Buffer }

/** Nonces remembered at once. A lane makes a few calls a second at most; past this many live ones, new requests are
 *  refused (never a remembered nonce forgotten early, which would let its request be replayed). */
const SEEN_MAX = 8192;

export class LaneChannels {
  /** laneId -> key */
  readonly #lanes = new Map<string, string>();
  /** nonce -> until when it must be remembered (its request's time plus the window) */
  readonly #seen = new Map<string, number>();

  /** Accept `key` for `laneId` (a launch, or a reattach of a record a previous engine wrote). A malformed key is
   *  ignored: that lane then has no channel and its calls are refused. */
  register(laneId: string, key: unknown): void {
    if (isChannelKey(key)) this.#lanes.set(laneId, key);
  }

  forget(laneId: string): void { this.#lanes.delete(laneId); }

  /** Whether `laneId` is registered with exactly `key`. */
  knows(laneId: string, key: string): boolean {
    const held = this.#lanes.get(laneId);
    return held !== undefined && tokenValid(key, held);
  }

  /** The lane `req` authenticated as, or null: no channel headers, a time outside the window, a MAC no lane's key
   *  gives for this method, path and query, time and body, or a nonce already used. `url` is `req.url` parsed. */
  async authenticate(req: Request, url: URL, now: number = Date.now()): Promise<ChannelRequest | null> {
    const nonce = req.headers.get(CHANNEL_NONCE_HEADER);
    const time = req.headers.get(CHANNEL_TIME_HEADER);
    const mac = req.headers.get(CHANNEL_MAC_HEADER);
    if (!isChannelNonce(nonce) || !isChannelTime(time) || mac === null || this.#lanes.size === 0) return null;
    const at = Number(time);
    if (Math.abs(now - at) > CHANNEL_WINDOW_MS) return null;
    // A clone, so the route handler still reads the body it was sent.
    const body = Buffer.from(await req.clone().arrayBuffer());
    for (const [laneId, key] of this.#lanes) {
      const expected = channelRequestMac(key, nonce, req.method, url.pathname + url.search, time, body);
      if (!tokenValid(mac, expected)) continue;
      return this.#remember(nonce, at + CHANNEL_WINDOW_MS, now) ? { laneId, key, mac: expected, body } : null;
    }
    return null;
  }

  /** Record `nonce` as used. False when it already was (a replay), or when the cache is full of live nonces. */
  #remember(nonce: string, until: number, now: number): boolean {
    if (this.#seen.has(nonce)) return false;
    if (this.#seen.size >= SEEN_MAX) for (const [n, u] of this.#seen) if (u < now) this.#seen.delete(n);
    if (this.#seen.size >= SEEN_MAX) return false;
    this.#seen.set(nonce, until);
    return true;
  }
}

/** A top-level string field of a JSON object body, or null. */
function bodyField(body: Buffer, field: string): string | null {
  let parsed: unknown;
  try { parsed = JSON.parse(body.toString("utf8")); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || !(field in parsed)) return null;
  const value: unknown = Reflect.get(parsed, field);
  return typeof value === "string" ? value : null;
}

/** PURE but for `sessionOf`: may the authenticated lane's request `ch` go to `url`? Only a CHANNEL_ROUTES path, a
 *  query `target` (on any route) that is the lane, and the route's speaker present and equal to the lane (or to
 *  `sessionOf(lane)`, the omp session the lane runs, for a `session` speaker). */
export function channelAdmits(ch: ChannelRequest, url: URL, sessionOf: (laneId: string) => string | null): boolean {
  if (!Object.hasOwn(CHANNEL_ROUTES, url.pathname)) return false;
  const speaker = CHANNEL_ROUTES[url.pathname] ?? null;
  const target = url.searchParams.get("target");
  if (target !== null && target !== ch.laneId) return false;
  if (speaker === null) return true;
  const named = speaker.in === "query" ? url.searchParams.get(speaker.field) : bodyField(ch.body, speaker.field);
  const expected = speaker.is === "lane" ? ch.laneId : sessionOf(ch.laneId);
  return named !== null && expected !== null && named === expected;
}

/** `res` as the lane gets it: with the proof over the request's MAC, the status and the exact body bytes. */
export async function answerChannel(ch: ChannelRequest, res: Response): Promise<Response> {
  const body = Buffer.from(await res.arrayBuffer());
  const headers = new Headers(res.headers);
  headers.set(CHANNEL_PROOF_HEADER, channelProof(ch.key, ch.mac, res.status, body));
  return new Response(res.status === 204 || res.status === 304 ? null : body, { status: res.status, statusText: res.statusText, headers });
}
