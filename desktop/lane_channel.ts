// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/lane_channel.ts - LH-03 (ADR-0544): the engine's half of a held lane's channel (harness/omp/engine_channel.ts).
//
// The engine knows the channel key of every held lane it runs: the ones it launched, and the ones it reattached
// from their holder records (a key minted by an engine that is gone). A request whose `t` (or `x-lucid-token`) is
// one lane's channel credential opens the agent routes for that lane only, and its reply carries the proof the
// lane's extensions check before they trust it.

import { CHANNEL_NONCE_HEADER, CHANNEL_PROOF_HEADER, channelCredential, channelProof, isChannelKey, isChannelNonce, sameHex } from "../harness/omp/engine_channel.ts";

export class LaneChannels {
  /** laneId -> [key, credential] */
  readonly #lanes = new Map<string, [string, string]>();

  /** Accept `key` for `laneId` (a launch, or a reattach of a record a previous engine wrote). A malformed key is
   *  ignored: that lane then has no channel and its calls are refused. */
  register(laneId: string, key: unknown): void {
    if (isChannelKey(key)) this.#lanes.set(laneId, [key, channelCredential(key)]);
  }

  forget(laneId: string): void { this.#lanes.delete(laneId); }

  /** The lane whose channel credential `token` is, or null. */
  laneFor(token: string | null): { laneId: string; key: string } | null {
    if (!token) return null;
    for (const [laneId, [key, cred]] of this.#lanes) if (sameHex(token, cred)) return { laneId, key };
    return null;
  }

  /** The lane a request authenticated as through its channel, or null. A request that names a `target` other than
   *  that lane is not the lane speaking for itself, so it gets null too (and is refused like any unknown token). */
  laneOf(url: URL, headerToken: string | null): { laneId: string; key: string } | null {
    const lane = this.laneFor(url.searchParams.get("t")) ?? this.laneFor(headerToken);
    if (!lane) return null;
    const target = url.searchParams.get("target");
    return target === null || target === lane.laneId ? lane : null;
  }

  /** `res` as the lane gets it: with the proof over the request's nonce, the status and the body, when the request
   *  came over a lane channel with a well-formed nonce. Any other request's reply is returned untouched. */
  async answer(req: Request, res: Response): Promise<Response> {
    const lane = this.laneOf(new URL(req.url), req.headers.get("x-lucid-token"));
    const nonce = req.headers.get(CHANNEL_NONCE_HEADER);
    if (!lane || !isChannelNonce(nonce)) return res;
    const body = new Uint8Array(await res.arrayBuffer());
    const headers = new Headers(res.headers);
    headers.set(CHANNEL_PROOF_HEADER, channelProof(lane.key, nonce, res.status, body));
    return new Response(res.status === 204 || res.status === 304 ? null : body, { status: res.status, statusText: res.statusText, headers });
  }
}
